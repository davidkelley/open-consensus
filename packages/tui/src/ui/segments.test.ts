import { describe, expect, it } from 'vitest'
import { theme } from '../theme'
import { seg } from './segments'

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
