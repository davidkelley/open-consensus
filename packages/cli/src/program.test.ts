import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@open-consensus/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CliDeps, resolveConfigFile, run } from './program'

describe('config CLI', () => {
  let dir: string
  let configFile: string
  let lines: string[]
  let deps: CliDeps

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cli-'))
    configFile = join(dir, 'config.json')
    lines = []
    deps = { configFile, out: (line) => lines.push(line) }
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const argv = (...args: string[]) => ['node', 'open-consensus', ...args]

  it('adds agents and panels, then lists them', async () => {
    await run(argv('agent', 'add', 'claude', '--adapter', 'claude', '--model', 'opus'), deps)
    await run(argv('agent', 'add', 'codex', '--adapter', 'codex'), deps)
    await run(argv('panel', 'create', 'quick', '--agents', 'claude, codex', '--quorum', '1'), deps)

    const config = loadConfig(configFile)
    expect(config.agents.map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(config.panels[0]).toMatchObject({
      id: 'quick',
      agentIds: ['claude', 'codex'],
      quorum: 1,
    })

    lines.length = 0
    await run(argv('agent', 'list'), deps)
    await run(argv('panel', 'list'), deps)
    expect(lines).toEqual([
      'claude  (claude / opus)',
      'codex  (codex)',
      'quick  [claude, codex]  quorum 1',
    ])
  })

  it('defaults panel quorum to the panel size', async () => {
    await run(argv('agent', 'add', 'a', '--adapter', 'mock'), deps)
    await run(argv('agent', 'add', 'b', '--adapter', 'mock'), deps)
    await run(argv('panel', 'create', 'p', '--agents', 'a,b'), deps)
    expect(loadConfig(configFile).panels[0]?.quorum).toBe(2)
  })

  it('reports empty lists', async () => {
    await run(argv('agent', 'list'), deps)
    await run(argv('panel', 'list'), deps)
    expect(lines).toEqual(['no agents configured', 'no panels configured'])
  })

  it('surfaces store errors (duplicate agent)', async () => {
    await run(argv('agent', 'add', 'a', '--adapter', 'mock'), deps)
    await expect(run(argv('agent', 'add', 'a', '--adapter', 'mock'), deps)).rejects.toThrow(
      /already exists/,
    )
  })

  it('rejects a missing required option', async () => {
    await expect(run(argv('agent', 'add', 'a'), deps)).rejects.toThrow()
  })

  it('uses default deps (env-resolved config + console.log) when none are passed', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('OPEN_CONSENSUS_CONFIG', configFile)
    try {
      await run(argv('agent', 'list'))
      expect(spy).toHaveBeenCalledWith('no agents configured')
    } finally {
      spy.mockRestore()
      vi.unstubAllEnvs()
    }
  })
})

describe('resolveConfigFile', () => {
  it('honors OPEN_CONSENSUS_CONFIG', () => {
    expect(resolveConfigFile({ OPEN_CONSENSUS_CONFIG: '/tmp/x/config.json' })).toBe(
      '/tmp/x/config.json',
    )
  })

  it('falls back to the XDG config path', () => {
    expect(resolveConfigFile({ HOME: '/home/x' })).toBe(
      '/home/x/.config/open-consensus/config.json',
    )
  })

  it('treats an empty OPEN_CONSENSUS_CONFIG as unset', () => {
    expect(resolveConfigFile({ HOME: '/home/x', OPEN_CONSENSUS_CONFIG: '' })).toBe(
      '/home/x/.config/open-consensus/config.json',
    )
  })
})
