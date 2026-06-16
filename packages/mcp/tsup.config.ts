import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { mcp: 'src/mcp.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: { entry: { index: 'src/index.ts' } },
})
