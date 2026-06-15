import { type ChildProcess, spawn } from 'node:child_process'
import {
  type DaemonResponse,
  type Discovery,
  daemonRequest,
  readDiscovery,
  waitForReady,
} from '@open-consensus/daemon'
import type { RoundRecord, RunRecord } from '@open-consensus/engine'

/**
 * Daemon control + RPC for the CLI/TUI (plan D21 / Stage 8). This is the
 * *stateless* side of `command-core`: each call is one request/response with no
 * retained connection — the long-lived SSE/transcript concerns live in the TUI's
 * `tui-session` layer (D19), never here, so the one-shot CLI can't hang at exit.
 *
 * command-core speaks a small, focused subset of the daemon HTTP surface via the
 * dependency-free `daemonRequest` (a clean sibling of the MCP client, not a
 * dependency on it) — just what `daemon status`, `run start`, and `run status`
 * need; the rich poll/SSE/get-raw surface stays with the MCP orchestrator.
 */
export class DaemonRpcError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DaemonRpcError'
  }
}

/** Thrown by command functions when no daemon discovery file is present. */
export class DaemonNotRunningError extends Error {
  constructor(message = 'open-consensus daemon is not running — start it with `daemon start`') {
    super(message)
    this.name = 'DaemonNotRunningError'
  }
}

const MAX_ERROR_CHARS = 500

function parse<T>(res: DaemonResponse): T {
  if (res.status < 200 || res.status >= 300) {
    let message = res.body
    try {
      const parsed = (JSON.parse(res.body) as { error?: unknown }).error
      if (typeof parsed === 'string') message = parsed
    } catch {
      /* non-JSON error body */
    }
    throw new DaemonRpcError(res.status, String(message).slice(0, MAX_ERROR_CHARS))
  }
  return JSON.parse(res.body) as T
}

function requireDiscovery(discoveryPath: string): Discovery {
  const discovery = readDiscovery(discoveryPath)
  if (!discovery) throw new DaemonNotRunningError()
  return discovery
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

/** True if `pid` exists and is signalable by this process (POSIX `kill 0`). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// ── status ──────────────────────────────────────────────────────────────────

export interface DaemonStatus {
  running: boolean
  endpoint?: string
  pid?: number
  /** True only when a discovery file exists AND the daemon answers /health. */
  healthy?: boolean
}

/**
 * Report whether the daemon is running. A discovery file may be stale (the
 * daemon crashed), so `running` is the *file* presence and `healthy` is a live
 * health check — the CLI distinguishes "no daemon" from "stale/wedged daemon".
 */
export async function daemonStatusCommand(discoveryPath: string): Promise<DaemonStatus> {
  const discovery = readDiscovery(discoveryPath)
  if (!discovery) return { running: false }
  const healthy = await waitForReady(discovery, { attempts: 1, intervalMs: 0 })
  return {
    running: true,
    endpoint: discovery.endpoint,
    ...(discovery.pid !== undefined ? { pid: discovery.pid } : {}),
    healthy,
  }
}

// ── run RPC ─────────────────────────────────────────────────────────────────

export interface PanelSummary {
  id: string
  name: string
  agentIds: string[]
  quorum: number
}

export interface RunStatusView {
  run: RunRecord
  round: RoundRecord | undefined
  stateVersion: number
}

export interface StartRunInput {
  panel: string
  prompt: string
  idempotencyKey?: string
}

/** Start a run on the daemon (creates the run + its first round). */
export async function startRunCommand(
  discoveryPath: string,
  input: StartRunInput,
): Promise<{ runId: string; roundId: string }> {
  const d = requireDiscovery(discoveryPath)
  const res = await daemonRequest(d.endpoint, d.token, {
    method: 'POST',
    path: '/runs',
    body: {
      panel: input.panel,
      prompt: input.prompt,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    timeoutMs: 10_000,
  })
  return parse(res)
}

/** Fetch a run's current status snapshot (run + latest round + stateVersion). */
export async function runStatusCommand(
  discoveryPath: string,
  runId: string,
): Promise<RunStatusView> {
  const d = requireDiscovery(discoveryPath)
  const res = await daemonRequest(d.endpoint, d.token, {
    method: 'GET',
    path: `/runs/${encodeURIComponent(runId)}/status`,
    timeoutMs: 10_000,
  })
  return parse(res)
}

/** List runs the daemon knows about, optionally filtered by state. */
export async function listRunsCommand(
  discoveryPath: string,
  state?: 'running' | 'abandoned',
): Promise<RunRecord[]> {
  const d = requireDiscovery(discoveryPath)
  const res = await daemonRequest(d.endpoint, d.token, {
    method: 'GET',
    path: `/runs${state ? `?state=${state}` : ''}`,
    timeoutMs: 10_000,
  })
  return parse<{ runs: RunRecord[] }>(res).runs
}

/** List the panels the *running daemon* loaded (vs. the on-disk config). */
export async function listDaemonPanelsCommand(discoveryPath: string): Promise<PanelSummary[]> {
  const d = requireDiscovery(discoveryPath)
  const res = await daemonRequest(d.endpoint, d.token, {
    method: 'GET',
    path: '/panels',
    timeoutMs: 10_000,
  })
  return parse<{ panels: PanelSummary[] }>(res).panels
}

// ── lifecycle (start / ensure / stop) ─────────────────────────────────────────

export interface DaemonLauncher {
  /** Executable to spawn (usually `process.execPath`). */
  command: string
  /** Args, e.g. `[cliEntryPath, 'daemon', 'serve']`. */
  args: string[]
  /** Extra env merged over the inherited env for the child. */
  env?: Record<string, string>
}

/**
 * Spawn the daemon as a fully-detached background process (D21): its own session
 * (`detached`), no inherited stdio, and `unref`'d so the launching CLI/TUI can
 * exit immediately while the daemon keeps running.
 */
export function spawnDetachedDaemon(launcher: DaemonLauncher): ChildProcess {
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...launcher.env },
  })
  // A detached child emits 'error' asynchronously if the executable can't be
  // spawned (e.g. ENOENT). Swallow it here so it isn't an unhandled exception in
  // the parent — the real failure surfaces as `ensureDaemonRunning` timing out.
  child.on('error', () => {})
  child.unref()
  return child
}

export interface EnsureDaemonDeps {
  discoveryPath: string
  /** Start the daemon when it isn't already healthy (spawn detached, or in-process for tests). */
  launch: () => void | Promise<void>
  attempts?: number
  intervalMs?: number
}

/**
 * Ensure a healthy daemon is reachable, auto-starting it if absent (D21) — the
 * shared logic the CLI's `daemon start` and the TUI both use, so there's no
 * duplication and neither ever silently hangs. Returns the live {@link Discovery}.
 */
export async function ensureDaemonRunning(deps: EnsureDaemonDeps): Promise<Discovery> {
  const existing = readDiscovery(deps.discoveryPath)
  if (existing && (await waitForReady(existing, { attempts: 1, intervalMs: 0 }))) {
    return existing
  }
  await deps.launch()
  const attempts = deps.attempts ?? 50
  const intervalMs = deps.intervalMs ?? 100
  for (let i = 0; i < attempts; i++) {
    // Re-read every attempt: the daemon writes discovery once it's listening,
    // and may have replaced a stale file via atomic rename (D2).
    const discovery = readDiscovery(deps.discoveryPath)
    if (discovery && (await waitForReady(discovery, { attempts: 1, intervalMs: 0 }))) {
      return discovery
    }
    await delay(intervalMs)
  }
  throw new Error('open-consensus daemon did not become ready after auto-start')
}

export interface ForegroundDaemon {
  endpoint: string
  stop(): Promise<void>
}

export interface RunForegroundDeps {
  /** Start the daemon (the CLI wires this to `startDaemon({ adapters })`). */
  start: () => Promise<ForegroundDaemon>
  /** Resolve when a shutdown signal (SIGTERM/SIGINT) arrives. */
  waitForShutdown: () => Promise<void>
  /** Called once the daemon is listening (the CLI prints the endpoint). */
  onStarted?: (endpoint: string) => void
}

/**
 * Run the daemon in the foreground until a shutdown signal, then stop it
 * gracefully — the body of `open-consensus daemon serve` (the detached process
 * `daemon start` spawns). The signal wiring + real `startDaemon` are injected so
 * this orchestration is unit-testable without forking a process.
 */
export async function runDaemonForeground(deps: RunForegroundDeps): Promise<void> {
  const daemon = await deps.start()
  deps.onStarted?.(daemon.endpoint)
  try {
    await deps.waitForShutdown()
  } finally {
    await daemon.stop()
  }
}

export interface StopDaemonResult {
  stopped: boolean
  pid?: number
  reason?: string
}

/**
 * Stop a running daemon by signalling its serve process (`SIGTERM` by default,
 * which the serve handler turns into a graceful drain + shutdown). Waits, bounded,
 * for the process to exit. Safe + idempotent: a missing daemon or an already-dead
 * PID reports cleanly rather than throwing.
 *
 * Crucially, it **only signals a PID it has confirmed is our daemon** — it first
 * health-checks the discovered endpoint (which answers only with our token). If
 * the daemon isn't responding, the discovery file is treated as stale and **no
 * signal is sent**, so a recycled PID now owned by an unrelated process is never
 * killed (the reviewer-flagged PID-reuse hazard).
 */
export async function stopDaemonCommand(
  discoveryPath: string,
  opts: { signal?: NodeJS.Signals; attempts?: number; intervalMs?: number } = {},
): Promise<StopDaemonResult> {
  const discovery = readDiscovery(discoveryPath)
  if (!discovery) return { stopped: false, reason: 'daemon is not running' }
  if (typeof discovery.pid !== 'number') {
    return { stopped: false, reason: 'daemon discovery has no pid; cannot signal it' }
  }
  const pid = discovery.pid
  if (!(await waitForReady(discovery, { attempts: 1, intervalMs: 0 }))) {
    return {
      stopped: false,
      pid,
      reason: `daemon at ${discovery.endpoint} is not responding; not signalling pid ${pid} (it may be stale/reused). Remove the discovery file or kill it manually if it is wedged.`,
    }
  }
  try {
    process.kill(pid, opts.signal ?? 'SIGTERM')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      return { stopped: true, pid, reason: 'process had already exited' }
    }
    throw err
  }
  const attempts = opts.attempts ?? 50
  const intervalMs = opts.intervalMs ?? 100
  for (let i = 0; i < attempts; i++) {
    if (!isAlive(pid) || !readDiscovery(discoveryPath)) return { stopped: true, pid }
    await delay(intervalMs)
  }
  return { stopped: false, pid, reason: 'daemon did not exit in time' }
}
