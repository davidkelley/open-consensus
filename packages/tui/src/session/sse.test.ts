import { type Server, createServer } from 'node:http'
import type { Discovery } from '@open-consensus/daemon'
import type { EngineEvent } from '@open-consensus/engine'
import { describe, expect, it } from 'vitest'
import {
  type Connect,
  type ConnectHandlers,
  SseParser,
  type StreamStatus,
  defaultBackoff,
  startEventStream,
} from './sse'

const DISCOVERY: Discovery = { endpoint: 'http://127.0.0.1:1234', token: 't' }

describe('SseParser', () => {
  it('parses a complete frame', () => {
    const frames = new SseParser().feed('id: 5\ndata: {"a":1}\n\n')
    expect(frames).toEqual([{ id: 5, data: '{"a":1}' }])
  })

  it('assembles a frame split across chunks', () => {
    const p = new SseParser()
    expect(p.feed('id: 1\nda')).toEqual([])
    expect(p.feed('ta: hello\n\n')).toEqual([{ id: 1, data: 'hello' }])
  })

  it('ignores comment-only frames (pings)', () => {
    expect(new SseParser().feed(': ping\n\n: connected\n\n')).toEqual([])
  })

  it('parses multiple frames and multi-line data in one chunk', () => {
    expect(new SseParser().feed('data: a\ndata: b\n\nid: 2\ndata: c\n\n')).toEqual([
      { data: 'a\nb' },
      { id: 2, data: 'c' },
    ])
  })
})

describe('defaultBackoff', () => {
  it('grows with the attempt, is bounded, and never zero', () => {
    const a = defaultBackoff(0, () => 0)
    const b = defaultBackoff(5, () => 0)
    const capped = defaultBackoff(100, () => 1)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(capped).toBeLessThanOrEqual(30_000)
  })
})

/** A controllable fake transport + scheduler for the stream orchestration. */
function harness(discovery: Discovery | undefined) {
  let handlers: ConnectHandlers | undefined
  let lastEventId = -1
  let closed = false
  const connect: Connect = (_d, since, h) => {
    handlers = h
    lastEventId = since
    return {
      close() {
        closed = true
      },
    }
  }
  let scheduled: (() => void) | undefined
  const schedule = (fn: () => void) => {
    scheduled = fn
    return () => {
      scheduled = undefined
    }
  }
  const events: Array<{ event: EngineEvent; seq: number }> = []
  const statuses: StreamStatus[] = []
  const stream = startEventStream({
    resolveDiscovery: () => discovery,
    onEvent: (event, seq) => events.push({ event, seq }),
    onStatus: (s) => statuses.push(s),
    connect,
    schedule,
    backoffMs: () => 1,
  })
  return {
    stream,
    events,
    statuses,
    fireScheduled: () => scheduled?.(),
    get handlers() {
      return handlers
    },
    get sinceUsed() {
      return lastEventId
    },
    get closed() {
      return closed
    },
  }
}

describe('startEventStream', () => {
  it('connects, decodes events, tracks status and last-event-id', () => {
    const h = harness(DISCOVERY)
    expect(h.statuses).toContain('connecting')
    h.handlers?.onOpen()
    expect(h.statuses).toContain('open')
    h.handlers?.onChunk('id: 7\ndata: {"type":"run-created","runId":"r","panelId":"p"}\n\n')
    expect(h.events).toEqual([{ event: { type: 'run-created', runId: 'r', panelId: 'p' }, seq: 7 }])
  })

  it('drops malformed frames without emitting', () => {
    const h = harness(DISCOVERY)
    h.handlers?.onChunk('id: 1\ndata: not json\n\n')
    h.handlers?.onChunk('id: 2\ndata: {"no":"type"}\n\n')
    expect(h.events).toEqual([])
  })

  it('reconnects on close and resumes from the last event id', () => {
    const h = harness(DISCOVERY)
    h.handlers?.onChunk('id: 4\ndata: {"type":"run-abandoned","runId":"r"}\n\n')
    h.handlers?.onClose()
    expect(h.statuses).toContain('reconnecting')
    h.fireScheduled() // the backoff timer fires -> reconnect
    expect(h.sinceUsed).toBe(4) // resumed from the last seen id
  })

  it('schedules a retry when discovery is not yet available', () => {
    const h = harness(undefined)
    expect(h.statuses).toContain('reconnecting')
    expect(h.handlers).toBeUndefined() // never connected
  })

  it('streams real SSE frames over loopback (default http transport)', async () => {
    let server: Server | undefined
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': connected\n\n')
        res.write('id: 9\ndata: {"type":"run-abandoned","runId":"r"}\n\n')
        setTimeout(() => res.end(), 20)
      })
      await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      const events: Array<{ event: EngineEvent; seq: number }> = []
      const stream = startEventStream({
        resolveDiscovery: () => ({ endpoint: `http://127.0.0.1:${port}`, token: 't' }),
        onEvent: (event, seq) => events.push({ event, seq }),
        backoffMs: () => 60_000, // don't reconnect during the test window
      })
      await new Promise((r) => setTimeout(r, 80))
      stream.close()
      expect(events).toEqual([{ event: { type: 'run-abandoned', runId: 'r' }, seq: 9 }])
    } finally {
      server?.close()
    }
  })

  it('schedules exactly ONE reconnect when a clean end+close both fire', async () => {
    let server: Server | undefined
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('id: 1\ndata: {"type":"run-abandoned","runId":"r"}\n\n')
        setTimeout(() => res.end(), 10) // clean end -> both 'end' and 'close' fire
      })
      await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      const statuses: StreamStatus[] = []
      const stream = startEventStream({
        resolveDiscovery: () => ({ endpoint: `http://127.0.0.1:${port}`, token: 't' }),
        onEvent: () => undefined,
        onStatus: (s) => statuses.push(s),
        backoffMs: () => 60_000,
      })
      await new Promise((r) => setTimeout(r, 80))
      stream.close()
      // The once-guard means end+close collapse to a single reconnect attempt.
      expect(statuses.filter((s) => s === 'reconnecting')).toHaveLength(1)
    } finally {
      server?.close()
    }
  })

  it('does not report "open" or reset backoff on a non-2xx response', async () => {
    let server: Server | undefined
    try {
      server = createServer((_req, res) => {
        res.writeHead(503)
        res.end('busy')
      })
      await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()))
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      const statuses: StreamStatus[] = []
      const stream = startEventStream({
        resolveDiscovery: () => ({ endpoint: `http://127.0.0.1:${port}`, token: 't' }),
        onEvent: () => undefined,
        onStatus: (s) => statuses.push(s),
        backoffMs: () => 60_000,
      })
      await new Promise((r) => setTimeout(r, 60))
      stream.close()
      expect(statuses).not.toContain('open') // a 503 is not an open stream
      expect(statuses).toContain('reconnecting')
    } finally {
      server?.close()
    }
  })

  it('stops reconnecting once closed', () => {
    const h = harness(DISCOVERY)
    h.handlers?.onClose()
    h.stream.close()
    expect(h.statuses).toContain('closed')
    expect(h.closed).toBe(true)
    h.fireScheduled() // firing a stale timer after close must be a no-op
    // still only the first connection happened (sinceUsed from the initial connect)
    expect(h.sinceUsed).toBe(0)
  })
})
