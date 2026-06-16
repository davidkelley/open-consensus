import { createMockAdapter } from '@open-consensus/adapters'
import { type Config, parseConfig } from '@open-consensus/config'
import { describe, expect, it } from 'vitest'
import { type AdapterRegistry, resolvePanel } from './resolver'

const registry: AdapterRegistry = new Map([['mock', createMockAdapter()]])

function cfg(overrides: Partial<Parameters<typeof parseConfig>[0] & object> = {}): Config {
  return parseConfig({
    schemaVersion: 1,
    agents: [
      { id: 'a1', name: 'A1', adapter: 'mock', model: 'mock:ok', timeoutMs: 5000, maxRetries: 1 },
      { id: 'a2', name: 'A2', adapter: 'mock' },
    ],
    panels: [{ id: 'p1', name: 'P1', agentIds: ['a1', 'a2'], quorum: 2, concurrency: 3 }],
    ...overrides,
  })
}

describe('resolvePanel', () => {
  it('resolves a panel into runnable agents bound to their adapters', () => {
    const panel = resolvePanel(cfg(), registry, 'p1')
    expect(panel).toBeDefined()
    expect(panel?.panelId).toBe('p1')
    expect(panel?.quorum).toBe(2)
    expect(panel?.concurrency).toBe(3)
    expect(panel?.agents).toHaveLength(2)
    expect(panel?.agents[0]).toMatchObject({ agentId: 'a1', model: 'mock:ok', timeoutMs: 5000 })
    expect(panel?.agents[0]?.adapter.id).toBe('mock')
    // a2 has no model -> the optional field is omitted, not set to undefined.
    expect('model' in (panel?.agents[1] ?? {})).toBe(false)
    // Fully resolvable -> no unavailable members reported.
    expect(panel?.unavailableAgentIds).toBeUndefined()
  })

  it('returns undefined for an unknown panel', () => {
    expect(resolvePanel(cfg(), registry, 'ghost')).toBeUndefined()
  })

  it('surfaces an agent whose adapter is not in the registry as unavailable, not silently dropped', () => {
    const config = parseConfig({
      schemaVersion: 1,
      agents: [
        { id: 'a1', name: 'A1', adapter: 'mock' },
        { id: 'ghost', name: 'Ghost', adapter: 'nonexistent' },
      ],
      panels: [{ id: 'p1', name: 'P1', agentIds: ['a1', 'ghost'], quorum: 1 }],
    })
    const panel = resolvePanel(config, registry, 'p1')
    // The resolvable agent runs; the unknown-adapter member is reported by NAME
    // (D13) so a partial drop can't read a false `met` with a member that vanished.
    expect(panel?.agents.map((a) => a.agentId)).toEqual(['a1'])
    expect(panel?.unavailableAgentIds).toEqual(['ghost'])
  })

  it('all agents unresolvable -> empty agents but every id reported as unavailable', () => {
    const config = parseConfig({
      schemaVersion: 1,
      agents: [{ id: 'a1', name: 'A1', adapter: 'nonexistent' }],
      panels: [{ id: 'p1', name: 'P1', agentIds: ['a1'], quorum: 1 }],
    })
    const panel = resolvePanel(config, registry, 'p1')
    expect(panel?.agents).toHaveLength(0)
    expect(panel?.unavailableAgentIds).toEqual(['a1'])
  })

  it('reports a panel agent id that no longer exists in the roster as unavailable', () => {
    // Build a config, then mutate it past schema validation to drop the agent
    // (simulating drift). The resolver must surface the dangling id, not throw.
    const config = cfg()
    const drifted: Config = { ...config, agents: config.agents.filter((a) => a.id !== 'a2') }
    const panel = resolvePanel(drifted, registry, 'p1')
    expect(panel?.agents.map((a) => a.agentId)).toEqual(['a1'])
    expect(panel?.unavailableAgentIds).toEqual(['a2'])
  })
})
