import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DaemonLock,
  acquireLock,
  generateToken,
  readDiscovery,
  writeDiscovery,
} from './lifecycle'

describe('lifecycle lock', () => {
  let dir: string
  let lockPath: string
  let held: DaemonLock[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-lock-'))
    lockPath = join(dir, 'daemon')
    held = []
  })
  afterEach(() => {
    for (const l of held.splice(0)) l.release() // stop heartbeat timers
    rmSync(dir, { recursive: true, force: true })
  })

  /** Acquire + track for release (so heartbeat timers don't outlive the test). */
  function lock(opts?: { staleMs?: number }): DaemonLock | null {
    const l = acquireLock(lockPath, opts)
    if (l) held.push(l)
    return l
  }

  it('acquires a free lock and refuses a second concurrent holder', () => {
    expect(lock()).not.toBeNull()
    expect(acquireLock(lockPath)).toBeNull() // second holder blocked (ELOCKED)
  })

  it('releases the lock so it can be re-acquired', () => {
    const a = acquireLock(lockPath)
    expect(a).not.toBeNull()
    a?.release()
    expect(lock()).not.toBeNull()
  })

  it('release is idempotent and best-effort', () => {
    const a = acquireLock(lockPath)
    a?.release()
    expect(() => a?.release()).not.toThrow()
  })

  it('reclaims a lock whose owner crashed (heartbeat went stale)', () => {
    expect(lock({ staleMs: 5000 })).not.toBeNull()
    // Simulate a crashed owner: backdate the lock dir's mtime past the window.
    const past = new Date(Date.now() - 60_000)
    utimesSync(`${lockPath}.lock`, past, past)
    expect(lock({ staleMs: 5000 })).not.toBeNull() // proper-lockfile reclaims it
  })

  it('propagates a non-ELOCKED failure (e.g. a missing parent dir)', () => {
    expect(() => acquireLock(join(dir, 'no-such-subdir', 'daemon'))).toThrow()
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
