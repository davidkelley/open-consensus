import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Daemon lifecycle primitives (plan D2/D14): an atomic single-instance lock and
 * an endpoint discovery file. Kept dependency-free — a `wx` (O_CREAT|O_EXCL)
 * open is atomic, and staleness is decided by PID liveness + start time.
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
  try {
    const fd = openSync(lockPath, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(info))
    } finally {
      closeSync(fd)
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const existing = readLock(lockPath)
    if (existing && isAlive(existing.pid)) return false
    if (reclaimed) return false // already tried once; avoid a reclaim loop
    rmSync(lockPath, { force: true })
    return acquireLock(lockPath, info, true)
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
