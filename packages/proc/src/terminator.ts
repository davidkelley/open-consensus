import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * Terminates a spawned process **and its whole tree** (plan D10). Abstracted so
 * the POSIX (process-group signalling) and Windows (`taskkill /T`) strategies
 * live behind one interface — macOS/Linux are certified; Windows is best-effort
 * and uncertified.
 */
export interface ProcessTerminator {
  terminate(pid: number, options?: { graceMs?: number }): Promise<void>
}

/**
 * Is the process GROUP still alive? `kill(-pid, 0)` checks the group whose pgid
 * is `pid` — for a detached leader pgid === pid, and the group stays alive while
 * ANY member (e.g. a grandchild that outlived the leader) survives.
 *
 * This terminator operates ONLY on detached children (its documented contract).
 * We deliberately do NOT fall back to a bare `kill(pid, …)`: a recycled bare PID
 * could otherwise be signalled by mistake. PGID reuse is far rarer than PID
 * reuse and the detached-group design keeps the (accepted) race window bounded.
 */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/** Signal the process GROUP (negative pid). Ignores ESRCH if the group is gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    /* group already gone */
  }
}

/**
 * POSIX terminator: SIGTERM the group, poll for up to `graceMs`, then SIGKILL.
 * Requires the child to have been spawned `detached` so its pgid === pid.
 */
export function createPosixTerminator(): ProcessTerminator {
  return {
    async terminate(pid, options = {}) {
      const graceMs = options.graceMs ?? 2000
      if (!groupAlive(pid)) return
      signalGroup(pid, 'SIGTERM')
      const start = Date.now()
      while (Date.now() - start < graceMs) {
        if (!groupAlive(pid)) return
        await delay(25)
      }
      // Group may still hold a SIGTERM-ignoring grandchild even if the leader
      // exited — SIGKILL the whole group.
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')
    },
  }
}

/** Windows terminator (uncertified): `taskkill /PID <pid> /T /F` kills the tree. */
export function createWindowsTerminator(spawn: typeof nodeSpawn = nodeSpawn): ProcessTerminator {
  return {
    terminate(pid) {
      return new Promise<void>((resolve) => {
        let tk: ChildProcess
        try {
          tk = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          resolve()
          return
        }
        tk.once('exit', () => resolve())
        tk.once('error', () => resolve())
      })
    },
  }
}

/** Pick the terminator backend for the running platform. */
export function createProcessTerminator(
  platform: NodeJS.Platform = process.platform,
): ProcessTerminator {
  return platform === 'win32' ? createWindowsTerminator() : createPosixTerminator()
}
