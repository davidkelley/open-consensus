import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockAdapter } from '@open-consensus/adapters'
import { type Config, parseConfig } from '@open-consensus/config'
import { type EngineEvent, EngineStore } from '@open-consensus/engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonCore } from './daemon'
import type { AdapterRegistry } from './resolver'

const registry: AdapterRegistry = new Map([['mock', createMockAdapter({ slowMs: 2000 })]])

const config: Config = parseConfig({
  schemaVersion: 1,
  agents: [
    { id: 'a-ok', name: 'OK', adapter: 'mock', model: 'mock:ok', maxRetries: 0 },
    { id: 'a-slow', name: 'Slow', adapter: 'mock', model: 'mock:slow', maxRetries: 0 },
    { id: 'a-ghost', name: 'Ghost', adapter: 'ghost', maxRetries: 0 },
  ],
  panels: [
    { id: 'p-ok', name: 'OK panel', agentIds: ['a-ok'], quorum: 1 },
    { id: 'p-slow', name: 'Slow panel', agentIds: ['a-slow'], quorum: 1 },
    { id: 'p-empty', name: 'Empty', agentIds: ['a-ghost'], quorum: 1 },
  ],
})

function makeCore(opts: { now?: () => number; idleTtlMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-daemon-'))
  const store = new EngineStore({ dbPath: ':memory:', rawDir: join(dir, 'raw') })
  const core = new DaemonCore({
    store,
    config,
    adapters: registry,
    maxWaitMs: 5000,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
  })
  return { core, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Assert a value is defined (waitRound returns undefined only for a bad round). */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a defined snapshot')
  return value
}

describe('DaemonCore runs', () => {
  let h: ReturnType<typeof makeCore>
  beforeEach(() => {
    h = makeCore()
  })
  afterEach(async () => {
    await h.core.drain()
    h.store.close()
    h.cleanup()
  })

  it('starts a run, polls it to a terminal verdict', async () => {
    const started = h.core.startRun('p-ok', 'review this')
    expect('runId' in started).toBe(true)
    if (!('runId' in started)) return
    const snap = must(await h.core.waitRound(started.runId, started.roundId, 5000))
    expect(snap.done).toBe(true)
    expect(snap.round?.verdict).toBe('met')
    expect(snap.round?.invocations[0]).toMatchObject({ agentId: 'a-ok', status: 'ok' })
    expect(snap.stateVersion).toBeGreaterThan(0)
  })

  it('returns undefined for an unknown round or a run/round mismatch', async () => {
    const started = h.core.startRun('p-ok', 'x')
    if (!('runId' in started)) throw new Error('start failed')
    await h.core.drain()
    expect(await h.core.waitRound(started.runId, 'no-such-round')).toBeUndefined()
    // Right round, wrong run — must not leak the round under the wrong owner.
    expect(await h.core.waitRound('some-other-run', started.roundId)).toBeUndefined()
  })

  it('rejects an unknown panel and a panel with no resolvable agents', () => {
    expect(h.core.startRun('nope', 'x')).toEqual({ error: "unknown panel 'nope'" })
    expect(h.core.startRun('p-empty', 'x')).toEqual({
      error: "panel 'p-empty' has no resolvable agents",
    })
  })

  it('adds a round to an existing run', async () => {
    const started = h.core.startRun('p-ok', 'round one')
    if (!('runId' in started)) throw new Error('start failed')
    await h.core.waitRound(started.runId, started.roundId, 5000)
    const next = h.core.startRound(started.runId, 'round two')
    expect('roundId' in next).toBe(true)
    if (!('roundId' in next)) return
    const snap = must(await h.core.waitRound(started.runId, next.roundId, 5000))
    expect(snap.done).toBe(true)
    expect(snap.round?.index).toBe(1)
  })

  it('rejects a round on an unknown or non-running run', () => {
    expect(h.core.startRound('missing', 'x')).toEqual({ error: "unknown run 'missing'" })
    const started = h.core.startRun('p-ok', 'x')
    if (!('runId' in started)) throw new Error('start failed')
    h.core.engine.abandonRun(started.runId)
    expect(h.core.startRound(started.runId, 'y')).toEqual({
      error: `run '${started.runId}' is abandoned`,
    })
  })

  it('returns a status snapshot and 404s an unknown run', async () => {
    const started = h.core.startRun('p-ok', 'x')
    if (!('runId' in started)) throw new Error('start failed')
    await h.core.waitRound(started.runId, started.roundId, 5000)
    const status = h.core.status(started.runId)
    expect(status?.run.runId).toBe(started.runId)
    expect(status?.round?.roundId).toBe(started.roundId)
    expect(h.core.status('ghost')).toBeUndefined()
  })

  it('polling a round that is not in-flight returns its current snapshot', async () => {
    const started = h.core.startRun('p-ok', 'x')
    if (!('runId' in started)) throw new Error('start failed')
    await h.core.drain()
    const snap = must(await h.core.waitRound(started.runId, started.roundId))
    expect(snap.done).toBe(true)
  })

  it('lists panels and runs', async () => {
    expect(h.core.listPanels().map((p) => p.id)).toEqual(['p-ok', 'p-slow', 'p-empty'])
    const started = h.core.startRun('p-ok', 'x')
    if (!('runId' in started)) throw new Error('start failed')
    await h.core.drain()
    expect(h.core.listRuns().map((r) => r.runId)).toContain(started.runId)
    expect(h.core.listRuns('running').length).toBeGreaterThan(0)
  })

  it('reads raw output by ref', async () => {
    const started = h.core.startRun('p-ok', 'hello')
    if (!('runId' in started)) throw new Error('start failed')
    const snap = must(await h.core.waitRound(started.runId, started.roundId, 5000))
    const ref = snap.round?.invocations[0]?.rawRef
    expect(ref).toBeDefined()
    const raw = h.core.readRaw(ref as string)
    expect(raw.chunk).toContain('hello')
  })
})

describe('DaemonCore cancellation', () => {
  let h: ReturnType<typeof makeCore>
  beforeEach(() => {
    h = makeCore()
  })
  afterEach(async () => {
    await h.core.drain()
    h.store.close()
    h.cleanup()
  })

  it('cancels an in-flight run, tree-killing its agents', async () => {
    const started = h.core.startRun('p-slow', 'long task')
    if (!('runId' in started)) throw new Error('start failed')
    expect(h.core.cancelRun(started.runId)).toEqual({ cancelled: 1 })
    const snap = must(await h.core.waitRound(started.runId, started.roundId, 5000))
    expect(snap.round?.invocations[0]?.status).toBe('cancelled')
    expect(snap.round?.verdict).toBe('failed')
  })

  it('cancels a round only for its owner and reports a miss otherwise', async () => {
    const started = h.core.startRun('p-slow', 'long')
    if (!('runId' in started)) throw new Error('start failed')
    // A different run id must not cancel another run's round.
    expect(h.core.cancelRound('other-run', started.roundId)).toEqual({ cancelled: false })
    expect(h.core.cancelRound(started.runId, started.roundId)).toEqual({ cancelled: true })
    expect(h.core.cancelRound(started.runId, 'no-such-round')).toEqual({ cancelled: false })
    await h.core.drain()
  })
})

describe('DaemonCore events + idle reaper', () => {
  it('streams live events and backfills from the log', async () => {
    const h = makeCore()
    const seen: EngineEvent[] = []
    const unsubscribe = h.core.subscribe((event) => seen.push(event))
    const started = h.core.startRun('p-ok', 'x')
    if (!('runId' in started)) throw new Error('start failed')
    await h.core.waitRound(started.runId, started.roundId, 5000)
    unsubscribe()
    expect(seen.map((e) => e.type)).toContain('run-created')
    expect(seen.map((e) => e.type)).toContain('round-completed')
    const { events } = h.core.backfill(0)
    expect(events.length).toBeGreaterThan(0)
    h.store.close()
    h.cleanup()
  })

  it('parks an idle run past its TTL but never an in-flight one', async () => {
    let clock = 1_000_000
    const h = makeCore({ now: () => clock, idleTtlMs: 0 /* floored to the minimum */ })

    // An in-flight (slow) run is never reaped, even far in the future.
    const slow = h.core.startRun('p-slow', 'long')
    if (!('runId' in slow)) throw new Error('start failed')
    clock += 10_000_000
    expect(h.core.reapIdle()).not.toContain(slow.runId)
    h.core.cancelRun(slow.runId)
    await h.core.drain()

    // A finished, untouched run is parked once its TTL elapses.
    const done = h.core.startRun('p-ok', 'x')
    if (!('runId' in done)) throw new Error('start failed')
    await h.core.drain()
    h.core.touch(done.runId)
    const touchedAt = clock
    expect(h.core.reapIdle()).not.toContain(done.runId) // just touched
    clock = touchedAt + 70_000 // past the 60s floor
    expect(h.core.reapIdle()).toContain(done.runId)
    expect(h.core.getRun(done.runId)?.state).toBe('abandoned')

    h.store.close()
    h.cleanup()
  })

  it('sweeps process groups left by a prior daemon instance on startup', async () => {
    const terminated: number[] = []
    const dir = mkdtempSync(join(tmpdir(), 'oc-sweep-'))
    const store = new EngineStore({ dbPath: ':memory:', rawDir: join(dir, 'raw') })
    store.recordPgid(4242, 'old-daemon') // an orphan from a crashed instance
    store.recordPgid(9999, 'this-daemon') // our own — must NOT be swept
    const core = new DaemonCore({
      store,
      config,
      adapters: registry,
      daemonId: 'this-daemon',
      terminator: {
        terminate: (pid) => {
          terminated.push(pid)
          return Promise.resolve()
        },
      },
    })
    expect(await core.sweepOrphans()).toBe(1)
    expect(terminated).toEqual([4242])
    expect(store.foreignPgids('this-daemon')).toEqual([]) // cleared after sweeping
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('sweepOrphans is a no-op without a daemon id', async () => {
    const h = makeCore()
    expect(await h.core.sweepOrphans()).toBe(0)
    h.store.close()
    h.cleanup()
  })

  it('gives a never-before-seen run a fresh clock instead of parking it', async () => {
    let clock = 5_000_000
    const h = makeCore({ now: () => clock, idleTtlMs: 0 })
    // Create a run directly on the engine so DaemonCore has no lastTouched entry.
    const run = h.core.engine.createRun('p-ok')
    expect(h.core.reapIdle()).not.toContain(run.runId) // first sighting -> seeded
    clock += 70_000
    expect(h.core.reapIdle()).toContain(run.runId) // now past TTL
    h.store.close()
    h.cleanup()
  })
})
