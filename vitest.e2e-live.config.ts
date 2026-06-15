import { defineConfig } from 'vitest/config'

// Live-E2E tier (plan D18): real agent CLIs, real spend. Mechanically isolated
// from the default suite — its own config, its own dir, only runs under the
// explicit OPEN_CONSENSUS_E2E_LIVE=1 guard set by the `test:e2e:live` script.
export default defineConfig({
  test: {
    include: ['test/e2e-live/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Live agents share machine resources; never fan all of them out at once.
    fileParallelism: false,
  },
})
