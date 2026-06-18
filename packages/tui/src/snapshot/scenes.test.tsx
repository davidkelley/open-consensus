import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { type Scene, scenes } from './scenes'

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
