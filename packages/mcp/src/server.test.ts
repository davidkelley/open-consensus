import { mkdtempSync, rmSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { writeDiscovery } from '@open-consensus/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { type DaemonClient, DaemonError } from './client'
import { createMcpServer, resolveClient } from './server'

function fakeClient(over: Partial<DaemonClient> = {}): DaemonClient {
  const reject = () => Promise.reject(new Error('not stubbed'))
  return {
    listPanels: () => Promise.resolve([]),
    listRuns: () => Promise.resolve([]),
    startRun: reject,
    startRound: reject,
    poll: reject,
    status: reject,
    cancelRun: reject,
    cancelRound: reject,
    getRaw: reject,
    ...over,
  }
}

/** Connect an MCP Client to a server over a linked in-memory transport pair. */
async function connect(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientTransport)
  return client
}

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => c.text ?? '').join('')

describe('createMcpServer', () => {
  it('registers the full tool surface', async () => {
    const client = await connect(createMcpServer(fakeClient()))
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'consensus_list_panels',
        'consensus_list_runs',
        'consensus_start',
        'consensus_round',
        'consensus_poll',
        'consensus_status',
        'consensus_cancel',
        'consensus_cancel_agent',
        'consensus_get_raw',
      ]),
    )
    await client.close()
  })

  it('returns a tool result as JSON text content', async () => {
    const client = await connect(
      createMcpServer(
        fakeClient({
          listPanels: () => Promise.resolve([{ id: 'p', name: 'P', agentIds: ['a'], quorum: 1 }]),
        }),
      ),
    )
    const res = (await client.callTool({ name: 'consensus_list_panels', arguments: {} })) as {
      content: Array<{ type: string; text?: string }>
    }
    expect(JSON.parse(textOf(res)).panels[0].id).toBe('p')
    await client.close()
  })

  it('maps a daemon error to an isError result (not a thrown protocol error)', async () => {
    const client = await connect(
      createMcpServer(
        fakeClient({
          startRun: () => Promise.reject(new DaemonError(400, "unknown panel 'ghost'")),
        }),
      ),
    )
    const res = (await client.callTool({
      name: 'consensus_start',
      arguments: { panel: 'ghost', prompt: 'x' },
    })) as { content: Array<{ type: string; text?: string }>; isError?: boolean }
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain("unknown panel 'ghost'")
    await client.close()
  })

  it('maps a non-DaemonError throw to an isError result too', async () => {
    const client = await connect(
      createMcpServer(fakeClient({ listPanels: () => Promise.reject(new Error('boom')) })),
    )
    const res = (await client.callTool({ name: 'consensus_list_panels', arguments: {} })) as {
      content: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('boom')
    await client.close()
  })

  it('rejects an input that fails the tool zod schema', async () => {
    const client = await connect(createMcpServer(fakeClient()))
    // consensus_start requires `prompt`; omitting it must be rejected by the SDK.
    await expect(
      client.callTool({ name: 'consensus_start', arguments: { panel: 'p' } }),
    ).rejects.toBeDefined()
    await client.close()
  })
})

describe('resolveClient', () => {
  const dirs: string[] = []
  const servers: Server[] = []
  afterEach(() => {
    for (const s of servers.splice(0)) s.close()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('throws an actionable error when the daemon is not running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-mcp-'))
    dirs.push(dir)
    await expect(resolveClient(join(dir, 'discovery.json'))).rejects.toThrow(/not running/)
  })

  it('throws when the discovered daemon never becomes ready', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-mcp-'))
    dirs.push(dir)
    const path = join(dir, 'discovery.json')
    writeDiscovery(path, { endpoint: 'http://127.0.0.1:1', token: 't' }) // nothing listens
    await expect(resolveClient(path, { attempts: 2, intervalMs: 10 })).rejects.toThrow(
      /did not become ready/,
    )
  })

  it('returns a working client once the daemon answers /health', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/health') return res.writeHead(200).end('{"ok":true}')
      if (req.url === '/panels')
        return res.writeHead(200).end('{"panels":[{"id":"p","name":"P","agentIds":[],"quorum":1}]}')
      res.writeHead(404).end()
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0

    const dir = mkdtempSync(join(tmpdir(), 'oc-mcp-'))
    dirs.push(dir)
    const path = join(dir, 'discovery.json')
    writeDiscovery(path, { endpoint: `http://127.0.0.1:${port}`, token: 't' })

    const client = await resolveClient(path, { attempts: 20, intervalMs: 20 })
    expect((await client.listPanels())[0]?.id).toBe('p')
  })
})
