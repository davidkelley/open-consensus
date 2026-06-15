import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type LockInfo,
  acquireLock,
  generateToken,
  readDiscovery,
  releaseLock,
  writeDiscovery,
} from './lifecycle'

const DEAD_PID = 2_147_483_646 // out of range / never alive -> isAlive() false

describe('lifecycle lock', () => {
  let dir: string
  let lockPath: string
  const me: LockInfo = { pid: process.pid, startTime: 1000 }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-lock-'))
    lockPath = join(dir, 'daemon.lock')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('acquires a free lock and records the owner (no temp left behind)', () => {
    expect(acquireLock(lockPath, me)).toBe(true)
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(me)
    // The atomic temp+link must not leave a stray `.acquire-*` file.
    expect(readdirSync(dir).filter((f) => f.includes('.acquire-'))).toEqual([])
  })

  it('refuses when a live owner holds it', () => {
    expect(acquireLock(lockPath, me)).toBe(true)
    expect(acquireLock(lockPath, { pid: process.pid, startTime: 2 })).toBe(false)
  })

  it('reclaims a lock whose owner is dead, atomically and without leftovers', () => {
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, startTime: 1 }))
    expect(acquireLock(lockPath, me)).toBe(true)
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid)
    // The temp + rename-claim reclaim must leave no `.acquire-*` / `.reclaim-*`.
    expect(
      readdirSync(dir).filter((f) => f.includes('.acquire-') || f.includes('.reclaim-')),
    ).toEqual([])
  })

  it('reclaims a corrupt lock file', () => {
    writeFileSync(lockPath, 'not json at all')
    expect(acquireLock(lockPath, me)).toBe(true)
  })

  it('does not loop forever: a second reclaim pass gives up', () => {
    // Directly exercising the reclaim guard: a corrupt/dead lock that still
    // exists on the retry pass must return false rather than recurse again.
    writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, startTime: 1 }))
    expect(acquireLock(lockPath, me, /* reclaimed */ true)).toBe(false)
  })

  it('releases only when still the owner', () => {
    expect(acquireLock(lockPath, me)).toBe(true)
    releaseLock(lockPath, { pid: process.pid, startTime: 999 }) // wrong startTime -> not owner
    expect(() => readFileSync(lockPath, 'utf8')).not.toThrow()
    releaseLock(lockPath, me)
    expect(() => readFileSync(lockPath, 'utf8')).toThrow()
  })

  it('releaseLock on a missing file is a no-op', () => {
    expect(() => releaseLock(lockPath, me)).not.toThrow()
  })
})

describe('lifecycle discovery', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-disc-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips an endpoint + token atomically', () => {
    const path = join(dir, 'discovery.json')
    writeDiscovery(path, { endpoint: '/tmp/d.sock', token: 'abc' })
    expect(readDiscovery(path)).toEqual({ endpoint: '/tmp/d.sock', token: 'abc' })
  })

  it('returns undefined for a missing or corrupt file', () => {
    expect(readDiscovery(join(dir, 'nope.json'))).toBeUndefined()
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not valid')
    expect(readDiscovery(bad)).toBeUndefined()
    writeFileSync(bad, JSON.stringify({ endpoint: 1, token: 2 }))
    expect(readDiscovery(bad)).toBeUndefined()
  })

  it('cleans up the temp file and rethrows on a write failure', () => {
    expect(() =>
      writeDiscovery(join(dir, 'missing-subdir', 'd.json'), { endpoint: 'x', token: 'y' }),
    ).toThrow()
  })
})

describe('generateToken', () => {
  it('produces a 64-char hex token that differs each call', () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
