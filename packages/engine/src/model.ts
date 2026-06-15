/**
 * Run / Round / Invocation state machine (plan D13/D15). An adapter classifies
 * ok/refusal/error; the engine adds the lifecycle statuses (timeout, cancelled,
 * unavailable, interrupted) and the round/run states.
 */

export type InvocationStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'refusal'
  | 'timeout'
  | 'error'
  | 'unavailable'
  | 'cancelled'
  | 'interrupted'

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

export type QuorumVerdict = 'met' | 'degraded' | 'failed'
export type RoundState = 'running' | 'complete'
export type RunState = 'running' | 'abandoned'

export interface InvocationRecord {
  agentId: string
  status: InvocationStatus
  attempts: number
  /** Distilled final answer (byte-capped). */
  distilled: string
  /** Coarse failure class for provenance (timeout, exit-1, …). */
  errorClass?: string
  durationMs: number
  truncated: boolean
  /** Reference to the full raw output on disk (runId/roundId/agentId/attempt). */
  rawRef?: string
}

export interface RoundRecord {
  roundId: string
  runId: string
  index: number
  prompt: string
  /** Quorum snapshotted from the panel at round start (D7). */
  quorum: number
  state: RoundState
  verdict?: QuorumVerdict
  invocations: InvocationRecord[]
}

export interface RunRecord {
  runId: string
  panelId: string
  state: RunState
  createdAt: number
}

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
