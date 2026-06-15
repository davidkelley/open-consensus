import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Adapter, type MockMode, createMockAdapter } from '@open-consensus/adapters'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type PanelAgent } from './engine'
import { EngineStore } from './store'

const caps = {
  nonInteractive: true,
  structuredOutput: false,
  sandbox: true,
  promptDelivery: 'stdin',
} as const

/** An adapter whose binary does not exist (-> runner spawn-error -> unavailable). */
const brokenAdapter: Adapter = {
  id: 'broken',
  capabilities: caps,
  detect: () => Promise.resolve({ available: false }),
  buildInvocation: () => ({ file: '/nonexistent/oc-bin-xyz', args: [], env: {} }),
  parse: () => ({ status: 'error', text: '' }),
}

/** An adapter that floods stdout past the engine's byte cap (-> output-overflow). */
const floodAdapter: Adapter = {
  id: 'flood',
  capabilities: caps,
  detect: () => Promise.resolve({ available: true }),
  buildInvocation: () => ({
    file: process.execPath,
    args: ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'],
    env: {},
  }),
  parse: (result) => ({ status: result.outcome === 'output-overflow' ? 'error' : 'ok', text: '' }),
}

/** An adapter whose buildInvocation throws (engine must isolate the failure). */
const throwingAdapter: Adapter = {
  id: 'throwing',
  capabilities: caps,
  detect: () => Promise.resolve({ available: true }),
  buildInvocation: () => {
    throw new Error('boom')
  },
  parse: () => ({ status: 'error', text: '' }),
}

function agent(agentId: string, mode: MockMode = 'ok', over: Partial<PanelAgent> = {}): PanelAgent {
  return {
    agentId,
    adapter: createMockAdapter({ mode, slowMs: 30 }),
    timeoutMs: 2000,
    maxRetries: 0,
    ...over,
  }
}

describe('Engine.dispatchRound', () => {
  let store: EngineStore
  let dir: string
  let engine: Engine

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-eng-'))
    store = new EngineStore({ dbPath: join(dir, 'db.sqlite'), rawDir: join(dir, 'raw') })
    engine = new Engine({ store, sleep: () => Promise.resolve() })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs every agent and computes a met verdict, persisting the round', async () => {
    const run = engine.createRun('quick')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'quick', quorum: 2, agents: [agent('a'), agent('b')] },
      'hello',
    )
    expect(round.state).toBe('complete')
    expect(round.verdict).toBe('met')
    expect(round.invocations.map((i) => i.status).sort()).toEqual(['ok', 'ok'])
    expect(round.invocations.find((i) => i.agentId === 'a')?.distilled).toBe('ok:hello')
    expect(round.invocations[0]?.rawRef).toBeTruthy()
    expect(store.getRound(round.roundId)?.verdict).toBe('met')
  })

  it('honors a caller-provided roundId (async daemon tracking)', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a')] },
      'x',
      { roundId: 'fixed-round-id' },
    )
    expect(round.roundId).toBe('fixed-round-id')
    expect(store.getRound('fixed-round-id')?.verdict).toBe('met')
  })

  it('abandons a run with a durable run-abandoned event', () => {
    const run = engine.createRun('p')
    engine.abandonRun(run.runId)
    expect(store.getRun(run.runId)?.state).toBe('abandoned')
    const types = store.readEvents().events.map((e) => JSON.parse(e.payload).type)
    expect(types).toContain('run-abandoned')
  })

  it('redacts secrets from distilled text and raw blobs before persisting (D10)', async () => {
    const run = engine.createRun('p')
    const secret = `sk-ant-${'A'.repeat(24)}`
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a')] },
      `my key is ${secret}`,
    )
    const inv = round.invocations[0]
    expect(inv?.distilled).toContain('[REDACTED]')
    expect(inv?.distilled).not.toContain(secret)
    const raw = store.readRaw(inv?.rawRef as string)
    expect(raw.chunk).not.toContain(secret)
    expect(raw.chunk).toContain('[REDACTED]')
    // The persisted/served prompt is redacted too (agents got the original).
    expect(round.prompt).toContain('[REDACTED]')
    expect(round.prompt).not.toContain(secret)
    expect(store.getRound(round.roundId)?.prompt).not.toContain(secret)
  })

  it('records its process group in the orphan registry and clears it on completion', async () => {
    const eng = new Engine({ store, daemonId: 'd1', sleep: () => Promise.resolve() })
    const recordSpy = vi.spyOn(store, 'recordPgid')
    const run = eng.createRun('p')
    await eng.dispatchRound(run, { panelId: 'p', quorum: 1, agents: [agent('a')] }, 'x')
    expect(recordSpy).toHaveBeenCalled()
    // Removed on completion -> nothing for a later daemon instance to sweep.
    expect(store.foreignPgids('d2')).toEqual([])
  })

  it('retries under backoff with a live (un-aborted) signal threaded through', async () => {
    const controller = new AbortController()
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a', 'error', { maxRetries: 1 })] },
      'x',
      { signal: controller.signal },
    )
    expect(round.invocations[0]).toMatchObject({ status: 'error', attempts: 2 })
  })

  it('wakes from retry backoff the moment the round is aborted', async () => {
    const controller = new AbortController()
    // The injected backoff aborts the round, so the next attempt short-circuits.
    const eng = new Engine({
      store,
      sleep: () => {
        controller.abort()
        return Promise.resolve()
      },
    })
    const run = eng.createRun('p')
    const round = await eng.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a', 'error', { maxRetries: 3 })] },
      'x',
      { signal: controller.signal },
    )
    expect(round.invocations[0]?.attempts).toBeLessThan(4)
    expect(round.invocations[0]?.status).toBe('cancelled')
  })

  it('isolates failures and yields a degraded verdict', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 2, agents: [agent('a', 'ok'), agent('b', 'error')] },
      'x',
    )
    expect(round.verdict).toBe('degraded')
    expect(round.invocations.find((i) => i.agentId === 'b')?.status).toBe('error')
    expect(round.invocations.find((i) => i.agentId === 'a')?.status).toBe('ok')
  })

  it('classifies a timeout and yields a failed verdict', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a', 'timeout', { timeoutMs: 150 })] },
      'x',
    )
    expect(round.verdict).toBe('failed')
    expect(round.invocations[0]).toMatchObject({ status: 'timeout', errorClass: 'timeout' })
  })

  it('retries transient failures up to maxRetries', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a', 'error', { maxRetries: 2 })] },
      'x',
    )
    expect(round.invocations[0]?.status).toBe('error')
    expect(round.invocations[0]?.attempts).toBe(3)
  })

  it('does not retry a refusal', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a', 'refusal', { maxRetries: 3 })] },
      'x',
    )
    expect(round.invocations[0]).toMatchObject({ status: 'refusal', attempts: 1 })
  })

  it('emits the lifecycle events', async () => {
    const run = engine.createRun('p')
    const types: string[] = []
    engine.events.on((e) => types.push(e.type))
    await engine.dispatchRound(run, { panelId: 'p', quorum: 1, agents: [agent('a')] }, 'x')
    expect(types).toEqual(
      expect.arrayContaining([
        'round-started',
        'invocation-started',
        'invocation-finished',
        'round-completed',
      ]),
    )
  })

  it('tracks round index across multiple rounds of a run', async () => {
    const run = engine.createRun('p')
    const panel = { panelId: 'p', quorum: 1, agents: [agent('a')] }
    const r0 = await engine.dispatchRound(run, panel, 'one')
    const r1 = await engine.dispatchRound(run, panel, 'two')
    expect([r0.index, r1.index]).toEqual([0, 1])
    expect(store.countRounds(run.runId)).toBe(2)
  })

  it('maps a missing binary to unavailable', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      {
        panelId: 'p',
        quorum: 1,
        agents: [{ agentId: 'x', adapter: brokenAdapter, timeoutMs: 1000, maxRetries: 0 }],
      },
      'x',
    )
    expect(round.invocations[0]?.status).toBe('unavailable')
    expect(round.verdict).toBe('failed')
  })

  it('maps an output flood to an error (overflow)', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      {
        panelId: 'p',
        quorum: 1,
        agents: [{ agentId: 'f', adapter: floodAdapter, timeoutMs: 3000, maxRetries: 0 }],
      },
      'x',
    )
    expect(round.invocations[0]?.status).toBe('error')
  })

  it('classifies cancelled when the dispatch signal is aborted', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      { panelId: 'p', quorum: 1, agents: [agent('a', 'slow')] },
      'x',
      { signal: AbortSignal.abort() },
    )
    expect(round.invocations[0]?.status).toBe('cancelled')
    expect(round.verdict).toBe('failed')
  })

  it('isolates an adapter that throws (failure isolation)', async () => {
    const run = engine.createRun('p')
    const round = await engine.dispatchRound(
      run,
      {
        panelId: 'p',
        quorum: 1,
        agents: [{ agentId: 't', adapter: throwingAdapter, timeoutMs: 1000, maxRetries: 0 }],
      },
      'x',
    )
    expect(round.invocations[0]?.status).toBe('error')
    expect(round.invocations[0]?.errorClass).toContain('engine-error')
    expect(round.verdict).toBe('failed')
  })

  it('bounds engine-global concurrency across different tools (waiters queue)', async () => {
    const limited = new Engine({ store, sleep: () => Promise.resolve(), concurrency: 1 })
    const a: PanelAgent = {
      agentId: 'a',
      adapter: { ...createMockAdapter({ mode: 'ok' }), id: 'mock-a' },
      timeoutMs: 2000,
      maxRetries: 0,
    }
    const b: PanelAgent = {
      agentId: 'b',
      adapter: { ...createMockAdapter({ mode: 'ok' }), id: 'mock-b' },
      timeoutMs: 2000,
      maxRetries: 0,
    }
    const run = limited.createRun('p')
    const round = await limited.dispatchRound(
      run,
      { panelId: 'p', quorum: 2, concurrency: 1, agents: [a, b] },
      'hi',
    )
    expect(round.verdict).toBe('met')
    expect(round.invocations).toHaveLength(2)
  })

  it('reconciles a crashed in-flight round on store reopen', async () => {
    // Simulate a crash mid-dispatch: pending rows exist, round is 'running'.
    const run = engine.createRun('p')
    const roundId = '00000000-0000-0000-0000-000000000001'
    store.startRound({
      roundId,
      runId: run.runId,
      index: 0,
      prompt: 'x',
      quorum: 1,
      state: 'running',
    })
    store.upsertInvocation(roundId, {
      agentId: 'a',
      status: 'running',
      attempts: 1,
      distilled: '',
      durationMs: 0,
      truncated: false,
    })
    expect(engine.reconcile().repairedRounds).toContain(roundId)
    const repaired = store.getRound(roundId)
    expect(repaired?.state).toBe('complete')
    expect(repaired?.invocations[0]?.status).toBe('interrupted')
  })
})
