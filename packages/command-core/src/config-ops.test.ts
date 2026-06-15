import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Adapter, createAdapter } from '@open-consensus/adapters'
import { loadConfig } from '@open-consensus/config'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type ConfigContext,
  addAgentCommand,
  createPanelCommand,
  listAgentsCommand,
  listPanelsCommand,
  panelAddAgentCommand,
  panelRemoveAgentCommand,
  removeAgentCommand,
  removePanelCommand,
  setQuorumCommand,
  testAgentCommand,
  updateAgentCommand,
} from './config-ops'

const FAKE = fileURLToPath(new URL('../../adapters/test/fixtures/fake-cli.mjs', import.meta.url))

beforeAll(() => chmodSync(FAKE, 0o755))

let dir: string
let ctx: ConfigContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-cfg-'))
  ctx = { configFile: join(dir, 'config.json') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Registry: claude available (fake), gemini missing, opencode available+unsandboxed. */
function registry(): Map<string, Adapter> {
  return new Map<string, Adapter>([
    ['claude', createAdapter('claude', { binPath: FAKE }) as Adapter],
    ['gemini', createAdapter('gemini', { binPath: '/nonexistent/gemini-xyz' }) as Adapter],
    ['opencode', createAdapter('opencode', { binPath: FAKE }) as Adapter],
  ])
}

describe('agent commands', () => {
  it('adds an agent and detects its binary (no warnings when available)', async () => {
    const result = await addAgentCommand(ctx, { id: 'a1', adapter: 'claude' }, registry())
    expect(result.agent.id).toBe('a1')
    expect(result.detected?.available).toBe(true)
    expect(result.warnings).toEqual([])
    expect(listAgentsCommand(ctx).map((a) => a.id)).toEqual(['a1'])
  })

  it('warns (does not throw) when the binary is not detected', async () => {
    const result = await addAgentCommand(ctx, { id: 'g', adapter: 'gemini' }, registry())
    expect(result.detected?.available).toBe(false)
    expect(result.warnings.join(' ')).toMatch(/not detected/)
  })

  it('throws when the adapter id is unknown to the registry', async () => {
    await expect(addAgentCommand(ctx, { id: 'x', adapter: 'made-up' }, registry())).rejects.toThrow(
      /unknown adapter/,
    )
  })

  it('refuses an unsandboxed adapter without the acknowledgment (D20)', async () => {
    await expect(
      addAgentCommand(ctx, { id: 'oc', adapter: 'opencode' }, registry()),
    ).rejects.toThrow(/read-only\/sandbox/)
    // …and allows it with the acknowledgment.
    const ok = await addAgentCommand(
      ctx,
      { id: 'oc', adapter: 'opencode', allowUnsandboxed: true },
      registry(),
    )
    expect(ok.agent.adapter).toBe('opencode')
  })

  it('carries through model, args, env, timeout, and retries', async () => {
    const result = await addAgentCommand(
      ctx,
      {
        id: 'a',
        adapter: 'claude',
        model: 'opus',
        args: ['--x'],
        env: { K: 'v' },
        timeoutMs: 5000,
        maxRetries: 0,
      },
      registry(),
    )
    expect(result.agent).toMatchObject({
      model: 'opus',
      args: ['--x'],
      env: { K: 'v' },
      timeoutMs: 5000,
      maxRetries: 0,
    })
  })

  it('updates mutable fields and clears model with null', async () => {
    await addAgentCommand(ctx, { id: 'a', adapter: 'claude', model: 'opus' }, registry())
    const updated = updateAgentCommand(ctx, 'a', { name: 'Renamed', timeoutMs: 9000, model: null })
    expect(updated.name).toBe('Renamed')
    expect(updated.timeoutMs).toBe(9000)
    expect(updated.model).toBeUndefined()
  })

  it('updates args, env, and maxRetries', async () => {
    await addAgentCommand(ctx, { id: 'a', adapter: 'claude' }, registry())
    const updated = updateAgentCommand(ctx, 'a', { args: ['--y'], env: { Z: '1' }, maxRetries: 4 })
    expect(updated).toMatchObject({ args: ['--y'], env: { Z: '1' }, maxRetries: 4 })
  })

  it('throws updating an unknown agent', () => {
    expect(() => updateAgentCommand(ctx, 'ghost', { name: 'x' })).toThrow(/unknown agent/)
  })

  it('removes an agent', async () => {
    await addAgentCommand(ctx, { id: 'a', adapter: 'claude' }, registry())
    removeAgentCommand(ctx, 'a')
    expect(listAgentsCommand(ctx)).toEqual([])
  })

  it('refuses to remove an agent a panel uses without force; force prunes it', async () => {
    await addAgentCommand(ctx, { id: 'a', adapter: 'claude' }, registry())
    await addAgentCommand(ctx, { id: 'b', adapter: 'claude' }, registry())
    createPanelCommand(ctx, { id: 'p', agentIds: ['a', 'b'], quorum: 2 })
    expect(() => removeAgentCommand(ctx, 'a')).toThrow(/used by panel/)
    removeAgentCommand(ctx, 'a', true) // force prunes it from the panel (which keeps 'b')
    expect(listAgentsCommand(ctx).map((x) => x.id)).toEqual(['b'])
    expect(listPanelsCommand(ctx)[0]?.agentIds).toEqual(['b'])
  })
})

describe('agent test', () => {
  it('dry-run: detects + previews the invocation without executing', async () => {
    await addAgentCommand(ctx, { id: 'a', adapter: 'claude', model: 'opus' }, registry())
    const result = await testAgentCommand(ctx, 'a', registry())
    expect(result.detected.available).toBe(true)
    expect(result.invocation.file).toBe(FAKE)
    expect(result.invocation.promptDelivery).toBe('stdin')
    expect(result.invocation.args).toContain('-p')
    expect(result.live).toBeUndefined()
  })

  it('elides the prompt from argv for an arg-delivery adapter', async () => {
    await addAgentCommand(ctx, { id: 'g', adapter: 'gemini' }, registry())
    const result = await testAgentCommand(ctx, 'g', registry())
    expect(result.invocation.promptDelivery).toBe('arg')
    expect(result.invocation.args).toContain('<prompt>')
    expect(result.invocation.args).not.toContain('Respond with OK to confirm you are reachable.')
  })

  it('reports an unknown-adapter agent (config drift) without spawning', async () => {
    // The agent was added against a registry that had 'claude'; testing it against
    // a registry that no longer does exercises the defensive unknown-adapter path.
    await addAgentCommand(ctx, { id: 'a', adapter: 'claude' }, registry())
    const result = await testAgentCommand(ctx, 'a', new Map<string, Adapter>())
    expect(result.detected.available).toBe(false)
    expect(result.detected.reason).toMatch(/unknown adapter/)
  })

  it('throws for an unknown agent id', async () => {
    await expect(testAgentCommand(ctx, 'nope', registry())).rejects.toThrow(/unknown agent/)
  })

  it('live: spawns the (fake) CLI and returns the parsed result', async () => {
    // The fake emits a JSON envelope the claude adapter parses; no real CLI/spend.
    await addAgentCommand(
      ctx,
      { id: 'a', adapter: 'claude', env: { FAKE_STDOUT: '{"result":"ok"}' } },
      registry(),
    )
    const result = await testAgentCommand(ctx, 'a', registry(), { live: true })
    expect(result.live?.status).toBe('ok')
    expect(result.live?.text).toBe('ok')
    expect(result.live?.outcome).toBe('exited')
  })
})

describe('panel commands', () => {
  beforeEach(async () => {
    for (const id of ['a', 'b', 'c']) {
      await addAgentCommand(ctx, { id, adapter: 'claude' }, registry())
    }
  })

  it('creates a panel (quorum defaults to size) and lists it', () => {
    const panel = createPanelCommand(ctx, { id: 'p', agentIds: ['a', 'b'] })
    expect(panel.quorum).toBe(2)
    expect(listPanelsCommand(ctx).map((p) => p.id)).toEqual(['p'])
  })

  it('adds and removes agents, clamping quorum', () => {
    createPanelCommand(ctx, { id: 'p', agentIds: ['a', 'b'], quorum: 2 })
    const added = panelAddAgentCommand(ctx, 'p', 'c')
    expect(added.agentIds).toEqual(['a', 'b', 'c'])
    expect(panelAddAgentCommand(ctx, 'p', 'c').agentIds).toEqual(['a', 'b', 'c']) // no-op
    const removed = panelRemoveAgentCommand(ctx, 'p', 'a')
    expect(removed.agentIds).toEqual(['b', 'c'])
    expect(removed.quorum).toBe(2)
  })

  it('clamps quorum when removal shrinks the panel below it', () => {
    createPanelCommand(ctx, { id: 'p', agentIds: ['a', 'b'], quorum: 2 })
    const removed = panelRemoveAgentCommand(ctx, 'p', 'a')
    expect(removed.quorum).toBe(1)
  })

  it('refuses to remove the last agent from a panel', () => {
    createPanelCommand(ctx, { id: 'p', agentIds: ['a'] })
    expect(() => panelRemoveAgentCommand(ctx, 'p', 'a')).toThrow(/no agents/)
  })

  it('sets a quorum and rejects one exceeding panel size', () => {
    createPanelCommand(ctx, { id: 'p', agentIds: ['a', 'b'], quorum: 1 })
    expect(setQuorumCommand(ctx, 'p', 2).quorum).toBe(2)
    expect(() => setQuorumCommand(ctx, 'p', 3)).toThrow()
  })

  it('removes a panel', () => {
    createPanelCommand(ctx, { id: 'p', agentIds: ['a'] })
    removePanelCommand(ctx, 'p')
    expect(listPanelsCommand(ctx)).toEqual([])
  })

  it('throws operating on an unknown panel', () => {
    expect(() => panelAddAgentCommand(ctx, 'ghost', 'a')).toThrow(/unknown panel/)
    expect(() => panelRemoveAgentCommand(ctx, 'ghost', 'a')).toThrow(/unknown panel/)
    expect(() => setQuorumCommand(ctx, 'ghost', 1)).toThrow(/unknown panel/)
  })

  it('persists everything to the config file', () => {
    createPanelCommand(ctx, { id: 'p', agentIds: ['a', 'b'], concurrency: 2 })
    const onDisk = loadConfig(ctx.configFile)
    expect(onDisk.panels[0]?.concurrency).toBe(2)
  })
})
