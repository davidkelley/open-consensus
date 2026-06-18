/**
 * A styled text span — the unit of colored output in the TUI (plan
 * tui-brand-polish). ink's `<Text>` can't reliably render raw ANSI embedded in a
 * string, so colored lines are modeled as arrays of segments and rendered as one
 * `<Text>` per segment. Used by the live run timeline (Stage 2) and the committed
 * transcript (Stage 3).
 */
export interface Segment {
  text: string
  color?: string
  bold?: boolean
  dim?: boolean
  inverse?: boolean
}

/** Build a segment: `seg('hi', { color: theme.brand, bold: true })`. */
export function seg(text: string, style: Omit<Segment, 'text'> = {}): Segment {
  return { text, ...style }
}

/** Normalize a print argument to segments (a bare string becomes one plain segment). */
export function toSegments(line: string | Segment[]): Segment[] {
  return typeof line === 'string' ? [seg(line)] : line
}

/**
 * Redact every segment's text with `redact`, preserving style. Used at the single
 * transcript sink so a secret in ANY segment (not just the first) is scrubbed
 * before it can reach the terminal's persistent scrollback (the D10/D19 invariant).
 */
export function redactSegments(segments: Segment[], redact: (s: string) => string): Segment[] {
  return segments.map((s) => ({ ...s, text: redact(s.text) }))
}
