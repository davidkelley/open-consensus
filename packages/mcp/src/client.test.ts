import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonError, httpDaemonClient } from './client'

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void

/** A minimal stand-in for the daemon's HTTP surface (no real engine). */
function fakeDaemon(handler: Handler): Promise<{ endpoint: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ endpoint: `http://127.0.0.1:${port}`, server })
    })
  })
}

function ok(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(payload)
}

describe('httpDaemonClient', () => {
  let server: Server
  let endpoint: string
  let lastRequest: { method: string; url: string; auth: string | undefined; body: string }

  async function start(handler: Handler) {
    const d = await fakeDaemon((req, res, body) => {
      lastRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body,
      }
      handler(req, res, body)
    })
    server = d.server
    endpoint = d.endpoint
  }

  afterEach(() => {
    server?.close()
  })

  it('attaches the bearer token and parses each route', async () => {
    await start((req, res, body) => {
      const url = req.url ?? ''
      if (url === '/panels')
        return ok(res, { panels: [{ id: 'p', name: 'P', agentIds: ['a'], quorum: 1 }] })
      if (url.startsWith('/runs?state=')) return ok(res, { runs: [] })
      if (url === '/runs') return ok(res, { runId: 'run', roundId: 'rd', echo: JSON.parse(body) })
      if (url.endsWith('/rounds')) return ok(res, { roundId: 'rd2', echo: JSON.parse(body) })
      if (url.includes('/rounds/') && url.includes('cancel')) return ok(res, { cancelled: true })
      if (url.includes('/rounds/'))
        return ok(res, { round: undefined, stateVersion: 1, done: false })
      if (url.endsWith('/status'))
        return ok(res, { run: { runId: 'run' }, round: undefined, stateVersion: 2 })
      if (url.endsWith('/cancel')) return ok(res, { cancelled: 1 })
      if (url.startsWith('/raw?')) return ok(res, { chunk: 'abc', nextCursor: 3, eof: true })
      res.writeHead(404)
      res.end()
    })
    const client = httpDaemonClient(endpoint, 'tok-123')

    expect((await client.listPanels())[0]?.id).toBe('p')
    expect(lastRequest.auth).toBe('Bearer tok-123')
    expect(await client.listRuns('running')).toEqual([])

    const started = await client.startRun('p', 'go', 'key-1')
    expect(started.runId).toBe('run')
    expect(JSON.parse(lastRequest.body)).toEqual({
      panel: 'p',
      prompt: 'go',
      idempotencyKey: 'key-1',
    })

    await client.startRound('run', 'next')
    expect(JSON.parse(lastRequest.body)).toEqual({ prompt: 'next' })

    expect((await client.poll('run', 'rd', 1000)).done).toBe(false)
    expect(lastRequest.url).toContain('wait_ms=1000')
    expect((await client.status('run')).stateVersion).toBe(2)
    expect(await client.cancelRun('run')).toEqual({ cancelled: 1 })
    expect(await client.cancelRound('run', 'rd')).toEqual({ cancelled: true })

    const raw = await client.getRaw('run.rd.a.1', 0, 64)
    expect(raw).toEqual({ chunk: 'abc', nextCursor: 3, eof: true })
    expect(lastRequest.url).toContain('ref=run.rd.a.1')
    expect(lastRequest.url).toContain('maxBytes=64')
  })

  it('omits optional params when not provided', async () => {
    await start((_req, res) =>
      ok(res, {
        runs: [],
        runId: 'r',
        roundId: 'rd',
        round: undefined,
        stateVersion: 0,
        done: false,
        chunk: '',
        nextCursor: 0,
        eof: true,
      }),
    )
    const client = httpDaemonClient(endpoint, 't')
    await client.listRuns()
    expect(lastRequest.url).toBe('/runs')
    await client.startRun('p', 'go')
    expect(JSON.parse(lastRequest.body)).toEqual({ panel: 'p', prompt: 'go' })
    await client.poll('r', 'rd')
    expect(lastRequest.url).not.toContain('wait_ms')
    await client.getRaw('ref')
    expect(lastRequest.url).toBe('/raw?ref=ref')
  })

  it('throws a DaemonError carrying the status + message on a non-2xx', async () => {
    await start((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: "unknown panel 'ghost'" }))
    })
    const client = httpDaemonClient(endpoint, 't')
    await expect(client.startRun('ghost', 'x')).rejects.toMatchObject({
      name: 'DaemonError',
      status: 400,
      message: "unknown panel 'ghost'",
    })
  })

  it('falls back to the raw body when an error response is not JSON', async () => {
    await start((_req, res) => {
      res.writeHead(500)
      res.end('boom')
    })
    const client = httpDaemonClient(endpoint, 't')
    await expect(client.listPanels()).rejects.toThrow('boom')
    await expect(client.listPanels()).rejects.toBeInstanceOf(DaemonError)
  })
})
