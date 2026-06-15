import type { InvocationStatus, QuorumVerdict } from './model'

/**
 * Typed engine events (plan D11). Every state transition is emitted with the
 * **durable** sequence number from the persisted event log (the store's
 * autoincrement rowid), so the sequence is monotonic and stable across daemon
 * restarts — the daemon uses it for both the long-poll snapshot version and the
 * SSE `Last-Event-ID`.
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
  | { type: 'run-readopted'; runId: string }

export type EngineEventListener = (event: EngineEvent, seq: number) => void

/**
 * Minimal synchronous in-process event bus. The sequence number is supplied by
 * the caller (the durable event-log rowid) rather than maintained internally, so
 * it never drifts from the persisted log. A throwing listener can't corrupt
 * engine state — listener errors are isolated.
 */
export class EventBus {
  private readonly listeners = new Set<EngineEventListener>()

  emit(event: EngineEvent, seq: number): void {
    for (const listener of this.listeners) {
      try {
        listener(event, seq)
      } catch {
        /* a misbehaving subscriber must not break engine control flow */
      }
    }
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
