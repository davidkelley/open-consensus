import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { type Adapter, defaultRegistry } from '@open-consensus/adapters'
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
 * real CLI is installed/authed, and caps concurrency to a single panel.
 */

const PROMPT = 'Reply with only the single word: ok'

/** Probe the sandboxed real adapters; return the ids that are installed + usable. */
async function availableAdapters(registry: AdapterRegistry): Promise<string[]> {
  const ids: string[] = []
  for (const [id, adapter] of registry) {
    if (id === 'mock') continue
    if ((await (adapter as Adapter).detect()).available) ids.push(id)
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
  it('runs a real multi-CLI consensus to a finalized verdict', async () => {
    const registry = defaultRegistry()
    const ids = await availableAdapters(registry)
    if (ids.length === 0) {
      console.warn('live-e2e: no real agent CLIs detected — skipping')
      return
    }

    const config: Config = parseConfig({
      schemaVersion: 1,
      agents: ids.map((id) => ({ id, name: id, adapter: id, maxRetries: 0, timeoutMs: 90_000 })),
      panels: [{ id: 'live', name: 'Live', agentIds: ids, quorum: 1 }],
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
      const res = await client.callTool({ name, arguments: args })
      const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
      return JSON.parse(text) as Record<string, unknown>
    }

    const started = (await call('consensus_start', { panel: 'live', prompt: PROMPT })) as {
      runId: string
      roundId: string
    }
    const round = (await call('consensus_poll', {
      runId: started.runId,
      roundId: started.roundId,
      wait_ms: 90_000,
    })) as { done: boolean; verdict: string; agents: Array<{ status: string }> }

    expect(round.done).toBe(true)
    // At least one real agent answered ok; the verdict is met or degraded (never
    // a hang — every invocation reaches a terminal state via the per-agent timeout).
    expect(round.agents.some((a) => a.status === 'ok')).toBe(true)
    expect(['met', 'degraded']).toContain(round.verdict)
  })
})
