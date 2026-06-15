import { type RunResult, runProcess } from '@open-consensus/proc'
import { describe, expect, it } from 'vitest'
import { createMockAdapter, mockAdapter } from './mock'
import type { Adapter, AdapterInvocationContext } from './types'

async function drive(
  adapter: Adapter,
  ctx: Partial<AdapterInvocationContext> = {},
  timeoutMs = 3000,
) {
  const context: AdapterInvocationContext = { prompt: 'hi', cwd: process.cwd(), ...ctx }
  const invocation = adapter.buildInvocation(context)
  const result = await runProcess(
    { file: invocation.file, args: invocation.args, env: invocation.env, stdin: invocation.stdin },
    { timeoutMs, maxOutputBytes: 1 << 20 },
  )
  return adapter.parse(result, context)
}

describe('mock adapter (driven through the real runner)', () => {
  it('detects as available', async () => {
    expect((await mockAdapter.detect()).available).toBe(true)
  })

  it('ok mode returns the prompt as a distilled ok answer', async () => {
    expect(await drive(mockAdapter, { prompt: 'ping' })).toEqual({ status: 'ok', text: 'ok:ping' })
  })

  it('refusal mode returns a refusal', async () => {
    expect((await drive(createMockAdapter({ mode: 'refusal' }))).status).toBe('refusal')
  })

  it('error mode returns an error with an exit class', async () => {
    const r = await drive(createMockAdapter({ mode: 'error' }))
    expect(r.status).toBe('error')
    expect(r.errorClass).toBe('exit-1')
  })

  it('timeout mode returns an error classified as timeout', async () => {
    const r = await drive(createMockAdapter({ mode: 'timeout' }), {}, 200)
    expect(r).toEqual({ status: 'error', text: '', errorClass: 'timeout' })
  })

  it('slow mode returns ok after the delay', async () => {
    const r = await drive(createMockAdapter({ mode: 'slow', slowMs: 50 }), { prompt: 'x' })
    expect(r).toEqual({ status: 'ok', text: 'slow:x' })
  })

  it('mode can be overridden per-invocation via a namespaced model string', async () => {
    expect((await drive(mockAdapter, { model: 'mock:refusal' })).status).toBe('refusal')
  })

  it('a real (non-namespaced) model name does NOT select a mock mode', async () => {
    // 'error' as a plain model name must not trigger the error mode.
    expect((await drive(mockAdapter, { model: 'error', prompt: 'p' })).status).toBe('ok')
  })
})

describe('mock parse classification (unit)', () => {
  const ctx: AdapterInvocationContext = { prompt: 'p', cwd: process.cwd() }
  const base: RunResult = {
    outcome: 'exited',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    truncated: false,
    durationMs: 1,
  }

  it('maps every non-ok runner outcome', () => {
    expect(mockAdapter.parse({ ...base, outcome: 'cancelled' }, ctx).errorClass).toBe('cancelled')
    expect(
      mockAdapter.parse({ ...base, outcome: 'output-overflow', stdout: 'x' }, ctx),
    ).toMatchObject({ status: 'error', errorClass: 'output-overflow' })
    expect(
      mockAdapter.parse({ ...base, outcome: 'spawn-error', error: 'boom' }, ctx).errorClass,
    ).toBe('boom')
    expect(mockAdapter.parse({ ...base, outcome: 'spawn-error' }, ctx).errorClass).toBe(
      'spawn-error',
    )
    expect(mockAdapter.parse({ ...base, stdout: 'not json' }, ctx).errorClass).toBe('unparseable')
  })
})
