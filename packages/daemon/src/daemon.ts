import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Config } from '@open-consensus/config'
import {
  Engine,
  type EngineEventListener,
  type EngineStore,
  type Panel,
  type RoundRecord,
  type RunRecord,
  type RunState,
} from '@open-consensus/engine'
import { type ProcessTerminator, createProcessTerminator } from '@open-consensus/proc'
import { type AdapterRegistry, resolvePanel } from './resolver'

/** Long-poll ceiling (D4): a single poll never blocks longer than this. */
const DEFAULT_MAX_WAIT_MS = 50_000
/** Idle-reaper TTL floor (D14): a misconfig like `0` can't abandon everything. */
const MIN_IDLE_TTL_MS = 60_000

export interface DaemonCoreOptions {
  store: EngineStore
  config: Config
  adapters: AdapterRegistry
  /** Inject a pre-built engine (tests); otherwise one is created over the store. */
  engine?: Engine
  maxWaitMs?: number
  /** Idle-run TTL before auto-parking (clamped to the floor). */
  idleTtlMs?: number
  /** Injectable clock (the reaper; tests drive it). */
  now?: () => number
  /** This daemon instance's id — tags spawned children + their pgid registry rows
   * so a later instance can sweep this one's orphans (D10). */
  daemonId?: string
  /** Terminator for the startup orphan sweep (tests inject a fake). */
  terminator?: ProcessTerminator
}

/** An authoritative round snapshot (D11) — always complete, never a delta. */
export interface RoundSnapshot {
  round: RoundRecord | undefined
  /** Monotonic durable event seq; lets a poller detect change (D4). */
  stateVersion: number
  /** True once the round has reached a terminal verdict. */
  done: boolean
}

interface Inflight {
  runId: string
  promise: Promise<void>
  abort: AbortController
}

/**
 * The daemon's engine-facing core (plan D2/D4/D13/D14). Owns the async job model:
 * start a run/round in the background, hand back ids immediately, and let clients
 * long-poll a snapshot. Transport-free, so it is unit-testable without HTTP.
 */
export class DaemonCore {
  readonly engine: Engine
  private readonly store: EngineStore
  private readonly config: Config
  private readonly adapters: AdapterRegistry
  private readonly maxWaitMs: number
  private readonly idleTtlMs: number
  private readonly now: () => number
  private readonly daemonId: string | undefined
  private readonly terminator: ProcessTerminator
  private readonly inflight = new Map<string, Inflight>()
  /** Last time any run-scoped call touched a run (idle-reaper clock). */
  private readonly lastTouched = new Map<string, number>()

  constructor(opts: DaemonCoreOptions) {
    this.store = opts.store
    this.config = opts.config
    this.adapters = opts.adapters
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    this.idleTtlMs = Math.max(MIN_IDLE_TTL_MS, opts.idleTtlMs ?? 15 * MIN_IDLE_TTL_MS)
    this.now = opts.now ?? (() => Date.now())
    this.daemonId = opts.daemonId
    this.terminator = opts.terminator ?? createProcessTerminator()
    this.engine =
      opts.engine ??
      new Engine({ store: opts.store, ...(opts.daemonId ? { daemonId: opts.daemonId } : {}) })
  }

  /** Crash recovery — the daemon MUST call this once before serving (D15). */
  reconcile(): { repairedRounds: string[] } {
    return this.engine.reconcile()
  }

  /**
   * Scoped orphan sweep (D10/D15): tree-kill any process group recorded by a
   * PRIOR daemon instance that survived a crash, then clear those registry rows.
   * Runs at startup BEFORE serving. A no-op without a daemonId. Returns the count
   * of groups swept. The detached-group design accepts the (rare) pgid-reuse race.
   */
  async sweepOrphans(): Promise<number> {
    if (this.daemonId === undefined) return 0
    const pgids = this.store.foreignPgids(this.daemonId)
    await Promise.all(pgids.map((pgid) => this.terminator.terminate(pgid).catch(() => {})))
    this.store.clearForeignPgids(this.daemonId)
    return pgids.length
  }

  // -- panels / runs (reads) ---------------------------------------------

  listPanels(): { id: string; name: string; agentIds: string[]; quorum: number }[] {
    return this.config.panels.map((p) => ({
      id: p.id,
      name: p.name,
      agentIds: p.agentIds,
      quorum: p.quorum,
    }))
  }

  listRuns(state?: RunState): RunRecord[] {
    return this.store.listRuns(state)
  }

  getRun(runId: string): RunRecord | undefined {
    return this.store.getRun(runId)
  }

  readRaw(ref: string, cursor?: number, maxBytes?: number) {
    // A rawRef is `runId.roundId.agentId.attempt`; touching the run resets its
    // idle TTL so `consensus_get_raw` counts as activity (D12).
    const runId = ref.split('.')[0]
    if (runId) this.touch(runId)
    return this.store.readRaw(ref, cursor, maxBytes)
  }

  /** Run state + its most recent round snapshot (D12 `consensus_status`). */
  status(
    runId: string,
  ): { run: RunRecord; round: RoundRecord | undefined; stateVersion: number } | undefined {
    const run = this.store.getRun(runId)
    if (!run) return undefined
    this.touch(runId)
    return {
      run,
      round: this.store.latestRound(runId),
      stateVersion: this.store.latestSeq(runId),
    }
  }

  // -- start work --------------------------------------------------------

  startRun(
    panelId: string,
    prompt: string,
    idempotencyKey?: string,
  ): { runId: string; roundId: string } | { error: string } {
    // Idempotency lookup FIRST (D12): a replay returns the original result even if
    // the panel was reconfigured since — the original call already succeeded.
    // Scoped to (panel, key) so the same key for a different panel can't return an
    // unrelated run; the FK guarantees the mapping still references a live run.
    const key = idempotencyKey ? `start:${panelId}:${idempotencyKey}` : undefined
    if (key) {
      const existing = this.store.getIdempotent(key)
      if (existing) {
        this.touch(existing.runId)
        return existing
      }
    }
    const panel = resolvePanel(this.config, this.adapters, panelId)
    if (!panel) return { error: `unknown panel '${panelId}'` }
    if (panel.agents.length === 0) return { error: `panel '${panelId}' has no resolvable agents` }
    if (key) {
      // Reserve the key ATOMICALLY with the run row (engine creates both in one
      // transaction). The roundId is pre-generated so it goes into that mapping.
      const roundId = randomUUID()
      const run = this.engine.createRun(panelId, { idempotency: { key, roundId } })
      this.beginRound(run, panel, prompt, roundId)
      return { runId: run.runId, roundId }
    }
    const run = this.engine.createRun(panelId)
    const roundId = this.beginRound(run, panel, prompt)
    return { runId: run.runId, roundId }
  }

  startRound(
    runId: string,
    prompt: string,
    idempotencyKey?: string,
  ): { roundId: string } | { error: string } {
    const run = this.store.getRun(runId)
    if (!run) return { error: `unknown run '${runId}'` }
    // Idempotency lookup before the run-state check (D12): a replay returns the
    // original round even if the run has since been parked. Scoped to (runId, key)
    // — the runId is in the storage key, so it can never collide with a start key.
    const key = idempotencyKey ? `round:${runId}:${idempotencyKey}` : undefined
    if (key) {
      const existing = this.store.getIdempotent(key)
      if (existing) {
        this.touch(runId)
        return { roundId: existing.roundId }
      }
    }
    if (run.state !== 'running') return { error: `run '${runId}' is ${run.state}` }
    const panel = resolvePanel(this.config, this.adapters, run.panelId)
    if (!panel) return { error: `panel '${run.panelId}' is no longer resolvable` }
    const roundId = this.beginRound(run, panel, prompt)
    if (key) this.store.reserveIdempotent(key, runId, roundId)
    return { roundId }
  }

  /** Dispatch a round in the background; track it so callers can poll/cancel. */
  private beginRound(run: RunRecord, panel: Panel, prompt: string, roundId = randomUUID()): string {
    const abort = new AbortController()
    const promise = this.engine
      .dispatchRound(run, panel, prompt, { signal: abort.signal, roundId })
      .then(
        () => {},
        () => {},
      )
      .finally(() => this.inflight.delete(roundId))
    this.inflight.set(roundId, { runId: run.runId, promise, abort })
    this.touch(run.runId)
    return roundId
  }

  // -- poll --------------------------------------------------------------

  /**
   * Snapshot long-poll (D4): resolves the instant the round goes terminal, else
   * after `waitMs` (capped to the daemon ceiling). Idempotent and safe to repeat.
   * Returns `undefined` when the round does not exist or does not belong to
   * `runId` (the server maps that to 404, so a bad id can't drive a busy-wait
   * loop). A terminal round not in-flight returns its snapshot immediately.
   */
  async waitRound(
    runId: string,
    roundId: string,
    waitMs?: number,
  ): Promise<RoundSnapshot | undefined> {
    const existing = this.store.getRound(roundId)
    if (!existing || existing.runId !== runId) return undefined
    this.touch(runId)
    const inflight = this.inflight.get(roundId)
    if (inflight) {
      const ms = Math.min(waitMs ?? this.maxWaitMs, this.maxWaitMs)
      const timer = new AbortController()
      await Promise.race([
        inflight.promise,
        delay(ms, undefined, { signal: timer.signal }).catch(() => {}),
      ])
      timer.abort() // free the timer if the round finished first
    }
    return this.snapshot(runId, roundId)
  }

  snapshot(runId: string, roundId: string): RoundSnapshot {
    const round = this.store.getRound(roundId)
    return {
      round,
      stateVersion: this.store.latestSeq(runId),
      done: round?.state === 'complete',
    }
  }

  // -- cancellation ------------------------------------------------------

  /** Cancel every in-flight round of a run (tree-kills their children) (D19). */
  cancelRun(runId: string): { cancelled: number } {
    this.touch(runId) // cancellation is activity — don't let the reaper race it
    let cancelled = 0
    for (const inflight of this.inflight.values()) {
      if (inflight.runId === runId) {
        inflight.abort.abort()
        cancelled++
      }
    }
    return { cancelled }
  }

  /** Cancel a single in-flight round — only if it belongs to `runId` (so a
   * known round id can't be cancelled from another run's path). */
  cancelRound(runId: string, roundId: string): { cancelled: boolean } {
    const inflight = this.inflight.get(roundId)
    if (!inflight || inflight.runId !== runId) return { cancelled: false }
    this.touch(runId)
    inflight.abort.abort()
    return { cancelled: true }
  }

  // -- SSE plumbing ------------------------------------------------------

  /** Subscribe to live engine events (the server's SSE tail). */
  subscribe(listener: EngineEventListener): () => void {
    return this.engine.events.on(listener)
  }

  /** Durable events after `sinceSeq` for SSE `Last-Event-ID` backfill (D11). */
  backfill(sinceSeq: number, limit?: number) {
    return this.store.readEvents(sinceSeq, limit)
  }

  // -- idle reaper (D14) -------------------------------------------------

  /** Mark a run touched (resets its idle-reaper clock). */
  touch(runId: string): void {
    this.lastTouched.set(runId, this.now())
  }

  /** Whether a run currently has an in-flight round. */
  private hasInflight(runId: string): boolean {
    for (const inflight of this.inflight.values()) {
      if (inflight.runId === runId) return true
    }
    return false
  }

  /**
   * Auto-park runs no orchestrator is polling and that have no in-flight round
   * (D14). A run with a live round is never reaped (its clock is reset); a run
   * unseen since before its TTL is parked. Returns the parked run ids.
   */
  reapIdle(): string[] {
    const now = this.now()
    const parked: string[] = []
    const running = new Set<string>()
    for (const run of this.store.listRuns('running')) {
      running.add(run.runId)
      if (this.hasInflight(run.runId)) {
        this.lastTouched.set(run.runId, now) // active -> reset clock
        continue
      }
      const seen = this.lastTouched.get(run.runId)
      if (seen === undefined) {
        // First sighting (e.g. just after a restart) — start its clock fresh.
        this.lastTouched.set(run.runId, now)
        continue
      }
      if (now - seen >= this.idleTtlMs) {
        this.engine.abandonRun(run.runId)
        this.lastTouched.delete(run.runId)
        parked.push(run.runId)
      }
    }
    // Bound the map: drop clocks for runs no longer in the running set (parked
    // elsewhere, or pruned), so a long-lived daemon never accumulates entries.
    for (const runId of this.lastTouched.keys()) {
      if (!running.has(runId)) this.lastTouched.delete(runId)
    }
    return parked
  }

  /** Await all in-flight rounds (graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.inflight.values()].map((i) => i.promise))
  }
}
