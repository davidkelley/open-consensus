import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

describe('stripAnsi', () => {
  it('removes ANSI colour codes', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red')
  })

  it('removes BEL and other control characters but keeps tab/newline/CR', () => {
    expect(stripAnsi(`a${BEL}b\tc\nd\re`)).toBe('ab\tc\nd\re')
  })

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123')
  })
})
