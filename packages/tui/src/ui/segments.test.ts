import { describe, expect, it } from 'vitest'
import { seg } from './segments'

describe('seg', () => {
  it('builds a plain segment with no style', () => {
    expect(seg('hi')).toEqual({ text: 'hi' })
  })

  it('merges style onto the text', () => {
    expect(seg('hi', { color: '#fff', bold: true })).toEqual({
      text: 'hi',
      color: '#fff',
      bold: true,
    })
  })
})
