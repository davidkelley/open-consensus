import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterRegistry } from '@open-consensus/daemon'
import type { EngineEvent } from '@open-consensus/engine'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from './app'
import type { EventStream, EventStreamDeps } from './session/sse'

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
const CTRL_C = '\x03'

let dir: string
let server: Server
let endpoint: string
let streamDeps: EventStreamDeps | undefined
let cancelled: string[]
let exited: number

function fakeStartStream(deps: EventStreamDeps): EventStream {
  streamDeps = deps
  return { close: () => undefined }
}

function emit(event: EngineEvent, seq: number): void {
  streamDeps?.onEvent(event, seq)
}

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (s: number, b: unknown) => {
      res.writeHead(s, { 'content-type': 'application/json' })
      res.end(JSON.stringify(b))
    }
    if (url === '/health') return send(200, { ok: true, pid: process.pid })
    if (url === '/events') {
      // A real SSE stream: emit a run's lifecycle, then hold the connection open.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': connected\n\n')
      res.write(
        'id: 1\ndata: {"type":"round-started","runId":"r1","roundId":"rd1","index":0,"agentIds":["a"]}\n\n',
      )
      res.write(
        'id: 2\ndata: {"type":"round-completed","runId":"r1","roundId":"rd1","verdict":"met"}\n\n',
      )
      return
    }
    if (req.method === 'POST' && url === '/runs') return send(200, { runId: 'r1', roundId: 'rd1' })
    if (req.method === 'POST' && url === '/runs/r1/cancel') return send(200, { cancelled: 1 })
    send(404, { error: 'nope' })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') endpoint = `http://127.0.0.1:${addr.port}`
      resolve()
    }),
  )
}

function renderApp(overrides: Partial<Parameters<typeof App>[0]> = {}) {
  const discoveryPath = join(dir, 'discovery.json')
  writeFileSync(discoveryPath, JSON.stringify({ endpoint, token: 't', pid: process.pid }))
  return render(
    <App
      configFile={join(dir, 'config.json')}
      discoveryPath={discoveryPath}
      registry={new Map() as AdapterRegistry}
      ensureDaemon={async () => undefined}
      cancelRun={async (id) => {
        cancelled.push(id)
      }}
      startStream={fakeStartStream}
      exit={() => {
        exited += 1
      }}
      {...overrides}
    />,
  )
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oc-app-'))
  streamDeps = undefined
  cancelled = []
  exited = 0
  await startServer()
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('App', () => {
  it('renders the greeting and a prompt', () => {
    const { lastFrame } = renderApp()
    expect(lastFrame()).toContain('Open Consensus')
    expect(lastFrame()).toContain('›')
  })

  it('dispatches a slash command and prints to the transcript', async () => {
    const { stdin, lastFrame } = renderApp()
    stdin.write('/help')
    await tick()
    stdin.write('\r')
    await tick()
    expect(lastFrame()).toContain('› /help') // echoed
    expect(lastFrame()).toContain('start a consensus run') // /run summary printed
  })

  it('reports an unknown command', async () => {
    const { stdin, lastFrame } = renderApp()
    stdin.write('/nope')
    await tick()
    stdin.write('\r')
    await tick()
    expect(lastFrame()).toContain("unknown command '/nope'")
  })

  it('reports free text as not-a-command', async () => {
    const { stdin, lastFrame } = renderApp()
    stdin.write('hello')
    await tick()
    stdin.write('\r')
    await tick()
    expect(lastFrame()).toContain('not a command')
  })

  it('starts a run, streams its timeline, and commits it on completion', async () => {
    const { stdin, lastFrame } = renderApp()
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick(60) // ensureDaemon + startRunCommand RPC
    expect(lastFrame()).toContain('started run r1')
    expect(streamDeps).toBeDefined()

    emit({ type: 'round-started', runId: 'r1', roundId: 'rd1', index: 0, agentIds: ['a'] }, 1)
    await tick()
    expect(lastFrame()).toContain('a: pending')

    emit(
      {
        type: 'invocation-finished',
        runId: 'r1',
        roundId: 'rd1',
        agentId: 'a',
        status: 'ok',
        attempts: 1,
      },
      2,
    )
    emit({ type: 'round-completed', runId: 'r1', roundId: 'rd1', verdict: 'met' }, 3)
    await tick()
    // Committed to the scrollback with the final verdict.
    expect(lastFrame()).toContain('met')
  })

  it('Ctrl+C cancels an active run server-side', async () => {
    const { stdin } = renderApp()
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick(60)
    emit({ type: 'round-started', runId: 'r1', roundId: 'rd1', index: 0, agentIds: ['a'] }, 1)
    await tick()
    stdin.write(CTRL_C)
    await tick()
    expect(cancelled).toEqual(['r1'])
    expect(exited).toBe(0) // first Ctrl+C cancels, does not exit
  })

  it('Ctrl+C during /run dispatch cancels the run once its id arrives', async () => {
    // Hold the daemon-ensure pending so Ctrl+C lands in the dispatch window
    // (run started on the daemon, but no id returned to the TUI yet).
    let releaseEnsure: () => void = () => undefined
    const { stdin } = renderApp({
      ensureDaemon: () =>
        new Promise<void>((r) => {
          releaseEnsure = r
        }),
    })
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick()
    stdin.write(CTRL_C) // in the dispatch window -> remember to cancel, don't exit
    await tick()
    expect(exited).toBe(0)
    releaseEnsure() // ensure resolves -> startRunCommand -> viewRun(r1) -> cancel
    await tick(60)
    expect(cancelled).toEqual(['r1'])
  })

  it('Ctrl+C exits when idle', async () => {
    const { stdin } = renderApp()
    stdin.write(CTRL_C)
    await tick()
    expect(exited).toBe(1)
  })

  it('drives a run over the REAL SSE transport when no stream is injected', async () => {
    // No `startStream` -> the production useDaemonEvents + httpConnect run against
    // the fake daemon's /events; a strong end-to-end of the live timeline path.
    const discoveryPath = join(dir, 'discovery.json')
    writeFileSync(discoveryPath, JSON.stringify({ endpoint, token: 't', pid: process.pid }))
    const { stdin, lastFrame } = render(
      <App
        configFile={join(dir, 'config.json')}
        discoveryPath={discoveryPath}
        registry={new Map() as AdapterRegistry}
        ensureDaemon={async () => undefined}
        exit={() => undefined}
      />,
    )
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick(120) // RPC + SSE connect + stream the two frames
    expect(lastFrame()).toContain('met') // round-completed streamed + committed
  })

  it('falls back to the real cancel RPC when no cancelRun is injected', async () => {
    // No `cancelRun` and no `exit` props -> exercises the production defaults
    // (cancelRunCommand against the daemon, and ink's own exit).
    const discoveryPath = join(dir, 'discovery.json')
    writeFileSync(discoveryPath, JSON.stringify({ endpoint, token: 't', pid: process.pid }))
    const { stdin, lastFrame } = render(
      <App
        configFile={join(dir, 'config.json')}
        discoveryPath={discoveryPath}
        registry={new Map() as AdapterRegistry}
        ensureDaemon={async () => undefined}
        startStream={fakeStartStream}
      />,
    )
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick(60)
    emit({ type: 'round-started', runId: 'r1', roundId: 'rd1', index: 0, agentIds: ['a'] }, 1)
    await tick()
    stdin.write(CTRL_C)
    await tick(40)
    expect(lastFrame()).toContain('cancel requested for r1')
  })

  it('a second Ctrl+C exits after a cancel is already in flight', async () => {
    const { stdin } = renderApp({ cancelRun: async () => new Promise(() => undefined) }) // never resolves
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick(60)
    emit({ type: 'round-started', runId: 'r1', roundId: 'rd1', index: 0, agentIds: ['a'] }, 1)
    await tick()
    stdin.write(CTRL_C) // first: cancel (does not exit)
    await tick()
    expect(exited).toBe(0)
    stdin.write(CTRL_C) // second: exit even though the cancel is still pending
    await tick()
    expect(exited).toBe(1)
  })

  it('redacts secrets when echoing the typed line', async () => {
    const { stdin, lastFrame } = renderApp()
    stdin.write('here is a token sk-ant-api03-SECRETSECRETSECRET')
    await tick()
    stdin.write('\r')
    await tick()
    expect(lastFrame()).not.toContain('SECRETSECRETSECRET')
  })

  it('commits an abandoned run to scrollback (no orchestrator)', async () => {
    const { stdin, lastFrame } = renderApp()
    stdin.write('/run p review this')
    await tick()
    stdin.write('\r')
    await tick(60)
    emit({ type: 'round-started', runId: 'r1', roundId: 'rd1', index: 0, agentIds: ['a'] }, 1)
    await tick()
    emit({ type: 'run-abandoned', runId: 'r1' }, 2)
    await tick()
    expect(lastFrame()).toContain('(abandoned)')
  })
})
