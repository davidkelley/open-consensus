import type { EngineEvent } from '@open-consensus/engine'
import { statusColor, theme, verdictColor } from '../theme'
import { type Segment, seg } from '../ui/segments'

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

export type RunVerdict = 'met' | 'degraded' | 'failed'

export interface RunTimeline {
  runId: string
  roundIndex: number
  agents: AgentTimeline[]
  verdict?: RunVerdict
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

/**
 * Render the timeline to styled segment-rows (plan tui-brand-polish). The live
 * region and the committed handoff both use this so a running and a finished run
 * look identical. Pure, with semantic color from {@link statusColor}/
 * {@link verdictColor}. Run ids use the shared accent color (matching the `/run`
 * and `/runs` command output).
 */
export function timelineRows(t: RunTimeline): Segment[][] {
  const head: Segment[] = [
    seg('run ', { dim: true }),
    seg(t.runId, { color: theme.accent }),
    seg('  round ', { dim: true }),
    seg(String(t.roundIndex), { bold: true }),
  ]
  if (t.done) {
    head.push(
      seg(` — ${t.verdict ?? 'complete'}`, {
        color: t.verdict ? verdictColor(t.verdict) : theme.success,
        bold: true,
      }),
    )
  } else {
    head.push(seg(' — running', { color: theme.brand }))
  }
  if (t.abandoned) head.push(seg(' (abandoned)', { color: theme.warn }))

  const rows = t.agents.map((a): Segment[] => [
    seg(`  ${STATUS_MARK[a.status]} `, { color: statusColor(a.status) }),
    seg(a.agentId, { bold: true }),
    seg(`: ${a.status}`, { dim: true }),
    ...(a.attempts > 1 ? [seg(` (×${a.attempts})`, { dim: true })] : []),
  ])
  return [head, ...rows]
}
