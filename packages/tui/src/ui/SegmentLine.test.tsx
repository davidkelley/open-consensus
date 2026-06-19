import { Box } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { SegmentLine } from './SegmentLine'
import { seg } from './segments'

describe('SegmentLine', () => {
  it('renders all segments inline on one line', () => {
    const { lastFrame } = render(
      <SegmentLine segments={[seg('run '), seg('abc', { bold: true }), seg(' — running')]} />,
    )
    expect(lastFrame()).toBe('run abc — running')
  })

  it('wraps at a narrow width WITHOUT fragmenting tokens (nested Text = one paragraph)', () => {
    // The exact wrap that garbled as a flex-<Box> of separate <Text> (see SegmentLine docs).
    const segs = [seg('run '), seg('2f9a1c7e'), seg('  round '), seg('3'), seg(' — running')]
    const frame =
      render(
        <Box width={20}>
          <SegmentLine segments={segs} />
        </Box>,
      ).lastFrame() ?? ''
    expect(frame.split('\n').length).toBeGreaterThan(1) // it did wrap
    // every token stays contiguous — none split across the line break
    for (const token of ['run', '2f9a1c7e', 'round', 'running']) {
      expect(frame).toContain(token)
    }
  })

  it('renders an empty segment list as a blank line without throwing', () => {
    const { lastFrame } = render(<SegmentLine segments={[]} />)
    expect(typeof lastFrame()).toBe('string')
  })
})
