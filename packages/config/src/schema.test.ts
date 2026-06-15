import { describe, expect, it } from 'vitest'
import { agentSchema, configSchema, formatZodError, panelSchema } from './schema'

describe('agentSchema', () => {
  it('applies defaults for optional fields', () => {
    const agent = agentSchema.parse({ id: 'claude', name: 'Claude', adapter: 'claude' })
    expect(agent).toMatchObject({
      args: [],
      env: {},
      timeoutMs: 120_000,
      maxRetries: 2,
      sessionMode: 'stateless',
    })
  })

  it('rejects a non-kebab id with an actionable message', () => {
    const result = agentSchema.safeParse({ id: 'Bad_ID', name: 'x', adapter: 'mock' })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/kebab-case/)
  })

  it('rejects unknown keys (strict) and empty required fields', () => {
    expect(agentSchema.safeParse({ id: 'a', name: 'a', adapter: 'm', extra: 1 }).success).toBe(
      false,
    )
    expect(agentSchema.safeParse({ id: 'a', name: '', adapter: 'm' }).success).toBe(false)
    expect(agentSchema.safeParse({ id: 'a', name: 'a', adapter: '' }).success).toBe(false)
  })
})

describe('panelSchema', () => {
  it('requires at least one agent and a positive quorum', () => {
    expect(panelSchema.safeParse({ id: 'p', name: 'P', agentIds: [], quorum: 1 }).success).toBe(
      false,
    )
    expect(panelSchema.safeParse({ id: 'p', name: 'P', agentIds: ['a'], quorum: 0 }).success).toBe(
      false,
    )
  })
})

describe('configSchema referential integrity', () => {
  const agent = (id: string) => ({ id, name: id, adapter: 'mock' })

  it('accepts a consistent config', () => {
    const result = configSchema.safeParse({
      schemaVersion: 1,
      agents: [agent('a'), agent('b')],
      panels: [{ id: 'quick', name: 'Quick', agentIds: ['a', 'b'], quorum: 2 }],
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown schemaVersion', () => {
    expect(configSchema.safeParse({ schemaVersion: 2, agents: [], panels: [] }).success).toBe(false)
  })

  it('flags duplicate agent ids, duplicate panel ids, unknown refs, dup refs, and over-quorum', () => {
    const result = configSchema.safeParse({
      schemaVersion: 1,
      agents: [agent('a'), agent('a')],
      panels: [
        { id: 'p', name: 'P', agentIds: ['a', 'a'], quorum: 9 },
        { id: 'p', name: 'P2', agentIds: ['ghost'], quorum: 1 },
      ],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const text = formatZodError(result.error)
      expect(text).toMatch(/duplicate agent id 'a'/)
      expect(text).toMatch(/duplicate panel id 'p'/)
      expect(text).toMatch(/references unknown agent 'ghost'/)
      expect(text).toMatch(/lists a duplicate agent/)
      expect(text).toMatch(/quorum \(9\) exceeds panel size/)
    }
  })
})

describe('formatZodError', () => {
  it('prefixes each issue with its path (or root)', () => {
    const result = configSchema.safeParse({ schemaVersion: 1, agents: 'nope' })
    expect(result.success).toBe(false)
    if (!result.success) expect(formatZodError(result.error)).toMatch(/^ {2}- agents:/m)
  })

  it('labels a root-level issue as (root)', () => {
    const result = configSchema.safeParse(null)
    expect(result.success).toBe(false)
    if (!result.success) expect(formatZodError(result.error)).toContain('(root)')
  })
})
