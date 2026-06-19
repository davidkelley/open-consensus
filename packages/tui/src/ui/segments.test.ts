import { describe, expect, it } from 'vitest'
import { theme } from '../theme'
import { redactSegments, seg, toSegments } from './segments'

describe('seg', () => {
  it('builds a plain segment with no style', () => {
    expect(seg('hi')).toEqual({ text: 'hi' })
  })

  it('merges style onto the text', () => {
    expect(seg('hi', { color: theme.brand, bold: true })).toEqual({
      text: 'hi',
      color: theme.brand,
      bold: true,
    })
  })
})

describe('toSegments', () => {
  it('wraps a string in a single plain segment', () => {
    expect(toSegments('hi')).toEqual([{ text: 'hi' }])
  })

  it('passes segments through unchanged', () => {
    const segs = [seg('a', { bold: true }), seg('b')]
    expect(toSegments(segs)).toBe(segs)
  })
})

describe('redactSegments', () => {
  const redact = (s: string): string => s.replace(/SECRET/g, '***')

  it('redacts a secret in ANY segment, not just the first', () => {
    const out = redactSegments(
      [seg('› ', { color: theme.brandDim }), seg('token SECRET here', { bold: true })],
      redact,
    )
    expect(out[1]?.text).toBe('token *** here')
    // style is preserved on each segment
    expect(out[0]).toEqual({ text: '› ', color: theme.brandDim })
    expect(out[1]?.bold).toBe(true)
  })

  it('returns new segment objects (does not mutate the input)', () => {
    const input = [seg('SECRET')]
    const out = redactSegments(input, redact)
    expect(input[0]?.text).toBe('SECRET')
    expect(out[0]?.text).toBe('***')
  })
})
