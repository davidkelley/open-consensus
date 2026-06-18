import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

// Bake the release version (root package.json) into the bundle as __OC_VERSION__
// so a from-source `open-consensus --version` matches the release; the packaged
// binary injects the same constant via scripts/build-binary.mjs.
const version = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  // The CLI launches the ink TUI (ink 7 requires Node >= 22).
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  define: { __OC_VERSION__: JSON.stringify(version) },
})
