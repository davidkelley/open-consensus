import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Daemon lifecycle primitives (plan D2/D14): an atomic single-instance lock and
 * an endpoint discovery file. Kept dependency-free — acquisition is a temp-file
 * write + atomic `link()` (so a racer never sees a partial file), and a stale
 * lock (dead PID) is reclaimed by an atomic `rename()` claim so two racers can
 * never both reclaim it. Staleness is decided by PID liveness.
 */

export interface LockInfo {
  pid: number
  /** Process start time (ms) — distinguishes a live owner from a recycled PID. */
  startTime: number
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock(lockPath: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockInfo>
    if (typeof parsed.pid === 'number' && typeof parsed.startTime === 'number') {
      return { pid: parsed.pid, startTime: parsed.startTime }
    }
  } catch {
    /* missing or corrupt -> treat as no valid lock */
  }
  return undefined
}

/**
 * Acquire the singleton lock atomically. Returns true on success. If a LIVE
 * owner holds it, returns false. A stale lock (dead PID, or unreadable) is
 * reclaimed and retried once.
 */
export function acquireLock(lockPath: string, info: LockInfo, reclaimed = false): boolean {
  // Write the content to a private temp file, then hard-link it into place.
  // link() is atomic and fails EEXIST if the lock already exists — so a concurrent
  // starter that loses the race always observes a COMPLETE lock file, never an
  // empty/partial one. (An `openSync('wx')` then write exposes a window where the
  // file exists but is still empty, which would let two daemons both reclaim it —
  // the exact split-brain D14 forbids.)
  const tmp = `${lockPath}.acquire-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 })
    linkSync(tmp, lockPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    if (reclaimed) return false // already tried once; avoid a reclaim loop
    const existing = readLock(lockPath)
    if (existing && isAlive(existing.pid)) return false // a clearly-live owner
    // Stale (or corrupt) lock. Reclaim it ATOMICALLY: rename it aside. Only one
    // racer can rename a given path — the rest get ENOENT and restart — so two
    // daemons can never both reclaim and both `link` (a plain rmSync+link would
    // let a second reclaimer delete the first's freshly-acquired lock: D14).
    const claim = `${lockPath}.reclaim-${randomBytes(6).toString('hex')}`
    try {
      renameSync(lockPath, claim)
    } catch {
      return acquireLock(lockPath, info, false) // lost the claim race; start over
    }
    try {
      // Re-check what we actually moved: if a fresh LIVE lock slipped in between
      // the read and the rename, restore it rather than steal it.
      const moved = readLock(claim)
      if (moved && isAlive(moved.pid)) {
        try {
          linkSync(claim, lockPath)
        } catch {
          /* a newer lock already exists — leave it */
        }
        return false
      }
      return acquireLock(lockPath, info, true) // lockPath is free; we hold `claim`
    } finally {
      rmSync(claim, { force: true })
    }
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Release the lock only if we still own it (best-effort). */
export function releaseLock(lockPath: string, info: LockInfo): void {
  const existing = readLock(lockPath)
  if (existing && existing.pid === info.pid && existing.startTime === info.startTime) {
    rmSync(lockPath, { force: true })
  }
}

export interface Discovery {
  /** Unix socket path, or an `http://127.0.0.1:port` URL. */
  endpoint: string
  /** Bearer token clients must present. */
  token: string
}

/** Atomically (temp + rename) write the 0600 discovery file clients read. */
export function writeDiscovery(path: string, discovery: Discovery): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, JSON.stringify(discovery), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Read the discovery file (clients retry on a transient ENOENT during rename). */
export function readDiscovery(path: string): Discovery | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Discovery>
    if (typeof parsed.endpoint === 'string' && typeof parsed.token === 'string') {
      return { endpoint: parsed.endpoint, token: parsed.token }
    }
  } catch {
    /* missing / mid-rename / corrupt */
  }
  return undefined
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}
