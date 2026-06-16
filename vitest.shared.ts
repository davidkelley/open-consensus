import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vitest/config'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

/**
 * Shared vitest config for every workspace package. Wires the `no-live` guard
 * (plan D18: the default suite hard-fails if OPEN_CONSENSUS_E2E_LIVE=1) and the
 * ≥90% line+branch coverage gate. Coverage only runs when `--coverage` is set,
 * so a package's `test` script passes `--coverage` to enforce the gate.
 */
export function packageVitestConfig(): UserConfig {
  return {
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
      exclude: ['**/dist/**', '**/node_modules/**', 'test/e2e-live/**'],
      setupFiles: [resolve(repoRoot, 'test/setup/no-live.ts')],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html'],
        include: ['src/**/*.ts', 'src/**/*.tsx'],
        // Thin entrypoint stubs carry no logic; everything else must hit the gate.
        exclude: [
          'src/**/*.test.ts',
          'src/**/*.test.tsx',
          'src/index.ts',
          'src/cli.ts',
          'src/mcp.ts',
          'src/tui.tsx',
        ],
        thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
  }
}
