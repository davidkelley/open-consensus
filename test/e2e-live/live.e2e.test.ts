import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { REAL_ADAPTER_IDS, defaultRegistry } from '@open-consensus/adapters'
import { type Config, parseConfig } from '@open-consensus/config'
import type { AppPaths } from '@open-consensus/core'
import { type AdapterRegistry, type RunningDaemon, startDaemon } from '@open-consensus/daemon'
import { createMcpServer, httpDaemonClient } from '@open-consensus/mcp'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * LIVE-E2E (plan D18 / Stage 10) — the documented final release quality-gate.
 * Drives the full MCP → daemon → engine stack against the user's REAL agent CLIs
 * and SPENDS REAL MONEY. Mechanically isolated: this file lives under
 * `test/e2e-live/`, runs only via `npm run test:e2e:live` (which sets
 * OPEN_CONSENSUS_E2E_LIVE=1 — the loader-time guard in vitest.e2e-live.config.ts),
 * and is NEVER discovered by the default suite's globs. It SKIPS cleanly when no
 * real CLI is installed/authed, and caps concurrency to one invocation at a time.
 */

// Defence-in-depth (in addition to the config loader guard): if this file is ever
// picked up by another runner, refuse to spend real money without the explicit flag.
if (process.env.OPEN_CONSENSUS_E2E_LIVE !== '1') {
  throw new Error('live-e2e requires OPEN_CONSENSUS_E2E_LIVE=1 — run via `npm run test:e2e:live`')
}

const PROMPT = 'Reply with only the single word: ok'
// The MCP SDK Client defaults to a 60s request timeout; our long-poll waits up to
// 90s for a real agent, so requests must allow longer.
const CALL_TIMEOUT_MS = 120_000

/**
 * Allow-list (not deny-list) the agents we'll spend money on: a KNOWN real
 * adapter id, WITH a native sandbox, that is installed + usable. So a registry
 * change can never slip the mock or an unsandboxed tool into a live, paid run.
 */
async function availableAdapters(registry: AdapterRegistry): Promise<string[]> {
  const ids: string[] = []
  for (const id of REAL_ADAPTER_IDS) {
    const adapter = registry.get(id)
    if (!adapter || adapter.capabilities.sandbox === false) continue // D20
    if ((await adapter.detect()).available) ids.push(id)
  }
  return ids
}

function makePaths(base: string): AppPaths {
  return {
    config: join(base, 'config'),
    state: join(base, 'state'),
    data: join(base, 'data'),
    cache: join(base, 'cache'),
    runtime: join(base, 'runtime'),
  }
}

let daemon: RunningDaemon | undefined
let dir: string | undefined
afterAll(async () => {
  await daemon?.stop().catch(() => undefined)
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('consensus live-e2e (real agents)', () => {
  it('runs a real multi-CLI consensus to a finalized verdict', async (ctx) => {
    const registry = defaultRegistry()
    const ids = await availableAdapters(registry)
    if (ids.length === 0) {
      // A VISIBLE skip (not a silent green pass) so a broken detection in CI shows.
      ctx.skip()
      return
    }

    const config: Config = parseConfig({
      schemaVersion: 1,
      agents: ids.map((id) => ({ id, name: id, adapter: id, maxRetries: 0, timeoutMs: 90_000 })),
      // concurrency: 1 -> never fan all real CLIs out at once (cap the live spend).
      panels: [{ id: 'live', name: 'Live', agentIds: ids, quorum: 1, concurrency: 1 }],
    })

    dir = mkdtempSync(join(tmpdir(), 'oc-live-'))
    daemon = await startDaemon({
      adapters: registry,
      config,
      paths: makePaths(dir),
      loopback: true,
    })
    const dClient = httpDaemonClient(daemon.endpoint, daemon.token)
    const server = createMcpServer(dClient)
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    await server.connect(serverT)
    const client = new Client({ name: 'live-e2e', version: '0' })
    await client.connect(clientT)

    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      })
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
      return JSON.parse(text) as Record<string, unknown>
    }

    const started = (await call('consensus_start', { panel: 'live', prompt: PROMPT })) as {
      runId: string
      roundId: string
    }
    // With concurrency:1 the real agents run sequentially and a single (server-capped)
    // long-poll can return before the round finishes — re-poll until done.
    let round: { done: boolean; verdict: string; agents: Array<{ status: string }> }
    const deadline = Date.now() + 5 * 60_000
    do {
      round = (await call('consensus_poll', {
        runId: started.runId,
        roundId: started.roundId,
        wait_ms: 45_000,
      })) as typeof round
    } while (!round.done && Date.now() < deadline)

    expect(round.done).toBe(true)
    // At least one real agent answered ok; the verdict is met or degraded (never
    // a hang — every invocation reaches a terminal state via the per-agent timeout).
    expect(round.agents.some((a) => a.status === 'ok')).toBe(true)
    expect(['met', 'degraded']).toContain(round.verdict)
  })
})
