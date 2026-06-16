import { z } from 'zod'
import { invocationStatusSchema, quorumVerdictSchema } from './model'

/**
 * Typed engine events (plan D11/D17). Defined as a zod discriminated union (the
 * inferred TS type is the single source of truth) so a consumer reading them off
 * the wire — the SSE stream — can validate the payload and DROP a malformed frame
 * rather than feed missing fields into a reducer. Every transition carries the
 * **durable** sequence number from the persisted event log, monotonic + stable
 * across daemon restarts (the daemon uses it for the long-poll `stateVersion` and
 * the SSE `Last-Event-ID`).
 */
export const engineEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run-created'), runId: z.string(), panelId: z.string() }),
  z.object({
    type: z.literal('round-started'),
    runId: z.string(),
    roundId: z.string(),
    index: z.number().int().min(0),
    agentIds: z.array(z.string()),
  }),
  z.object({
    type: z.literal('invocation-started'),
    runId: z.string(),
    roundId: z.string(),
    agentId: z.string(),
    attempt: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('invocation-finished'),
    runId: z.string(),
    roundId: z.string(),
    agentId: z.string(),
    status: invocationStatusSchema,
    attempts: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('round-completed'),
    runId: z.string(),
    roundId: z.string(),
    verdict: quorumVerdictSchema,
  }),
  z.object({ type: z.literal('run-abandoned'), runId: z.string() }),
  z.object({ type: z.literal('run-readopted'), runId: z.string() }),
])
export type EngineEvent = z.infer<typeof engineEventSchema>

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
