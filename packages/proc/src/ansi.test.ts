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

  it('fully consumes OSC sequences (title / hyperlink) up to BEL or ST', () => {
    expect(stripAnsi(`${ESC}]0;My Title${BEL}hello`)).toBe('hello')
    expect(stripAnsi(`${ESC}]8;;https://example.com/${BEL}link${ESC}]8;;${BEL}`)).toBe('link')
    expect(stripAnsi(`${ESC}]0;t${ESC}\\after`)).toBe('after') // ST-terminated
  })

  it('consumes a non-CSI escape (charset designation)', () => {
    expect(stripAnsi(`${ESC}(Bplain`)).toBe('plain')
  })

  it('is linear on adversarial input (no catastrophic backtracking)', () => {
    const evil = `${ESC}[${';'.repeat(100_000)}x`
    const t0 = Date.now()
    expect(stripAnsi(`${evil}tail`)).toBe('tail')
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
