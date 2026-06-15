import type { InvocationStatus, QuorumVerdict } from './model'

/**
 * Typed engine events (plan D11). Every state transition is emitted with a
 * monotonic sequence number; the daemon persists them to the event log and
 * exposes them as both the long-poll snapshot source and the SSE stream.
 */
export type EngineEvent =
  | { type: 'run-created'; runId: string; panelId: string }
  | { type: 'round-started'; runId: string; roundId: string; index: number; agentIds: string[] }
  | { type: 'invocation-started'; runId: string; roundId: string; agentId: string; attempt: number }
  | {
      type: 'invocation-finished'
      runId: string
      roundId: string
      agentId: string
      status: InvocationStatus
      attempts: number
    }
  | { type: 'round-completed'; runId: string; roundId: string; verdict: QuorumVerdict }
  | { type: 'run-abandoned'; runId: string }

export type EngineEventListener = (event: EngineEvent, seq: number) => void

/** Minimal synchronous in-process event bus with monotonic sequencing. */
export class EventBus {
  private readonly listeners = new Set<EngineEventListener>()
  private seq = 0

  emit(event: EngineEvent): number {
    const next = ++this.seq
    for (const listener of this.listeners) listener(event, next)
    return next
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get sequence(): number {
    return this.seq
  }
}
