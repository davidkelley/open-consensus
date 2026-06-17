#!/usr/bin/env node
// Stage 2 (plan D-PKG1/D-PKG4): build a single self-contained `open-consensus`
// binary with @yao-pkg/pkg in ENHANCED SEA MODE — the documented path for an ESM
// app (https://yao-pkg.github.io/pkg/guide/sea-mode). Standard pkg mode can't load
// ESM from its snapshot (Node's ESM loader bypasses pkg's CJS fs patch); SEA mode
// dispatches the ESM entry natively and supports top-level await.
//
// Self-contained: it runs the workspace build itself, so `--target` reaches THIS
// script directly (no fragile `&&` arg-forwarding through an npm script). Steps:
//   1. turbo build the workspace dist.
//   2. esbuild bundles the ESM CLI entry into ONE file, INLINING the lazy TUI/MCP
//      dynamic imports (yoga-layout's top-level await stays deferred inside the
//      lazily-initialized TUI module) and EXTERNALIZING native `better-sqlite3`,
//      which is shipped as a resolvable node_modules asset instead.
//   3. pkg (sea:true) wraps the bundle + better-sqlite3 into a per-target binary.
//
// Usage: node scripts/build-binary.mjs [--target <rust-triple>]  (default: host).
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { arch as osArch, platform as osPlatform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Rust-style triple (D-PKG11) -> @yao-pkg/pkg target token. The triple is the
// single shared asset-name contract with the installer's install.sh.
const TARGETS = {
  'aarch64-apple-darwin': 'node22-macos-arm64',
  'x86_64-apple-darwin': 'node22-macos-x64',
  'x86_64-unknown-linux-gnu': 'node22-linux-x64',
  'aarch64-unknown-linux-gnu': 'node22-linux-arm64',
}
const TARGET_OS = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' },
}
// The Node version the pkg `node22` base binary embeds. better-sqlite3's native
// addon must match its ABI (NODE_MODULE_VERSION 127), NOT the build machine's Node.
const NODE22 = '22.22.3'

function hostTriple() {
  const p = osPlatform()
  const a = osArch()
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (p === 'linux') return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  throw new Error(
    `unsupported host platform for the binary build: ${p}/${a} (Windows is a non-goal)`,
  )
}

const argTarget = process.argv.indexOf('--target')
const triple = argTarget >= 0 ? process.argv[argTarget + 1] : hostTriple()
const pkgTarget = TARGETS[triple]
if (!pkgTarget) {
  throw new Error(`unknown target '${triple}'. Known: ${Object.keys(TARGETS).join(', ')}`)
}

const outDir = join(root, 'dist-bin')
const stageDir = join(outDir, 'stage')
const bundle = join(stageDir, 'app.mjs')
const stagePkgJson = join(stageDir, 'package.json')
const outBin = join(outDir, `open-consensus-${triple}`)

console.log(`[build-binary] target=${triple} (pkg ${pkgTarget}, SEA mode)`)

console.log('[build-binary] building the workspace (turbo)…')
execFileSync('npm', ['run', 'build'], { stdio: 'inherit', cwd: root })

rmSync(stageDir, { recursive: true, force: true })
mkdirSync(join(stageDir, 'node_modules'), { recursive: true })

console.log('[build-binary] esbuild bundling the CLI (ESM, node22, external better-sqlite3)…')
await build({
  entryPoints: [join(root, 'packages/cli/src/cli.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // The native addon is excluded from the JS bundle; it ships as a resolvable
  // node_modules asset (copied below) so `import 'better-sqlite3'` resolves.
  external: ['better-sqlite3'],
  banner: {
    js: [
      "import { createRequire as __ocCreateRequire } from 'node:module'",
      'const require = __ocCreateRequire(import.meta.url)',
    ].join('\n'),
  },
  logLevel: 'info',
})

// Stage better-sqlite3 (+ its native loader deps) as a real node_modules package
// so the embedded Node resolves the bare `import 'better-sqlite3'` from the SEA VFS.
// Resolve it via require.resolve from the package that depends on it, so a non-
// hoisted layout (npm workspaces don't guarantee root hoisting) still works.
const bs3Src = dirname(
  require.resolve('better-sqlite3/package.json', { paths: [join(root, 'packages/engine'), root] }),
)
console.log('[build-binary] staging better-sqlite3 (native addon) into node_modules…')
cpSync(bs3Src, join(stageDir, 'node_modules/better-sqlite3'), {
  recursive: true,
  dereference: true,
})
for (const dep of ['bindings', 'file-uri-to-path']) {
  try {
    const depSrc = dirname(require.resolve(`${dep}/package.json`, { paths: [bs3Src, root] }))
    cpSync(depSrc, join(stageDir, 'node_modules', dep), { recursive: true, dereference: true })
  } catch {
    /* not required by this better-sqlite3 version's loader */
  }
}

// Replace the staged addon with one built for the TARGET's Node 22 ABI (the build
// machine's Node may differ — e.g. Node 24 -> ABI 137 vs the SEA binary's 127).
// Delete the build-machine-native .node FIRST so a failed/partial prebuild fetch
// can never silently ship the wrong-ABI addon: prebuild-install must produce a
// fresh one, and we assert it exists below.
const bs3Dir = join(stageDir, 'node_modules/better-sqlite3')
const stagedNode = join(bs3Dir, 'build/Release/better_sqlite3.node')
rmSync(join(bs3Dir, 'build'), { recursive: true, force: true })
const { platform: tgtPlatform, arch: tgtArch } = TARGET_OS[triple]
console.log(
  `[build-binary] fetching better-sqlite3 node22 prebuild (${tgtPlatform}-${tgtArch}, ABI 127)…`,
)
execFileSync(
  process.execPath,
  [
    require.resolve('prebuild-install/bin.js', { paths: [bs3Src, root] }),
    '--runtime',
    'node',
    '--target',
    NODE22,
    '--platform',
    tgtPlatform,
    '--arch',
    tgtArch,
    '--tag-prefix',
    'v',
  ],
  { stdio: 'inherit', cwd: bs3Dir },
)
if (!existsSync(stagedNode)) {
  throw new Error(
    `prebuild-install did not produce ${stagedNode} for node22 ${tgtPlatform}-${tgtArch}; the binary would ship without (or with a wrong-ABI) better-sqlite3 addon.`,
  )
}

// The SEA-mode project manifest (type:module + ESM bin + sea:true). Version is read
// from the root package.json so the embedded metadata matches the release.
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
writeFileSync(
  stagePkgJson,
  `${JSON.stringify(
    {
      name: 'open-consensus',
      version,
      type: 'module',
      bin: 'app.mjs',
      pkg: {
        sea: true,
        // Embed the WHOLE staged node_modules (better-sqlite3 + its `bindings` /
        // `file-uri-to-path` deps) so the bare `import 'better-sqlite3'` and its
        // transitive requires resolve from the SEA VFS on every target.
        assets: ['node_modules/**/*'],
      },
    },
    null,
    2,
  )}\n`,
)

console.log('[build-binary] pkg (SEA mode) wrapping the bundle into a single binary…')
execFileSync(
  join(root, 'node_modules/.bin/pkg'),
  [stagePkgJson, '--targets', pkgTarget, '--output', outBin],
  { stdio: 'inherit', cwd: stageDir },
)

const sizeMb = (statSync(outBin).size / 1024 / 1024).toFixed(1)
console.log(`[build-binary] done -> ${outBin} (${sizeMb} MB)`)
