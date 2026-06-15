import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InvocationRecord, RunRecord } from './model'
import { EngineStore } from './store'

const run = (runId = 'run1'): RunRecord => ({
  runId,
  panelId: 'p',
  state: 'running',
  createdAt: 1,
})

const startRound = (store: EngineStore, quorum = 1, roundId = 'rd1') =>
  store.startRound({ roundId, runId: 'run1', index: 0, prompt: 'hi', quorum, state: 'running' })

const okInv = (agentId: string, over: Partial<InvocationRecord> = {}): InvocationRecord => ({
  agentId,
  status: 'ok',
  attempts: 1,
  distilled: 'ans',
  durationMs: 5,
  truncated: false,
  ...over,
})

describe('EngineStore', () => {
  let store: EngineStore
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-store-'))
    store = new EngineStore({ dbPath: ':memory:', rawDir: join(dir, 'raw') })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists a run/round/invocation and reads them back', () => {
    store.createRun(run())
    startRound(store)
    store.upsertInvocation('rd1', okInv('a', { rawRef: 'run1.rd1.a.1' }))
    store.completeRound('rd1', 'met')

    const round = store.getRound('rd1')
    expect(round).toMatchObject({ state: 'complete', verdict: 'met', quorum: 1, index: 0 })
    expect(round?.invocations[0]).toMatchObject({ agentId: 'a', status: 'ok', distilled: 'ans' })
    expect(store.getRun('run1')?.panelId).toBe('p')
    expect(store.countRounds('run1')).toBe(1)
  })

  it('upserts an invocation (later attempt overwrites)', () => {
    store.createRun(run())
    startRound(store)
    store.upsertInvocation('rd1', okInv('a', { status: 'error', distilled: '' }))
    store.upsertInvocation('rd1', okInv('a', { status: 'ok', attempts: 2, distilled: 'x' }))
    expect(store.getRound('rd1')?.invocations[0]).toMatchObject({ status: 'ok', attempts: 2 })
  })

  it('writes and paginates raw blobs', () => {
    store.writeRaw('ref1', Buffer.from('0123456789'))
    expect(store.readRaw('ref1', 0, 4)).toEqual({ chunk: '0123', nextCursor: 4, eof: false })
    expect(store.readRaw('ref1', 4, 100)).toEqual({ chunk: '456789', nextCursor: 10, eof: true })
    expect(store.readRaw('missing')).toEqual({ chunk: '', nextCursor: 0, eof: true })
  })

  it('paginates raw without splitting a multi-byte UTF-8 codepoint', () => {
    // 'aé' is bytes [0x61, 0xC3, 0xA9]; a page ending at byte 2 would cut 'é'.
    store.writeRaw('u', Buffer.from('aé', 'utf8'))
    const whole = store.readRaw('u', 0, 2)
    expect(whole.chunk).toBe('aé') // boundary-safe: pulled the whole codepoint
    expect(whole.eof).toBe(true)
    // A clean split at a lead-byte boundary pages without corruption.
    const a = store.readRaw('u', 0, 1)
    expect(a).toMatchObject({ chunk: 'a', eof: false })
    expect(store.readRaw('u', a.nextCursor, 10)).toMatchObject({ chunk: 'é', eof: true })
  })

  it('lists runs, optionally filtered by state', () => {
    store.createRun(run('a'))
    store.createRun({ ...run('b'), state: 'abandoned' })
    expect(
      store
        .listRuns()
        .map((r) => r.runId)
        .sort(),
    ).toEqual(['a', 'b'])
    expect(store.listRuns('abandoned').map((r) => r.runId)).toEqual(['b'])
  })

  it('reconciles running invocations to interrupted and recomputes verdicts', () => {
    store.createRun(run())
    startRound(store, 2)
    store.upsertInvocation('rd1', okInv('a'))
    store.upsertInvocation('rd1', okInv('b', { status: 'running', distilled: '', durationMs: 0 }))

    expect(store.reconcile()).toEqual({ repairedRounds: ['rd1'] })
    const round = store.getRound('rd1')
    expect(round?.state).toBe('complete')
    expect(round?.verdict).toBe('degraded') // 1 ok < quorum 2
    expect(round?.invocations.find((i) => i.agentId === 'b')?.status).toBe('interrupted')

    // The repair is recorded in the durable log (terminal transition for the
    // interrupted agent + the round verdict), so an SSE replay stays consistent.
    const { events, hasMore } = store.readEvents()
    const types = events.map((e) => JSON.parse(e.payload).type)
    expect(hasMore).toBe(false)
    expect(types).toContain('invocation-finished')
    expect(types).toContain('round-completed')
  })

  it('paginates events with a hasMore flag', () => {
    for (let i = 0; i < 5; i++) store.appendEvent('run1', `{"type":"e${i}"}`)
    const page1 = store.readEvents(0, 2)
    expect(page1.events).toHaveLength(2)
    expect(page1.hasMore).toBe(true)
    const last = page1.events[1]?.seq ?? 0
    const page2 = store.readEvents(last, 100)
    expect(page2.hasMore).toBe(false)
  })

  it('prunes a run with its rounds, invocations, and raw blobs', () => {
    store.createRun(run())
    startRound(store)
    store.writeRaw('run1.rd1.a.1', Buffer.from('raw output'))
    store.upsertInvocation('rd1', okInv('a', { rawRef: 'run1.rd1.a.1' }))

    store.pruneRun('run1')
    expect(store.getRun('run1')).toBeUndefined()
    expect(store.getRound('rd1')).toBeUndefined()
    expect(store.readRaw('run1.rd1.a.1').eof).toBe(true)
  })

  it('reports the latest event seq and the latest round', () => {
    store.createRun(run())
    expect(store.latestSeq('run1')).toBe(0) // no events yet
    expect(store.latestRound('run1')).toBeUndefined()
    store.appendEvent('run1', '{"type":"x"}')
    const last = store.appendEvent('run1', '{"type":"y"}')
    expect(store.latestSeq('run1')).toBe(last)
    expect(store.latestSeq('missing')).toBe(0)

    startRound(store, 1, 'rd0')
    store.startRound({
      roundId: 'rd1',
      runId: 'run1',
      index: 1,
      prompt: 'p',
      quorum: 1,
      state: 'running',
    })
    expect(store.latestRound('run1')?.roundId).toBe('rd1')
    expect(store.latestRound('missing')).toBeUndefined()
  })

  it('records idempotency keys, dedups replays, and prunes them with the run', () => {
    store.createRun(run())
    startRound(store)
    expect(store.getIdempotent('k1')).toBeUndefined()
    store.recordIdempotent('k1', 'run1', 'rd1')
    store.recordIdempotent('k1', 'run1', 'other') // first writer wins
    expect(store.getIdempotent('k1')).toEqual({ runId: 'run1', roundId: 'rd1' })
    // FK ON DELETE CASCADE: pruning the run drops its idempotency rows too (D16).
    store.pruneRun('run1')
    expect(store.getIdempotent('k1')).toBeUndefined()
  })

  it('migrates an older database forward to the current schema on reopen', () => {
    const dbPath = join(dir, 'older.sqlite')
    const s1 = new EngineStore({ dbPath, rawDir: join(dir, 'rawo') })
    s1.createRun(run('r'))
    s1.recordIdempotent('k', 'r', 'rd') // requires the v3 idempotency table
    s1.close()
    const s2 = new EngineStore({ dbPath, rawDir: join(dir, 'rawo') })
    expect(s2.getIdempotent('k')).toEqual({ runId: 'r', roundId: 'rd' })
    s2.close()
  })

  it('appends events with a monotonic sequence', () => {
    const s1 = store.appendEvent('run1', '{"type":"x"}')
    expect(store.appendEvent('run1', '{"type":"y"}')).toBe(s1 + 1)
  })

  it('updates a run state (used by the reaper)', () => {
    store.createRun(run())
    store.setRunState('run1', 'abandoned')
    expect(store.getRun('run1')?.state).toBe('abandoned')
  })

  it('reopens an on-disk database without re-migrating', () => {
    const dbPath = join(dir, 'persist.sqlite')
    const s1 = new EngineStore({ dbPath, rawDir: join(dir, 'raw2') })
    s1.createRun(run('persisted'))
    s1.close()
    const s2 = new EngineStore({ dbPath, rawDir: join(dir, 'raw2') })
    expect(s2.getRun('persisted')?.runId).toBe('persisted')
    s2.close()
  })

  it('tracks the orphan pgid registry scoped by daemon instance', () => {
    store.recordPgid(111, 'daemon-a')
    store.recordPgid(222, 'daemon-a')
    store.recordPgid(333, 'daemon-b')
    // From daemon-b's view, daemon-a's groups are the foreign (sweepable) ones.
    expect(store.foreignPgids('daemon-b').sort()).toEqual([111, 222])
    store.removePgid(111)
    expect(store.foreignPgids('daemon-b')).toEqual([222])
    store.clearForeignPgids('daemon-b')
    expect(store.foreignPgids('daemon-b')).toEqual([])
    expect(store.foreignPgids('daemon-a')).toEqual([333]) // daemon-b's own survived
  })

  it('migrates a v1 database to v2 (adds the pgids table) on reopen', () => {
    const dbPath = join(dir, 'v1.sqlite')
    const s1 = new EngineStore({ dbPath, rawDir: join(dir, 'rawv') })
    s1.recordPgid(7, 'd') // works -> the pgids table exists after migration
    s1.close()
    const s2 = new EngineStore({ dbPath, rawDir: join(dir, 'rawv') })
    expect(s2.foreignPgids('other')).toEqual([7])
    s2.close()
  })
})
