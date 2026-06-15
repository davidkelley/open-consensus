import type { RunResult } from '@open-consensus/proc'

/**
 * The Adapter contract (plan D8) — **frozen at Stage 3**. An adapter teaches the
 * engine how to drive one CLI tool non-interactively: detect it, build a safe
 * invocation, and classify the result. Semantic ok/refusal/error classification
 * is the adapter's responsibility (the process runner only reports mechanics).
 */

/** What an adapter's CLI supports. */
export interface AdapterCapabilities {
  /** Has a non-interactive "one prompt -> print -> exit" mode. */
  nonInteractive: boolean
  /** Emits a structured/JSON mode we parse the final answer from. */
  structuredOutput: boolean
  /** Defaults to a native read-only / sandbox / no-edit mode (D20). */
  sandbox: boolean
  /** How the prompt is delivered to the CLI. */
  promptDelivery: 'stdin' | 'tempFile' | 'arg'
}

/** Availability probe result. */
export interface DetectResult {
  available: boolean
  version?: string
  /** Why it is unavailable (missing binary, unexpected interface, …). */
  reason?: string
}

/** Per-invocation inputs the engine hands to `buildInvocation` / `parse`. */
export interface AdapterInvocationContext {
  /** Fully-composed prompt for this round (D5). */
  prompt: string
  /** Model override, if configured. */
  model?: string
  /** Extra CLI args from the agent config. */
  args?: string[]
  /**
   * Composed child environment. The engine builds this with an allowlist plus a
   * sanitized `PATH` (and `SystemRoot` on Windows), because the runner passes
   * ONLY this env to the child — the inherited env is dropped (D8/D20).
   */
  env?: Record<string, string>
  /** Ephemeral scratch working directory (D20). */
  cwd: string
  /** Session mode — v1 is always `stateless`; carried for future resume (D5). */
  sessionMode?: 'stateless' | 'resume'
  /** Per-adapter session id (resume mode; unused in v1). */
  sessionId?: string
  /**
   * Engine-allocated writable scratch path the adapter MAY reference in argv for
   * temp-file prompt delivery (D10). The engine writes the prompt (`0600`) and
   * cleans it up; the adapter only formats the path into its arguments.
   */
  promptFile?: string
}

/**
 * A runnable invocation. Mirrors the proc `ProcessSpec` plus prompt delivery.
 * For temp-file delivery the adapter references the *engine-allocated*
 * `ctx.promptFile` path in `args` — it never returns a path, so a bad/malicious
 * adapter can't redirect the engine's write to an arbitrary file.
 */
export interface AdapterInvocation {
  file: string
  args: string[]
  env: Record<string, string>
  /** Prompt delivered on stdin (preferred). */
  stdin?: string
}

export type AdapterStatus = 'ok' | 'refusal' | 'error'

/** The adapter's semantic classification of a finished run. */
export interface AdapterParseResult {
  status: AdapterStatus
  /** The agent's distilled final answer. */
  text: string
  /** Coarse error classification for provenance (e.g. timeout, exit-1). */
  errorClass?: string
}

export interface Adapter {
  /** Stable adapter id (e.g. `claude`, `codex`, `mock`). */
  readonly id: string
  readonly capabilities: AdapterCapabilities
  /** Probe whether the underlying CLI is installed + usable. */
  detect(): Promise<DetectResult>
  /** Compose a safe, runnable invocation for one prompt. */
  buildInvocation(ctx: AdapterInvocationContext): AdapterInvocation
  /**
   * Classify the finished run into ok / refusal / error + distilled text. Gets
   * the invocation context too, so an adapter can use the original prompt /
   * model / structured-output expectations to interpret the result.
   */
  parse(result: RunResult, ctx: AdapterInvocationContext): AdapterParseResult
}
