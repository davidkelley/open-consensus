import { describe, expect, it } from 'vitest'
import { ansiFrameToSvg } from './ansiToSvg'

const ESC = String.fromCharCode(27)
const esc = (s: string): string => ESC + s

describe('ansiFrameToSvg', () => {
  it('renders plain text with the page background and default fg', () => {
    const svg = ansiFrameToSvg('hello')
    expect(svg).toContain('<svg')
    expect(svg).toContain('fill="#1e1e1e"') // page background rect
    expect(svg).toContain('>hello</text>')
    expect(svg).toContain('fill="#d4d4d4"') // default fg
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('maps a truecolor (38;2;r;g;b) fg to hex', () => {
    const svg = ansiFrameToSvg(`${esc('[38;2;215;161;74m')}brand${esc('[39m')}`)
    expect(svg).toContain('fill="#d7a14a"')
    expect(svg).toContain('>brand</text>')
  })

  it('applies bold / dim / italic / underline and their resets', () => {
    const svg = ansiFrameToSvg(
      `${esc('[1m')}b${esc('[22m')}${esc('[2m')}d${esc('[22m')}${esc('[3m')}i${esc('[23m')}${esc('[4m')}u${esc('[24m')}`,
    )
    expect(svg).toContain('font-weight="bold"')
    expect(svg).toContain('fill-opacity="0.55"')
    expect(svg).toContain('font-style="italic"')
    expect(svg).toContain('text-decoration="underline"')
  })

  it('swaps fg/bg for inverse so default-inverse text stays visible', () => {
    const svg = ansiFrameToSvg(`${esc('[7m')}A${esc('[27m')}`)
    // the cell is painted with the foreground...
    expect(svg).toContain('fill="#d4d4d4"')
    // ...and the glyph with the page background (NOT the same color as its cell)
    expect(svg).toMatch(/<text[^>]*fill="#1e1e1e"[^>]*>A<\/text>/)
  })

  it('accounts for wide glyphs when positioning later runs', () => {
    // '世' is double-width (2 cells); the run after it must start 2 columns right.
    const svg = ansiFrameToSvg(`${esc('[31m')}世${esc('[39m')}X`)
    // charWidth=9, padX=14 → the glyph occupies cols 0-1, so 'X' starts at col 2.
    expect(svg).toMatch(/<text x="32\.0"[^>]*>X<\/text>/)
  })

  it('maps named (30-37/90-97) and background (40-47) colors', () => {
    const svg = ansiFrameToSvg(
      `${esc('[36m')}c${esc('[39m')}${esc('[91m')}r${esc('[41m')}bg${esc('[49m')}`,
    )
    expect(svg).toContain('fill="#11a8cd"') // cyan
    expect(svg).toContain('fill="#f14c4c"') // bright red
    expect(svg).toContain('fill="#cd3131"') // red background rect
  })

  it('maps truecolor and 256-color backgrounds and bright backgrounds', () => {
    expect(ansiFrameToSvg(`${esc('[48;2;40;50;60m')}bg${esc('[49m')}`)).toContain('fill="#28323c"')
    expect(ansiFrameToSvg(`${esc('[48;5;21m')}bg${esc('[49m')}`)).toContain('fill="#0000ff"')
    expect(ansiFrameToSvg(`${esc('[101m')}bg${esc('[49m')}`)).toContain('fill="#f14c4c"') // bright red bg
  })

  it('maps 256-color fg across base, cube, and grayscale ranges', () => {
    expect(ansiFrameToSvg(`${esc('[38;5;1m')}a`)).toContain('fill="#cd3131"') // base
    expect(ansiFrameToSvg(`${esc('[38;5;16m')}a`)).toContain('fill="#000000"') // cube origin
    expect(ansiFrameToSvg(`${esc('[38;5;196m')}a`)).toContain('fill="#ff0000"') // cube red
    expect(ansiFrameToSvg(`${esc('[38;5;240m')}a`)).toContain('fill="#') // grayscale (valid hex)
  })

  it('ignores 38/48 with an unsupported mode and unknown SGR codes', () => {
    const svg = ansiFrameToSvg(`${esc('[38;9m')}${esc('[99m')}plain`)
    expect(svg).toContain('>plain</text>')
    expect(svg).toContain('fill="#d4d4d4"') // stayed default fg
  })

  it('treats an empty SGR body as a reset', () => {
    const svg = ansiFrameToSvg(`${esc('[1m')}${esc('[m')}plain`)
    // the bare reset cleared bold, so the run is not bold
    expect(svg).toContain('>plain</text>')
    expect(svg).not.toContain('font-weight="bold"')
  })

  it('escapes XML metacharacters in text', () => {
    const svg = ansiFrameToSvg('a <b> & c')
    expect(svg).toContain('a &lt;b&gt; &amp; c')
  })

  it('carries active style across line breaks until reset', () => {
    const svg = ansiFrameToSvg(`${esc('[1m')}top\nbottom`)
    // both rows inherit bold (no reset between them)
    expect(svg.match(/font-weight="bold"/g)?.length).toBe(2)
  })

  it('ignores non-SGR CSI sequences (e.g. cursor moves)', () => {
    const svg = ansiFrameToSvg(`${esc('[2J')}kept`)
    expect(svg).toContain('>kept</text>')
  })

  it('skips emitting text for blank default runs but keeps the svg valid', () => {
    const svg = ansiFrameToSvg('   ')
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('<text')
  })

  it('handles an empty frame and a trailing newline', () => {
    expect(ansiFrameToSvg('')).toContain('<svg')
    const svg = ansiFrameToSvg('one\n')
    expect(svg.match(/<text/g)?.length).toBe(1)
  })

  it('honors option overrides', () => {
    const svg = ansiFrameToSvg('x', { fontSize: 30, background: '#000000', foreground: '#ffffff' })
    expect(svg).toContain('font-size="30"')
    expect(svg).toContain('fill="#000000"')
    expect(svg).toContain('fill="#ffffff"')
  })
})
