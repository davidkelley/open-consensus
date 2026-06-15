/**
 * Strip ANSI escape sequences and stray control characters from CLI output
 * before it is distilled or persisted (plan D10). Real coding CLIs emit colour
 * codes, cursor moves, spinner frames, and bell characters; left in, they bloat
 * tokens and make consensus non-deterministic.
 *
 * The patterns are assembled from numeric code points via String.fromCharCode so
 * the source file stays pure ASCII (no literal control bytes, no escapes). The
 * ANSI matcher is the well-known `ansi-regex` shape, inlined to avoid a dep.
 */

const ESC = String.fromCharCode(27) // 0x1B
const CSI = String.fromCharCode(155) // 0x9B single-byte CSI
const BEL = String.fromCharCode(7) // 0x07 OSC terminator

const ANSI_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?${BEL}|(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])`,
  'g',
)

// C0 control characters except tab (9), newline (10), carriage return (13);
// plus DEL (127). Built individually so no escapes appear in the source.
const CONTROL_CHARS = Array.from({ length: 0x20 }, (_, i) => i)
  .filter((code) => code !== 9 && code !== 10 && code !== 13)
  .concat(0x7f)
  .map((code) => String.fromCharCode(code))
  .join('')

const CONTROL_REGEX = new RegExp(`[${CONTROL_CHARS}]`, 'g')

/** Remove ANSI escapes and non-printable control characters (keeps \t \n \r). */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '').replace(CONTROL_REGEX, '')
}
