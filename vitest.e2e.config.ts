import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Default mock-stack E2E tier (plan Stage 10). Drives the FULL stack —
 * MCP → daemon → engine → mock adapter — over a real loopback daemon, but with
 * the deterministic mock adapter only: zero real CLIs, zero network, zero spend.
 * Reuses the `no-live` guard so it can never run with the live flag set, and
 * carries no coverage gate (it's an integration tier, not a unit one).
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    setupFiles: [resolve(import.meta.dirname, 'test/setup/no-live.ts')],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
