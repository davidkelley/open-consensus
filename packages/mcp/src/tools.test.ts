import type { RoundSnapshot } from '@open-consensus/daemon'
import type { InvocationRecord, RoundRecord } from '@open-consensus/engine'
import { describe, expect, it } from 'vitest'
import type { DaemonClient } from './client'
import { TOOLS, shapeRound } from './tools'

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

const ctx = (client: Partial<DaemonClient>) => ({ client: client as DaemonClient })

const inv = (over: Partial<InvocationRecord> = {}): InvocationRecord => ({
  agentId: 'a',
  status: 'ok',
  attempts: 1,
  distilled: 'the answer',
  durationMs: 5,
  truncated: false,
  ...over,
})

const round = (over: Partial<RoundRecord> = {}): RoundRecord => ({
  roundId: 'rd',
  runId: 'run',
  index: 0,
  prompt: 'p',
  quorum: 1,
  state: 'complete',
  verdict: 'met',
  invocations: [inv({ rawRef: 'run.rd.a.1' })],
  ...over,
})

const snap = (over: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  round: round(),
  stateVersion: 3,
  done: true,
  ...over,
})

describe('shapeRound', () => {
  it('returns only status/attempts while running (tiny payload)', () => {
    const r = round({
      state: 'running',
      verdict: undefined,
      invocations: [inv({ status: 'running', distilled: '' })],
    })
    const shaped = shapeRound({ round: r, stateVersion: 1, done: false })
    expect(shaped.next_action).toBe('keep_polling')
    expect(shaped.done).toBe(false)
    const agents = shaped.agents as Record<string, unknown>[]
    expect(agents[0]).toEqual({ agentId: 'a', status: 'running', attempts: 1 })
    expect(agents[0]).not.toHaveProperty('distilled')
  })

  it('returns full distilled answers + review_results when met', () => {
    const shaped = shapeRound(snap())
    expect(shaped.next_action).toBe('review_results')
    expect(shaped.verdict).toBe('met')
    const agents = shaped.agents as Record<string, unknown>[]
    expect(agents[0]).toMatchObject({
      distilled: 'the answer',
      rawRef: 'run.rd.a.1',
      truncated: false,
    })
  })

  it('signals handle_degraded for a degraded/failed verdict', () => {
    expect(shapeRound(snap({ round: round({ verdict: 'degraded' }) })).next_action).toBe(
      'handle_degraded',
    )
    expect(shapeRound(snap({ round: round({ verdict: 'failed' }) })).next_action).toBe(
      'handle_degraded',
    )
  })

  it('flags truncation so a clipped tail is not misjudged', () => {
    const shaped = shapeRound(snap({ round: round({ invocations: [inv({ truncated: true })] }) }))
    expect(String(shaped.note)).toContain('consensus_get_raw')
  })

  it('handles a missing round (round not yet readable)', () => {
    expect(shapeRound({ round: undefined, stateVersion: 0, done: false })).toMatchObject({
      done: false,
      next_action: 'keep_polling',
    })
  })

  it('includes an agent error class without distilled while running', () => {
    const r = round({
      state: 'running',
      verdict: undefined,
      invocations: [inv({ status: 'error', errorClass: 'exit-1', distilled: '' })],
    })
    const agents = shapeRound({ round: r, stateVersion: 1, done: false }).agents as Record<
      string,
      unknown
    >[]
    expect(agents[0]).toEqual({ agentId: 'a', status: 'error', attempts: 1, errorClass: 'exit-1' })
  })
})

describe('tool handlers', () => {
  it('consensus_list_panels / list_runs forward to the client', async () => {
    const panels = [{ id: 'p', name: 'P', agentIds: ['a'], quorum: 1 }]
    expect(
      await tool('consensus_list_panels').handler(ctx({ listPanels: async () => panels }), {}),
    ).toEqual({
      panels,
    })
    const runs = [{ runId: 'r', panelId: 'p', state: 'running' as const, createdAt: 1 }]
    expect(
      await tool('consensus_list_runs').handler(ctx({ listRuns: async () => runs }), {
        state: 'running',
      }),
    ).toEqual({ runs })
  })

  it('consensus_start returns ids + keep_polling and threads the idempotency key', async () => {
    let seenKey: string | undefined
    const res = await tool('consensus_start').handler(
      ctx({
        startRun: async (_p, _prompt, key) => {
          seenKey = key
          return { runId: 'run', roundId: 'rd' }
        },
      }),
      { panel: 'p', prompt: 'go', idempotencyKey: 'k' },
    )
    expect(res).toEqual({ runId: 'run', roundId: 'rd', next_action: 'keep_polling' })
    expect(seenKey).toBe('k')
  })

  it('consensus_round returns the new round id', async () => {
    const res = await tool('consensus_round').handler(
      ctx({ startRound: async () => ({ roundId: 'rd2' }) }),
      { runId: 'run', prompt: 'next' },
    )
    expect(res).toEqual({ runId: 'run', roundId: 'rd2', next_action: 'keep_polling' })
  })

  it('consensus_poll shapes the snapshot and caps wait_ms', async () => {
    let seenWait: number | undefined
    const res = await tool('consensus_poll').handler(
      ctx({
        poll: async (_r, _rd, wait) => {
          seenWait = wait
          return snap()
        },
      }),
      { runId: 'run', roundId: 'rd', wait_ms: 999_999 },
    )
    expect((res as Record<string, unknown>).next_action).toBe('review_results')
    expect(seenWait).toBe(45_000) // clamped to the ceiling
  })

  it('consensus_poll returns a transient re-poll signal on a transport error', async () => {
    const res = (await tool('consensus_poll').handler(
      ctx({
        poll: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        },
      }),
      { runId: 'run', roundId: 'rd' },
    )) as Record<string, unknown>
    expect(res.transient).toBe(true)
    expect(res.next_action).toBe('keep_polling')
  })

  it('consensus_poll rethrows a non-transport error', async () => {
    await expect(
      tool('consensus_poll').handler(
        ctx({
          poll: async () => {
            throw new Error('unknown round')
          },
        }),
        { runId: 'run', roundId: 'rd' },
      ),
    ).rejects.toThrow('unknown round')
  })

  it('consensus_status shapes the latest round', async () => {
    const res = (await tool('consensus_status').handler(
      ctx({
        status: async () => ({
          run: { runId: 'run', panelId: 'p', state: 'running', createdAt: 1 },
          round: round(),
          stateVersion: 4,
        }),
      }),
      { runId: 'run' },
    )) as Record<string, unknown>
    expect((res.round as Record<string, unknown>).next_action).toBe('review_results')
    expect(res.stateVersion).toBe(4)
  })

  it('consensus_status with no round yet returns an undefined round', async () => {
    const res = (await tool('consensus_status').handler(
      ctx({
        status: async () => ({
          run: { runId: 'run', panelId: 'p', state: 'running', createdAt: 1 },
          round: undefined,
          stateVersion: 0,
        }),
      }),
      { runId: 'run' },
    )) as Record<string, unknown>
    expect(res.round).toBeUndefined()
  })

  it('consensus_cancel / cancel_agent / get_raw forward to the client', async () => {
    expect(
      await tool('consensus_cancel').handler(ctx({ cancelRun: async () => ({ cancelled: 2 }) }), {
        runId: 'r',
      }),
    ).toEqual({
      cancelled: 2,
    })
    // cancel_agent maps to round cancel in v1.
    let cancelledRound: [string, string] | undefined
    await tool('consensus_cancel_agent').handler(
      ctx({
        cancelRound: async (runId, roundId) => {
          cancelledRound = [runId, roundId]
          return { cancelled: true }
        },
      }),
      { runId: 'r', roundId: 'rd', agentId: 'a' },
    )
    expect(cancelledRound).toEqual(['r', 'rd'])
    expect(
      await tool('consensus_get_raw').handler(
        ctx({ getRaw: async () => ({ chunk: 'x', nextCursor: 1, eof: true }) }),
        { rawRef: 'ref' },
      ),
    ).toEqual({ chunk: 'x', nextCursor: 1, eof: true })
  })

  it('every tool description teaches the loop (non-empty, mentions the next tool)', () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(40)
    }
    // The start/poll docs explicitly chain to the next step.
    expect(tool('consensus_start').description).toContain('consensus_poll')
    expect(tool('consensus_poll').description.toLowerCase()).toContain('transient')
  })
})
