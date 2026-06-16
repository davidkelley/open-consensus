import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMockAdapter } from '@open-consensus/adapters'
import { type Config, parseConfig } from '@open-consensus/config'
import type { AppPaths } from '@open-consensus/core'
import { type AdapterRegistry, type RunningDaemon, startDaemon } from '@open-consensus/daemon'
import { createMcpServer, httpDaemonClient } from '@open-consensus/mcp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Mock-stack E2E (plan Stage 10): a driving agent runs a full consensus through
 * the ENTIRE stack — an MCP client over InMemoryTransport → the MCP server →
 * a real loopback daemon → engine → the deterministic mock adapter. Zero real
 * CLIs, zero network, zero spend. Exercises start→poll→finalize, quorum-degraded,
 * cancellation, raw pagination, and orchestrator-restart re-anchor + daemon
 * restart persistence.
 */

const config: Config = parseConfig({
  schemaVersion: 1,
  agents: [
    { id: 'ok1', name: 'OK1', adapter: 'mock', model: 'mock:ok', maxRetries: 0 },
    { id: 'ok2', name: 'OK2', adapter: 'mock', model: 'mock:ok', maxRetries: 0 },
    { id: 'bad', name: 'BAD', adapter: 'mock', model: 'mock:error', maxRetries: 0 },
    {
      id: 'slow',
      name: 'SLOW',
      adapter: 'mock',
      model: 'mock:slow',
      maxRetries: 0,
      timeoutMs: 10_000,
    },
  ],
  panels: [
    { id: 'all-ok', name: 'All OK', agentIds: ['ok1', 'ok2'], quorum: 2 },
    { id: 'degraded', name: 'Degraded', agentIds: ['ok1', 'bad'], quorum: 2 },
    { id: 'slowp', name: 'Slow', agentIds: ['slow'], quorum: 1 },
  ],
})

function makePaths(base: string): AppPaths {
  return {
    config: join(base, 'config'),
    state: join(base, 'state'),
    data: join(base, 'data'),
    cache: join(base, 'cache'),
    runtime: join(base, 'runtime'),
  }
}

let dir: string
let paths: AppPaths
let daemon: RunningDaemon
let registryUsed: AdapterRegistry

/** A fresh MCP client wired to the running daemon — a "driving agent". */
async function connectOrchestrator(): Promise<Client> {
  const dClient = httpDaemonClient(daemon.endpoint, daemon.token)
  const server = createMcpServer(dClient)
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  await server.connect(serverT)
  const client = new Client({ name: 'e2e', version: '0' })
  await client.connect(clientT)
  return client
}

async function call<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ parsed: T }> {
  const res = await client.callTool({ name, arguments: args })
  const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
  // Surface a daemon-side tool error as its message, not an opaque JSON.parse throw.
  if (res.isError === true) throw new Error(`${name} failed: ${text}`)
  return { parsed: JSON.parse(text) as T }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oc-e2e-'))
  paths = makePaths(dir)
  registryUsed = new Map([['mock', createMockAdapter({ slowMs: 2000 })]])
  daemon = await startDaemon({ adapters: registryUsed, config, paths, loopback: true })
})
afterEach(async () => {
  await daemon.stop().catch(() => undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('consensus e2e (mock stack)', () => {
  it('uses ONLY the deterministic mock adapter (mechanical no-spend guarantee)', () => {
    expect([...registryUsed.keys()]).toEqual(['mock'])
    // The default-suite `no-live.ts` setup already hard-fails if this is '1'.
    expect(process.env.OPEN_CONSENSUS_E2E_LIVE).not.toBe('1')
  })

  it('drives start -> poll -> finalize with quorum met', async () => {
    const client = await connectOrchestrator()
    const { parsed: started } = await call<{ runId: string; roundId: string; next_action: string }>(
      client,
      'consensus_start',
      { panel: 'all-ok', prompt: 'Is the sky blue?' },
    )
    expect(started.runId).toBeTruthy()
    expect(started.next_action).toBe('keep_polling')

    const { parsed: round } = await call<{
      done: boolean
      verdict: string
      agents: Array<{ agentId: string; status: string; distilled?: string }>
      next_action: string
    }>(client, 'consensus_poll', {
      runId: started.runId,
      roundId: started.roundId,
      wait_ms: 5000,
    })
    expect(round.done).toBe(true)
    expect(round.verdict).toBe('met')
    expect(round.next_action).toBe('review_results')
    expect(round.agents.map((a) => a.status).sort()).toEqual(['ok', 'ok'])
    expect(round.agents.every((a) => (a.distilled ?? '').startsWith('ok:'))).toBe(true)
  })

  it('reports a quorum-degraded round with the errored agent by name', async () => {
    const client = await connectOrchestrator()
    const { parsed: started } = await call<{ runId: string; roundId: string }>(
      client,
      'consensus_start',
      { panel: 'degraded', prompt: 'review' },
    )
    const { parsed: round } = await call<{
      done: boolean
      verdict: string
      agents: Array<{ agentId: string; status: string; errorClass?: string }>
      next_action: string
    }>(client, 'consensus_poll', { runId: started.runId, roundId: started.roundId, wait_ms: 5000 })
    expect(round.done).toBe(true)
    expect(round.verdict).toBe('degraded')
    expect(round.next_action).toBe('handle_degraded')
    const bad = round.agents.find((a) => a.agentId === 'bad')
    expect(bad?.status).toBe('error')
  })

  it('cancels an in-flight run and tree-kills the child', async () => {
    const client = await connectOrchestrator()
    const { parsed: started } = await call<{ runId: string; roundId: string }>(
      client,
      'consensus_start',
      { panel: 'slowp', prompt: 'take your time' },
    )
    const { parsed: cancelled } = await call<{ cancelled: number }>(client, 'consensus_cancel', {
      runId: started.runId,
    })
    expect(cancelled.cancelled).toBeGreaterThanOrEqual(1)
    // The round resolves to a terminal (non-ok) state rather than hanging.
    const { parsed: round } = await call<{ done: boolean; verdict: string }>(
      client,
      'consensus_poll',
      { runId: started.runId, roundId: started.roundId, wait_ms: 5000 },
    )
    expect(round.done).toBe(true)
    expect(round.verdict).not.toBe('met')
  })

  it('pages an agent’s full raw output via consensus_get_raw (cursor + eof)', async () => {
    const client = await connectOrchestrator()
    // A long prompt makes the mock's echoed output span several small pages, so
    // the test exercises cursor advancement + EOF + multi-page reconstruction.
    const prompt = `raw-${'x'.repeat(300)}`
    const { parsed: started } = await call<{ runId: string; roundId: string }>(
      client,
      'consensus_start',
      { panel: 'all-ok', prompt },
    )
    const { parsed: round } = await call<{ agents: Array<{ rawRef?: string }> }>(
      client,
      'consensus_poll',
      { runId: started.runId, roundId: started.roundId, wait_ms: 5000 },
    )
    const rawRef = round.agents.map((a) => a.rawRef).find(Boolean)
    expect(rawRef).toBeTruthy()

    let cursor = 0
    let full = ''
    let pages = 0
    for (;;) {
      const { parsed: page } = await call<{ chunk: string; eof: boolean; nextCursor: number }>(
        client,
        'consensus_get_raw',
        { rawRef, cursor, maxBytes: 64 },
      )
      full += page.chunk
      cursor = page.nextCursor
      pages += 1
      if (page.eof) break
      expect(pages).toBeLessThan(100) // guard against a non-advancing cursor
    }
    expect(pages).toBeGreaterThan(1) // genuinely paginated
    expect(full).toContain(prompt) // reconstructed output contains the echoed prompt
  })

  it('a restarted orchestrator re-anchors via consensus_list_runs', async () => {
    const first = await connectOrchestrator()
    const { parsed: started } = await call<{ runId: string }>(first, 'consensus_start', {
      panel: 'all-ok',
      prompt: 'persist me',
    })
    await first.close()

    // A brand-new MCP client/server pair = a replacement orchestrator.
    const second = await connectOrchestrator()
    const { parsed: runs } = await call<{ runs: Array<{ runId: string }> }>(
      second,
      'consensus_list_runs',
      {},
    )
    expect(runs.runs.map((r) => r.runId)).toContain(started.runId)
    const { parsed: status } = await call<{ run: { runId: string } }>(second, 'consensus_status', {
      runId: started.runId,
    })
    expect(status.run.runId).toBe(started.runId)
  })

  it('survives a daemon restart on the same state dir (runs persist)', async () => {
    const client = await connectOrchestrator()
    const { parsed: started } = await call<{ runId: string; roundId: string }>(
      client,
      'consensus_start',
      { panel: 'all-ok', prompt: 'durable' },
    )
    await call(client, 'consensus_poll', {
      runId: started.runId,
      roundId: started.roundId,
      wait_ms: 5000,
    })
    await daemon.stop()

    registryUsed = new Map([['mock', createMockAdapter()]])
    daemon = await startDaemon({ adapters: registryUsed, config, paths, loopback: true })
    const reconnected = await connectOrchestrator()
    const { parsed: runs } = await call<{ runs: Array<{ runId: string }> }>(
      reconnected,
      'consensus_list_runs',
      {},
    )
    expect(runs.runs.map((r) => r.runId)).toContain(started.runId)

    // Re-poll the original round: its completed verdict persisted across restart.
    const { parsed: round } = await call<{ done: boolean; verdict: string }>(
      reconnected,
      'consensus_poll',
      { runId: started.runId, roundId: started.roundId, wait_ms: 5000 },
    )
    expect(round.done).toBe(true)
    expect(round.verdict).toBe('met')
  })
})
