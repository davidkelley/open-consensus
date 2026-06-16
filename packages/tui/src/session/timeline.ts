import type { EngineEvent } from '@open-consensus/engine'

/**
 * Pure reducer for a run's live consensus timeline (plan D19/D11). The TUI feeds
 * daemon SSE events through this; the result drives the in-progress render region
 * and, on completion, is committed verbatim to the `<Static>` scrollback. Keeping
 * it a pure function of (state, event) makes the streaming UI trivially testable.
 */
export type AgentTimelineStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'refusal'
  | 'timeout'
  | 'error'
  | 'unavailable'
  | 'cancelled'
  | 'interrupted'

export interface AgentTimeline {
  agentId: string
  status: AgentTimelineStatus
  attempts: number
}

export interface RunTimeline {
  runId: string
  roundIndex: number
  agents: AgentTimeline[]
  verdict?: 'met' | 'degraded' | 'failed'
  done: boolean
  abandoned: boolean
}

export function emptyTimeline(runId: string): RunTimeline {
  return { runId, roundIndex: 0, agents: [], done: false, abandoned: false }
}

/**
 * True once the live region should hand off to scrollback: the round completed,
 * OR the run was abandoned (no orchestrator driving it). Without the abandoned
 * case an orphaned run would hold the dynamic region forever.
 */
export function isTerminal(timeline: RunTimeline): boolean {
  return timeline.done || timeline.abandoned
}

/** Apply one engine event. Events for a different run are ignored (returned as-is). */
export function applyEvent(timeline: RunTimeline, event: EngineEvent): RunTimeline {
  if ('runId' in event && event.runId !== timeline.runId) return timeline

  switch (event.type) {
    case 'round-started':
      return {
        ...timeline,
        roundIndex: event.index,
        done: false,
        verdict: undefined,
        agents: event.agentIds.map((agentId) => ({ agentId, status: 'pending', attempts: 0 })),
      }
    case 'invocation-started':
      return patchAgent(timeline, event.agentId, { status: 'running', attempts: event.attempt })
    case 'invocation-finished':
      return patchAgent(timeline, event.agentId, {
        status: event.status,
        attempts: event.attempts,
      })
    case 'round-completed':
      return { ...timeline, verdict: event.verdict, done: true }
    case 'run-abandoned':
      return { ...timeline, abandoned: true }
    case 'run-readopted':
      return { ...timeline, abandoned: false }
    default:
      return timeline
  }
}

function patchAgent(
  timeline: RunTimeline,
  agentId: string,
  patch: Partial<AgentTimeline>,
): RunTimeline {
  let found = false
  const agents = timeline.agents.map((a) => {
    if (a.agentId !== agentId) return a
    found = true
    return { ...a, ...patch }
  })
  // An invocation event can arrive for an agent we haven't seen via round-started
  // (e.g. reconnect mid-round); add it rather than dropping the update.
  if (!found) {
    agents.push({ agentId, status: 'pending', attempts: 0, ...patch })
  }
  return { ...timeline, agents }
}

const STATUS_MARK: Record<AgentTimelineStatus, string> = {
  pending: '·',
  running: '◐',
  ok: '✓',
  refusal: '✗',
  timeout: '⌛',
  error: '✗',
  unavailable: '∅',
  cancelled: '⊘',
  interrupted: '⚠',
}

/** Render the timeline to plain lines (committed to <Static> on completion). */
export function timelineLines(t: RunTimeline): string[] {
  const head = `run ${t.runId}  round ${t.roundIndex}${t.done ? ` — ${t.verdict ?? 'complete'}` : ' — running'}${t.abandoned ? ' (abandoned)' : ''}`
  const rows = t.agents.map(
    (a) =>
      `  ${STATUS_MARK[a.status]} ${a.agentId}: ${a.status}${a.attempts > 1 ? ` (×${a.attempts})` : ''}`,
  )
  return [head, ...rows]
}
