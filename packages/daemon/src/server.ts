import { createHash, timingSafeEqual } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { formatZodError } from '@open-consensus/config'
import type { z } from 'zod'
import type { DaemonCore } from './daemon'
import { clampWaitMs, parseIntParam, startRoundBodySchema, startRunBodySchema } from './schema'

const DEFAULT_MAX_BODY_BYTES = 2_000_000
const DEFAULT_PING_MS = 25_000
/** Hard ceiling on a single `/raw` page, independent of the client's `maxBytes`. */
const RAW_PAGE_CAP = 256_000
/** Receiving a full request must complete within this — bounds slow-body holds. */
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_SSE_CLIENTS = 64

export type ListenTarget = { socketPath: string } | { host: string; port: number }

export interface DaemonServerOptions {
  core: DaemonCore
  token: string
  maxBodyBytes?: number
  pingMs?: number
  /** Cap on concurrent SSE connections (excess get 503). */
  maxSseClients?: number
}

/**
 * Constant-time bearer-token comparison. Hashing both sides to fixed-length
 * digests makes the compare constant-time regardless of input length — so it
 * leaks neither the value nor the length of the expected token.
 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  })
  res.end(payload)
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders?: Record<string, string>,
): void {
  sendJson(res, status, { error: message }, extraHeaders)
}

/** Read a request body up to `max` bytes; resolves `null` if it overflows. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    let done = false
    const finish = (value: Buffer | null) => {
      if (!done) {
        done = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      if (overflow) return
      size += chunk.length
      if (size > max) {
        overflow = true
        finish(null)
        // Stop consuming the body; the caller sends a 413 with `Connection:
        // close`, so the socket is torn down rather than held by a slow client.
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflow) finish(Buffer.concat(chunks))
    })
    req.on('error', () => finish(null))
    // A client that aborts mid-body emits 'close' without 'end' — resolve so the
    // awaiting handler never leaks (a no-op after a normal 'end').
    req.on('close', () => finish(null))
  })
}

/**
 * The daemon's HTTP surface (plan D2/D11/D12) over a unix socket (default) or a
 * loopback fallback. Every request needs a bearer token; loopback additionally
 * validates `Host`/`Origin` by exact match (DNS-rebinding defense). Routes are
 * thin shims over {@link DaemonCore}; SSE and long-poll are two views of one log.
 */
export class DaemonServer {
  private readonly http: Server
  private readonly core: DaemonCore
  private readonly token: string
  private readonly maxBodyBytes: number
  private readonly pingMs: number
  private readonly maxSseClients: number
  /** Set once when bound to loopback: the exact `host:port` we require. */
  private expectedHost: string | undefined
  /** True once `listen()` has bound, so `close()` won't hang on a dead server. */
  private listening = false
  /** Open SSE connections, closed on shutdown. */
  private readonly sseClients = new Set<ServerResponse>()

  constructor(opts: DaemonServerOptions) {
    this.core = opts.core
    this.token = opts.token
    this.maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    this.pingMs = opts.pingMs ?? DEFAULT_PING_MS
    this.maxSseClients = opts.maxSseClients ?? DEFAULT_MAX_SSE_CLIENTS
    this.http = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 500, 'internal error')
        else res.end()
      })
    })
    // Bound how long a client may take to deliver a full request (slow-body
    // defense); does not apply to the long-poll/SSE response wait.
    this.http.requestTimeout = REQUEST_TIMEOUT_MS
  }

  /** Begin listening; resolves the published endpoint (socket path / loopback URL). */
  listen(target: ListenTarget): Promise<string> {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject)
      const onListening = () => {
        this.http.removeListener('error', reject)
        this.listening = true
        if ('socketPath' in target) {
          try {
            // Force 0600 on the socket file itself (umask-independent); the
            // runtime dir is already 0700, but the socket must not depend on the
            // umask.
            chmodSync(target.socketPath, 0o600)
          } catch (err) {
            // A throw here would escape the 'listening' callback and bypass
            // startDaemon's rollback — close + reject so rollback fires.
            this.listening = false
            this.http.close()
            reject(err)
            return
          }
          resolve(target.socketPath)
          return
        }
        const addr = this.http.address()
        const port = typeof addr === 'object' && addr ? addr.port : target.port
        // Set the expected Host BEFORE resolving so a request can never be
        // handled with Host/Origin validation disabled.
        this.expectedHost = `${target.host}:${port}`
        resolve(`http://${this.expectedHost}`)
      }
      if ('socketPath' in target) this.http.listen(target.socketPath, onListening)
      else this.http.listen(target.port, target.host, onListening)
    })
  }

  close(): Promise<void> {
    for (const res of this.sseClients) res.end()
    this.sseClients.clear()
    // A server that never bound (startup rolled back) has no close callback —
    // returning here keeps the rollback from awaiting forever.
    if (!this.listening) return Promise.resolve()
    this.listening = false
    return new Promise((resolve) => {
      this.http.close(() => resolve())
      // Force-close lingering sockets (idle keep-alive + any open SSE) so the
      // close callback fires promptly instead of waiting on the client.
      this.http.closeAllConnections?.()
    })
  }

  // -- auth --------------------------------------------------------------

  private authorize(
    req: IncomingMessage,
  ): { ok: true } | { ok: false; status: number; message: string } {
    const header = req.headers.authorization ?? ''
    const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!provided || !tokenMatches(provided, this.token)) {
      return { ok: false, status: 401, message: 'unauthorized' }
    }
    // Loopback only: reject mismatched Host/Origin (DNS-rebinding defense, D2).
    if (this.expectedHost !== undefined) {
      if (req.headers.host !== this.expectedHost) {
        return { ok: false, status: 403, message: 'bad host' }
      }
      const origin = req.headers.origin
      if (origin !== undefined && origin !== `http://${this.expectedHost}`) {
        return { ok: false, status: 403, message: 'bad origin' }
      }
    }
    return { ok: true }
  }

  // -- routing -----------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.authorize(req)
    if (!auth.ok) return sendError(res, auth.status, auth.message)

    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    let seg: string[]
    try {
      seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    } catch {
      return sendError(res, 400, 'malformed path') // invalid percent-encoding
    }

    if (method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true })
    if (method === 'GET' && url.pathname === '/panels') {
      return sendJson(res, 200, { panels: this.core.listPanels() })
    }
    if (method === 'GET' && url.pathname === '/events') return this.handleSse(req, res, url)
    if (url.pathname === '/raw' && method === 'GET') {
      const ref = url.searchParams.get('ref')
      if (!ref) return sendError(res, 400, 'ref is required')
      const cursor = parseIntParam(url.searchParams.get('cursor'), 0)
      // Clamp the page to a server cap so a client can't ask for an unbounded read.
      const maxBytes = Math.min(
        parseIntParam(url.searchParams.get('maxBytes'), 64_000),
        RAW_PAGE_CAP,
      )
      return sendJson(res, 200, this.core.readRaw(ref, cursor, maxBytes))
    }
    if (url.pathname === '/runs') {
      if (method === 'GET') {
        const stateParam = url.searchParams.get('state')
        const state =
          stateParam === 'running' || stateParam === 'abandoned' ? stateParam : undefined
        return sendJson(res, 200, { runs: this.core.listRuns(state) })
      }
      if (method === 'POST') return this.handleStartRun(req, res)
    }
    if (seg[0] === 'runs' && seg[1]) return this.handleRunScoped(req, res, method, seg)

    return sendError(res, 404, 'not found')
  }

  private async handleRunScoped(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    seg: string[],
  ): Promise<void> {
    const runId = seg[1] as string
    // /runs/:id/status
    if (seg.length === 3 && seg[2] === 'status' && method === 'GET') {
      const status = this.core.status(runId)
      return status ? sendJson(res, 200, status) : sendError(res, 404, 'unknown run')
    }
    // /runs/:id/cancel
    if (seg.length === 3 && seg[2] === 'cancel' && method === 'POST') {
      return sendJson(res, 200, this.core.cancelRun(runId))
    }
    // /runs/:id/rounds (POST -> add a round)
    if (seg.length === 3 && seg[2] === 'rounds' && method === 'POST') {
      return this.handleStartRound(req, res, runId)
    }
    // /runs/:id/rounds/:roundId (GET -> long-poll)
    if (seg.length === 4 && seg[2] === 'rounds' && method === 'GET') {
      const roundId = seg[3] as string
      const url = new URL(req.url ?? '/', 'http://localhost')
      const waitMs = clampWaitMs(url.searchParams.get('wait_ms'), Number.POSITIVE_INFINITY)
      const snapshot = await this.core.waitRound(runId, roundId, waitMs)
      return snapshot ? sendJson(res, 200, snapshot) : sendError(res, 404, 'unknown round')
    }
    // /runs/:id/rounds/:roundId/cancel
    if (seg.length === 5 && seg[2] === 'rounds' && seg[4] === 'cancel' && method === 'POST') {
      return sendJson(res, 200, this.core.cancelRound(runId, seg[3] as string))
    }
    return sendError(res, 404, 'not found')
  }

  private async handleStartRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.parseBody(req, res, startRunBodySchema)
    if (!body) return
    const result = this.core.startRun(body.panel, body.prompt)
    if ('error' in result) return sendError(res, 400, result.error)
    sendJson(res, 200, result)
  }

  private async handleStartRound(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
  ): Promise<void> {
    const body = await this.parseBody(req, res, startRoundBodySchema)
    if (!body) return
    const result = this.core.startRound(runId, body.prompt)
    if ('error' in result) return sendError(res, 400, result.error)
    sendJson(res, 200, result)
  }

  /** Read + zod-parse a JSON body; writes the error response and returns null on failure. */
  private async parseBody<T>(
    req: IncomingMessage,
    res: ServerResponse,
    schema: { safeParse: (v: unknown) => z.SafeParseReturnType<unknown, T> },
  ): Promise<T | null> {
    const raw = await readBody(req, this.maxBodyBytes)
    if (raw === null) {
      sendError(res, 413, 'request body too large', { connection: 'close' })
      return null
    }
    let json: unknown
    try {
      json = JSON.parse(raw.toString('utf8') || '{}')
    } catch {
      sendError(res, 400, 'invalid JSON body')
      return null
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      sendError(res, 400, `invalid request:\n${formatZodError(parsed.error)}`)
      return null
    }
    return parsed.data
  }

  // -- SSE ---------------------------------------------------------------

  private handleSse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    // Bound concurrent streams so a flood of connections can't exhaust memory.
    if (this.sseClients.size >= this.maxSseClients) {
      sendError(res, 503, 'too many event streams')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // Flush headers immediately so the client's `response` event fires now,
    // rather than waiting for the first engine event (a connect handshake).
    res.write(': connected\n\n')
    this.sseClients.add(res)

    const headerId = req.headers['last-event-id']
    const lastEventId = parseIntParam(
      typeof headerId === 'string' ? headerId : url.searchParams.get('lastEventId'),
      0,
    )

    const writeRaw = (seq: number, payload: string): void => {
      res.write(`id: ${seq}\ndata: ${payload}\n\n`)
    }

    // Subscribe BEFORE backfill so no live event is missed; the guard dedupes any
    // overlap with the (synchronous, never-interleaved) backfill below.
    let highWater = lastEventId
    const unsubscribe = this.core.subscribe((event, seq) => {
      this.core.touch(event.runId) // SSE activity resets the run's idle TTL (D14)
      if (seq > highWater) writeRaw(seq, JSON.stringify(event))
    })

    // Register cleanup + handlers BEFORE backfill, so a throw during backfill (a
    // DB read / write error) still tears down the subscription via res 'close'.
    const ping = setInterval(() => res.write(': ping\n\n'), this.pingMs)
    if (typeof ping.unref === 'function') ping.unref()
    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(ping)
      unsubscribe()
      this.sseClients.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
    // A write to a dropped client emits 'error' (EPIPE/ECONNRESET); handle both
    // streams so an unhandled error can't crash the daemon and cleanup is
    // exhaustive even when 'close' doesn't follow a socket error.
    req.on('error', cleanup)
    res.on('error', cleanup)

    // Backfill missed events from the durable log (synchronous; the event loop is
    // blocked, so no live event can interleave and duplicate).
    let since = lastEventId
    for (;;) {
      const { events, hasMore } = this.core.backfill(since)
      for (const e of events) {
        if (e.runId) this.core.touch(e.runId) // backfilled SSE traffic also resets the TTL
        writeRaw(e.seq, e.payload)
        since = e.seq
      }
      if (!hasMore) break
    }
    highWater = since
  }
}
