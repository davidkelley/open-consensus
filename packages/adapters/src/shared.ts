import { type RunResult, runProcess } from '@open-consensus/proc'
import type { AdapterParseResult, DetectResult } from './types'

/** Per-adapter options: the binary path is overridable so tests point at a fake. */
export interface AdapterOptions {
  /** Path/name of the CLI binary (default: the tool's name, resolved via PATH). */
  binPath?: string
}

const VERSION_TIMEOUT_MS = 5000

/**
 * Minimal env for the detect probe. The runner drops the inherited env, so detect
 * must supply a PATH (to find the binary) + a few common vars — never secrets.
 */
function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'SystemRoot', 'LANG'] as const) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Availability probe (plan D8): run `<bin> --version`. A spawn error means the
 * binary is absent (-> unavailable); a non-zero exit means an unexpected
 * interface. The first output line is reported as the version.
 */
export async function probeVersion(
  binPath: string,
  versionArgs: readonly string[] = ['--version'],
  env: Record<string, string> = probeEnv(),
): Promise<DetectResult> {
  const result = await runProcess(
    { file: binPath, args: [...versionArgs], env },
    { timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: 64_000 },
  )
  if (result.outcome === 'spawn-error') {
    return { available: false, reason: result.error ?? 'binary not found' }
  }
  if (result.outcome !== 'exited' || result.exitCode !== 0) {
    return {
      available: false,
      reason: `--version exited with ${result.exitCode ?? result.outcome}`,
    }
  }
  const version = (result.stdout || result.stderr).trim().split('\n')[0]?.slice(0, 200) ?? ''
  return { available: true, version }
}

/**
 * Translate the runner's mechanical outcomes (timeout/cancel/overflow/spawn) into
 * an adapter result. Returns `null` for a normal `exited` outcome, so the adapter
 * applies its own exit-code + output classification (D8).
 */
export function nonExitedResult(result: RunResult): AdapterParseResult | null {
  switch (result.outcome) {
    case 'timeout':
      return { status: 'error', text: '', errorClass: 'timeout' }
    case 'cancelled':
      return { status: 'error', text: '', errorClass: 'cancelled' }
    case 'output-overflow':
      return { status: 'error', text: result.stdout, errorClass: 'output-overflow' }
    case 'spawn-error':
      return { status: 'error', text: '', errorClass: result.error ?? 'spawn-error' }
    default:
      return null
  }
}
