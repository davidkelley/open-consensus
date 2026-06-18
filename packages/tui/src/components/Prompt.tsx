import { Box, Text, useInput } from 'ink'
import { type ReactElement, useState } from 'react'
import { applySuggestion, autocomplete } from '../slash/autocomplete'
import { theme } from '../theme'

/**
 * The persistent bottom prompt (plan D19): a claude-code-style input with
 * `/command` autocomplete and history. Implemented directly on ink's `useInput`
 * (no extra text-input dependency) so it can own Tab-completion + Up/Down history
 * exactly. Ctrl-combos are ignored here so the App's `useInput` owns Ctrl+C.
 */
export function Prompt({
  onSubmit,
  busy,
}: {
  onSubmit: (line: string) => void
  busy: boolean
}): ReactElement {
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)

  const suggestions = autocomplete(value)

  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return // Ctrl+C etc. are the App's to handle

      if (key.return) {
        const line = value
        if (line.trim().length > 0) setHistory((h) => [...h, line])
        setValue('')
        setHistoryIdx(null)
        onSubmit(line)
        return
      }
      if (key.tab) {
        const first = suggestions[0]
        if (first) setValue(applySuggestion(first))
        return
      }
      if (key.upArrow) {
        if (history.length === 0) return
        const idx = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1)
        setHistoryIdx(idx)
        setValue(history[idx] ?? '')
        return
      }
      if (key.downArrow) {
        if (historyIdx === null) return
        const idx = historyIdx + 1
        if (idx >= history.length) {
          setHistoryIdx(null)
          setValue('')
        } else {
          setHistoryIdx(idx)
          setValue(history[idx] ?? '')
        }
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (input) setValue((v) => v + input)
    },
    { isActive: !busy },
  )

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.brand} bold>
          {busy ? '… ' : '› '}
        </Text>
        <Text>{value}</Text>
        {busy ? null : <Text backgroundColor={theme.brand}> </Text>}
      </Box>
      {suggestions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {suggestions.slice(0, 6).map((s, i) => (
            <Box key={s.value}>
              <Text color={i === 0 ? theme.brandBright : theme.brand} bold={i === 0}>
                {(i === 0 ? '▸ ' : '  ') + s.value.padEnd(10)}
              </Text>
              <Text dimColor> {s.summary}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}
