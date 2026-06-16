import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  // The CLI launches the ink TUI (ink 7 requires Node >= 22).
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
})
