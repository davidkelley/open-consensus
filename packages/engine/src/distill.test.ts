import { describe, expect, it } from 'vitest'
import { distill } from './distill'

describe('distill', () => {
  it('returns text unchanged when under the cap', () => {
    expect(distill('hello world', 100)).toEqual({ distilled: 'hello world', truncated: false })
  })

  it('caps oversized text, keeps the tail, and marks truncation with rawRef', () => {
    const text = `${'head line\n'.repeat(50)}THE FINAL ANSWER`
    const r = distill(text, 40, 'run.round.agent.1')
    expect(r.truncated).toBe(true)
    expect(r.distilled).toContain('truncated:')
    expect(r.distilled).toContain('rawRef=run.round.agent.1')
    expect(r.distilled).toContain('THE FINAL ANSWER')
  })

  it('omits the rawRef from the marker when not provided', () => {
    const r = distill('x'.repeat(100), 10)
    expect(r.truncated).toBe(true)
    expect(r.distilled).toContain('truncated:')
    expect(r.distilled).not.toContain('rawRef')
  })

  it('does not corrupt a multi-byte codepoint split by the cap boundary', () => {
    // 😀 is 4 bytes; a 5-byte cap lands mid-emoji, then 'END' follows.
    const r = distill(`${'a'.repeat(20)}😀END`, 5)
    expect(r.truncated).toBe(true)
    expect(r.distilled).not.toContain('�')
    expect(r.distilled).toContain('END')
  })

  it('handles a cap window of only continuation bytes (empty tail)', () => {
    const r = distill('😀😀😀', 2)
    expect(r.truncated).toBe(true)
    expect(r.distilled).not.toContain('�')
  })
})
