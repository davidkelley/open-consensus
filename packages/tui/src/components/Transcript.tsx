import { Static, Text } from 'ink'
import type { ReactElement } from 'react'

export interface TranscriptLine {
  id: number
  text: string
}

/**
 * The finalized scrollback (plan D19): committed lines render once via ink's
 * `<Static>` (append-only, never re-rendered), so a long session stays cheap and
 * the terminal's own scrollback works. The live in-progress region is a SEPARATE
 * dynamic component ({@link RunTimelineView}) because `<Static>` can't be mutated.
 */
export function Transcript({ lines }: { lines: TranscriptLine[] }): ReactElement {
  return <Static items={lines}>{(line) => <Text key={line.id}>{line.text}</Text>}</Static>
}
