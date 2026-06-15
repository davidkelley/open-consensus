import { chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type RunResult, runProcess } from '@open-consensus/proc'
import { beforeAll, describe, expect, it } from 'vitest'
import { REAL_ADAPTER_IDS, capabilityMatrix, createAdapter, defaultRegistry } from './registry'
import { nonExitedResult, probeVersion, resolveBinaryPath } from './shared'
import type { Adapter, AdapterInvocationContext } from './types'

const FAKE = fileURLToPath(new URL('../test/fixtures/fake-cli.mjs', import.meta.url))

beforeAll(() => {
  chmodSync(FAKE, 0o755) // the runner spawns it directly via its shebang
})

/** Build the adapter's invocation and run it through the real runner + fake CLI. */
async function run(
  adapter: Adapter,
  ctx: AdapterInvocationContext,
  fakeEnv: Record<string, string> = {},
): Promise<RunResult> {
  const env = { PATH: process.env.PATH ?? '', ...ctx.env, ...fakeEnv }
  const inv = adapter.buildInvocation({ ...ctx, env })
  return runProcess(
    {
      file: inv.file,
      args: inv.args,
      env: inv.env,
      ...(inv.stdin !== undefined ? { stdin: inv.stdin } : {}),
    },
    { timeoutMs: 5000, maxOutputBytes: 1 << 20 },
  )
}

const ctxFor = (cwd = '/tmp'): AdapterInvocationContext => ({ prompt: 'review this', cwd })

describe('real adapters', () => {
  it('the default registry excludes the unsandboxed opencode (D20 opt-in)', () => {
    expect([...defaultRegistry().keys()].sort()).toEqual(['claude', 'codex', 'gemini', 'mock'])
    // opencode is only present with the explicit elevated opt-in.
    expect([...defaultRegistry({ includeUnsandboxed: true }).keys()].sort()).toEqual([
      'claude',
      'codex',
      'gemini',
      'mock',
      'opencode',
    ])
    expect(createAdapter('nope')).toBeUndefined()
  })

  it('reports a capability matrix (opencode has no native sandbox)', () => {
    const rows = capabilityMatrix()
    expect(rows.map((r) => r.id).sort()).toEqual(['claude', 'codex', 'gemini', 'opencode'])
    expect(rows.every((r) => r.nonInteractive)).toBe(true)
    expect(rows.find((r) => r.id === 'opencode')?.sandbox).toBe(false)
    expect(rows.find((r) => r.id === 'claude')?.sandbox).toBe(true)
  })

  it('claude: -p/json/plan, prompt on stdin, parses the result envelope', () => {
    const claude = createAdapter('claude', { binPath: FAKE }) as Adapter
    const inv = claude.buildInvocation({ ...ctxFor(), model: 'opus', args: ['--extra'] })
    // Mandatory safety/output flags come LAST so a config `arg` can't override them.
    expect(inv.args).toEqual([
      '-p',
      '--extra',
      '--model',
      'opus',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
    ])
    expect(inv.stdin).toBe('review this')
  })

  it('claude: classifies an ok / error JSON envelope and strips ANSI', async () => {
    const claude = createAdapter('claude', { binPath: FAKE }) as Adapter
    const okResult = await run(claude, ctxFor(), {
      FAKE_STDOUT: JSON.stringify({ result: 'the answer', is_error: false }),
      FAKE_ANSI: '1', // the runner must strip real ANSI before the adapter JSON-parses
    })
    const ok = claude.parse(okResult, ctxFor())
    expect(ok).toEqual({ status: 'ok', text: 'the answer' })

    const errResult = await run(claude, ctxFor(), {
      FAKE_STDOUT: JSON.stringify({ result: 'nope', is_error: true, subtype: 'error_max_turns' }),
    })
    expect(claude.parse(errResult, ctxFor())).toMatchObject({ status: 'error', text: 'nope' })
  })

  it('codex: exec read-only sandbox + skip-git-repo-check, text output', async () => {
    const codex = createAdapter('codex', { binPath: FAKE }) as Adapter
    const inv = codex.buildInvocation({ ...ctxFor(), model: 'o3' })
    expect(inv.args).toEqual([
      'exec',
      '--model',
      'o3',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
    ])
    expect(inv.stdin).toBe('review this')
    const result = await run(codex, ctxFor(), { FAKE_STDOUT: 'codex says hello' })
    expect(codex.parse(result, ctxFor())).toEqual({ status: 'ok', text: 'codex says hello' })
  })

  it('gemini: -p arg + approval-mode plan + json, parses the response field', async () => {
    const gemini = createAdapter('gemini', { binPath: FAKE }) as Adapter
    const inv = gemini.buildInvocation({ ...ctxFor(), model: 'gemini-3.1-pro' })
    expect(inv.args).toEqual([
      '-p',
      'review this',
      '-m',
      'gemini-3.1-pro',
      '--approval-mode',
      'plan',
      '-o',
      'json',
    ])
    expect(inv.stdin).toBeUndefined() // prompt delivered via arg
    const result = await run(gemini, ctxFor(), {
      FAKE_STDOUT: JSON.stringify({ response: 'gem answer' }),
    })
    expect(gemini.parse(result, ctxFor())).toEqual({ status: 'ok', text: 'gem answer' })
  })

  it('opencode: run with the message as the trailing positional', async () => {
    const opencode = createAdapter('opencode', { binPath: FAKE }) as Adapter
    const inv = opencode.buildInvocation({ ...ctxFor(), model: 'anthropic/claude' })
    // `--` guards a prompt that starts with `-` from being read as a flag.
    expect(inv.args).toEqual(['run', '--model', 'anthropic/claude', '--', 'review this'])
    const result = await run(opencode, ctxFor(), { FAKE_STDOUT: 'oc answer' })
    expect(opencode.parse(result, ctxFor())).toEqual({ status: 'ok', text: 'oc answer' })
  })

  it('every adapter maps a non-zero exit, a timeout, and a missing binary', async () => {
    for (const id of REAL_ADAPTER_IDS) {
      const adapter = createAdapter(id, { binPath: FAKE }) as Adapter
      const errResult = await run(adapter, ctxFor(), {
        FAKE_MODE: 'error',
        FAKE_EXIT: '2',
        FAKE_STDERR: 'bad',
      })
      expect(adapter.parse(errResult, ctxFor())).toMatchObject({
        status: 'error',
        errorClass: 'exit-2',
      })

      const timeoutResult = await runProcess(
        { file: FAKE, args: ['exec'], env: { PATH: process.env.PATH ?? '', FAKE_MODE: 'timeout' } },
        { timeoutMs: 150, maxOutputBytes: 1 << 20 },
      )
      expect(adapter.parse(timeoutResult, ctxFor())).toEqual({
        status: 'error',
        text: '',
        errorClass: 'timeout',
      })

      // detect() against a missing binary -> unavailable.
      const missing = createAdapter(id, { binPath: '/nonexistent/oc-bin-xyz' }) as Adapter
      expect((await missing.detect()).available).toBe(false)
    }
  })

  it('detect() reports the version of an installed (fake) binary', async () => {
    const claude = createAdapter('claude', { binPath: FAKE }) as Adapter
    const detected = await claude.detect()
    expect(detected.available).toBe(true)
    expect(detected.version).toContain('fake-cli')
  })

  it('parses prompt delivered on stdin (echo round-trip)', async () => {
    const codex = createAdapter('codex', { binPath: FAKE }) as Adapter
    const result = await run(codex, ctxFor(), { FAKE_ECHO_STDIN: '1' })
    expect(codex.parse(result, ctxFor()).text).toBe('review this')
  })

  it('claude / gemini fall back to raw text when output is not JSON', async () => {
    const claude = createAdapter('claude', { binPath: FAKE }) as Adapter
    const r1 = await run(claude, ctxFor(), { FAKE_STDOUT: 'plain, not json' })
    expect(claude.parse(r1, ctxFor())).toEqual({ status: 'ok', text: 'plain, not json' })

    const gemini = createAdapter('gemini', { binPath: FAKE }) as Adapter
    const r2 = await run(gemini, ctxFor(), { FAKE_STDOUT: 'also not json' })
    expect(gemini.parse(r2, ctxFor())).toEqual({ status: 'ok', text: 'also not json' })
    // gemini picks the text/content field, and falls back to raw on a non-string.
    const r3 = await run(gemini, ctxFor(), { FAKE_STDOUT: JSON.stringify({ text: 'via text' }) })
    expect(gemini.parse(r3, ctxFor()).text).toBe('via text')
    const r4 = await run(gemini, ctxFor(), { FAKE_STDOUT: JSON.stringify({ response: 42 }) })
    expect(gemini.parse(r4, ctxFor()).text).toContain('42') // non-string -> raw stdout
  })

  it('honors extra args from the agent config', () => {
    for (const id of REAL_ADAPTER_IDS) {
      const adapter = createAdapter(id, { binPath: FAKE }) as Adapter
      const inv = adapter.buildInvocation({ ...ctxFor(), args: ['--marker'] })
      expect(inv.args).toContain('--marker')
    }
  })

  it('nonExitedResult maps the runner mechanical outcomes', () => {
    const base = {
      exitCode: null,
      signal: null,
      stdout: 'partial',
      stderr: '',
      truncated: false,
      durationMs: 1,
    } as const
    expect(nonExitedResult({ ...base, outcome: 'cancelled' })).toMatchObject({
      status: 'error',
      errorClass: 'cancelled',
    })
    expect(nonExitedResult({ ...base, outcome: 'output-overflow' })).toMatchObject({
      status: 'error',
      text: 'partial',
      errorClass: 'output-overflow',
    })
    expect(nonExitedResult({ ...base, outcome: 'spawn-error', error: 'ENOENT' })).toMatchObject({
      errorClass: 'ENOENT',
    })
    expect(nonExitedResult({ ...base, outcome: 'exited', exitCode: 0 })).toBeNull()
  })

  it('probeVersion reports unavailable when --version exits non-zero', async () => {
    const detected = await probeVersion(FAKE, ['--version'], {
      PATH: process.env.PATH ?? '',
      FAKE_VERSION_EXIT: '3',
    })
    expect(detected.available).toBe(false)
    expect(detected.reason).toContain('3')
  })

  it('resolveBinaryPath resolves a bare name on PATH and passes a path through', () => {
    expect(resolveBinaryPath('/abs/path')).toBe('/abs/path')
    expect(resolveBinaryPath('definitely-not-a-real-bin-xyz')).toBe('definitely-not-a-real-bin-xyz')
    const node = resolveBinaryPath('node')
    expect(node === 'node' || node.endsWith('node')).toBe(true) // resolved when present
  })

  it('claude surfaces a drifted envelope shape and parses banner-wrapped JSON', async () => {
    const claude = createAdapter('claude', { binPath: FAKE }) as Adapter
    // A non-string `result` is schema drift -> error, not a silent empty `ok`.
    const drift = await run(claude, ctxFor(), { FAKE_STDOUT: JSON.stringify({ result: 42 }) })
    expect(claude.parse(drift, ctxFor())).toMatchObject({
      status: 'error',
      errorClass: 'unparseable-result',
    })
    // A stray banner line before the JSON is still parsed (loose extraction).
    const banner = await run(claude, ctxFor(), {
      FAKE_STDOUT: `Update available!\n${JSON.stringify({ result: 'hi', is_error: false })}`,
    })
    expect(claude.parse(banner, ctxFor())).toEqual({ status: 'ok', text: 'hi' })
  })
})
