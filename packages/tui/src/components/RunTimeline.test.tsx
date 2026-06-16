import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { RunTimeline } from '../session/timeline'
import { RunTimelineView } from './RunTimeline'

const TIMELINE: RunTimeline = {
  runId: 'r1',
  roundIndex: 0,
  agents: [
    { agentId: 'a', status: 'ok', attempts: 1 },
    { agentId: 'b', status: 'running', attempts: 1 },
  ],
  done: false,
  abandoned: false,
}

describe('RunTimelineView', () => {
  it('renders nothing without a timeline', () => {
    const { lastFrame } = render(<RunTimelineView timeline={undefined} status={undefined} />)
    expect(lastFrame()).toBe('')
  })

  it('renders the run header and agent rows', () => {
    const { lastFrame } = render(<RunTimelineView timeline={TIMELINE} status="open" />)
    expect(lastFrame()).toContain('run r1')
    expect(lastFrame()).toContain('a: ok')
    expect(lastFrame()).toContain('b: running')
  })

  it('shows a reconnecting status while not open and not done', () => {
    const { lastFrame } = render(<RunTimelineView timeline={TIMELINE} status="reconnecting" />)
    expect(lastFrame()).toContain('reconnecting')
  })

  it('hides the status once the run is done', () => {
    const done = { ...TIMELINE, done: true, verdict: 'met' as const }
    const { lastFrame } = render(<RunTimelineView timeline={done} status="reconnecting" />)
    expect(lastFrame()).not.toContain('reconnecting')
  })
})
