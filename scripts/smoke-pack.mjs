#!/usr/bin/env node
// Install-from-pack smoke (plan Stage 10): pack every workspace package, verify
// each publishable package's `bin` targets are actually inside its tarball, then
// install the tarballs into a CLEAN temp prefix and run the `open-consensus` bin.
// This proves the published artifacts' bins + dependency graph resolve and run —
// not just that the tarball file list looks right. Run `npm run build` first.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts })

// The published bins require Node >= 22 (ink 7); installing + running under an
// older Node would 'succeed' the install but fail at runtime, so guard up front.
const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  console.error(`smoke:pack requires Node >= 22 (found ${process.versions.node})`)
  process.exit(1)
}

const PUBLISHABLE = [
  { name: '@open-consensus/cli', dir: 'packages/cli', runnableBin: 'open-consensus' },
  { name: '@open-consensus/mcp', dir: 'packages/mcp' },
]

const work = mkdtempSync(join(tmpdir(), 'oc-pack-'))
try {
  // 1. Pack every workspace package into the temp dir.
  run('npm', ['pack', '--workspaces', '--pack-destination', work], { cwd: repoRoot })
  const tarballs = readdirSync(work)
    .filter((f) => f.endsWith('.tgz'))
    .map((f) => join(work, f))
  if (tarballs.length === 0) throw new Error('npm pack produced no tarballs')

  // 2. Verify each publishable package's declared bin targets are IN its tarball.
  for (const pkg of PUBLISHABLE) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, pkg.dir, 'package.json'), 'utf8'))
    const out = run('npm', ['pack', '--dry-run', '--json', '-w', pkg.name], { cwd: repoRoot })
    const files = new Set(JSON.parse(out)[0].files.map((f) => f.path))
    for (const [binName, binPath] of Object.entries(manifest.bin ?? {})) {
      const target = binPath.replace(/^\.\//, '')
      if (!files.has(target))
        throw new Error(`${pkg.name}: bin '${binName}' -> '${target}' not packed`)
      console.log(`ok   ${pkg.name}: bin ${binName} -> ${target}`)
    }
  }

  // 3. Install ALL tarballs into a clean consumer (so @open-consensus/* deps
  //    resolve from the local tarballs, not the registry) and run the bin.
  const consumer = join(work, 'consumer')
  mkdirSync(consumer)
  run('npm', ['init', '-y'], { cwd: consumer })
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: consumer })
  const bin = join(consumer, 'node_modules', '.bin', 'open-consensus')
  const help = run(bin, ['--help'], { cwd: consumer })
  if (!help.includes('open-consensus')) {
    throw new Error("open-consensus --help did not mention 'open-consensus'")
  }
  console.log('ok   installed open-consensus runs (--help)')

  console.log('\ninstall-from-pack smoke passed')
} finally {
  rmSync(work, { recursive: true, force: true })
}
