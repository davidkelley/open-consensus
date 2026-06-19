import { Box } from 'ink'
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

  it('wraps the header cleanly at a narrow width with a real UUID (no mid-token garble)', () => {
    const uuid = '2f9a1c7e-3b4d-4e5f-8a6b-1c2d3e4f5a6b'
    const t: RunTimeline = { ...TIMELINE, runId: uuid, roundIndex: 3 }
    const frame =
      render(
        <Box width={40}>
          <RunTimelineView timeline={t} status="open" />
        </Box>,
      ).lastFrame() ?? ''
    // the short id renders CONTIGUOUSLY (the flex-row version split it as `2f9a…/…6b`)
    expect(frame).toContain('2f9a1c7e')
    expect(frame).not.toContain(uuid) // full UUID never shown
    // header tokens stay intact across the wrap
    expect(frame).toContain('run ')
    expect(frame).toContain('running')
  })
})
