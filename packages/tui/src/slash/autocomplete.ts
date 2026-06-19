import { SLASH_COMMANDS } from './registry'

export interface Suggestion {
  /** Full command token including the leading slash (e.g. `/run`). */
  value: string
  summary: string
}

/**
 * Slash-command autocomplete (plan D19). Suggestions appear only while typing the
 * command NAME — once a space is typed the user is into arguments and the
 * command-specific usage (shown elsewhere) takes over. Matching is
 * case-insensitive prefix on the command name.
 */
export function autocomplete(line: string): Suggestion[] {
  if (!line.startsWith('/')) return []
  if (line.includes(' ')) return [] // past the command name, into args
  const prefix = line.slice(1).toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(prefix))
    .sort((a, b) => {
      // Relevance, not definition order: an exact match first, then the shortest
      // name (so `/r` completes `/run` before `/runs`), then alphabetical.
      const exact = Number(b.name === prefix) - Number(a.name === prefix)
      if (exact !== 0) return exact
      if (a.name.length !== b.name.length) return a.name.length - b.name.length
      return a.name.localeCompare(b.name)
    })
    .map((c) => ({ value: `/${c.name}`, summary: c.summary }))
}

/**
 * Apply a suggestion to the current line: replace the partial command with the
 * full command name plus a trailing space (ready for arguments).
 */
export function applySuggestion(suggestion: Suggestion): string {
  return `${suggestion.value} `
}
