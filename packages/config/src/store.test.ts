import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Agent,
  type Config,
  type Panel,
  agentSchema,
  configSchema,
  panelSchema,
} from './schema'
import {
  ConfigCorruptError,
  ConfigIntegrityError,
  ConfigInvalidError,
  addAgent,
  addPanel,
  configPath,
  defaultConfig,
  getAgent,
  getPanel,
  listAgents,
  listPanels,
  loadConfig,
  removeAgent,
  removePanel,
  saveConfig,
  updateAgent,
  updatePanel,
} from './store'

const agent = (id: string): Agent => agentSchema.parse({ id, name: id, adapter: 'mock' })
const panel = (id: string, agentIds: string[], quorum = agentIds.length): Panel =>
  panelSchema.parse({ id, name: id, agentIds, quorum })
const cfg = (agents: Agent[] = [], panels: Panel[] = []): Config =>
  configSchema.parse({ schemaVersion: 1, agents, panels })

describe('configPath', () => {
  it('lives under the XDG config dir', () => {
    expect(configPath({ HOME: '/home/x' })).toBe('/home/x/.config/open-consensus/config.json')
  })
})

describe('load / save (IO)', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-config-'))
    path = join(dir, 'nested', 'config.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns an empty default when the file is absent', () => {
    expect(loadConfig(path)).toEqual(defaultConfig())
  })

  it('round-trips, creating parent dirs and writing 0600', () => {
    const config = cfg([agent('a')], [panel('p', ['a'])])
    saveConfig(config, path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(loadConfig(path)).toEqual(config)
  })

  it('reports a corrupt (non-JSON) file without overwriting it', () => {
    writeFileSync(path.replace('/nested', ''), 'not json {')
    expect(() => loadConfig(join(dir, 'config.json'))).toThrow(ConfigCorruptError)
  })

  it('reports an invalid (schema-violating) file', () => {
    const p = join(dir, 'config.json')
    writeFileSync(
      p,
      JSON.stringify({ schemaVersion: 1, agents: [{ id: 'Bad', name: '', adapter: '' }] }),
    )
    expect(() => loadConfig(p)).toThrow(ConfigInvalidError)
  })

  it('rethrows a non-ENOENT read error (e.g. reading a directory)', () => {
    expect(() => loadConfig(dir)).toThrow()
    expect(() => loadConfig(dir)).not.toThrow(ConfigCorruptError)
  })
})

describe('agent CRUD', () => {
  it('adds, gets, lists, and rejects duplicates', () => {
    let c = addAgent(cfg(), agent('a'))
    c = addAgent(c, agent('b'))
    expect(listAgents(c).map((a) => a.id)).toEqual(['a', 'b'])
    expect(getAgent(c, 'a')?.id).toBe('a')
    expect(() => addAgent(c, agent('a'))).toThrow(/already exists/)
  })

  it('updates by patch and rejects unknown ids', () => {
    const c = addAgent(cfg(), agent('a'))
    expect(updateAgent(c, 'a', { model: 'opus' }).agents[0]?.model).toBe('opus')
    expect(() => updateAgent(c, 'ghost', { model: 'x' })).toThrow(ConfigIntegrityError)
  })

  it('removes, guarding panel references unless forced', () => {
    const c = cfg([agent('a'), agent('b')], [panel('p', ['a', 'b'], 1)])
    expect(() => removeAgent(c, 'ghost')).toThrow(/not found/)
    expect(() => removeAgent(c, 'a')).toThrow(/used by panel/)
    const forced = removeAgent(c, 'a', { force: true })
    expect(forced.agents.map((a) => a.id)).toEqual(['b'])
    expect(forced.panels[0]?.agentIds).toEqual(['b'])
  })

  it('refuses a force-remove that would empty a panel', () => {
    const c = cfg([agent('a')], [panel('solo', ['a'])])
    expect(() => removeAgent(c, 'a', { force: true })).toThrow(/would leave panel\(s\) empty/)
  })
})

describe('panel CRUD', () => {
  it('adds, gets, lists, rejects dups and unknown agent refs', () => {
    const base = cfg([agent('a')])
    const c = addPanel(base, panel('p', ['a']))
    expect(listPanels(c).map((p) => p.id)).toEqual(['p'])
    expect(getPanel(c, 'p')?.id).toBe('p')
    expect(() => addPanel(c, panel('p', ['a']))).toThrow(/already exists/)
    expect(() => addPanel(base, panel('q', ['ghost']))).toThrow(ConfigIntegrityError)
  })

  it('updates and removes panels', () => {
    const c = addPanel(cfg([agent('a')]), panel('p', ['a']))
    expect(updatePanel(c, 'p', { name: 'Renamed' }).panels[0]?.name).toBe('Renamed')
    expect(() => updatePanel(c, 'ghost', { name: 'x' })).toThrow(/not found/)
    expect(removePanel(c, 'p').panels).toEqual([])
    expect(() => removePanel(c, 'ghost')).toThrow(/not found/)
  })
})
