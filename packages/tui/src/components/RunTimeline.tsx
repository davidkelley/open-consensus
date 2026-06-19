import { Box, Text } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { StreamStatus } from '../session/sse'
import { type RunTimeline, isTerminal, timelineRows } from '../session/timeline'
import { theme, timelineBorderColor } from '../theme'
import { SegmentLine } from '../ui/SegmentLine'

/** Spinner cadence (ms) — slow enough to read as a heartbeat, not a strobe. */
const SPINNER_MS = 120

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
  // Hooks run unconditionally (before the early return) per the rules of hooks.
  const [frame, setFrame] = useState(0)
  const running = timeline !== undefined && !isTerminal(timeline)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setFrame((f) => f + 1), SPINNER_MS)
    // `running` is the only dep: the cleanup clears the interval on unmount AND the
    // moment the run goes terminal (running → false), so it never outlives its run.
    // A new run starting (still running) just keeps the one spinner going — no leak.
    return () => clearInterval(id)
  }, [running])

  if (!timeline) return null
  const rows = timelineRows(timeline, frame)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={timelineBorderColor(timeline)}
      paddingX={1}
    >
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional + fully re-rendered each tick
        <SegmentLine key={i} segments={row} />
      ))}
      {status !== undefined && status !== 'open' && !timeline.done ? (
        <Text color={theme.muted}> …{status}</Text>
      ) : null}
    </Box>
  )
}
