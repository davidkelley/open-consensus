import { mkdtempSync, rmSync } from 'node:fs'
import { type IncomingMessage, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createMockAdapter } from '@open-consensus/adapters'
import { type Config, parseConfig } from '@open-consensus/config'
import { EngineStore } from '@open-consensus/engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { daemonRequest } from './client'
import { DaemonCore } from './daemon'
import type { AdapterRegistry } from './resolver'
import { DaemonServer } from './server'

const registry: AdapterRegistry = new Map([['mock', createMockAdapter({ slowMs: 2000 })]])
const config: Config = parseConfig({
  schemaVersion: 1,
  agents: [
    { id: 'a-ok', name: 'OK', adapter: 'mock', model: 'mock:ok', maxRetries: 0 },
    { id: 'a-slow', name: 'Slow', adapter: 'mock', model: 'mock:slow', maxRetries: 0 },
  ],
  panels: [
    { id: 'p-ok', name: 'OK', agentIds: ['a-ok'], quorum: 1 },
    { id: 'p-slow', name: 'Slow', agentIds: ['a-slow'], quorum: 1 },
  ],
})

const TOKEN = 'test-token-12345'

function makeServer(opts: { maxBodyBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-srv-'))
  const store = new EngineStore({ dbPath: ':memory:', rawDir: join(dir, 'raw') })
  const core = new DaemonCore({ store, config, adapters: registry, maxWaitMs: 5000 })
  const server = new DaemonServer({
    core,
    token: TOKEN,
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
  })
  return {
    server,
    core,
    async start() {
      return server.listen({ host: '127.0.0.1', port: 0 })
    },
    async cleanup() {
      await core.drain()
      await server.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const json = (res: { body: string }) => JSON.parse(res.body)

/** Raw POST with an arbitrary (possibly invalid) body string. */
function rawPost(
  endpoint: string,
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        method: 'POST',
        path,
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** Open an SSE stream; accumulate the text body until closed. */
function openEvents(endpoint: string, lastEventId?: number) {
  const url = new URL(endpoint)
  let data = ''
  let req: ReturnType<typeof request>
  const ready = new Promise<IncomingMessage>((resolve, reject) => {
    req = request(
      {
        host: url.hostname,
        port: Number(url.port),
        method: 'GET',
        path: '/events',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(lastEventId !== undefined ? { 'last-event-id': String(lastEventId) } : {}),
        },
      },
      (res) => {
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          data += c
        })
        resolve(res)
      },
    )
    req.on('error', reject)
    req.end()
  })
  return { ready, data: () => data, close: () => req.destroy() }
}

async function waitForText(getData: () => string, needle: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (getData().includes(needle)) return
    await delay(20)
  }
  throw new Error(`timed out waiting for "${needle}" in SSE stream`)
}

describe('DaemonServer over loopback', () => {
  let h: ReturnType<typeof makeServer>
  let endpoint: string
  beforeEach(async () => {
    h = makeServer()
    endpoint = await h.start()
  })
  afterEach(() => h.cleanup())

  it('serves a health check', async () => {
    const res = await daemonRequest(endpoint, TOKEN, { method: 'GET', path: '/health' })
    expect(res.status).toBe(200)
    expect(json(res)).toEqual({ ok: true })
  })

  it('rejects a missing or wrong token with 401', async () => {
    expect((await daemonRequest(endpoint, '', { method: 'GET', path: '/health' })).status).toBe(401)
    expect(
      (await daemonRequest(endpoint, 'wrong', { method: 'GET', path: '/health' })).status,
    ).toBe(401)
  })

  it('rejects a mismatched Host or Origin with 403 (DNS-rebinding defense)', async () => {
    const badHost = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: '/health',
      headers: { host: 'evil.example' },
    })
    expect(badHost.status).toBe(403)
    const badOrigin = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: '/health',
      headers: { origin: 'http://evil.example' },
    })
    expect(badOrigin.status).toBe(403)
  })

  it('lists panels', async () => {
    const res = await daemonRequest(endpoint, TOKEN, { method: 'GET', path: '/panels' })
    expect(json(res).panels.map((p: { id: string }) => p.id)).toEqual(['p-ok', 'p-slow'])
  })

  it('starts a run, polls it, reads its raw output, and lists it', async () => {
    const start = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: '/runs',
      body: { panel: 'p-ok', prompt: 'hello world' },
    })
    expect(start.status).toBe(200)
    const { runId, roundId } = json(start)

    const poll = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: `/runs/${runId}/rounds/${roundId}?wait_ms=5000`,
    })
    const snap = json(poll)
    expect(snap.done).toBe(true)
    expect(snap.round.verdict).toBe('met')

    const ref = snap.round.invocations[0].rawRef
    const raw = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: `/raw?ref=${encodeURIComponent(ref)}`,
    })
    expect(json(raw).chunk).toContain('hello world')

    const status = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: `/runs/${runId}/status`,
    })
    expect(json(status).run.runId).toBe(runId)

    const runs = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: '/runs?state=running',
    })
    expect(json(runs).runs.map((r: { runId: string }) => r.runId)).toContain(runId)
  })

  it('adds a round to a run', async () => {
    const start = json(
      await daemonRequest(endpoint, TOKEN, {
        method: 'POST',
        path: '/runs',
        body: { panel: 'p-ok', prompt: 'one' },
      }),
    )
    await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: `/runs/${start.runId}/rounds/${start.roundId}?wait_ms=5000`,
    })
    const round = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: `/runs/${start.runId}/rounds`,
      body: { prompt: 'two' },
    })
    expect(round.status).toBe(200)
    expect(json(round).roundId).toBeDefined()
  })

  it('cancels a run and a single round', async () => {
    const start = json(
      await daemonRequest(endpoint, TOKEN, {
        method: 'POST',
        path: '/runs',
        body: { panel: 'p-slow', prompt: 'long' },
      }),
    )
    const cancel = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: `/runs/${start.runId}/cancel`,
    })
    expect(json(cancel).cancelled).toBeGreaterThanOrEqual(0)
    const cancelRound = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: `/runs/${start.runId}/rounds/${start.roundId}/cancel`,
    })
    expect(json(cancelRound)).toHaveProperty('cancelled')
  })

  it('validates inputs: bad panel (400), unknown run (400/404), missing fields, bad JSON, 404', async () => {
    const badPanel = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: '/runs',
      body: { panel: 'ghost', prompt: 'x' },
    })
    expect(badPanel.status).toBe(400)

    const unknownRunRound = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: '/runs/nope/rounds',
      body: { prompt: 'x' },
    })
    expect(unknownRunRound.status).toBe(400)

    const unknownStatus = await daemonRequest(endpoint, TOKEN, {
      method: 'GET',
      path: '/runs/nope/status',
    })
    expect(unknownStatus.status).toBe(404)

    const missingPrompt = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: '/runs',
      body: { panel: 'p-ok' },
    })
    expect(missingPrompt.status).toBe(400)

    expect((await rawPost(endpoint, '/runs', '{not json')).status).toBe(400)

    const missingRef = await daemonRequest(endpoint, TOKEN, { method: 'GET', path: '/raw' })
    expect(missingRef.status).toBe(400)

    expect((await daemonRequest(endpoint, TOKEN, { method: 'GET', path: '/nope' })).status).toBe(
      404,
    )
    // An unmatched run-scoped sub-route also 404s.
    expect(
      (await daemonRequest(endpoint, TOKEN, { method: 'GET', path: '/runs/x/mystery' })).status,
    ).toBe(404)
  })

  it('streams live events and backfills from Last-Event-ID', async () => {
    // Live: subscribe, then start a run and watch its events arrive.
    const live = openEvents(endpoint)
    await live.ready
    const start = json(
      await daemonRequest(endpoint, TOKEN, {
        method: 'POST',
        path: '/runs',
        body: { panel: 'p-ok', prompt: 'streamed' },
      }),
    )
    await waitForText(live.data, 'round-completed')
    expect(live.data()).toContain('run-created')
    live.close()

    // Backfill: a fresh connection from seq 0 replays the persisted log.
    const replay = openEvents(endpoint, 0)
    await replay.ready
    await waitForText(replay.data, start.runId)
    expect(replay.data()).toContain('id: 1')
    replay.close()
  })
})

describe('DaemonServer edge cases', () => {
  it('rejects an over-large body with 413', async () => {
    const h = makeServer({ maxBodyBytes: 50 })
    const endpoint = await h.start()
    const res = await daemonRequest(endpoint, TOKEN, {
      method: 'POST',
      path: '/runs',
      body: { panel: 'p-ok', prompt: 'x'.repeat(500) },
    })
    expect(res.status).toBe(413)
    await h.cleanup()
  })

  it('returns 500 when a handler throws', async () => {
    const throwingCore = {
      listPanels() {
        throw new Error('boom')
      },
    } as unknown as DaemonCore
    const server = new DaemonServer({ core: throwingCore, token: TOKEN })
    const endpoint = await server.listen({ host: '127.0.0.1', port: 0 })
    const res = await daemonRequest(endpoint, TOKEN, { method: 'GET', path: '/panels' })
    expect(res.status).toBe(500)
    await server.close()
  })

  it('closes open SSE connections on shutdown', async () => {
    const h = makeServer()
    const endpoint = await h.start()
    const stream = openEvents(endpoint)
    const res = await stream.ready
    let ended = false
    res.on('end', () => {
      ended = true
    })
    await h.cleanup() // server.close() ends SSE responses
    await delay(50)
    expect(ended).toBe(true)
  })
})

describe('DaemonServer over a unix socket', () => {
  it('serves requests over a 0600 unix socket', async () => {
    const dir = mkdtempSync(join('/tmp', 'oc-sock-'))
    const socketPath = join(dir, 'd.sock')
    const store = new EngineStore({ dbPath: ':memory:', rawDir: join(dir, 'raw') })
    const core = new DaemonCore({ store, config, adapters: registry })
    const server = new DaemonServer({ core, token: TOKEN })
    const endpoint = await server.listen({ socketPath })
    expect(endpoint).toBe(socketPath)

    const res = await daemonRequest(socketPath, TOKEN, { method: 'GET', path: '/health' })
    expect(res.status).toBe(200)
    // No Host/Origin enforcement over a local socket: a stray Origin still passes.
    const withOrigin = await daemonRequest(socketPath, TOKEN, {
      method: 'GET',
      path: '/health',
      headers: { origin: 'http://anything' },
    })
    expect(withOrigin.status).toBe(200)

    await server.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
})
