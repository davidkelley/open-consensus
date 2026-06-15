import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, AdapterInvocationContext } from '@open-consensus/adapters'
import { type RunOutcome, runProcess } from '@open-consensus/proc'
import { DEFAULT_DISTILL_CAP_BYTES, distill } from './distill'
import { EventBus } from './events'
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
  /** Max concurrent invocations in this panel's round (default = agent count). */
  concurrency?: number
  agents: PanelAgent[]
}

export interface DispatchOptions {
  signal?: AbortSignal
}

export interface EngineOptions {
  store: EngineStore
  bus?: EventBus
  distillCap?: number
  now?: () => number
  /** Backoff sleep — tests inject an instant resolver. */
  sleep?: (ms: number) => Promise<void>
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
 * panel agent — bounded concurrency, per-tool serialization, per-agent timeout,
 * bounded retries with backoff, failure isolation — then computes the quorum
 * verdict once every agent is terminal. Persists metadata + events + raw blobs.
 */
export class Engine {
  private readonly store: EngineStore
  private readonly bus: EventBus
  private readonly distillCap: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(options: EngineOptions) {
    this.store = options.store
    this.bus = options.bus ?? new EventBus()
    this.distillCap = options.distillCap ?? DEFAULT_DISTILL_CAP_BYTES
    this.now = options.now ?? (() => Date.now())
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  get events(): EventBus {
    return this.bus
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
    this.store.startRound({
      roundId,
      runId: run.runId,
      index,
      prompt,
      quorum: panel.quorum,
      state: 'running',
    })
    this.persistEvent(run.runId, {
      type: 'round-started',
      runId: run.runId,
      roundId,
      index,
      agentIds: panel.agents.map((a) => a.agentId),
    })

    const invocations = await this.dispatchAgents(run, roundId, panel, prompt, options)

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

  private async dispatchAgents(
    run: RunRecord,
    roundId: string,
    panel: Panel,
    prompt: string,
    options: DispatchOptions,
  ): Promise<InvocationRecord[]> {
    const limit = panel.concurrency ?? panel.agents.length
    let active = 0
    const waiters: Array<() => void> = []
    const acquire = (): Promise<void> =>
      new Promise((resolve) => {
        if (active < limit) {
          active++
          resolve()
        } else {
          waiters.push(() => {
            active++
            resolve()
          })
        }
      })
    const release = (): void => {
      active--
      waiters.shift()?.()
    }

    // Per-tool serialization: chain invocations of the SAME adapter id so they
    // never race on shared CLI state (~/.claude etc.); different tools run in
    // parallel up to the global concurrency cap (D16).
    const chains = new Map<string, Promise<unknown>>()
    const schedule = (agent: PanelAgent): Promise<InvocationRecord> => {
      const prev = chains.get(agent.adapter.id) ?? Promise.resolve()
      const task = prev
        .catch(() => {})
        .then(async () => {
          await acquire()
          try {
            return await this.executeAgent(run, roundId, agent, prompt, options)
          } finally {
            release()
          }
        })
      chains.set(
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
    let record: InvocationRecord = {
      agentId: agent.agentId,
      status: 'error',
      attempts: 0,
      distilled: '',
      durationMs: 0,
      truncated: false,
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.persistEvent(run.runId, {
        type: 'invocation-started',
        runId: run.runId,
        roundId,
        agentId: agent.agentId,
        attempt,
      })
      record = await this.runOnce(run, roundId, agent, prompt, attempt, options)
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
          onRaw: (_stream, chunk) => rawChunks.push(chunk),
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
    const exp = BACKOFF_BASE_MS * 2 ** (attempt - 1)
    return exp + Math.floor(Math.random() * BACKOFF_BASE_MS)
  }

  private persistEvent(runId: string, event: Parameters<EventBus['emit']>[0]): void {
    this.store.appendEvent(runId, JSON.stringify(event))
    this.bus.emit(event)
  }
}
