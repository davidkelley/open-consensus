import { request } from 'node:http'
import type { Discovery } from '@open-consensus/daemon'
import type { EngineEvent } from '@open-consensus/engine'

/**
 * Daemon SSE subscription for the TUI (plan D11/D19). The daemon streams
 * `id: <seq>\ndata: <EngineEvent JSON>\n\n` frames (plus `:` comment pings) on
 * `/events`, supporting `Last-Event-ID` so a reconnect back-fills missed events
 * from the durable log — which doubles as the snapshot. This module is the
 * `tui-session` stream concern the stateless command-core deliberately lacks; the
 * reconnect/backoff orchestration is injectable so it's unit-tested without a
 * real socket.
 */
export interface SseFrame {
  id?: number
  data: string
}

/** Incremental SSE frame parser: feed raw chunks, get back complete frames. */
export class SseParser {
  private buf = ''

  feed(chunk: string): SseFrame[] {
    this.buf += chunk
    const frames: SseFrame[] = []
    let sep = this.buf.indexOf('\n\n')
    while (sep !== -1) {
      const frame = parseFrame(this.buf.slice(0, sep))
      if (frame) frames.push(frame)
      this.buf = this.buf.slice(sep + 2)
      sep = this.buf.indexOf('\n\n')
    }
    return frames
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  let id: number | undefined
  const data: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue // comment (`: ping` / `: connected`)
    if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim())
      if (Number.isFinite(n)) id = n
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (data.length === 0) return undefined // comment-only frame
  return { ...(id !== undefined ? { id } : {}), data: data.join('\n') }
}

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface RawConnection {
  close(): void
}

export interface ConnectHandlers {
  onOpen(): void
  onChunk(chunk: string): void
  /** The connection ended (clean close or error); the stream will reconnect. */
  onClose(): void
}

export type Connect = (
  discovery: Discovery,
  lastEventId: number,
  handlers: ConnectHandlers,
) => RawConnection

export interface EventStreamDeps {
  /** Re-read every attempt — the daemon may have restarted on a new port (D19). */
  resolveDiscovery: () => Discovery | undefined
  onEvent: (event: EngineEvent, seq: number) => void
  onStatus?: (status: StreamStatus) => void
  /** Connection transport (defaults to a real node:http SSE connection). */
  connect?: Connect
  /** Reconnect delay for attempt N (defaults to exponential backoff + jitter, cap 30s). */
  backoffMs?: (attempt: number) => number
  /** Schedule a delayed callback; returns a canceller (injected for tests). */
  schedule?: (fn: () => void, ms: number) => () => void
  /** Jitter source (defaults to Math.random). */
  random?: () => number
}

const MAX_BACKOFF_MS = 30_000

export interface EventStream {
  close(): void
}

/**
 * Start a reconnecting SSE subscription. Tracks the highest seen `Last-Event-ID`
 * so a reconnect resumes exactly where it left off; reconnects with exponential
 * backoff + jitter (cap 30s), re-reading discovery each attempt.
 */
export function startEventStream(deps: EventStreamDeps): EventStream {
  const connect = deps.connect ?? httpConnect
  const random = deps.random ?? Math.random
  const schedule = deps.schedule ?? defaultSchedule
  const backoff = deps.backoffMs ?? ((attempt) => defaultBackoff(attempt, random))

  let lastEventId = 0
  let attempt = 0
  let closed = false
  let conn: RawConnection | undefined
  let cancelTimer: (() => void) | undefined

  const setStatus = (s: StreamStatus) => deps.onStatus?.(s)

  const scheduleReconnect = () => {
    if (closed) return
    setStatus('reconnecting')
    const delay = backoff(attempt)
    attempt += 1
    cancelTimer = schedule(connectOnce, delay)
  }

  function connectOnce(): void {
    if (closed) return
    const discovery = deps.resolveDiscovery()
    if (!discovery) {
      // Daemon not discoverable yet (e.g. mid-restart rename) — retry on backoff.
      scheduleReconnect()
      return
    }
    setStatus('connecting')
    const parser = new SseParser()
    conn = connect(discovery, lastEventId, {
      onOpen() {
        attempt = 0
        setStatus('open')
      },
      onChunk(chunk) {
        for (const frame of parser.feed(chunk)) {
          if (frame.id !== undefined && frame.id > lastEventId) lastEventId = frame.id
          const event = decodeEvent(frame.data)
          if (event && frame.id !== undefined) deps.onEvent(event, frame.id)
        }
      },
      onClose() {
        if (!closed) scheduleReconnect()
      },
    })
  }

  connectOnce()

  return {
    close() {
      closed = true
      setStatus('closed')
      cancelTimer?.()
      conn?.close()
    },
  }
}

function decodeEvent(data: string): EngineEvent | undefined {
  try {
    const parsed = JSON.parse(data)
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as EngineEvent
    }
  } catch {
    /* malformed frame — drop it rather than crash the stream */
  }
  return undefined
}

export function defaultBackoff(attempt: number, random: () => number): number {
  const base = Math.min(MAX_BACKOFF_MS, 250 * 2 ** attempt)
  return Math.round(base / 2 + random() * (base / 2)) // full-ish jitter, never 0
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms)
  if (typeof t.unref === 'function') t.unref()
  return () => clearTimeout(t)
}

/** Real transport: a streaming node:http GET /events with the bearer token. */
function httpConnect(
  discovery: Discovery,
  lastEventId: number,
  handlers: ConnectHandlers,
): RawConnection {
  const isHttp = discovery.endpoint.startsWith('http://')
  const headers: Record<string, string> = {
    authorization: `Bearer ${discovery.token}`,
    accept: 'text/event-stream',
    ...(lastEventId > 0 ? { 'last-event-id': String(lastEventId) } : {}),
  }
  const common = { method: 'GET', path: '/events', headers }
  const options = isHttp
    ? { ...common, ...hostPort(discovery.endpoint) }
    : { ...common, socketPath: discovery.endpoint }

  const req = request(options, (res) => {
    handlers.onOpen()
    res.setEncoding('utf8')
    res.on('data', (chunk: string) => handlers.onChunk(chunk))
    res.on('end', () => handlers.onClose())
    res.on('close', () => handlers.onClose())
    res.on('error', () => handlers.onClose())
  })
  req.on('error', () => handlers.onClose())
  req.end()
  return { close: () => req.destroy() }
}

function hostPort(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint)
  return { host: url.hostname, port: Number(url.port) }
}
