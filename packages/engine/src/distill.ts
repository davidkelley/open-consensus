/**
 * Deterministic distillation (plan D6) — NEVER an LLM call. The adapter already
 * extracted the agent's final answer; this caps it to a byte budget so a huge
 * answer can't bloat the orchestrator's context, appending an unambiguous
 * truncation marker that points at the full raw output (`rawRef`).
 */

export const DEFAULT_DISTILL_CAP_BYTES = 8_000

export interface Distilled {
  distilled: string
  truncated: boolean
}

export function distill(
  text: string,
  capBytes = DEFAULT_DISTILL_CAP_BYTES,
  rawRef?: string,
): Distilled {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= capBytes) return { distilled: text, truncated: false }

  // Keep the TAIL (a CLI's final answer usually trails). Advance past any UTF-8
  // continuation bytes so we never start mid-codepoint (which would emit U+FFFD
  // and inflate the byte length).
  let start = buf.byteLength - capBytes
  while (start < buf.byteLength && ((buf[start] as number) & 0xc0) === 0x80) start++
  let tail = buf.subarray(start).toString('utf8')
  // Drop the partial first line so the kept text starts on a clean line boundary.
  const firstNewline = tail.indexOf('\n')
  if (firstNewline >= 0 && firstNewline < tail.length - 1) {
    tail = tail.slice(firstNewline + 1)
  }
  const marker = `…[truncated: ${start} bytes omitted${rawRef ? `; rawRef=${rawRef}` : ''}]…\n`
  return { distilled: marker + tail, truncated: true }
}
