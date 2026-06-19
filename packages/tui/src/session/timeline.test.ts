import type { EngineEvent } from '@open-consensus/engine'
import { describe, expect, it } from 'vitest'
import { theme } from '../theme'
import {
  type RunTimeline,
  applyEvent,
  emptyTimeline,
  shortId,
  spinnerMark,
  timelineRows,
} from './timeline'

const RUN = 'run1'
function reduce(events: EngineEvent[]): RunTimeline {
  return events.reduce(applyEvent, emptyTimeline(RUN))
}

describe('timeline reducer', () => {
  it('ignores events for other runs', () => {
    const t = applyEvent(emptyTimeline(RUN), {
      type: 'round-started',
      runId: 'other',
      roundId: 'x',
      index: 0,
      agentIds: ['a'],
    })
    expect(t.agents).toEqual([])
  })

  it('builds agent rows from round-started, then tracks running/finished', () => {
    const t = reduce([
      { type: 'run-created', runId: RUN, panelId: 'p' },
      { type: 'round-started', runId: RUN, roundId: 'r0', index: 0, agentIds: ['a', 'b'] },
      { type: 'invocation-started', runId: RUN, roundId: 'r0', agentId: 'a', attempt: 1 },
      {
        type: 'invocation-finished',
        runId: RUN,
        roundId: 'r0',
        agentId: 'a',
        status: 'ok',
        attempts: 1,
      },
      {
        type: 'invocation-finished',
        runId: RUN,
        roundId: 'r0',
        agentId: 'b',
        status: 'timeout',
        attempts: 3,
      },
      { type: 'round-completed', runId: RUN, roundId: 'r0', verdict: 'degraded' },
    ])
    expect(t.agents).toEqual([
      { agentId: 'a', status: 'ok', attempts: 1 },
      { agentId: 'b', status: 'timeout', attempts: 3 },
    ])
    expect(t.done).toBe(true)
    expect(t.verdict).toBe('degraded')
  })

  it('adds an agent seen only via an invocation event (reconnect mid-round)', () => {
    const t = applyEvent(emptyTimeline(RUN), {
      type: 'invocation-started',
      runId: RUN,
      roundId: 'r0',
      agentId: 'late',
      attempt: 2,
    })
    expect(t.agents).toEqual([{ agentId: 'late', status: 'running', attempts: 2 }])
  })

  it('tracks abandon and readopt', () => {
    let t = applyEvent(emptyTimeline(RUN), { type: 'run-abandoned', runId: RUN })
    expect(t.abandoned).toBe(true)
    t = applyEvent(t, { type: 'run-readopted', runId: RUN })
    expect(t.abandoned).toBe(false)
  })
})

describe('timelineRows', () => {
  const flat = (segs: { text: string }[]): string => segs.map((s) => s.text).join('')

  it('colors the accent run id and a running header', () => {
    const t: RunTimeline = {
      runId: 'r9',
      roundIndex: 2,
      agents: [{ agentId: 'a', status: 'running', attempts: 1 }],
      done: false,
      abandoned: false,
    }
    const rows = timelineRows(t)
    expect(flat(rows[0] ?? [])).toBe('run r9  round 2 — running')
    expect((rows[0] ?? []).some((s) => s.text === 'r9' && s.color === theme.accent)).toBe(true)
    // the agent mark carries the status color
    expect((rows[1] ?? [])[0]?.color).toBe(theme.brand) // running mark
    expect(flat(rows[1] ?? [])).toBe('  ◐ a: running')
  })

  it('colors the verdict on a completed run and shows attempts', () => {
    const t: RunTimeline = {
      runId: 'r9',
      roundIndex: 1,
      agents: [{ agentId: 'a', status: 'ok', attempts: 2 }],
      done: true,
      verdict: 'met',
      abandoned: false,
    }
    const rows = timelineRows(t)
    expect(flat(rows[0] ?? [])).toBe('run r9  round 1 — met')
    expect((rows[0] ?? []).some((s) => s.text === ' — met' && s.color === theme.success)).toBe(true)
    expect(flat(rows[1] ?? [])).toBe('  ✓ a: ok (×2)')
  })

  it('falls back to "complete" with no verdict and marks abandoned', () => {
    const t: RunTimeline = {
      runId: 'r9',
      roundIndex: 0,
      agents: [],
      done: true,
      abandoned: true,
    }
    const head = flat(timelineRows(t)[0] ?? [])
    expect(head).toContain('— complete')
    expect(head).toContain('(abandoned — no orchestrator driving it)')
  })

  it('spins the running agent mark with the frame (others stay static)', () => {
    const t: RunTimeline = {
      runId: 'r9',
      roundIndex: 1,
      agents: [
        { agentId: 'a', status: 'running', attempts: 1 },
        { agentId: 'b', status: 'ok', attempts: 1 },
      ],
      done: false,
      abandoned: false,
    }
    expect(flat(timelineRows(t, 0)[1] ?? [])).toBe('  ◐ a: running')
    expect(flat(timelineRows(t, 1)[1] ?? [])).toBe('  ◓ a: running')
    expect(flat(timelineRows(t, 2)[1] ?? [])).toBe('  ◑ a: running')
    // a non-running agent is unaffected by the frame
    expect(flat(timelineRows(t, 1)[2] ?? [])).toBe('  ✓ b: ok')
  })

  it('shortens a UUID run id in the header (display only)', () => {
    const t: RunTimeline = {
      runId: '2f9a1c7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b',
      roundIndex: 1,
      agents: [{ agentId: 'a', status: 'ok', attempts: 1 }],
      done: false,
      abandoned: false,
    }
    const head = flat(timelineRows(t)[0] ?? [])
    expect(head).toContain('run 2f9a1c7e ')
    expect(head).not.toContain('2f9a1c7e-3b4d') // the full UUID is not shown
  })

  it('renders an explicit row for a round with no agents (not a silent stall)', () => {
    const t: RunTimeline = { runId: 'r9', roundIndex: 0, agents: [], done: false, abandoned: false }
    const rows = timelineRows(t)
    expect(rows.length).toBe(2)
    expect(flat(rows[1] ?? [])).toContain('(no agents in this round)')
  })
})

describe('shortId', () => {
  it('returns the first 8 chars of a UUID', () => {
    expect(shortId('2f9a1c7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b')).toBe('2f9a1c7e')
  })
  it('leaves an already-short id unchanged', () => {
    expect(shortId('r9')).toBe('r9')
  })
})

describe('spinnerMark', () => {
  it('cycles the four frames and wraps', () => {
    expect([0, 1, 2, 3, 4, 5].map(spinnerMark)).toEqual(['◐', '◓', '◑', '◒', '◐', '◓'])
  })
})
