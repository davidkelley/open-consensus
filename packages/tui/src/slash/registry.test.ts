import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Adapter, createAdapter } from '@open-consensus/adapters'
import { addAgentCommand } from '@open-consensus/command-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { theme } from '../theme'
import type { Segment } from '../ui/segments'
import { SLASH_COMMANDS, type SlashContext, findCommand } from './registry'

const FAKE = fileURLToPath(new URL('../../../adapters/test/fixtures/fake-cli.mjs', import.meta.url))
beforeAll(() => chmodSync(FAKE, 0o755))

let dir: string
let out: string[]
let viewed: string[]
let quit: number
let active: boolean
let server: Server
let endpoint: string
let ctx: SlashContext
let runsEmpty: boolean

function registry(): Map<string, Adapter> {
  return new Map<string, Adapter>([
    ['claude', createAdapter('claude', { binPath: FAKE }) as Adapter],
    ['gemini', createAdapter('gemini', { binPath: '/nonexistent/gemini-xyz' }) as Adapter],
  ])
}

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (s: number, b: unknown) => {
      res.writeHead(s, { 'content-type': 'application/json' })
      res.end(JSON.stringify(b))
    }
    if (url === '/health') return send(200, { ok: true, pid: process.pid })
    if (req.method === 'POST' && url === '/runs') return send(200, { runId: 'r1', roundId: 'rd1' })
    if (url.startsWith('/runs')) {
      const runs = runsEmpty ? [] : [{ runId: 'r1', panelId: 'p', state: 'running', createdAt: 0 }]
      return send(200, { runs })
    }
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

async function dispatch(line: string): Promise<void> {
  const [name, ...args] = line.split(' ').filter(Boolean)
  const command = findCommand(name as string)
  if (!command) throw new Error(`no command ${name}`)
  const rest = line.slice((name as string).length + 1)
  await command.run(ctx, args, rest)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oc-slash-'))
  out = []
  viewed = []
  quit = 0
  active = false
  runsEmpty = false
  await startServer()
  writeFileSync(
    join(dir, 'discovery.json'),
    JSON.stringify({ endpoint, token: 't', pid: process.pid }),
  )
  ctx = {
    configCtx: { configFile: join(dir, 'config.json') },
    registry: registry(),
    discoveryPath: join(dir, 'discovery.json'),
    // Flatten styled segments back to plain text for assertions (the styling is
    // covered elsewhere; here we only care about the content the commands emit).
    print: (l) => out.push(typeof l === 'string' ? l : l.map((s) => s.text).join('')),
    ensureDaemon: async () => undefined,
    viewRun: (id) => viewed.push(id),
    hasActiveRun: () => active,
    quit: () => {
      quit += 1
    },
  }
})
afterEach(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('slash registry', () => {
  it('exposes a stable command set', () => {
    expect(SLASH_COMMANDS.map((c) => c.name).sort()).toEqual(
      ['agent', 'agents', 'daemon', 'help', 'panel', 'panels', 'quit', 'run', 'runs'].sort(),
    )
  })

  it('/help lists every command plus a concepts line', async () => {
    await dispatch('help')
    expect(out.length).toBe(SLASH_COMMANDS.length + 1) // commands + the concepts line
    expect(out.join('\n')).toMatch(/\/run/)
    expect(out.join('\n')).toMatch(/panel = a group of agents/)
    expect(out.join('\n')).toMatch(/verdict: met \/ degraded \/ failed/)
  })

  it('styles output: brand usage + dim summary for /help, red errors, green created', async () => {
    // Capture raw segments (not flattened) so styling regressions are caught.
    const captured: Segment[][] = []
    const styled: SlashContext = {
      ...ctx,
      print: (l) => captured.push(typeof l === 'string' ? [{ text: l }] : l),
    }
    await (findCommand('help') as NonNullable<ReturnType<typeof findCommand>>).run(styled, [], '')
    const helpRow = captured[0] ?? []
    expect(helpRow[0]?.color).toBe(theme.brand) // usage column is brand
    expect(helpRow[1]?.dim).toBe(true) // summary is dim

    captured.length = 0
    await (findCommand('agent') as NonNullable<ReturnType<typeof findCommand>>).run(
      styled,
      ['add', 'a', '--adapter', 'claude'],
      'add a --adapter claude',
    )
    // the agent-id token specifically (not surrounding text) is success-green + bold
    const idSeg = captured[0]?.[1]
    expect(idSeg?.text).toBe("'a'")
    expect(idSeg?.color).toBe(theme.success)
    expect(idSeg?.bold).toBe(true)
  })

  it('empty /agents guides the next step', async () => {
    await dispatch('agents')
    expect(out).toContain('no agents configured')
    expect(out.join('\n')).toMatch(/add one with .*\/agent add/) // actionable hint
  })

  it('shows an agent model when one is configured', async () => {
    await addAgentCommand(
      ctx.configCtx,
      { id: 'm', adapter: 'claude', model: 'opus' },
      ctx.registry,
    )
    out.length = 0
    await dispatch('agents')
    expect(out.join('\n')).toMatch(/m {2}\(claude \/ opus\)/) // the model branch
  })

  it('agents: empty then populated; agent add/test/remove', async () => {
    await dispatch('agents')
    expect(out).toContain('no agents configured')
    out.length = 0

    await dispatch('agent add a --adapter claude')
    expect(out.join('\n')).toMatch(/added agent 'a'/)

    out.length = 0
    await dispatch('agents')
    expect(out.join('\n')).toMatch(/a {2}\(claude\)/)

    out.length = 0
    await dispatch('agent test a')
    expect(out.join('\n')).toMatch(/available/)
    expect(out.join('\n')).toMatch(/would run:.*fake-cli/)

    out.length = 0
    await dispatch('agent remove a')
    expect(out.join('\n')).toMatch(/removed agent 'a'/)
  })

  it('rejects an unknown agent subcommand and missing args', async () => {
    await expect(dispatch('agent frob x')).rejects.toThrow(/unknown agent subcommand/)
    await expect(dispatch('agent')).rejects.toThrow(/missing/)
  })

  it('agent add accepts a positional adapter and the unsandboxed ack flag', async () => {
    await dispatch('agent add a claude --allow-unsandboxed') // positional adapter + ack flag
    expect(out.join('\n')).toMatch(/added agent 'a' \(claude\)/)
  })

  it('agent add rejects a dangling --adapter with no value', async () => {
    await expect(dispatch('agent add a --adapter')).rejects.toThrow(/missing adapter value/)
  })

  it('agent test reports an unavailable adapter', async () => {
    await dispatch('agent add g --adapter gemini')
    out.length = 0
    await dispatch('agent test g')
    expect(out.join('\n')).toMatch(/unavailable/)
  })

  it('panels + panel create/set-quorum/remove', async () => {
    await dispatch('agent add a --adapter claude')
    await dispatch('agent add b --adapter claude')
    out.length = 0
    await dispatch('panels')
    expect(out).toContain('no panels configured')

    out.length = 0
    await dispatch('panel create p a,b')
    expect(out.join('\n')).toMatch(/created panel 'p'/)

    out.length = 0
    await dispatch('panels')
    expect(out.join('\n')).toMatch(/p {2}\[a, b\]/)

    out.length = 0
    await dispatch('panel set-quorum p 1')
    expect(out.join('\n')).toMatch(/quorum set to 1/)

    await dispatch('panel remove p')
    await dispatch('panels')
    expect(out.join('\n')).toMatch(/no panels configured/)
  })

  it('rejects an unknown panel subcommand', async () => {
    await expect(dispatch('panel frob p')).rejects.toThrow(/unknown panel subcommand/)
  })

  it('empty /runs guides the next step', async () => {
    runsEmpty = true
    await dispatch('runs')
    expect(out.join('\n')).toMatch(/no runs yet/)
    expect(out.join('\n')).toMatch(/start one with .*\/run/)
  })

  it('/runs lists runs and /run starts + views', async () => {
    await dispatch('runs')
    expect(out.join('\n')).toMatch(/r1 {2}running/)

    out.length = 0
    await dispatch('run p review this plan')
    expect(out.join('\n')).toMatch(/started run r1 on panel 'p'/)
    expect(viewed).toEqual(['r1'])
  })

  it('/run requires a prompt', async () => {
    await expect(dispatch('run p')).rejects.toThrow(/missing prompt/)
  })

  it('/run refuses to start while a run is already streaming', async () => {
    active = true
    await expect(dispatch('run p review this')).rejects.toThrow(/already streaming/)
    expect(viewed).toEqual([]) // never started a second run
  })

  it('/daemon rejects an unknown subcommand', async () => {
    await expect(dispatch('daemon restart')).rejects.toThrow(/unknown daemon subcommand/)
  })

  it('/daemon shows status and /quit exits', async () => {
    await dispatch('daemon status')
    expect(out.join('\n')).toMatch(/running \(healthy\)/)
    await dispatch('quit')
    expect(quit).toBe(1)
  })
})
