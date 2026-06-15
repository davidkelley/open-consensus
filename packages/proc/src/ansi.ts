/**
 * Strip ANSI escape sequences and stray control characters from CLI output
 * before it is distilled or persisted (plan D10). Real coding CLIs emit colour
 * codes, cursor moves, spinner frames, hyperlinks, and bell characters; left in,
 * they bloat tokens and make consensus non-deterministic.
 *
 * Implemented as a single-pass linear scanner (NOT a regex) — a malicious CLI
 * must not be able to trigger catastrophic regex backtracking and stall the
 * daemon event loop. Handles CSI (`ESC [ ...`), OSC (`ESC ] ... BEL|ST`), and
 * other `ESC`-introduced sequences, plus stray C0/DEL controls (keeps \t \n \r).
 */

const ESC = 0x1b
const CSI = 0x9b // single-byte CSI
const BEL = 0x07
const DEL = 0x7f

function isFinalByte(code: number): boolean {
  // CSI final byte range 0x40-0x7E.
  return code >= 0x40 && code <= 0x7e
}

function isIntermediate(code: number): boolean {
  // Escape intermediate byte range 0x20-0x2F.
  return code >= 0x20 && code <= 0x2f
}

/** Consume one escape sequence starting at `start`; return the index after it. */
function skipEscape(s: string, start: number): number {
  const n = s.length
  const first = s.charCodeAt(start)
  let i = start + 1
  if (i >= n) return i

  let kind: 'csi' | 'osc' | 'other'
  if (first === CSI) {
    kind = 'csi'
  } else {
    const c = s.charCodeAt(i)
    if (c === 0x5b /* [ */) {
      kind = 'csi'
      i++
    } else if (c === 0x5d /* ] */) {
      kind = 'osc'
      i++
    } else {
      kind = 'other'
    }
  }

  if (kind === 'csi') {
    while (i < n) {
      const code = s.charCodeAt(i)
      i++
      if (isFinalByte(code)) break
    }
    return i
  }

  if (kind === 'osc') {
    // Consume until BEL or ST (ESC \).
    while (i < n) {
      const code = s.charCodeAt(i)
      if (code === BEL) return i + 1
      if (code === ESC && i + 1 < n && s.charCodeAt(i + 1) === 0x5c /* \ */) return i + 2
      i++
    }
    return i
  }

  // 'other': an optional intermediate run then a single final byte.
  while (i < n && isIntermediate(s.charCodeAt(i))) i++
  if (i < n) i++
  return i
}

/** Remove ANSI escapes and non-printable control characters (keeps \t \n \r). */
export function stripAnsi(input: string): string {
  let out = ''
  let i = 0
  const n = input.length
  while (i < n) {
    const code = input.charCodeAt(i)
    if (code === ESC || code === CSI) {
      i = skipEscape(input, i)
      continue
    }
    // Drop C0 controls (except tab/newline/CR) and DEL.
    if ((code <= 0x1f && code !== 9 && code !== 10 && code !== 13) || code === DEL) {
      i++
      continue
    }
    out += input[i]
    i++
  }
  return out
}
