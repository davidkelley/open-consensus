import { describe, expect, it } from 'vitest'
import { ConfigVersionError, detectVersion, migrate, runMigrations } from './migrations'

describe('detectVersion', () => {
  it('reads an integer schemaVersion', () => {
    expect(detectVersion({ schemaVersion: 1 })).toBe(1)
    expect(detectVersion({ schemaVersion: 7 })).toBe(7)
  })

  it('returns 0 for unversioned / non-object / non-integer / negative values', () => {
    expect(detectVersion({})).toBe(0)
    expect(detectVersion(null)).toBe(0)
    expect(detectVersion('x')).toBe(0)
    expect(detectVersion({ schemaVersion: 1.5 })).toBe(0)
    expect(detectVersion({ schemaVersion: -1 })).toBe(0)
  })
})

describe('runMigrations', () => {
  it('is a no-op when fromVersion === toVersion', () => {
    const raw = { schemaVersion: 1, a: 1 }
    expect(runMigrations(raw, 1, 1, {})).toBe(raw)
  })

  it('applies each ordered step and stamps schemaVersion', () => {
    const out = runMigrations({ schemaVersion: 1 }, 1, 3, {
      1: (r) => ({ ...r, addedInV2: true }),
      2: (r) => ({ ...r, addedInV3: true }),
    })
    expect(out).toEqual({ schemaVersion: 3, addedInV2: true, addedInV3: true })
  })

  it('throws when a step in the path is missing', () => {
    expect(() => runMigrations({ schemaVersion: 1 }, 1, 2, {})).toThrow(ConfigVersionError)
  })
})

describe('migrate', () => {
  it('passes a current-version config through unchanged', () => {
    const raw = { schemaVersion: 1, agents: [], panels: [] }
    expect(migrate(raw)).toEqual(raw)
  })

  it('throws for a version newer than this build supports', () => {
    expect(() => migrate({ schemaVersion: 99 })).toThrow(/newer than this build supports/)
  })

  it('stamps an unversioned object as v1 (so hand-written configs are accepted)', () => {
    expect(migrate({ agents: [] })).toEqual({ agents: [], schemaVersion: 1 })
  })

  it('passes non-object unversioned values through (schema then surfaces the error)', () => {
    expect(migrate('nope')).toBe('nope')
    expect(migrate(null)).toBe(null)
    const arr: unknown[] = []
    expect(migrate(arr)).toBe(arr)
  })
})
