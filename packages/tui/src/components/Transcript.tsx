import { Box, Static, Text } from 'ink'
import type { ReactElement } from 'react'
import type { Segment } from '../ui/segments'

export interface TranscriptLine {
  id: number
  segments: Segment[]
}

/**
 * The finalized scrollback (plan D19; segment-based since tui-brand-polish). Each
 * committed line is an array of styled {@link Segment}s rendered once via ink's
 * `<Static>` (append-only, never re-rendered), so a long session stays cheap and
 * the terminal's own scrollback works. Colors come from the segments, which the
 * single `print` sink produced (and redacted). The live in-progress region is a
 * SEPARATE dynamic component ({@link RunTimelineView}) because `<Static>` can't be
 * mutated.
 */
export function Transcript({ lines }: { lines: TranscriptLine[] }): ReactElement {
  return (
    <Static items={lines}>
      {(line) => (
        <Box key={line.id}>
          {line.segments.map((s, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a committed line
            <Text key={j} color={s.color} bold={s.bold} dimColor={s.dim} inverse={s.inverse}>
              {s.text}
            </Text>
          ))}
        </Box>
      )}
    </Static>
  )
}
