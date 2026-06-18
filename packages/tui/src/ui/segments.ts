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
