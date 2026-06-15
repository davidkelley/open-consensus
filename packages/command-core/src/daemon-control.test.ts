import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DaemonNotRunningError,
  DaemonRpcError,
  daemonStatusCommand,
  ensureDaemonRunning,
  listDaemonPanelsCommand,
  listRunsCommand,
  runDaemonForeground,
  runStatusCommand,
  spawnDetachedDaemon,
  startRunCommand,
  stopDaemonCommand,
} from './daemon-control'

let dir: string
let discoveryPath: string
let server: Server
let endpoint: string
const TOKEN = 'test-token'

function isAliveForTest(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A minimal fake daemon HTTP server covering the routes command-core calls. */
function startFakeServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url === '/health') return send(200, { ok: true })
    if (req.method === 'GET' && url === '/panels') {
      return send(200, { panels: [{ id: 'p', name: 'P', agentIds: ['a'], quorum: 1 }] })
    }
    if (req.method === 'GET' && url.startsWith('/runs') && !url.includes('/status')) {
      return send(200, { runs: [{ runId: 'r1', panelId: 'p', state: 'running', createdAt: 0 }] })
    }
    if (req.method === 'POST' && url === '/runs') return send(200, { runId: 'r1', roundId: 'rd1' })
    if (req.method === 'GET' && url === '/runs/r1/status') {
      return send(200, {
        run: { runId: 'r1', panelId: 'p', state: 'running', createdAt: 0 },
        round: undefined,
        stateVersion: 3,
      })
    }
    if (req.method === 'GET' && url === '/runs/bad/status')
      return send(404, { error: 'no such run' })
    if (req.method === 'GET' && url === '/runs/err/status') {
      res.writeHead(500, { 'content-type': 'text/plain' })
      return res.end('boom')
    }
    send(404, { error: 'not found' })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') endpoint = `http://127.0.0.1:${addr.port}`
      resolve()
    })
  })
}

function writeDiscovery(d: { endpoint?: string; token?: string; pid?: number }): void {
  writeFileSync(discoveryPath, JSON.stringify({ endpoint, token: TOKEN, ...d }))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oc-daemon-'))
  discoveryPath = join(dir, 'discovery.json')
  await startFakeServer()
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('daemon RPC', () => {
  it('startRunCommand posts and returns the run + round ids', async () => {
    writeDiscovery({})
    expect(await startRunCommand(discoveryPath, { panel: 'p', prompt: 'hi' })).toEqual({
      runId: 'r1',
      roundId: 'rd1',
    })
  })

  it('runStatusCommand returns the snapshot', async () => {
    writeDiscovery({})
    const status = await runStatusCommand(discoveryPath, 'r1')
    expect(status.stateVersion).toBe(3)
    expect(status.run.runId).toBe('r1')
  })

  it('listRunsCommand and listDaemonPanelsCommand parse their envelopes', async () => {
    writeDiscovery({})
    expect((await listRunsCommand(discoveryPath)).map((r) => r.runId)).toEqual(['r1'])
    expect((await listRunsCommand(discoveryPath, 'running')).length).toBe(1)
    expect((await listDaemonPanelsCommand(discoveryPath)).map((p) => p.id)).toEqual(['p'])
  })

  it('throws DaemonRpcError on a non-2xx JSON response', async () => {
    writeDiscovery({})
    await expect(runStatusCommand(discoveryPath, 'bad')).rejects.toMatchObject({
      name: 'DaemonRpcError',
      status: 404,
    })
  })

  it('throws DaemonRpcError on a non-2xx non-JSON response', async () => {
    writeDiscovery({})
    const err = await runStatusCommand(discoveryPath, 'err').catch((e) => e)
    expect(err).toBeInstanceOf(DaemonRpcError)
    expect(err.message).toBe('boom')
  })

  it('throws DaemonNotRunningError when no discovery file exists', async () => {
    await expect(
      startRunCommand(discoveryPath, { panel: 'p', prompt: 'x' }),
    ).rejects.toBeInstanceOf(DaemonNotRunningError)
  })
})

describe('daemonStatusCommand', () => {
  it('reports not-running with no discovery', async () => {
    expect(await daemonStatusCommand(discoveryPath)).toEqual({ running: false })
  })

  it('reports running + healthy against a live daemon', async () => {
    writeDiscovery({ pid: 4242 })
    expect(await daemonStatusCommand(discoveryPath)).toMatchObject({
      running: true,
      healthy: true,
      endpoint,
      pid: 4242,
    })
  })

  it('reports running but unhealthy when the endpoint is dead', async () => {
    writeFileSync(discoveryPath, JSON.stringify({ endpoint: 'http://127.0.0.1:1', token: TOKEN }))
    expect(await daemonStatusCommand(discoveryPath)).toMatchObject({
      running: true,
      healthy: false,
    })
  })
})

describe('ensureDaemonRunning', () => {
  it('returns the existing daemon without launching when already healthy', async () => {
    writeDiscovery({})
    let launched = false
    const d = await ensureDaemonRunning({
      discoveryPath,
      launch: () => {
        launched = true
      },
    })
    expect(d.endpoint).toBe(endpoint)
    expect(launched).toBe(false)
  })

  it('launches and waits for readiness when absent', async () => {
    const d = await ensureDaemonRunning({
      discoveryPath,
      // The "spawn" writes the discovery file, as a real detached daemon would.
      launch: () => writeDiscovery({}),
      attempts: 20,
      intervalMs: 5,
    })
    expect(d.endpoint).toBe(endpoint)
  })

  it('throws if the daemon never becomes ready', async () => {
    await expect(
      ensureDaemonRunning({ discoveryPath, launch: () => {}, attempts: 2, intervalMs: 1 }),
    ).rejects.toThrow(/did not become ready/)
  })
})

describe('runDaemonForeground', () => {
  it('starts, signals onStarted, waits for shutdown, then stops', async () => {
    const order: string[] = []
    let resolveShutdown!: () => void
    const shutdown = new Promise<void>((r) => {
      resolveShutdown = r
    })
    const run = runDaemonForeground({
      start: async () => ({
        endpoint,
        stop: async () => {
          order.push('stop')
        },
      }),
      onStarted: (e) => order.push(`started:${e}`),
      waitForShutdown: () => shutdown,
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([`started:${endpoint}`]) // still running, not yet stopped
    resolveShutdown()
    await run
    expect(order).toEqual([`started:${endpoint}`, 'stop'])
  })

  it('still stops the daemon if the shutdown wait rejects', async () => {
    let stopped = false
    await expect(
      runDaemonForeground({
        start: async () => ({
          endpoint,
          stop: async () => {
            stopped = true
          },
        }),
        waitForShutdown: () => Promise.reject(new Error('boom')),
      }),
    ).rejects.toThrow('boom')
    expect(stopped).toBe(true)
  })
})

describe('spawnDetachedDaemon', () => {
  it('spawns a detached, unref-ed child and returns it', () => {
    const child = spawnDetachedDaemon({ command: process.execPath, args: ['-e', ''] })
    expect(typeof child.pid).toBe('number')
    child.on('error', () => {}) // ignore — the no-op child exits immediately
  })
})

describe('stopDaemonCommand', () => {
  it('reports not running with no discovery', async () => {
    expect(await stopDaemonCommand(discoveryPath)).toMatchObject({ stopped: false })
  })

  it('reports cleanly when discovery has no pid', async () => {
    writeFileSync(discoveryPath, JSON.stringify({ endpoint, token: TOKEN }))
    expect(await stopDaemonCommand(discoveryPath)).toMatchObject({
      stopped: false,
      reason: expect.stringMatching(/no pid/),
    })
  })

  it('signals a live process and waits for it to exit', async () => {
    const child: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      stdio: 'ignore',
    })
    await new Promise((r) => setTimeout(r, 50)) // let it start
    writeDiscovery({ pid: child.pid })
    const result = await stopDaemonCommand(discoveryPath, { attempts: 100, intervalMs: 20 })
    expect(result.stopped).toBe(true)
    expect(result.pid).toBe(child.pid)
  })

  it('refuses to signal a PID when the endpoint is not responding (stale/reused)', async () => {
    // Live, signalable process, but the discovery endpoint is dead -> we must NOT
    // signal it (it could be a recycled PID owned by something unrelated).
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(
      discoveryPath,
      JSON.stringify({ endpoint: 'http://127.0.0.1:1', token: TOKEN, pid: child.pid }),
    )
    const result = await stopDaemonCommand(discoveryPath)
    expect(result).toMatchObject({
      stopped: false,
      reason: expect.stringMatching(/not responding/),
    })
    expect(isAliveForTest(child.pid)).toBe(true) // still alive — we did not signal it
    child.kill('SIGKILL')
  })

  it('reports failure when the process ignores the signal and never exits', async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)"],
      { stdio: 'ignore' },
    )
    await new Promise((r) => setTimeout(r, 50))
    writeDiscovery({ pid: child.pid })
    const result = await stopDaemonCommand(discoveryPath, { attempts: 2, intervalMs: 5 })
    expect(result).toMatchObject({ stopped: false, reason: expect.stringMatching(/did not exit/) })
    child.kill('SIGKILL') // clean up the deliberately-stubborn child
  })

  it('treats an already-dead pid as stopped (ESRCH)', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid
    await new Promise((r) => child.on('close', r)) // it has fully exited
    writeDiscovery({ pid })
    const result = await stopDaemonCommand(discoveryPath)
    expect(result).toMatchObject({ stopped: true, reason: expect.stringMatching(/already exited/) })
  })
})
