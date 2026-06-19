import { Static } from 'ink'
import type { ReactElement } from 'react'
import { SegmentLine } from '../ui/SegmentLine'
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
      {(line) => <SegmentLine key={line.id} segments={line.segments} />}
    </Static>
  )
}
