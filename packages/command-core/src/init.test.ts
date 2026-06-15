import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Adapter, createAdapter } from '@open-consensus/adapters'
import { loadConfig } from '@open-consensus/config'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type ConfigContext, addAgentCommand } from './config-ops'
import { detectAdaptersCommand, initCommand } from './init'

const FAKE = fileURLToPath(new URL('../../adapters/test/fixtures/fake-cli.mjs', import.meta.url))

beforeAll(() => chmodSync(FAKE, 0o755))

let dir: string
let ctx: ConfigContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-init-'))
  ctx = { configFile: join(dir, 'config.json') }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function registry(): Map<string, Adapter> {
  return new Map<string, Adapter>([
    ['claude', createAdapter('claude', { binPath: FAKE }) as Adapter],
    ['gemini', createAdapter('gemini', { binPath: '/nonexistent/gemini-xyz' }) as Adapter],
    ['opencode', createAdapter('opencode', { binPath: FAKE }) as Adapter],
  ])
}

describe('detect', () => {
  it('probes every adapter, sorted by id, recording sandbox capability', async () => {
    const reports = await detectAdaptersCommand(registry())
    expect(reports.map((r) => r.id)).toEqual(['claude', 'gemini', 'opencode'])
    expect(reports.find((r) => r.id === 'claude')).toMatchObject({ available: true, sandbox: true })
    expect(reports.find((r) => r.id === 'gemini')?.available).toBe(false)
    expect(reports.find((r) => r.id === 'opencode')?.sandbox).toBe(false)
  })
})

describe('init', () => {
  it('seeds sandboxed available adapters + a majority-quorum default panel', async () => {
    const report = await initCommand(ctx, registry())
    expect(report.wrote).toBe(true)
    expect(report.seededAgents).toEqual(['claude'])
    expect(report.seededPanel).toBe('default')
    // gemini skipped (unavailable), opencode skipped (unsandboxed).
    expect(report.skipped.map((s) => s.id).sort()).toEqual(['gemini', 'opencode'])
    const config = loadConfig(ctx.configFile)
    expect(config.panels[0]).toMatchObject({ id: 'default', agentIds: ['claude'], quorum: 1 })
  })

  it('includes the unsandboxed adapter with the acknowledgment, recomputing quorum', async () => {
    const report = await initCommand(ctx, registry(), { allowUnsandboxed: true })
    expect(report.seededAgents.sort()).toEqual(['claude', 'opencode'])
    // strict majority of 2 = 2.
    expect(loadConfig(ctx.configFile).panels[0]?.quorum).toBe(2)
  })

  it('refuses to clobber an existing non-empty config without force', async () => {
    await addAgentCommand(ctx, { id: 'pre', adapter: 'claude' }, registry())
    const report = await initCommand(ctx, registry())
    expect(report.wrote).toBe(false)
    expect(report.reason).toMatch(/already has/)
    // The pre-existing agent is untouched.
    expect(loadConfig(ctx.configFile).agents.map((a) => a.id)).toEqual(['pre'])
  })

  it('overwrites an existing config with force', async () => {
    await addAgentCommand(ctx, { id: 'pre', adapter: 'claude' }, registry())
    const report = await initCommand(ctx, registry(), { force: true })
    expect(report.wrote).toBe(true)
    expect(loadConfig(ctx.configFile).agents.map((a) => a.id)).toEqual(['claude'])
  })

  it('writes a config with no panel when nothing is detected', async () => {
    const empty = new Map<string, Adapter>([
      ['gemini', createAdapter('gemini', { binPath: '/nonexistent/x' }) as Adapter],
    ])
    const report = await initCommand(ctx, empty)
    expect(report.wrote).toBe(true)
    expect(report.seededAgents).toEqual([])
    expect(report.seededPanel).toBeUndefined()
    expect(loadConfig(ctx.configFile).panels).toEqual([])
  })

  it('honors a custom panel id', async () => {
    const report = await initCommand(ctx, registry(), { panelId: 'review' })
    expect(report.seededPanel).toBe('review')
  })
})
