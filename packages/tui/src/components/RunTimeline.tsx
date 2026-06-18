import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { StreamStatus } from '../session/sse'
import { type RunTimeline, timelineRows } from '../session/timeline'
import { theme, timelineBorderColor } from '../theme'

/**
 * The in-progress run region (plan D19, restyled in tui-brand-polish). Renders the
 * live consensus timeline as colored segment-rows in a dynamic box: a brand border
 * while running, verdict-tinted when done. The connection status is shown when not
 * `open` so a reconnect is visible, not a silent stall.
 */
export function RunTimelineView({
  timeline,
  status,
}: {
  timeline: RunTimeline | undefined
  status: StreamStatus | undefined
}): ReactElement | null {
  if (!timeline) return null
  const rows = timelineRows(timeline)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={timelineBorderColor(timeline)}
      paddingX={1}
    >
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional + fully re-rendered each tick
        <Box key={i}>
          {row.map((s, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a row
            <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim} inverse={s.inverse}>
              {s.text}
            </Text>
          ))}
        </Box>
      ))}
      {status !== undefined && status !== 'open' && !timeline.done ? (
        <Text color={theme.muted}> …{status}</Text>
      ) : null}
    </Box>
  )
}
