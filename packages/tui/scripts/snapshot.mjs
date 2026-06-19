// Snapshot harness runner (plan tui-brand-polish, Stage 1). Renders each scene in
// src/snapshot/scenes.tsx to an ANSI frame (ink-testing-library; FORCE_COLOR=3 is
// set by the npm script so chalk emits truecolor), converts it to SVG via our pure
// ansiFrameToSvg, and rasterises to PNG with rsvg-convert (falling back to
// ImageMagick `magick`, else skipping the PNG with a notice). Output lands in
// packages/tui/.snapshots/ (gitignored). This lives OUTSIDE src/ on purpose: it
// does file IO + spawns processes, so it must not be bundled by tsup nor counted
// by the ≥90% coverage gate — the pure pieces it uses ARE unit-tested.
//
// Usage: npm run -w @open-consensus/tui snapshot
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Box } from 'ink'
import { render } from 'ink-testing-library'
import { createElement } from 'react'

if (!process.env.FORCE_COLOR) process.env.FORCE_COLOR = '3'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src', 'snapshot')
const outDir = join(here, '..', '.snapshots')
mkdirSync(outDir, { recursive: true })

// esbuild-bundle the (TSX) scenes + the pure converter into one ESM module,
// keeping every bare import (react, ink, @open-consensus/*, …) external so it
// resolves to the workspace's real instances at runtime.
const bundlePath = join(outDir, '_bundle.mjs')
await build({
  stdin: {
    contents: [
      `export { scenes } from ${JSON.stringify(join(srcDir, 'scenes.tsx'))}`,
      `export { ansiFrameToSvg, stripAnsi } from ${JSON.stringify(join(srcDir, 'ansiToSvg.ts'))}`,
    ].join('\n'),
    resolveDir: srcDir,
    loader: 'ts',
    sourcefile: 'snapshot-entry.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  packages: 'external',
  outfile: bundlePath,
  logLevel: 'silent',
})

const { scenes, ansiFrameToSvg, stripAnsi } = await import(pathToFileURL(bundlePath).href)

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

// Pick a renderer once: rsvg-convert (best — does fontconfig glyph fallback) →
// ImageMagick magick → none (still emit .txt/.svg).
function pickRenderer() {
  for (const [bin, makeArgs] of [
    ['rsvg-convert', (svg, png) => [svg, '-o', png]],
    ['magick', (svg, png) => [svg, png]],
  ]) {
    if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0) return { bin, makeArgs }
  }
  return null
}

const renderer = pickRenderer()
const written = []
for (const scene of scenes) {
  // `width` constrains the render to N columns (wrap the dynamic node in a Box).
  const node = scene.width ? createElement(Box, { width: scene.width }, scene.node) : scene.node
  const { lastFrame, unmount, stdin } = render(node)
  await delay(40)
  if (scene.input) {
    stdin.write(scene.input)
    await delay(40)
  }
  // `noColor` simulates a NO_COLOR terminal by stripping all styling codes.
  const frame = scene.noColor ? stripAnsi(lastFrame() ?? '') : (lastFrame() ?? '')
  unmount()
  const txt = join(outDir, `${scene.name}.txt`)
  const svg = join(outDir, `${scene.name}.svg`)
  const png = join(outDir, `${scene.name}.png`)
  writeFileSync(txt, frame)
  writeFileSync(svg, ansiFrameToSvg(frame))
  let pngNote = '(no renderer — install librsvg or imagemagick for PNGs)'
  if (renderer) {
    const res = spawnSync(renderer.bin, renderer.makeArgs(svg, png), { encoding: 'utf8' })
    const err = (res.stderr || res.error?.message || '').trim().split('\n')[0] ?? ''
    pngNote = res.status === 0 ? png : `(${renderer.bin} failed${err ? `: ${err}` : ''})`
  }
  written.push(`  ${scene.name}: ${pngNote}`)
}

console.log(
  `Wrote ${scenes.length} snapshot(s) to ${outDir}` +
    `${renderer ? ` via ${renderer.bin}` : ''}:\n${written.join('\n')}`,
)
