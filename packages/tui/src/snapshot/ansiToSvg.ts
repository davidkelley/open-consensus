import stringWidth from 'string-width'

/**
 * Pure ANSI(SGR) → SVG converter for the snapshot harness (plan tui-brand-polish,
 * Stage 1). It exists so an AI agent / developer can *see* the real ink TUI: a
 * scene is rendered to an ANSI frame (ink-testing-library under FORCE_COLOR=3,
 * which emits truecolor `38;2;r;g;b`), this turns that frame into an SVG, and
 * `rsvg-convert` rasterises it to a PNG.
 *
 * It is deliberately a small, dependency-light, fully-tested module (NOT a
 * library): it handles exactly the SGR codes ink/chalk emit. It is dev/test-only
 * tooling and is never imported by the shipped TUI bundle (`src/index.ts` does not
 * reach it), so it adds nothing to the runtime surface.
 */

export interface SvgOptions {
  /** Monospace font stack used for every glyph. */
  fontFamily: string
  /** Font size in px. */
  fontSize: number
  /** Per-character advance in px (monospace cell width). */
  charWidth: number
  /** Line height in px. */
  lineHeight: number
  /** Horizontal padding in px. */
  padX: number
  /** Vertical padding in px. */
  padY: number
  /** Page background color. */
  background: string
  /** Default foreground when no SGR fg is active. */
  foreground: string
}

const DEFAULTS: SvgOptions = {
  fontFamily: "Menlo, 'DejaVu Sans Mono', monospace",
  fontSize: 15,
  charWidth: 9,
  lineHeight: 22,
  padX: 14,
  padY: 12,
  background: '#1e1e1e',
  foreground: '#d4d4d4',
}

// 16-color ANSI palette (normal 0-7, bright 8-15), tuned to read on a dark bg.
const PALETTE: readonly string[] = [
  '#1e1e1e',
  '#cd3131',
  '#0dbc79',
  '#e5e510',
  '#2472c8',
  '#bc3fbc',
  '#11a8cd',
  '#cccccc',
  '#666666',
  '#f14c4c',
  '#23d18b',
  '#f5f543',
  '#3b8eea',
  '#d670d6',
  '#29b8db',
  '#ffffff',
]

interface Style {
  fg?: string
  bg?: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

function emptyStyle(): Style {
  return { bold: false, dim: false, italic: false, underline: false, inverse: false }
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (x: number): string => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** Convert a 256-color (38;5;n) index to a hex color. */
function color256(n: number): string {
  if (n < 16) return PALETTE[n] ?? '#000000'
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return rgbHex(v, v, v)
  }
  const i = n - 16
  const r = Math.floor(i / 36)
  const g = Math.floor((i % 36) / 6)
  const b = i % 6
  const c = (x: number): number => (x === 0 ? 0 : 55 + x * 40)
  return rgbHex(c(r), c(g), c(b))
}

/** Apply one SGR parameter list to a style, returning a new style. */
function applySgr(style: Style, params: number[]): Style {
  const s = { ...style }
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0
    if (p === 0) Object.assign(s, emptyStyle())
    else if (p === 1) s.bold = true
    else if (p === 2) s.dim = true
    else if (p === 3) s.italic = true
    else if (p === 4) s.underline = true
    else if (p === 7) s.inverse = true
    else if (p === 22) {
      s.bold = false
      s.dim = false
    } else if (p === 23) s.italic = false
    else if (p === 24) s.underline = false
    else if (p === 27) s.inverse = false
    else if (p >= 30 && p <= 37) s.fg = PALETTE[p - 30]
    else if (p === 39) s.fg = undefined
    else if (p >= 40 && p <= 47) s.bg = PALETTE[p - 40]
    else if (p === 49) s.bg = undefined
    else if (p >= 90 && p <= 97) s.fg = PALETTE[p - 90 + 8]
    else if (p >= 100 && p <= 107) s.bg = PALETTE[p - 100 + 8]
    else if (p === 38 || p === 48) {
      const mode = params[i + 1]
      let color: string | undefined
      if (mode === 5) {
        color = color256(params[i + 2] ?? 0)
        i += 2
      } else if (mode === 2) {
        color = rgbHex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0)
        i += 4
      }
      if (color !== undefined) {
        if (p === 38) s.fg = color
        else s.bg = color
      }
    }
  }
  return s
}

interface Run {
  text: string
  startCol: number
  style: Style
}

// Any CSI escape: ESC [ <params> <final letter>. Only `m` (SGR) changes style;
// other finals (cursor moves etc.) are consumed and ignored.
const CSI_SOURCE = `${String.fromCharCode(27)}\\[([0-9;]*)([A-Za-z])`

/** Split one line (which may contain SGR escapes) into styled runs. */
function parseLine(line: string, initial: Style): { runs: Run[]; end: Style } {
  const runs: Run[] = []
  let style = initial
  let col = 0
  let last = 0
  const push = (text: string): void => {
    if (text.length === 0) return
    runs.push({ text, startCol: col, style })
    col += stringWidth(text)
  }
  // A fresh stateful regex per call: never share `lastIndex` across invocations.
  const csi = new RegExp(CSI_SOURCE, 'g')
  let m = csi.exec(line)
  while (m !== null) {
    push(line.slice(last, m.index))
    if (m[2] === 'm') {
      const body = m[1] ?? ''
      const params = body === '' ? [0] : body.split(';').map((x) => Number(x) || 0)
      style = applySgr(style, params)
    }
    last = m.index + m[0].length
    m = csi.exec(line)
  }
  push(line.slice(last))
  return { runs, end: style }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render an ANSI frame to an SVG string. The frame is the laid-out monospace text
 * block ink produced (rows separated by `\n`, padded with spaces), so column
 * positions come straight from the frame — no layout is re-derived here.
 */
export function ansiFrameToSvg(frame: string, opts: Partial<SvgOptions> = {}): string {
  const o: SvgOptions = { ...DEFAULTS, ...opts }
  const lines = frame.replace(/\n$/, '').split('\n')

  const parsed: Run[][] = []
  let carry = emptyStyle()
  let maxCols = 0
  for (const line of lines) {
    const { runs, end } = parseLine(line, carry)
    carry = end
    parsed.push(runs)
    for (const r of runs) maxCols = Math.max(maxCols, r.startCol + stringWidth(r.text))
  }

  const width = o.padX * 2 + Math.max(1, maxCols) * o.charWidth
  const height = o.padY * 2 + Math.max(1, lines.length) * o.lineHeight
  const ascent = Math.round(o.fontSize * 0.78)

  const rects: string[] = []
  const texts: string[] = []
  for (let r = 0; r < parsed.length; r++) {
    const rowY = o.padY + r * o.lineHeight
    for (const run of parsed[r] ?? []) {
      const x = o.padX + run.startCol * o.charWidth
      const w = stringWidth(run.text) * o.charWidth
      const st = run.style
      // Inverse swaps fg/bg. With no explicit colors, the text takes the PAGE
      // background and the cell takes the foreground — otherwise default-inverse
      // text would be the same color as its own block and vanish.
      const fg = st.inverse ? (st.bg ?? o.background) : (st.fg ?? o.foreground)
      const bg = st.inverse ? (st.fg ?? o.foreground) : st.bg
      const blank = run.text.trim() === ''
      if (bg !== undefined && w > 0) {
        rects.push(
          `<rect x="${x.toFixed(1)}" y="${rowY}" width="${w.toFixed(1)}" height="${o.lineHeight}" fill="${bg}"/>`,
        )
      }
      // Nothing visible to draw for a blank run with no background/underline.
      if (blank && bg === undefined && !st.underline) continue
      const attrs = [
        `x="${x.toFixed(1)}"`,
        `y="${rowY + ascent}"`,
        `fill="${fg}"`,
        st.bold ? 'font-weight="bold"' : '',
        st.italic ? 'font-style="italic"' : '',
        st.underline ? 'text-decoration="underline"' : '',
        st.dim ? 'fill-opacity="0.55"' : '',
        'xml:space="preserve"',
      ]
        .filter(Boolean)
        .join(' ')
      texts.push(`<text ${attrs}>${escapeXml(run.text)}</text>`)
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" font-family="${o.fontFamily}" font-size="${o.fontSize}">`,
    `<rect width="100%" height="100%" fill="${o.background}"/>`,
    ...rects,
    ...texts,
    '</svg>',
  ].join('\n')
}
