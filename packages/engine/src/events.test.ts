import { describe, expect, it } from 'vitest'
import { EventBus } from './events'

describe('EventBus', () => {
  it('forwards the supplied durable seq to listeners and supports unsubscribe', () => {
    const bus = new EventBus()
    const seen: Array<[string, number]> = []
    const off = bus.on((event, seq) => seen.push([event.type, seq]))

    bus.emit({ type: 'run-created', runId: 'r', panelId: 'p' }, 10)
    bus.emit({ type: 'run-abandoned', runId: 'r' }, 11)
    expect(seen).toEqual([
      ['run-created', 10],
      ['run-abandoned', 11],
    ])

    off()
    bus.emit({ type: 'run-abandoned', runId: 'r' }, 12)
    expect(seen).toHaveLength(2)
  })

  it('isolates a throwing listener from the others', () => {
    const bus = new EventBus()
    const seen: number[] = []
    bus.on(() => {
      throw new Error('boom')
    })
    bus.on((_event, seq) => seen.push(seq))
    expect(() => bus.emit({ type: 'run-abandoned', runId: 'r' }, 5)).not.toThrow()
    expect(seen).toEqual([5])
  })
})
