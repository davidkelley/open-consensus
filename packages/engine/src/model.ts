/**
 * Run / Round / Invocation state machine (plan D13/D15). An adapter classifies
 * ok/refusal/error; the engine adds the lifecycle statuses (timeout, cancelled,
 * unavailable, interrupted) and the round/run states.
 *
 * The persisted-record shapes are defined as zod schemas (D17: the inferred TS
 * type is the single source of truth). The store validates each record ON WRITE
 * (so a bug can't persist a malformed row); reads stay light per D17's caution
 * about better-sqlite3's synchronous reads. Validation is on the records the
 * engine CONSTRUCTS (exact known fields), so no passthrough is needed; schema
 * evolution is handled by the ordered DDL migrations (`user_version`).
 */
import { z } from 'zod'

export const invocationStatusSchema = z.enum([
  'pending',
  'running',
  'ok',
  'refusal',
  'timeout',
  'error',
  'unavailable',
  'cancelled',
  'interrupted',
])
export type InvocationStatus = z.infer<typeof invocationStatusSchema>

const TERMINAL: ReadonlySet<InvocationStatus> = new Set<InvocationStatus>([
  'ok',
  'refusal',
  'timeout',
  'error',
  'unavailable',
  'cancelled',
  'interrupted',
])

export function isTerminal(status: InvocationStatus): boolean {
  return TERMINAL.has(status)
}

export const quorumVerdictSchema = z.enum(['met', 'degraded', 'failed'])
export type QuorumVerdict = z.infer<typeof quorumVerdictSchema>
export const roundStateSchema = z.enum(['running', 'complete'])
export type RoundState = z.infer<typeof roundStateSchema>
export const runStateSchema = z.enum(['running', 'abandoned'])
export type RunState = z.infer<typeof runStateSchema>

export const invocationRecordSchema = z.object({
  agentId: z.string().min(1),
  status: invocationStatusSchema,
  attempts: z.number().int().min(0),
  /** Distilled final answer (byte-capped). */
  distilled: z.string(),
  /** Coarse failure class for provenance (timeout, exit-1, …). */
  errorClass: z.string().optional(),
  durationMs: z.number().int().min(0),
  truncated: z.boolean(),
  /** Reference to the full raw output on disk (runId/roundId/agentId/attempt). */
  rawRef: z.string().optional(),
})
export type InvocationRecord = z.infer<typeof invocationRecordSchema>

export const roundRecordSchema = z.object({
  roundId: z.string().min(1),
  runId: z.string().min(1),
  index: z.number().int().min(0),
  prompt: z.string(),
  /** Quorum snapshotted from the panel at round start (D7). */
  quorum: z.number().int().min(0),
  state: roundStateSchema,
  verdict: quorumVerdictSchema.optional(),
  invocations: z.array(invocationRecordSchema),
})
export type RoundRecord = z.infer<typeof roundRecordSchema>

export const runRecordSchema = z.object({
  runId: z.string().min(1),
  panelId: z.string().min(1),
  state: runStateSchema,
  createdAt: z.number().int().min(0),
})
export type RunRecord = z.infer<typeof runRecordSchema>

/**
 * Quorum verdict (plan D13): counts ONLY `ok` (non-partial) responses. `met` if
 * ≥ quorum ok, `degraded` if some-but-fewer ok, `failed` if zero ok.
 */
export function computeVerdict(
  invocations: readonly InvocationRecord[],
  quorum: number,
): QuorumVerdict {
  const okCount = invocations.filter((i) => i.status === 'ok').length
  if (okCount >= quorum) return 'met'
  if (okCount > 0) return 'degraded'
  return 'failed'
}

/** A round is complete once every invocation has reached a terminal state. */
export function allTerminal(invocations: readonly InvocationRecord[]): boolean {
  return invocations.every((i) => isTerminal(i.status))
}
