import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { Prompt } from './Prompt'

const tick = () => new Promise((r) => setTimeout(r, 20))
const BACKSPACE = ''
const UP = '[A'
const DOWN = '[B'

describe('Prompt', () => {
  it('echoes typed characters and shows autocomplete for a slash', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} busy={false} />)
    stdin.write('/he')
    await tick()
    expect(lastFrame()).toContain('/he')
    expect(lastFrame()).toContain('/help')
  })

  it('Tab completes to the first suggestion', async () => {
    const submitted: string[] = []
    const { stdin } = render(<Prompt onSubmit={(l) => submitted.push(l)} busy={false} />)
    stdin.write('/he') // unambiguous: only /help matches
    await tick()
    stdin.write('\t')
    await tick()
    stdin.write('\r') // submit to observe the exact completed value (with trailing space)
    await tick()
    expect(submitted).toEqual(['/help '])
  })

  it('Enter submits the line and clears the input', async () => {
    const submitted: string[] = []
    const { stdin, lastFrame } = render(<Prompt onSubmit={(l) => submitted.push(l)} busy={false} />)
    stdin.write('/panels')
    await tick()
    stdin.write('\r')
    await tick()
    expect(submitted).toEqual(['/panels'])
    expect(lastFrame()).not.toContain('/panels')
  })

  it('backspace deletes the last character', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} busy={false} />)
    stdin.write('abc') // non-slash so no autocomplete contaminates the frame
    await tick()
    stdin.write(BACKSPACE)
    await tick()
    expect(lastFrame()).toContain('ab')
    expect(lastFrame()).not.toContain('abc')
  })

  it('Up/Down navigate submitted history', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} busy={false} />)
    stdin.write('/help')
    await tick()
    stdin.write('\r')
    await tick()
    stdin.write(UP) // recall '/help'
    await tick()
    expect(lastFrame()).toContain('/help')
    stdin.write(DOWN) // back to the fresh (empty) line
    await tick()
    expect(lastFrame()).not.toContain('/help')
  })

  it('Down moves forward through history to a later entry', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} busy={false} />)
    stdin.write('/agents')
    await tick()
    stdin.write('\r')
    await tick()
    stdin.write('/panels')
    await tick()
    stdin.write('\r')
    await tick()
    stdin.write(UP) // -> '/panels' (most recent)
    await tick()
    stdin.write(UP) // -> '/agents' (older)
    await tick()
    expect(lastFrame()).toContain('/agents')
    stdin.write(DOWN) // forward -> '/panels' (a later entry, not empty)
    await tick()
    expect(lastFrame()).toContain('/panels')
  })

  it('Up with no history is a no-op', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} busy={false} />)
    stdin.write(UP)
    await tick()
    expect(lastFrame()).toContain('›')
  })

  it('ignores input while busy', async () => {
    const { stdin, lastFrame } = render(<Prompt onSubmit={() => {}} busy={true} />)
    stdin.write('/help')
    await tick()
    expect(lastFrame()).not.toContain('/help')
    expect(lastFrame()).toContain('…')
  })
})
