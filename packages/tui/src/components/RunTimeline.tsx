import { Box, Text } from 'ink'
import type { ReactElement } from 'react'
import type { StreamStatus } from '../session/sse'
import { type RunTimeline, timelineLines } from '../session/timeline'

/**
 * The in-progress run region (plan D19): renders the live consensus timeline in a
 * dynamic, in-place box (distinct from the `<Static>` scrollback). The connection
 * status is shown when not `open` so a reconnect is visible, not a silent stall.
 */
export function RunTimelineView({
  timeline,
  status,
}: {
  timeline: RunTimeline | undefined
  status: StreamStatus | undefined
}): ReactElement | null {
  if (!timeline) return null
  const lines = timelineLines(timeline)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={timeline.done ? 'green' : 'cyan'}>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional + fully re-rendered each tick
        <Text key={i}>{line}</Text>
      ))}
      {status !== undefined && status !== 'open' && !timeline.done ? (
        <Text dimColor> …{status}</Text>
      ) : null}
    </Box>
  )
}
