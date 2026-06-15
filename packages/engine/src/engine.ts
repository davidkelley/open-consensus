import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, AdapterInvocationContext } from '@open-consensus/adapters'
import { redactString } from '@open-consensus/core'
import { type RunOutcome, runProcess } from '@open-consensus/proc'
import { DEFAULT_DISTILL_CAP_BYTES, distill } from './distill'
import { type EngineEvent, EventBus } from './events'
import {
  type InvocationRecord,
  type InvocationStatus,
  type RoundRecord,
  type RunRecord,
  computeVerdict,
} from './model'
import type { EngineStore } from './store'

const MAX_OUTPUT_BYTES = 1_000_000
const BACKOFF_BASE_MS = 100
const MAX_BACKOFF_MS = 30_000
const DEFAULT_GLOBAL_CONCURRENCY = 8

/** A resolved panel agent (config + its adapter instance). */
export interface PanelAgent {
  agentId: string
  adapter: Adapter
  model?: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs: number
  maxRetries: number
}

export interface Panel {
  panelId: string
  quorum: number
  /** Per-round concurrency cap (in addition to the engine-global cap). */
  concurrency?: number
  agents: PanelAgent[]
}

export interface DispatchOptions {
  signal?: AbortSignal
  /** Pre-generated round id, so an async caller (the daemon) can track the round
   * by id immediately rather than waiting for dispatchRound to resolve. */
  roundId?: string
  /** Reserve this idempotency key in the SAME transaction as the round row (D12),
   * so a crash can't leave a round with no dedup mapping. */
  idempotency?: { key: string }
}

export interface EngineOptions {
  store: EngineStore
  bus?: EventBus
  /** Engine-global concurrency cap across ALL concurrent rounds (default 8). */
  concurrency?: number
  distillCap?: number
  now?: () => number
  /** Backoff sleep — tests inject an instant resolver. */
  sleep?: (ms: number) => Promise<void>
  /** This daemon instance's id — stamped on spawned children + their pgid registry
   * rows so a later instance can sweep this one's orphans (D10). */
  daemonId?: string
}

/** A small async counting semaphore (FIFO waiters). */
class Semaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active++
        resolve()
      })
    })
  }

  release(): void {
    this.active--
    this.waiters.shift()?.()
  }
}

/** Map runner outcome + adapter status to a terminal invocation status. */
function mapStatus(
  outcome: RunOutcome,
  adapterStatus: 'ok' | 'refusal' | 'error',
): InvocationStatus {
  switch (outcome) {
    case 'timeout':
      return 'timeout'
    case 'cancelled':
      return 'cancelled'
    case 'spawn-error':
      return 'unavailable'
    case 'output-overflow':
      return 'error'
    default:
      return adapterStatus
  }
}

/** Only transient failures are worth retrying. */
function isRetriable(status: InvocationStatus): boolean {
  return status === 'timeout' || status === 'error'
}

function placeholder(agentId: string, status: InvocationStatus): InvocationRecord {
  return { agentId, status, attempts: 0, distilled: '', durationMs: 0, truncated: false }
}

/**
 * Compose the child env (the runner drops the inherited env, so the engine MUST
 * supply a usable one — Stage 3 contract). Allowlist a sanitized PATH + a few
 * vars adapters need for auth/config, then the agent's configured overrides.
 */
function composeEnv(agentEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'LANG', 'TMPDIR'] as const) {
    const value = process.env[key]
    if (value !== undefined) base[key] = value
  }
  return { ...base, ...agentEnv }
}

/**
 * The consensus execution engine (plan D3/D13/D16). Fans a round out to every
 * panel agent — engine-global bounded concurrency, per-tool serialization,
 * per-agent timeout, bounded retries with backoff, failure isolation — then
 * computes the quorum verdict once every agent is terminal. Persists metadata +
 * a durable event log + raw blobs, with crash-consistent reconcile (D15).
 */
export class Engine {
  private readonly store: EngineStore
  private readonly bus: EventBus
  private readonly distillCap: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly daemonId: string | undefined
  /** Engine-global concurrency cap, shared across concurrent dispatchRound calls. */
  private readonly globalSem: Semaphore
  /** Engine-global per-adapter serialization chains (span concurrent rounds). */
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(options: EngineOptions) {
    this.store = options.store
    this.bus = options.bus ?? new EventBus()
    this.distillCap = options.distillCap ?? DEFAULT_DISTILL_CAP_BYTES
    this.now = options.now ?? (() => Date.now())
    this.sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise((resolve) => {
          // unref so a backoff abandoned by a cancel can never delay process exit.
          const timer = setTimeout(resolve, ms)
          if (typeof timer.unref === 'function') timer.unref()
        }))
    this.daemonId = options.daemonId
    this.globalSem = new Semaphore(Math.max(1, options.concurrency ?? DEFAULT_GLOBAL_CONCURRENCY))
  }

  get events(): EventBus {
    return this.bus
  }

  /**
   * Recover crashed in-flight state (D15). The daemon MUST call this on startup,
   * before accepting work, so running/pending invocations are advanced to
   * `interrupted` and any `running` round gets a recomputed terminal verdict.
   */
  reconcile(): { repairedRounds: string[] } {
    return this.store.reconcile()
  }

  /**
   * Park an idle, orchestrator-orphaned run (D14). Persists the state flip AND a
   * durable `run-abandoned` event in one transaction (via persistWith) so
   * long-poll/SSE clients observe the parking. Called by the daemon's idle reaper.
   */
  abandonRun(runId: string): void {
    this.persistWith(runId, () => this.store.setRunState(runId, 'abandoned'), {
      type: 'run-abandoned',
      runId,
    })
  }

  /**
   * Re-adopt a parked run (D14): flip `abandoned` back to `running` so a returning
   * orchestrator can continue it with a new round. Durable + observable via the
   * `run-readopted` event. A genuine no-op (no write, no event) if the run isn't
   * abandoned, so a caller can invoke it unconditionally.
   */
  readoptRun(runId: string): void {
    if (this.store.getRun(runId)?.state !== 'abandoned') return
    this.persistWith(runId, () => this.store.setRunState(runId, 'running'), {
      type: 'run-readopted',
      runId,
    })
  }

  createRun(panelId: string): RunRecord {
    const run: RunRecord = {
      runId: randomUUID(),
      panelId,
      state: 'running',
      createdAt: this.now(),
    }
    this.persistWith(run.runId, () => this.store.createRun(run), {
      type: 'run-created',
      runId: run.runId,
      panelId,
    })
    return run
  }

  /**
   * Open a NEW run together with its first round (and optional idempotency key) in
   * ONE transaction, then dispatch the round's agents in the background. Crash-safe
   * (D12/D15): the run row, round row, pending invocations, dedup key, and both
   * events commit atomically — so a replayed key can never point at a run/round
   * that was never durably created. Returns the run, the round id, and a promise
   * that resolves when the round completes.
   */
  openRun(
    panelId: string,
    panel: Panel,
    prompt: string,
    options: DispatchOptions = {},
  ): { run: RunRecord; roundId: string; done: Promise<RoundRecord> } {
    const run: RunRecord = { runId: randomUUID(), panelId, state: 'running', createdAt: this.now() }
    const roundId = options.roundId ?? randomUUID()
    const index = 0
    const safePrompt = redactString(prompt)
    const agentIds = panel.agents.map((a) => a.agentId)
    const runCreated: EngineEvent = { type: 'run-created', runId: run.runId, panelId }
    const roundStarted: EngineEvent = {
      type: 'round-started',
      runId: run.runId,
      roundId,
      index,
      agentIds,
    }
    const seqs = this.store.commitWithEvents(
      run.runId,
      [JSON.stringify(runCreated), JSON.stringify(roundStarted)],
      () => {
        this.store.createRun(run)
        this.store.startRoundWithPending(
          {
            roundId,
            runId: run.runId,
            index,
            prompt: safePrompt,
            quorum: panel.quorum,
            state: 'running',
          },
          agentIds,
        )
        // reserveIdempotent always wins here: the daemon's startRun runs
        // synchronously through this commit (no await between its getIdempotent
        // precheck and now) on a single-instance, single-threaded daemon, so a
        // second same-key call cannot interleave — it observes the committed key
        // and returns at the precheck. There is therefore no "losing run" to
        // discard; were the daemon ever made concurrent, this would need a
        // winner-check + rollback.
        if (options.idempotency)
          this.store.reserveIdempotent(options.idempotency.key, run.runId, roundId)
      },
    )
    this.bus.emit(runCreated, seqs[0] as number)
    this.bus.emit(roundStarted, seqs[1] as number)
    const done = this.completeRoundAgents(run, roundId, index, prompt, safePrompt, panel, options)
    return { run, roundId, done }
  }

  /** Fan a prompt out to the whole panel on an EXISTING run and return the
   * completed round. The round row (+ optional dedup key) starts atomically. */
  async dispatchRound(
    run: RunRecord,
    panel: Panel,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<RoundRecord> {
    const roundId = options.roundId ?? randomUUID()
    const index = this.store.countRounds(run.runId)
    const agentIds = panel.agents.map((a) => a.agentId)
    // The prompt is user-supplied and may carry a pasted secret, so the PERSISTED
    // + served copy is redacted (D10); agents still receive the original prompt.
    const safePrompt = redactString(prompt)
    // Atomically start the round, insert a `pending` row for EVERY agent, reserve
    // the dedup key, and log round-started — so a crash mid-setup never leaves a
    // `running` round with a partial agent set (D15) or a key with no round (D12).
    this.persistWith(
      run.runId,
      () => {
        this.store.startRoundWithPending(
          {
            roundId,
            runId: run.runId,
            index,
            prompt: safePrompt,
            quorum: panel.quorum,
            state: 'running',
          },
          agentIds,
        )
        if (options.idempotency)
          this.store.reserveIdempotent(options.idempotency.key, run.runId, roundId)
      },
      { type: 'round-started', runId: run.runId, roundId, index, agentIds },
    )
    return this.completeRoundAgents(run, roundId, index, prompt, safePrompt, panel, options)
  }

  /**
   * The async tail shared by dispatchRound + openRun: fan out to the agents
   * (failure-isolated), compute the quorum verdict, and complete the round. The
   * round row already exists; this never re-creates it.
   */
  private async completeRoundAgents(
    run: RunRecord,
    roundId: string,
    index: number,
    prompt: string,
    safePrompt: string,
    panel: Panel,
    options: DispatchOptions,
  ): Promise<RoundRecord> {
    let invocations: InvocationRecord[]
    try {
      invocations = await this.dispatchAgents(run, roundId, panel, prompt, options)
    } catch (err) {
      // Defensive: executeAgent is built never to throw, but if dispatch fails
      // catastrophically, never leave the round stuck `running`.
      this.persistWith(run.runId, () => this.store.completeRound(roundId, 'failed'), {
        type: 'round-completed',
        runId: run.runId,
        roundId,
        verdict: 'failed',
      })
      throw err
    }

    const verdict = computeVerdict(invocations, panel.quorum)
    this.persistWith(run.runId, () => this.store.completeRound(roundId, verdict), {
      type: 'round-completed',
      runId: run.runId,
      roundId,
      verdict,
    })

    return {
      roundId,
      runId: run.runId,
      index,
      prompt: safePrompt,
      quorum: panel.quorum,
      state: 'complete',
      verdict,
      invocations,
    }
  }

  private dispatchAgents(
    run: RunRecord,
    roundId: string,
    panel: Panel,
    prompt: string,
    options: DispatchOptions,
  ): Promise<InvocationRecord[]> {
    const roundSem = new Semaphore(Math.max(1, panel.concurrency ?? panel.agents.length))

    // Per-tool serialization: chain invocations of the SAME adapter id (engine-
    // global, so concurrent rounds also serialize same-tool work and never race
    // on shared CLI state). Acquire BOTH the global and per-round caps.
    const schedule = (agent: PanelAgent): Promise<InvocationRecord> => {
      const prev = this.chains.get(agent.adapter.id) ?? Promise.resolve()
      const task = prev
        .catch(() => {})
        .then(async () => {
          await this.globalSem.acquire()
          await roundSem.acquire()
          try {
            return await this.executeAgent(run, roundId, agent, prompt, options)
          } finally {
            roundSem.release()
            this.globalSem.release()
          }
        })
      this.chains.set(
        agent.adapter.id,
        task.catch(() => {}),
      )
      return task
    }

    return Promise.all(panel.agents.map(schedule))
  }

  private async executeAgent(
    run: RunRecord,
    roundId: string,
    agent: PanelAgent,
    prompt: string,
    options: DispatchOptions,
  ): Promise<InvocationRecord> {
    const maxAttempts = agent.maxRetries + 1
    let record = placeholder(agent.agentId, 'error')

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Atomically mark the row `running` with the CURRENT attempt count + log
      // the start, so a crash mid-attempt/backoff reconciles with the right
      // attempt number.
      this.persistWith(
        run.runId,
        () =>
          this.store.upsertInvocation(roundId, {
            agentId: agent.agentId,
            status: 'running',
            attempts: attempt,
            distilled: '',
            durationMs: 0,
            truncated: false,
          }),
        { type: 'invocation-started', runId: run.runId, roundId, agentId: agent.agentId, attempt },
      )
      try {
        record = await this.runOnce(run, roundId, agent, prompt, attempt, options)
      } catch (err) {
        // Failure isolation: an adapter/runner/fs THROW becomes a terminal error
        // record — it must never reject and fail the whole round.
        record = {
          agentId: agent.agentId,
          status: 'error',
          attempts: attempt,
          distilled: '',
          errorClass: redactString(
            `engine-error: ${err instanceof Error ? err.message : String(err)}`,
          ),
          durationMs: 0,
          truncated: false,
        }
      }
      if (!isRetriable(record.status) || attempt === maxAttempts) break
      // Wake early if the round is aborted mid-backoff, so a cancel isn't stuck
      // behind a (capped 30s) sleep; the next attempt then short-circuits to
      // `cancelled` via the runner's pre-spawn abort check.
      await this.sleepOrAbort(this.backoff(attempt), options.signal)
    }

    this.persistWith(run.runId, () => this.store.upsertInvocation(roundId, record), {
      type: 'invocation-finished',
      runId: run.runId,
      roundId,
      agentId: agent.agentId,
      status: record.status,
      attempts: record.attempts,
    })
    return record
  }

  private async runOnce(
    run: RunRecord,
    roundId: string,
    agent: PanelAgent,
    prompt: string,
    attempt: number,
    options: DispatchOptions,
  ): Promise<InvocationRecord> {
    const scratch = mkdtempSync(join(tmpdir(), 'oc-scratch-'))
    // Track this attempt's process group so it is removed from the orphan
    // registry once the child exits (D10).
    let pgid: number | undefined
    try {
      const ctx: AdapterInvocationContext = {
        prompt,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.args ? { args: agent.args } : {}),
        env: composeEnv(agent.env),
        cwd: scratch,
        sessionMode: 'stateless',
      }
      const invocation = agent.adapter.buildInvocation(ctx)
      const rawChunks: Buffer[] = []
      let rawBytes = 0
      const result = await runProcess(
        {
          file: invocation.file,
          args: invocation.args,
          env: invocation.env,
          cwd: scratch,
          ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
        },
        {
          timeoutMs: agent.timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(this.daemonId ? { daemonId: this.daemonId } : {}),
          // Record the detached pgid up front so a daemon crash mid-run leaves a
          // registry entry the next instance can sweep. Best-effort: an advisory
          // registry write must never fail the invocation.
          onSpawn: (pid) => {
            pgid = pid
            if (this.daemonId) {
              try {
                this.store.recordPgid(pid, this.daemonId)
              } catch {
                /* registry is advisory for the sweep */
              }
            }
          },
          // onRaw fires before the runner's own cap, so bound our accumulation
          // too (chunks arriving before a tree-kill lands could exceed the cap).
          // Clamp the final chunk to the remaining budget so capture never spills
          // past MAX_OUTPUT_BYTES, even by one chunk.
          onRaw: (_stream, chunk) => {
            const remaining = MAX_OUTPUT_BYTES - rawBytes
            if (remaining > 0) {
              const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
              rawChunks.push(slice)
              rawBytes += slice.length
            }
          },
        },
      )
      const parsed = agent.adapter.parse(result, ctx)
      const status = mapStatus(result.outcome, parsed.status)
      const rawRef = `${run.runId}.${roundId}.${agent.agentId}.${attempt}`
      // Redact secrets BEFORE persistence (D10): the raw blob, the distilled
      // answer, and the error class. Unredacted raw capture is not offered in v1.
      const rawText = redactString(Buffer.concat(rawChunks).toString('utf8'))
      this.store.writeRaw(rawRef, Buffer.from(rawText, 'utf8'))
      const { distilled, truncated } = distill(redactString(parsed.text), this.distillCap, rawRef)
      return {
        agentId: agent.agentId,
        status,
        attempts: attempt,
        distilled,
        ...(parsed.errorClass ? { errorClass: redactString(parsed.errorClass) } : {}),
        durationMs: result.durationMs,
        truncated,
        rawRef,
      }
    } finally {
      if (pgid !== undefined) {
        try {
          this.store.removePgid(pgid)
        } catch {
          /* a stale row is swept (and tolerated) by the next instance */
        }
      }
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  /** Backoff that resolves early if the round is aborted mid-sleep. */
  private sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return this.sleep(ms)
    if (signal.aborted) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', done)
        resolve()
      }
      signal.addEventListener('abort', done, { once: true })
      void this.sleep(ms).then(done)
    })
  }

  private backoff(attempt: number): number {
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
    return exp + Math.floor(Math.random() * BACKOFF_BASE_MS)
  }

  /**
   * Atomically commit a state mutation AND its durable event in one transaction,
   * THEN notify the live in-memory bus with the durable seq. A crash can never
   * leave a state transition without its matching event (or vice versa).
   */
  private persistWith(runId: string, mutate: () => void, event: EngineEvent): void {
    const seq = this.store.commitWithEvent(runId, JSON.stringify(event), mutate)
    this.bus.emit(event, seq)
  }
}
