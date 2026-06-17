import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type ProcessSpec, type RunOptions, runProcess } from './runner'
import { createPosixTerminator } from './terminator'

const FIXTURE = fileURLToPath(new URL('../test/fixtures/chaos-child.mjs', import.meta.url))
const NODE = process.execPath

// Fast terminator so SIGTERM-ignoring children don't add the full grace window.
const fastTerminator = {
  terminate: (pid: number) => createPosixTerminator().terminate(pid, { graceMs: 150 }),
}

function run(
  modeArgs: string | string[],
  options: Partial<RunOptions> = {},
  spec: Partial<ProcessSpec> = {},
) {
  const args = Array.isArray(modeArgs) ? modeArgs : [modeArgs]
  return runProcess(
    { file: NODE, args: [FIXTURE, ...args], ...spec },
    { timeoutMs: 5000, maxOutputBytes: 1 << 20, terminator: fastTerminator, ...options },
  )
}

const stillAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('runProcess', () => {
  it('reports the spawned pid via onSpawn (for the orphan registry)', async () => {
    let spawned: number | undefined
    const r = await run('echo', {
      onSpawn: (pid) => {
        spawned = pid
      },
    })
    expect(r.outcome).toBe('exited')
    expect(typeof spawned).toBe('number')
    expect(spawned ?? 0).toBeGreaterThan(0)
  })

  it('survives a throwing onSpawn — the child stays managed', async () => {
    const r = await run('echo', {
      onSpawn: () => {
        throw new Error('registry boom')
      },
    })
    expect(r.outcome).toBe('exited') // still collected + closed normally
  })

  it('delivers stdin and captures a clean exit', async () => {
    const r = await runProcess(
      { file: NODE, args: [FIXTURE, 'echo'], stdin: 'hello world' },
      { timeoutMs: 5000, maxOutputBytes: 1 << 20 },
    )
    expect(r.outcome).toBe('exited')
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('hello world')
    expect(r.truncated).toBe(false)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('strips ANSI and control characters from output', async () => {
    const r = await run('ansi')
    expect(r.outcome).toBe('exited')
    expect(r.stdout).toBe('red plain text\n')
  })

  it('maps a non-zero exit code', async () => {
    const r = await run(['exit', '3'])
    expect(r.outcome).toBe('exited')
    expect(r.exitCode).toBe(3)
  })

  it('reports timeout and kills the process', async () => {
    const r = await run('sleep', { timeoutMs: 200 })
    expect(r.outcome).toBe('timeout')
  })

  it('cancels via an AbortSignal', async () => {
    const ac = new AbortController()
    const p = run('sleep', { signal: ac.signal })
    setTimeout(() => ac.abort(), 100)
    expect((await p).outcome).toBe('cancelled')
  })

  it('honors an already-aborted signal', async () => {
    const r = await run('sleep', { signal: AbortSignal.abort() })
    expect(r.outcome).toBe('cancelled')
  })

  it('caps output, reports overflow + truncation, and forwards raw chunks', async () => {
    const rawSizes: number[] = []
    const r = await run('flood', {
      maxOutputBytes: 1000,
      onRaw: (_stream, chunk) => rawSizes.push(chunk.length),
    })
    expect(r.outcome).toBe('output-overflow')
    expect(r.truncated).toBe(true)
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(1000)
    expect(rawSizes.length).toBeGreaterThan(0)
  })

  it('detects overflow when a chunk exactly fills the cap and more follows', async () => {
    // flood emits 64KiB chunks; a 64KiB cap fills exactly on chunk 1, so the
    // overflow must be detected when chunk 2 arrives (the exact-fill path).
    const r = await run('flood', { maxOutputBytes: 64 * 1024 })
    expect(r.outcome).toBe('output-overflow')
    expect(r.truncated).toBe(true)
  })

  it('reports spawn-error for a missing executable', async () => {
    const r = await runProcess(
      { file: '/nonexistent/oc-bin-xyz' },
      { timeoutMs: 2000, maxOutputBytes: 1024 },
    )
    expect(r.outcome).toBe('spawn-error')
    expect(r.error).toBeTruthy()
  })

  it('reports spawn-error when spawn throws synchronously (invalid path)', async () => {
    const r = await runProcess(
      { file: `bad${String.fromCharCode(0)}name` },
      { timeoutMs: 2000, maxOutputBytes: 1024 },
    )
    expect(r.outcome).toBe('spawn-error')
    expect(r.error).toBeTruthy()
  })

  it('tree-kills a stubborn child and its grandchild', async () => {
    // Generous timeout so even a cold CI runner reliably starts node + spawns the
    // grandchild + flushes `grandchild:<pid>` BEFORE the timeout tree-kills it
    // (200ms was too tight on a slow linux runner — the write raced the kill).
    const r = await run('stubborn', { timeoutMs: 2000 })
    expect(r.outcome).toBe('timeout')
    const match = r.stdout.match(/grandchild:(\d+)/)
    expect(match).toBeTruthy()
    const gcPid = Number((match as RegExpMatchArray)[1])
    let gone = false
    for (let i = 0; i < 100 && !gone; i++) {
      if (!stillAlive(gcPid)) gone = true
      else await new Promise((res) => setTimeout(res, 20))
    }
    expect(gone).toBe(true)
  })
})
