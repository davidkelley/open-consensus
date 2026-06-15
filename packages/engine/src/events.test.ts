import { describe, expect, it } from 'vitest'
import { EventBus } from './events'

describe('EventBus', () => {
  it('emits with a monotonic sequence and notifies listeners', () => {
    const bus = new EventBus()
    const seen: Array<[string, number]> = []
    const off = bus.on((event, seq) => seen.push([event.type, seq]))

    expect(bus.emit({ type: 'run-created', runId: 'r', panelId: 'p' })).toBe(1)
    expect(bus.emit({ type: 'run-abandoned', runId: 'r' })).toBe(2)
    expect(seen).toEqual([
      ['run-created', 1],
      ['run-abandoned', 2],
    ])
    expect(bus.sequence).toBe(2)

    off()
    bus.emit({ type: 'run-abandoned', runId: 'r' })
    expect(seen).toHaveLength(2)
  })
})
