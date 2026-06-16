/**
 * Parse a prompt line typed in the TUI (plan D19). A line starting with `/` is a
 * slash command (`/run review a plan`); anything else is treated as free text
 * (currently unused — every action is a slash command, mirroring Claude Code).
 * Pure + synchronous so it's trivially testable and reused by autocomplete.
 */
export interface ParsedCommand {
  kind: 'command'
  /** Command name without the leading slash, lowercased (e.g. `run`). */
  name: string
  /** Whitespace-split arguments after the command name. */
  args: string[]
  /** The raw argument string (everything after the command name), untrimmed of internal spaces. */
  rest: string
}

export interface ParsedText {
  kind: 'text'
  text: string
}

export interface ParsedEmpty {
  kind: 'empty'
}

export type ParsedLine = ParsedCommand | ParsedText | ParsedEmpty

export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim()
  if (trimmed.length === 0) return { kind: 'empty' }
  if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed }

  const withoutSlash = trimmed.slice(1)
  const firstSpace = withoutSlash.indexOf(' ')
  if (firstSpace === -1) {
    return { kind: 'command', name: withoutSlash.toLowerCase(), args: [], rest: '' }
  }
  const name = withoutSlash.slice(0, firstSpace).toLowerCase()
  const rest = withoutSlash.slice(firstSpace + 1)
  const args = rest.split(/\s+/).filter((a) => a.length > 0)
  return { kind: 'command', name, args, rest }
}
