import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  createPosixTerminator,
  createProcessTerminator,
  createWindowsTerminator,
} from './terminator'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number, ms = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (!alive(pid)) return true
    await delay(20)
  }
  return !alive(pid)
}

describe('createProcessTerminator', () => {
  it('selects a backend per platform', () => {
    expect(typeof createProcessTerminator('win32').terminate).toBe('function')
    expect(typeof createProcessTerminator('linux').terminate).toBe('function')
    expect(typeof createProcessTerminator('darwin').terminate).toBe('function')
  })
})

describe('posix terminator', () => {
  it('returns immediately for a dead pid', async () => {
    await expect(createPosixTerminator().terminate(2 ** 30)).resolves.toBeUndefined()
  })

  it('SIGTERMs a cooperative detached process group', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    const pid = child.pid as number
    await createPosixTerminator().terminate(pid, { graceMs: 1500 })
    expect(await waitGone(pid)).toBe(true)
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'],
      { detached: true, stdio: 'ignore' },
    )
    const pid = child.pid as number
    await createPosixTerminator().terminate(pid, { graceMs: 150 })
    expect(await waitGone(pid)).toBe(true)
  })

  it('falls back to the bare pid when there is no process group', async () => {
    // Not detached -> no own group, so kill(-pid) fails and we fall back.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    const pid = child.pid as number
    await createPosixTerminator().terminate(pid, { graceMs: 1500 })
    expect(await waitGone(pid)).toBe(true)
  })

  it('SIGKILLs the GROUP when the leader exits but a grandchild ignores SIGTERM', async () => {
    // Leader spawns a SIGTERM-ignoring grandchild (same group), prints its pid,
    // then exits cooperatively on SIGTERM. The leader dies but the group must
    // still be SIGKILLed so the grandchild is reaped.
    const leaderCode = [
      'const { spawn } = require("node:child_process");',
      'const gc = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\',()=>{});setTimeout(()=>{},60000)"], { stdio: "ignore" });',
      'process.stdout.write(String(gc.pid));',
      'process.on("SIGTERM", () => process.exit(0));',
      'setTimeout(() => {}, 60000);',
    ].join('')
    const leader = spawn(process.execPath, ['-e', leaderCode], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const pid = leader.pid as number
    const gcPid = await new Promise<number>((resolve) => {
      leader.stdout?.on('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())))
    })
    await createPosixTerminator().terminate(pid, { graceMs: 200 })
    expect(await waitGone(pid)).toBe(true)
    expect(await waitGone(gcPid)).toBe(true)
  })
})

describe('windows terminator (fake spawn)', () => {
  const fakeSpawn = (impl: (ee: EventEmitter) => void) =>
    (() => {
      const ee = new EventEmitter()
      queueMicrotask(() => impl(ee))
      return ee as unknown as ChildProcess
    }) as unknown as typeof spawn

  it('resolves when taskkill exits', async () => {
    const term = createWindowsTerminator(fakeSpawn((ee) => ee.emit('exit', 0)))
    await expect(term.terminate(123)).resolves.toBeUndefined()
  })

  it('resolves when taskkill errors', async () => {
    const term = createWindowsTerminator(fakeSpawn((ee) => ee.emit('error', new Error('x'))))
    await expect(term.terminate(123)).resolves.toBeUndefined()
  })

  it('resolves if spawning taskkill throws', async () => {
    const throwing = (() => {
      throw new Error('no taskkill')
    }) as unknown as typeof spawn
    await expect(createWindowsTerminator(throwing).terminate(123)).resolves.toBeUndefined()
  })
})
