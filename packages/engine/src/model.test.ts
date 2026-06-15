import { describe, expect, it } from 'vitest'
import { type InvocationRecord, allTerminal, computeVerdict, isTerminal } from './model'

const inv = (status: InvocationRecord['status']): InvocationRecord => ({
  agentId: 'a',
  status,
  attempts: 1,
  distilled: '',
  durationMs: 1,
  truncated: false,
})

describe('isTerminal', () => {
  it('separates terminal from in-flight statuses', () => {
    expect(isTerminal('ok')).toBe(true)
    expect(isTerminal('interrupted')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('running')).toBe(false)
    expect(isTerminal('pending')).toBe(false)
  })
})

describe('computeVerdict', () => {
  it('met when ok count >= quorum', () => {
    expect(computeVerdict([inv('ok'), inv('ok')], 2)).toBe('met')
  })
  it('degraded when some ok but below quorum', () => {
    expect(computeVerdict([inv('ok'), inv('error')], 2)).toBe('degraded')
  })
  it('failed when zero ok (refusals/errors do not count)', () => {
    expect(computeVerdict([inv('refusal'), inv('timeout')], 1)).toBe('failed')
  })
})

describe('allTerminal', () => {
  it('true only when every invocation is terminal', () => {
    expect(allTerminal([inv('ok'), inv('error')])).toBe(true)
    expect(allTerminal([inv('ok'), inv('running')])).toBe(false)
  })
})
