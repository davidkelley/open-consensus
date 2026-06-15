import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, AdapterInvocationContext } from '@open-consensus/adapters'
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
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
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

  createRun(panelId: string): RunRecord {
    const run: RunRecord = {
      runId: randomUUID(),
      panelId,
      state: 'running',
      createdAt: this.now(),
    }
    this.store.createRun(run)
    this.persistEvent(run.runId, { type: 'run-created', runId: run.runId, panelId })
    return run
  }

  /** Fan a prompt out to the whole panel and return the completed round. */
  async dispatchRound(
    run: RunRecord,
    panel: Panel,
    prompt: string,
    options: DispatchOptions = {},
  ): Promise<RoundRecord> {
    const roundId = randomUUID()
    const index = this.store.countRounds(run.runId)
    // Atomically start the round AND insert a `pending` row for EVERY agent, so
    // a crash mid-setup never leaves a `running` round with a partial agent set
    // that reconcile would mis-verdict (D15).
    this.store.startRoundWithPending(
      { roundId, runId: run.runId, index, prompt, quorum: panel.quorum, state: 'running' },
      panel.agents.map((a) => a.agentId),
    )
    this.persistEvent(run.runId, {
      type: 'round-started',
      runId: run.runId,
      roundId,
      index,
      agentIds: panel.agents.map((a) => a.agentId),
    })

    let invocations: InvocationRecord[]
    try {
      invocations = await this.dispatchAgents(run, roundId, panel, prompt, options)
    } catch (err) {
      // Defensive: executeAgent is built never to throw, but if dispatch fails
      // catastrophically, never leave the round stuck `running`.
      this.store.completeRound(roundId, 'failed')
      this.persistEvent(run.runId, {
        type: 'round-completed',
        runId: run.runId,
        roundId,
        verdict: 'failed',
      })
      throw err
    }

    const verdict = computeVerdict(invocations, panel.quorum)
    this.store.completeRound(roundId, verdict)
    this.persistEvent(run.runId, { type: 'round-completed', runId: run.runId, roundId, verdict })

    return {
      roundId,
      runId: run.runId,
      index,
      prompt,
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
    this.store.upsertInvocation(roundId, placeholder(agent.agentId, 'running'))
    const maxAttempts = agent.maxRetries + 1
    let record = placeholder(agent.agentId, 'error')

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.persistEvent(run.runId, {
        type: 'invocation-started',
        runId: run.runId,
        roundId,
        agentId: agent.agentId,
        attempt,
      })
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
          errorClass: `engine-error: ${err instanceof Error ? err.message : String(err)}`,
          durationMs: 0,
          truncated: false,
        }
      }
      if (!isRetriable(record.status) || attempt === maxAttempts) break
      await this.sleep(this.backoff(attempt))
    }

    this.store.upsertInvocation(roundId, record)
    this.persistEvent(run.runId, {
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
          // onRaw fires before the runner's own cap, so bound our accumulation
          // too (chunks arriving before a tree-kill lands could exceed the cap).
          onRaw: (_stream, chunk) => {
            if (rawBytes < MAX_OUTPUT_BYTES) {
              rawChunks.push(chunk)
              rawBytes += chunk.length
            }
          },
        },
      )
      const parsed = agent.adapter.parse(result, ctx)
      const status = mapStatus(result.outcome, parsed.status)
      const rawRef = `${run.runId}.${roundId}.${agent.agentId}.${attempt}`
      this.store.writeRaw(rawRef, Buffer.concat(rawChunks))
      const { distilled, truncated } = distill(parsed.text, this.distillCap, rawRef)
      return {
        agentId: agent.agentId,
        status,
        attempts: attempt,
        distilled,
        ...(parsed.errorClass ? { errorClass: parsed.errorClass } : {}),
        durationMs: result.durationMs,
        truncated,
        rawRef,
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  private backoff(attempt: number): number {
    const exp = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)
    return exp + Math.floor(Math.random() * BACKOFF_BASE_MS)
  }

  private persistEvent(runId: string, event: EngineEvent): void {
    const seq = this.store.appendEvent(runId, JSON.stringify(event))
    this.bus.emit(event, seq)
  }
}
