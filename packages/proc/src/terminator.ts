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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Is the process GROUP (pgid === pid for a detached leader) still alive? */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Liveness for termination: the GROUP (covers grandchildren that outlive a
 * cooperative leader) OR the bare pid (covers non-detached single processes).
 * NOTE: a `kill(pid, 0)`/`kill(-pid, …)` pair is inherently racy w.r.t. PID/PGID
 * reuse on POSIX; the window is microseconds and the risk is accepted (same as
 * the broader ecosystem). The detached process-group design keeps this bounded.
 */
function stillAlive(pid: number): boolean {
  return groupAlive(pid) || alive(pid)
}

/** Signal the process GROUP (negative pid); fall back to the bare pid. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
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
      if (!stillAlive(pid)) return
      signalGroup(pid, 'SIGTERM')
      const start = Date.now()
      while (Date.now() - start < graceMs) {
        if (!stillAlive(pid)) return
        await delay(25)
      }
      // Group may still hold a SIGTERM-ignoring grandchild even if the leader
      // exited — SIGKILL the whole group.
      if (stillAlive(pid)) signalGroup(pid, 'SIGKILL')
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
