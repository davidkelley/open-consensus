import { describe, expect, it } from 'vitest'
import type { AgentTimelineStatus, RunTimeline, RunVerdict } from './session/timeline'
import { statusColor, theme, timelineBorderColor, verdictColor } from './theme'

const base: RunTimeline = { runId: 'r', roundIndex: 0, agents: [], done: false, abandoned: false }

describe('theme', () => {
  it('exposes a hex brand palette', () => {
    for (const c of [theme.brand, theme.brandBright, theme.brandDim, theme.success, theme.danger]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('maps every agent status to a defined color', () => {
    const statuses: AgentTimelineStatus[] = [
      'pending',
      'running',
      'ok',
      'refusal',
      'timeout',
      'error',
      'unavailable',
      'cancelled',
      'interrupted',
    ]
    for (const s of statuses) expect(statusColor(s)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(statusColor('ok')).toBe(theme.success)
    expect(statusColor('error')).toBe(theme.danger)
    expect(statusColor('refusal')).toBe(theme.danger)
    expect(statusColor('running')).toBe(theme.brand)
    expect(statusColor('timeout')).toBe(theme.warn)
    expect(statusColor('cancelled')).toBe(theme.warn)
    expect(statusColor('interrupted')).toBe(theme.warn)
    expect(statusColor('pending')).toBe(theme.muted)
    expect(statusColor('unavailable')).toBe(theme.muted)
  })

  it('maps every verdict to a defined color', () => {
    const verdicts: RunVerdict[] = ['met', 'degraded', 'failed']
    for (const v of verdicts) expect(verdictColor(v)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(verdictColor('met')).toBe(theme.success)
    expect(verdictColor('degraded')).toBe(theme.warn)
    expect(verdictColor('failed')).toBe(theme.danger)
  })

  it('picks the border color from run state', () => {
    expect(timelineBorderColor(base)).toBe(theme.brand) // running
    expect(timelineBorderColor({ ...base, done: true, verdict: 'met' })).toBe(theme.success)
    expect(timelineBorderColor({ ...base, done: true })).toBe(theme.success) // done, no verdict
    expect(timelineBorderColor({ ...base, done: true, verdict: 'failed' })).toBe(theme.danger)
    expect(timelineBorderColor({ ...base, abandoned: true })).toBe(theme.warn)
  })
})
