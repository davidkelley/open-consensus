import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { seg } from '../ui/segments'
import { Transcript } from './Transcript'

describe('Transcript', () => {
  it('renders each finalized line from its segments', () => {
    const { lastFrame } = render(
      <Transcript
        lines={[
          { id: 0, segments: [seg('first '), seg('line', { bold: true })] },
          { id: 1, segments: [seg('second line', { dim: true })] },
        ]}
      />,
    )
    expect(lastFrame()).toContain('first line')
    expect(lastFrame()).toContain('second line')
  })

  it('renders nothing for an empty transcript', () => {
    const { lastFrame } = render(<Transcript lines={[]} />)
    expect(lastFrame()).toBe('')
  })
})
