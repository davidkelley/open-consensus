import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { type RunResult, runProcess } from '@open-consensus/proc'
import type { AdapterParseResult, DetectResult } from './types'

/** Per-adapter options: the binary path is overridable so tests point at a fake. */
export interface AdapterOptions {
  /** Path/name of the CLI binary (default: the tool's name, resolved via PATH). */
  binPath?: string
}

const VERSION_TIMEOUT_MS = 10_000

/**
 * Resolve a bare binary NAME to an absolute path via PATH, honoring the runner's
 * "file should be an absolute, trusted path" contract and PINNING the resolution
 * (no per-spawn re-lookup). A path that already contains a separator is returned
 * unchanged; an unresolved name is returned as-is (the runner then surfaces a
 * spawn-error -> unavailable). `init` (D21) additionally resolves + lets the user
 * CONFIRM the binary, so an nvm/asdf-shadowed CLI isn't silently mis-picked.
 */
export function resolveBinaryPath(name: string, pathEnv = process.env.PATH ?? ''): string {
  if (name.includes('/') || name.includes('\\') || isAbsolute(name)) return name
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  return name
}

/** A per-adapter binary resolver that resolves the path once, lazily. */
export function lazyBinary(binPath: string): () => string {
  let resolved: string | undefined
  return () => {
    if (resolved === undefined) resolved = resolveBinaryPath(binPath)
    return resolved
  }
}

/**
 * Parse a JSON object a CLI may have wrapped in a stray banner/progress line: try
 * a direct parse, then the first `{`..last `}` span. Returns `undefined` when the
 * output isn't JSON (callers then fall back to raw text).
 */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    /* try to extract a JSON span below */
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      /* not JSON */
    }
  }
  return undefined
}

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
