import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { REAL_RUN_ID, type Scene, scenes } from './scenes'

describe('snapshot scenes', () => {
  it('exposes a named scene catalog', () => {
    expect(scenes.length).toBeGreaterThan(0)
    expect(new Set(scenes.map((s) => s.name)).size).toBe(scenes.length) // unique names
  })

  it('every scene renders to a string frame without throwing', () => {
    for (const scene of scenes) {
      const { lastFrame, unmount } = render(scene.node)
      expect(typeof lastFrame()).toBe('string')
      unmount()
    }
  })

  it('drives the autocomplete scene with its declared input', async () => {
    const scene = scenes.find((s) => s.name === 'prompt-autocomplete') as Scene
    expect(scene.input).toBe('/r')
    const { stdin, lastFrame, unmount } = render(scene.node)
    stdin.write(scene.input as string)
    await new Promise((r) => setTimeout(r, 30))
    expect(lastFrame()).toContain('/run')
    expect(lastFrame()).toContain('/runs')
    unmount()
  })

  it('includes the edge/robustness scenes with their fixtures', () => {
    const byName = new Map(scenes.map((s) => [s.name, s]))
    for (const name of [
      'narrow-timeline',
      'empty-states',
      'runs-list',
      'help',
      'error',
      'abandoned',
      'nocolor-timeline',
      'nocolor-prompt',
    ]) {
      expect(byName.has(name)).toBe(true)
    }
    // The narrow scene constrains width; the nocolor scene flags NO_COLOR.
    expect(byName.get('narrow-timeline')?.width).toBe(50)
    expect(byName.get('nocolor-timeline')?.noColor).toBe(true)
    // /runs now shows the SHORT id (first 8), not the full UUID.
    const runs = render((byName.get('runs-list') as Scene).node)
    expect(runs.lastFrame()).toContain(REAL_RUN_ID.slice(0, 8))
    expect(runs.lastFrame()).not.toContain(REAL_RUN_ID)
    runs.unmount()
    const empty = render((byName.get('empty-states') as Scene).node)
    expect(empty.lastFrame()).toContain('no agents configured')
    empty.unmount()
  })

  it('the timeline scenes show agents and verdict', () => {
    const running = scenes.find((s) => s.name === 'timeline-running')
    const done = scenes.find((s) => s.name === 'timeline-done')
    expect(running).toBeDefined()
    expect(done).toBeDefined()

    const r = render((running as Scene).node)
    expect(r.lastFrame()).toContain('claude')
    expect(r.lastFrame()).toContain('running')
    r.unmount()

    const d = render((done as Scene).node)
    expect(d.lastFrame()).toContain('met')
    d.unmount()
  })
})
