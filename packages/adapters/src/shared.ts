import { statSync } from 'node:fs'
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
    if (!dir) continue
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate // skip a same-named directory on PATH
  }
  return name
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const MANDATORY_FLAG_SET = new Set<string>()

/**
 * Throw if config `args` would defeat an adapter's mandatory flags: a `--`
 * option-terminator (a parser-independent bypass — it would turn the trailing
 * safety flags into positionals) or any of the adapter's own control flags. This
 * is parser-independent (doesn't rely on the CLI's first/last-wins behavior). The
 * adapter is the last line of defense; the CLI's `agent add` also pre-validates.
 * It does NOT catch every read-only-defeating flag (e.g. claude `--allowedTools`)
 * — that residual is the user's documented responsibility (D20, best-effort).
 */
export function assertSafeArgs(args: readonly string[], forbidden: readonly string[]): void {
  const deny = forbidden.length ? new Set(forbidden) : MANDATORY_FLAG_SET
  for (const arg of args) {
    if (arg === '--') {
      throw new Error('config arg "--" is not allowed: it would defeat the adapter safety flags')
    }
    const name = arg.split('=')[0] ?? arg
    if (deny.has(name)) {
      throw new Error(
        `config arg "${name}" conflicts with a mandatory adapter flag and is not allowed`,
      )
    }
  }
}

/** A per-adapter binary resolver that resolves the path once, lazily. */
export function lazyBinary(binPath: string): () => string {
  let resolved: string | undefined
  return () => {
    if (resolved === undefined) resolved = resolveBinaryPath(binPath)
    return resolved
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined // JSON.parse never returns undefined, so it's a safe sentinel
  }
}

/**
 * Parse a JSON envelope a CLI may have wrapped in banner/progress lines: (1) a
 * direct parse; (2) the LAST object line — handles JSONL/streaming output where
 * the final result is the last `{...}` line; (3) the first `{`..last `}` span —
 * handles a single object spanning lines with surrounding text. Returns
 * `undefined` when none parse (callers fall back to raw text).
 */
export function parseJsonLoose(text: string): unknown {
  const direct = tryParse(text)
  if (direct !== undefined) return direct
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (line?.startsWith('{')) {
      const parsed = tryParse(line)
      if (parsed !== undefined) return parsed
    }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const parsed = tryParse(text.slice(start, end + 1))
    if (parsed !== undefined) return parsed
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
