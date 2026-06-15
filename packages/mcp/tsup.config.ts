import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { mcp: 'src/mcp.ts' },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
})
