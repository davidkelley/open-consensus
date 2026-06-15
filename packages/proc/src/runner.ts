import { spawn } from 'node:child_process'
import { stripAnsi } from './ansi'
import { type ProcessTerminator, createProcessTerminator } from './terminator'

/** Sentinel env var tagging every spawned group for the daemon orphan sweep (D10). */
export const SENTINEL_ENV = 'OPEN_CONSENSUS_DAEMON'

export type RunOutcome = 'exited' | 'timeout' | 'cancelled' | 'output-overflow' | 'spawn-error'

export interface ProcessSpec {
  /** Executable to run. Should be an absolute, trusted path; never shell. */
  file: string
  /** Argument vector (no shell interpolation). */
  args?: string[]
  /** Working directory — the engine passes an ephemeral scratch dir (D20). */
  cwd?: string
  /**
   * Child environment. The runner passes ONLY this (plus the sentinel) — the
   * inherited env is intentionally dropped (D8/D20). The caller MUST therefore
   * compose a usable env, including a sanitized `PATH` (and `SystemRoot` on
   * Windows), or the child won't be able to resolve any binary it shells out to.
   */
  env?: Record<string, string>
  /** Prompt delivered on stdin (preferred over argv; plan D5). */
  stdin?: string
}

export interface RunOptions {
  /** Per-invocation timeout; on expiry the whole tree is killed. */
  timeoutMs: number
  /**
   * Byte cap on EACH captured stream; exceeding it tree-kills the child. Peak
   * in-memory capture is therefore up to ~2x this value (stdout + stderr).
   */
  maxOutputBytes: number
  /** Cancellation — abort tree-kills the child. */
  signal?: AbortSignal
  /** Terminator backend (defaults to the platform terminator). */
  terminator?: ProcessTerminator
  /** Daemon id stamped into the child env for the orphan sweep. */
  daemonId?: string
  /**
   * Receives every RAW chunk (pre-clean) so the engine can spill it to disk.
   * Chunks are raw bytes: a multi-byte UTF-8 codepoint may split across two
   * chunks, so callers MUST concatenate (or use a StringDecoder) before decoding.
   */
  onRaw?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void
}

export interface RunResult {
  outcome: RunOutcome
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** Cleaned (ANSI/control stripped), byte-capped stdout. */
  stdout: string
  /** Cleaned, byte-capped stderr. */
  stderr: string
  /** True if either stream hit the byte cap. */
  truncated: boolean
  durationMs: number
  /** Present on spawn-error. */
  error?: string
}

interface Stream {
  chunks: Buffer[]
  bytes: number
}

/**
 * Run a child process as a hardened security/lifecycle boundary (plan D10):
 * `shell:false`, argv-only, its own process group (so timeout/cancel/overflow
 * reap the whole tree), byte-capped streams with raw spill, and ANSI/control
 * stripping. Semantic ok/refusal/error classification is the *adapter's* job
 * (D8) — this layer only reports mechanics.
 */
export function runProcess(spec: ProcessSpec, options: RunOptions): Promise<RunResult> {
  const terminator = options.terminator ?? createProcessTerminator()
  const start = Date.now()

  return new Promise<RunResult>((resolve) => {
    let settled = false
    let outcome: RunOutcome = 'exited'
    let truncated = false
    let killing = false
    const cleanups: Array<() => void> = []
    const streams: Record<'stdout' | 'stderr', Stream> = {
      stdout: { chunks: [], bytes: 0 },
      stderr: { chunks: [], bytes: 0 },
    }

    const env = { ...spec.env }
    if (options.daemonId) env[SENTINEL_ENV] = options.daemonId

    const finish = (
      result: RunOutcome,
      code: number | null,
      sig: NodeJS.Signals | null,
      error?: string,
    ): void => {
      if (settled) return
      settled = true
      for (const cleanup of cleanups) cleanup()
      resolve({
        outcome: result,
        exitCode: code,
        signal: sig,
        stdout: stripAnsi(Buffer.concat(streams.stdout.chunks).toString('utf8')),
        stderr: stripAnsi(Buffer.concat(streams.stderr.chunks).toString('utf8')),
        truncated,
        durationMs: Date.now() - start,
        ...(error ? { error } : {}),
      })
    }

    // A pre-cancelled invocation must never launch the process (no spend, D20).
    if (options.signal?.aborted) {
      finish('cancelled', null, null)
      return
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.file, spec.args ?? [], {
        cwd: spec.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // own process group, so we can reap the whole tree
        shell: false,
        windowsHide: true,
      })
    } catch (err) {
      finish('spawn-error', null, null, (err as Error).message)
      return
    }

    const pid = child.pid

    const killTree = (): void => {
      if (killing || pid === undefined) return
      killing = true
      void terminator.terminate(pid).catch(() => {})
      // Defensive: if an orphaned grandchild keeps our stdio pipes open, 'close'
      // may never fire — resolve anyway after a bounded grace. signal is null
      // because no OS close was observed (don't fabricate a SIGKILL signal).
      const fallback = setTimeout(() => finish(outcome, null, null), 8000)
      fallback.unref()
      cleanups.push(() => clearTimeout(fallback))
    }

    // First terminal kill reason wins (a later timeout must not mask an
    // already-recorded output-overflow, and vice versa).
    const requestKill = (reason: RunOutcome): void => {
      if (!killing) outcome = reason
      killTree()
    }

    function onAbort(): void {
      requestKill('cancelled')
    }

    const collect = (name: 'stdout' | 'stderr', chunk: Buffer): void => {
      options.onRaw?.(name, chunk)
      const s = streams[name]
      if (s.bytes >= options.maxOutputBytes) {
        // Already full and yet more data arrived -> genuine overflow (covers a
        // chunk that exactly filled the cap, then another chunk follows).
        truncated = true
        requestKill('output-overflow')
        return
      }
      const remaining = options.maxOutputBytes - s.bytes
      if (chunk.length > remaining) {
        s.chunks.push(chunk.subarray(0, remaining))
        s.bytes = options.maxOutputBytes
        truncated = true
        requestKill('output-overflow')
      } else {
        s.chunks.push(chunk)
        s.bytes += chunk.length
      }
    }

    child.stdout?.on('data', (c: Buffer) => collect('stdout', c))
    child.stderr?.on('data', (c: Buffer) => collect('stderr', c))
    child.on('error', (err) => finish('spawn-error', null, null, err.message))
    child.on('close', (code, sig) => finish(outcome, code, sig))

    // EPIPE if the child exits before consuming stdin — swallow it.
    child.stdin?.on('error', () => {})
    child.stdin?.end(spec.stdin ?? '')

    const timer = setTimeout(() => requestKill('timeout'), options.timeoutMs)
    cleanups.push(() => clearTimeout(timer))

    // The signal is guaranteed not-yet-aborted here — the pre-spawn guard above
    // already handled an already-aborted signal.
    const { signal } = options
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => signal.removeEventListener('abort', onAbort))
    }
  })
}
