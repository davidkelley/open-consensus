import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { Transcript } from './Transcript'

describe('Transcript', () => {
  it('renders each finalized line', () => {
    const { lastFrame } = render(
      <Transcript
        lines={[
          { id: 0, text: 'first line' },
          { id: 1, text: 'second line' },
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
