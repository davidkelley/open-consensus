import { Text } from 'ink'
import type { ReactElement } from 'react'
import type { Segment } from './segments'

/**
 * Render one styled line as a SINGLE ink `<Text>` with nested `<Text>` spans
 * (plan tui-dx-refinement). ink wraps nested-`<Text>` content as one inline
 * paragraph, so a long line wraps cleanly at a word boundary — unlike a `<Box>`
 * flex-row of separate `<Text>` segments, where each segment wraps independently
 * and a narrow terminal garbles the line (empirically: at width 40 the flex-row
 * header rendered `ru2f9a…-uu / roun3 — / running`, the nested-`<Text>` rendered
 * `run 2f9a…-here / round 3 — running`).
 *
 * Purely presentational: it renders whatever segments it is given — it does not
 * touch the redaction boundary (the transcript's segments were already redacted at
 * the single `print` sink; the live region's are daemon-sourced structured ids).
 */
export function SegmentLine({ segments }: { segments: Segment[] }): ReactElement {
  return (
    <Text>
      {segments.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a line
        <Text key={i} color={s.color} bold={s.bold} dimColor={s.dim} inverse={s.inverse}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}
