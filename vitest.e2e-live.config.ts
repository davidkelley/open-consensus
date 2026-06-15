import { defineConfig } from 'vitest/config'

// Guard the live tier at config-load time: this config must only ever be loaded
// via `npm run test:e2e:live` (which sets the env). Running it directly without
// the flag would otherwise spawn real CLIs and spend real money.
if (process.env.OPEN_CONSENSUS_E2E_LIVE !== '1') {
  throw new Error(
    'vitest.e2e-live.config.ts loaded without OPEN_CONSENSUS_E2E_LIVE=1. ' +
      'Run the live tier only via `npm run test:e2e:live`.',
  )
}

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
