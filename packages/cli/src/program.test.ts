import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Adapter, createAdapter } from '@open-consensus/adapters'
import { loadConfig } from '@open-consensus/config'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type CliDeps, resolveConfigFile, run } from './program'

const FAKE = fileURLToPath(new URL('../../adapters/test/fixtures/fake-cli.mjs', import.meta.url))
beforeAll(() => chmodSync(FAKE, 0o755))

let dir: string
let out: string[]
let err: string[]
let server: Server
let endpoint: string
let deps: CliDeps

/** Registry: claude available (fake), gemini missing, opencode available+unsandboxed. */
function registry(): Map<string, Adapter> {
  return new Map<string, Adapter>([
    ['claude', createAdapter('claude', { binPath: FAKE }) as Adapter],
    ['gemini', createAdapter('gemini', { binPath: '/nonexistent/gemini-xyz' }) as Adapter],
    ['opencode', createAdapter('opencode', { binPath: FAKE }) as Adapter],
  ])
}

/** A fake daemon HTTP server covering the routes the CLI run/daemon commands call. */
function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url === '/health') return send(200, { ok: true })
    if (req.method === 'POST' && url === '/runs') return send(200, { runId: 'r1', roundId: 'rd1' })
    if (url === '/runs/r1/status') {
      return send(200, {
        run: { runId: 'r1', panelId: 'p', state: 'running', createdAt: 0 },
        round: {
          roundId: 'rd1',
          runId: 'r1',
          index: 0,
          prompt: 'x',
          quorum: 1,
          state: 'running',
          verdict: 'met',
          invocations: [
            { agentId: 'a', status: 'ok' },
            { agentId: 'b', status: 'error', errorClass: 'exit-1' },
          ],
        },
        stateVersion: 2,
      })
    }
    if (url === '/runs/r2/status') {
      return send(200, {
        run: { runId: 'r2', panelId: 'p', state: 'abandoned', createdAt: 0 },
        round: undefined,
        stateVersion: 1,
      })
    }
    if (url === '/runs?state=abandoned') return send(200, { runs: [] })
    if (url.startsWith('/runs')) {
      return send(200, { runs: [{ runId: 'r1', panelId: 'p', state: 'running', createdAt: 0 }] })
    }
    send(404, { error: 'not found' })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') endpoint = `http://127.0.0.1:${addr.port}`
      resolve()
    }),
  )
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oc-cli-'))
  out = []
  err = []
  await startServer()
  deps = {
    configFile: join(dir, 'config.json'),
    discoveryPath: join(dir, 'discovery.json'),
    registry: registry(),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    // "Starting" the daemon publishes a discovery file pointing at the fake server.
    launchDaemon: () =>
      writeFileSync(deps.discoveryPath, JSON.stringify({ endpoint, token: 't', pid: 4242 })),
    serveDaemon: async () => {
      out.push('serve-called')
    },
    mcpHostPath: join(dir, 'host.json'),
    ensureAttempts: 20,
    ensureIntervalMs: 5,
  }
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const argv = (...args: string[]) => ['node', 'open-consensus', ...args]
const addClaude = (id: string) => run(argv('agent', 'add', id, '--adapter', 'claude'), deps)

describe('agent commands', () => {
  it('adds an agent (with options), warns on undetected, lists, updates, removes', async () => {
    await run(
      argv(
        'agent',
        'add',
        'a',
        '--adapter',
        'claude',
        '--model',
        'opus',
        '--arg',
        '--x',
        '--env',
        'K=v',
        '--timeout',
        '5000',
        '--retries',
        '0',
      ),
      deps,
    )
    expect(out.join('\n')).toMatch(/added agent 'a'/)
    const config = loadConfig(deps.configFile)
    expect(config.agents[0]).toMatchObject({
      model: 'opus',
      args: ['--x'],
      env: { K: 'v' },
      timeoutMs: 5000,
      maxRetries: 0,
    })

    out.length = 0
    await run(argv('agent', 'add', 'g', '--adapter', 'gemini'), deps)
    expect(err.join('\n')).toMatch(/not detected/)

    out.length = 0
    await run(argv('agent', 'list'), deps)
    expect(out.join('\n')).toMatch(/a {2}\(claude \/ opus\)/)

    await run(argv('agent', 'update', 'a', '--name', 'Renamed', '--model', '-'), deps)
    expect(loadConfig(deps.configFile).agents.find((x) => x.id === 'a')?.model).toBeUndefined()

    await run(argv('agent', 'remove', 'g'), deps)
    expect(loadConfig(deps.configFile).agents.map((a) => a.id)).toEqual(['a'])
  })

  it('lists nothing when empty', async () => {
    await run(argv('agent', 'list'), deps)
    expect(out).toEqual(['no agents configured'])
  })

  it('rejects an unsandboxed adapter without acknowledgment; accepts with the flag', async () => {
    await expect(run(argv('agent', 'add', 'oc', '--adapter', 'opencode'), deps)).rejects.toThrow(
      /read-only\/sandbox/,
    )
    await run(argv('agent', 'add', 'oc', '--adapter', 'opencode', '--allow-unsandboxed'), deps)
    expect(loadConfig(deps.configFile).agents.map((a) => a.id)).toEqual(['oc'])
  })

  it('validates --env and --timeout', async () => {
    await expect(
      run(argv('agent', 'add', 'a', '--adapter', 'claude', '--env', 'bad'), deps),
    ).rejects.toThrow(/KEY=VALUE/)
    await expect(
      run(argv('agent', 'add', 'a', '--adapter', 'claude', '--timeout', 'NaN'), deps),
    ).rejects.toThrow(/non-negative integer/)
  })

  it('updates args, env, timeout, and retries', async () => {
    await addClaude('a')
    await run(
      argv(
        'agent',
        'update',
        'a',
        '--arg',
        '--y',
        '--env',
        'Z=1',
        '--timeout',
        '9000',
        '--retries',
        '4',
      ),
      deps,
    )
    expect(loadConfig(deps.configFile).agents[0]).toMatchObject({
      args: ['--y'],
      env: { Z: '1' },
      timeoutMs: 9000,
      maxRetries: 4,
    })
  })

  it('agent test reports an unavailable adapter', async () => {
    await run(argv('agent', 'add', 'g', '--adapter', 'gemini'), deps)
    out.length = 0
    await run(argv('agent', 'test', 'g'), deps)
    expect(out.join('\n')).toMatch(/unavailable/)
  })

  it('agent test dry-run and --live (fake binary, no spend)', async () => {
    await run(
      argv('agent', 'add', 'a', '--adapter', 'claude', '--env', 'FAKE_STDOUT={"result":"ok"}'),
      deps,
    )
    out.length = 0
    await run(argv('agent', 'test', 'a'), deps)
    expect(out.join('\n')).toMatch(/would run:.*fake-cli/)
    expect(out.join('\n')).toMatch(/prompt delivery: stdin/)

    out.length = 0
    await run(argv('agent', 'test', 'a', '--live'), deps)
    expect(out.join('\n')).toMatch(/live: ok \(exited/)
  })
})

describe('panel commands', () => {
  beforeEach(async () => {
    await addClaude('a')
    await addClaude('b')
    await addClaude('c')
  })

  it('creates a panel with a name and default quorum', async () => {
    await run(argv('panel', 'create', 'named', '--agents', 'a,b', '--name', 'My Panel'), deps)
    expect(loadConfig(deps.configFile).panels[0]).toMatchObject({ name: 'My Panel', quorum: 2 })
  })

  it('creates, lists, mutates, and removes panels', async () => {
    await run(
      argv('panel', 'create', 'p', '--agents', 'a, b', '--quorum', '1', '--concurrency', '2'),
      deps,
    )
    expect(loadConfig(deps.configFile).panels[0]).toMatchObject({
      id: 'p',
      quorum: 1,
      concurrency: 2,
    })

    out.length = 0
    await run(argv('panel', 'list'), deps)
    expect(out.join('\n')).toMatch(/p {2}\[a, b\] {2}quorum 1/)

    await run(argv('panel', 'add-agent', 'p', 'c'), deps)
    expect(loadConfig(deps.configFile).panels[0]?.agentIds).toEqual(['a', 'b', 'c'])

    await run(argv('panel', 'remove-agent', 'p', 'a'), deps)
    expect(loadConfig(deps.configFile).panels[0]?.agentIds).toEqual(['b', 'c'])

    await run(argv('panel', 'set-quorum', 'p', '2'), deps)
    expect(loadConfig(deps.configFile).panels[0]?.quorum).toBe(2)

    await run(argv('panel', 'remove', 'p'), deps)
    expect(loadConfig(deps.configFile).panels).toEqual([])
  })

  it('lists nothing when no panels exist', async () => {
    out.length = 0
    await run(argv('panel', 'list'), deps)
    expect(out).toEqual(['no panels configured'])
  })
})

describe('daemon commands', () => {
  it('serve delegates to the injected serveDaemon', async () => {
    await run(argv('daemon', 'serve'), deps)
    expect(out).toContain('serve-called')
  })

  it('start auto-launches and reports the endpoint', async () => {
    await run(argv('daemon', 'start'), deps)
    expect(out.join('\n')).toMatch(new RegExp(`daemon running on ${endpoint}`))
  })

  it('status reports not-running, then running', async () => {
    await run(argv('daemon', 'status'), deps)
    expect(out).toEqual(['daemon is not running'])
    out.length = 0
    deps.launchDaemon()
    await run(argv('daemon', 'status'), deps)
    expect(out.join('\n')).toMatch(/running \(healthy\).*pid 4242/)
  })

  it('status reports a present-but-unhealthy daemon', async () => {
    writeFileSync(
      deps.discoveryPath,
      JSON.stringify({ endpoint: 'http://127.0.0.1:1', token: 't' }),
    )
    await run(argv('daemon', 'status'), deps)
    expect(out.join('\n')).toMatch(/present but not answering/)
  })

  it('stop reports not-running cleanly when there is no daemon', async () => {
    await run(argv('daemon', 'stop'), deps)
    expect(out.join('\n')).toMatch(/not stopped/)
  })

  it('stop signals the serve process and reports success', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(deps.discoveryPath, JSON.stringify({ endpoint, token: 't', pid: child.pid }))
    await run(argv('daemon', 'stop'), deps)
    expect(out.join('\n')).toMatch(new RegExp(`daemon stopped \\(pid ${child.pid}\\)`))
  })
})

describe('run commands', () => {
  it('start auto-starts the daemon then starts a run', async () => {
    await run(argv('run', 'start', 'p', 'review', 'this', 'plan'), deps)
    expect(out.join('\n')).toMatch(/started run r1 \(round rd1\)/)
  })

  it('status renders the run + round + per-agent statuses', async () => {
    deps.launchDaemon()
    await run(argv('run', 'status', 'r1'), deps)
    const text = out.join('\n')
    expect(text).toMatch(/run r1 {2}running/)
    expect(text).toMatch(/round 0: running \(met\)/)
    expect(text).toMatch(/b: error \[exit-1\]/)
  })

  it('status renders a run with no round yet', async () => {
    deps.launchDaemon()
    await run(argv('run', 'status', 'r2'), deps)
    expect(out.join('\n')).toMatch(/run r2 {2}abandoned/)
    expect(out.join('\n')).not.toMatch(/round/)
  })

  it('list renders known runs', async () => {
    deps.launchDaemon()
    await run(argv('run', 'list'), deps)
    expect(out.join('\n')).toMatch(/r1 {2}running {2}panel=p/)
  })

  it('list reports none when the filter matches nothing', async () => {
    deps.launchDaemon()
    await run(argv('run', 'list', '--state', 'abandoned'), deps)
    expect(out).toContain('no runs')
  })

  it('list rejects an invalid --state', async () => {
    deps.launchDaemon()
    await expect(run(argv('run', 'list', '--state', 'bogus'), deps)).rejects.toThrow(/--state must/)
  })
})

describe('init', () => {
  it('--detect-only reports detection without writing a config', async () => {
    await run(argv('init', '--detect-only'), deps)
    expect(out.join('\n')).toMatch(/✓ claude/)
    expect(out.join('\n')).toMatch(/✗ gemini/)
    expect(out.join('\n')).toMatch(/opencode.*\(unsandboxed\)/)
    expect(loadConfig(deps.configFile).agents).toEqual([]) // no file written -> default
  })

  it('seeds agents + a default panel', async () => {
    await run(argv('init'), deps)
    expect(out.join('\n')).toMatch(/seeded agents: claude/)
    expect(out.join('\n')).toMatch(/seeded panel: default/)
    expect(loadConfig(deps.configFile).panels[0]?.id).toBe('default')
  })

  it('refuses to clobber without --force, then overwrites with it', async () => {
    await addClaude('pre')
    out.length = 0
    await run(argv('init'), deps)
    expect(err.join('\n')).toMatch(/did not write config/)
    await run(argv('init', '--force'), deps)
    expect(loadConfig(deps.configFile).agents.map((a) => a.id)).toEqual(['claude'])
  })

  it('writes an empty config and reports skips when nothing is detected', async () => {
    deps.registry = new Map([
      ['gemini', createAdapter('gemini', { binPath: '/nonexistent/x' }) as Adapter],
    ])
    await run(argv('init'), deps)
    expect(out.join('\n')).toMatch(/no agents seeded/)
    expect(err.join('\n')).toMatch(/skipped gemini/)
  })
})

describe('mcp install/uninstall', () => {
  it('installs, is idempotent, conflicts, force-overwrites, uninstalls', async () => {
    await run(argv('mcp', 'install'), deps)
    expect(out.join('\n')).toMatch(/installed 'open-consensus'/)
    expect(JSON.parse(readFileSync(deps.mcpHostPath, 'utf8')).mcpServers['open-consensus']).toEqual(
      {
        command: 'open-consensus-mcp',
        args: [],
      },
    )

    out.length = 0
    await run(argv('mcp', 'install'), deps)
    expect(out.join('\n')).toMatch(/unchanged/)

    await expect(run(argv('mcp', 'install', '--command', 'other'), deps)).rejects.toThrow(
      /conflicting entry/,
    )
    expect(err.join('\n')).toMatch(/already exists/)

    await run(argv('mcp', 'install', '--command', 'other', '--force'), deps)
    expect(
      JSON.parse(readFileSync(deps.mcpHostPath, 'utf8')).mcpServers['open-consensus'].command,
    ).toBe('other')

    await run(argv('mcp', 'uninstall'), deps)
    expect(out.join('\n')).toMatch(/removed 'open-consensus'/)
  })

  it('rejects --arg without --command', async () => {
    await expect(run(argv('mcp', 'install', '--arg', 'x'), deps)).rejects.toThrow(/--arg only/)
  })

  it('honors a custom --name and --config', async () => {
    const host = join(dir, 'other.json')
    await run(argv('mcp', 'install', '--name', 'oc-dev', '--config', host), deps)
    expect(JSON.parse(readFileSync(host, 'utf8')).mcpServers['oc-dev']).toBeDefined()
    await run(argv('mcp', 'uninstall', '--name', 'oc-dev', '--config', host), deps)
    expect(JSON.parse(readFileSync(host, 'utf8')).mcpServers['oc-dev']).toBeUndefined()
  })
})

describe('resolveConfigFile', () => {
  it('honors OPEN_CONSENSUS_CONFIG override', () => {
    expect(resolveConfigFile({ OPEN_CONSENSUS_CONFIG: '/tmp/x.json' })).toBe('/tmp/x.json')
  })
  it('falls back to the XDG config path', () => {
    expect(resolveConfigFile({ XDG_CONFIG_HOME: '/tmp/cfg' })).toMatch(/open-consensus/)
  })
})
