import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'

/**
 * Daemon lifecycle primitives (plan D2/D14): a single-instance lock and an
 * endpoint discovery file. The lock delegates to **proper-lockfile** — the same
 * battle-tested mkdir + mtime-heartbeat protocol npm uses — rather than a
 * hand-rolled PID-liveness lock, because POSIX has no atomic compare-and-replace
 * and every hand-rolled stale-reclaim scheme has a split-brain reclaim race. A
 * crashed owner's lock goes stale (its mtime heartbeat stops) and is reclaimed
 * automatically after `staleMs`; while the owner lives it heartbeats to stay
 * fresh. The release handle stops the heartbeat and removes the lock.
 */

/** Default ms before a crashed owner's lock is reclaimable (mtime staleness). */
const DEFAULT_STALE_MS = 10_000

export interface DaemonLock {
  /** Release the lock + stop its heartbeat (idempotent, best-effort). */
  release(): void
}

export interface AcquireLockOptions {
  /** Override the staleness window (tests use a short one). */
  staleMs?: number
}

/**
 * Acquire the single-instance lock (D14). Returns a {@link DaemonLock} on
 * success, or `null` if another LIVE daemon holds it (ELOCKED). Other errors
 * (e.g. a missing parent dir) propagate.
 */
export function acquireLock(lockPath: string, options: AcquireLockOptions = {}): DaemonLock | null {
  try {
    const release = lockSync(lockPath, {
      realpath: false, // the lock path itself need not exist; we lock the name
      stale: options.staleMs ?? DEFAULT_STALE_MS,
      // A compromised lock (e.g. its dir deleted out from under us) must not crash
      // the daemon via an uncaught throw from the heartbeat timer.
      onCompromised: () => {},
    })
    return {
      release: () => {
        try {
          release()
        } catch {
          /* already released / compromised — nothing to do */
        }
      },
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') return null
    throw err
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
