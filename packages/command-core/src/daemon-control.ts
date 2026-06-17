import { type ChildProcess, spawn } from 'node:child_process'
import { openSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
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
  // NOT unref'd: this backs the readiness/stop poll loops, which are an ACTIVE
  // wait — the timer must keep the event loop alive until the awaited condition
  // resolves. (From source other handles happen to keep the loop alive, but a
  // packaged single binary has none, so an unref'd timer let the process exit
  // after one poll iteration — the daemon auto-start then never confirmed.)
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
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

/** Run states a caller may filter `listRunsCommand` by. */
export const RUN_STATE_FILTERS = ['running', 'abandoned'] as const
export type RunStateFilter = (typeof RUN_STATE_FILTERS)[number]

/**
 * List runs the daemon knows about, optionally filtered by state. The filter is
 * validated at this boundary (not just in the CLI), so any caller — the TUI
 * included — gets a clear error rather than building an invalid daemon query.
 */
export async function listRunsCommand(
  discoveryPath: string,
  state?: RunStateFilter,
): Promise<RunRecord[]> {
  if (state !== undefined && !RUN_STATE_FILTERS.includes(state)) {
    throw new Error(`invalid run state filter '${state}' (expected running|abandoned)`)
  }
  const d = requireDiscovery(discoveryPath)
  const res = await daemonRequest(d.endpoint, d.token, {
    method: 'GET',
    path: `/runs${state ? `?state=${encodeURIComponent(state)}` : ''}`,
    timeoutMs: 10_000,
  })
  return parse<{ runs: RunRecord[] }>(res).runs
}

/** Cancel a run (tree-kills its in-flight children, server-side). Used by the
 * TUI's Ctrl+C so nothing keeps running after the user aborts (D19). */
export async function cancelRunCommand(
  discoveryPath: string,
  runId: string,
): Promise<{ cancelled: number }> {
  const d = requireDiscovery(discoveryPath)
  const res = await daemonRequest(d.endpoint, d.token, {
    method: 'POST',
    path: `/runs/${encodeURIComponent(runId)}/cancel`,
    timeoutMs: 10_000,
  })
  return parse(res)
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
  // The detached daemon's stdio is normally discarded; OPEN_CONSENSUS_DAEMON_LOG
  // redirects it to a file so an auto-start failure (which the foreground caller
  // never sees) is diagnosable.
  const logPath = process.env.OPEN_CONSENSUS_DAEMON_LOG
  const fd = logPath ? openSync(logPath, 'a') : undefined
  const child = spawn(launcher.command, launcher.args, {
    detached: true,
    stdio: fd !== undefined ? ['ignore', fd, fd] : 'ignore',
    env: { ...process.env, ...launcher.env },
  })
  // A detached child emits 'error' asynchronously if the executable can't be
  // spawned (e.g. ENOENT). Swallow it here so it isn't an unhandled exception in
  // the parent — the real failure surfaces as `ensureDaemonRunning` timing out.
  child.on('error', () => {})
  child.unref()
  return child
}

/**
 * Args to (re)spawn THIS process as the foreground daemon (`daemon serve`). In a
 * packaged single binary the executable IS the binary (`process.execPath`) and the
 * subcommand alone is enough — there is no on-disk script to pass (`import.meta.url`
 * resolves to a virtual `/snapshot/...` path that does not exist). From source we
 * pass the resolved CLI entry file so `node <cliEntry> daemon serve` runs.
 */
export function daemonSpawnArgs(opts: { packaged: boolean; cliEntry: string }): string[] {
  return opts.packaged ? ['daemon', 'serve'] : [opts.cliEntry, 'daemon', 'serve']
}

export interface EnsureDaemonDeps {
  discoveryPath: string
  /** Start the daemon when it isn't already healthy (spawn detached, or in-process for tests). */
  launch: () => void | Promise<void>
  /**
   * The config-file path this invocation intends to use. If a daemon is ALREADY
   * running with a different config, we error rather than silently dispatch
   * against the wrong roster (the daemon snapshots its config at startup, so a
   * config switch needs a restart). Omit to skip the check.
   */
  expectedConfigPath?: string
  attempts?: number
  intervalMs?: number
}

/**
 * Ensure a healthy daemon is reachable, auto-starting it if absent (D21) — the
 * shared logic the CLI's `daemon start` and the TUI both use, so there's no
 * duplication and neither ever silently hangs. Returns the live {@link Discovery}.
 *
 * If a daemon is already running it is reused, but only after confirming it
 * loaded the same config the caller intends (see {@link EnsureDaemonDeps.expectedConfigPath});
 * a mismatch throws rather than silently dispatching against the wrong config.
 */
export async function ensureDaemonRunning(deps: EnsureDaemonDeps): Promise<Discovery> {
  const existing = readDiscovery(deps.discoveryPath)
  if (existing) {
    const health = await fetchHealth(existing)
    if (health) {
      assertConfigMatches(health, deps.expectedConfigPath, existing.endpoint)
      return existing
    }
  }
  // We start the daemon with OUR config, so the post-launch poll needs no check.
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
  let shutdownErr: unknown
  try {
    await deps.waitForShutdown()
  } catch (err) {
    shutdownErr = err
  }
  // Always stop, but don't let a stop() failure mask the original shutdown error.
  try {
    await daemon.stop()
  } catch (stopErr) {
    if (shutdownErr === undefined) throw stopErr
  }
  if (shutdownErr !== undefined) throw shutdownErr
}

export interface StopDaemonResult {
  stopped: boolean
  pid?: number
  reason?: string
}

/** GET /health (token-authenticated); returns the parsed body, or undefined if
 * the daemon isn't answering / didn't return a 200 JSON body. */
async function fetchHealth(
  discovery: Discovery,
): Promise<{ ok?: boolean; pid?: number; config?: string } | undefined> {
  try {
    const res = await daemonRequest(discovery.endpoint, discovery.token, {
      method: 'GET',
      path: '/health',
      timeoutMs: 2000,
    })
    if (res.status !== 200) return undefined
    return JSON.parse(res.body) as { ok?: boolean; pid?: number; config?: string }
  } catch {
    return undefined
  }
}

/** Canonical path for comparison: realpath (deref symlinks) when the file exists,
 * else fall back to lexical resolve so a not-yet-created path still compares. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * Throw if a running daemon's config doesn't match what the caller intends. A
 * daemon that doesn't report a config at all (an in-process/older daemon) can't
 * be confirmed, so it's also refused — never silently reused — when a specific
 * config is expected. Paths are compared canonically so a symlink alias of the
 * same file isn't mistaken for a different config.
 */
function assertConfigMatches(
  health: { config?: string },
  expected: string | undefined,
  endpoint: string,
): void {
  if (expected === undefined) return
  if (health.config === undefined) {
    throw new Error(
      `a daemon is already running on ${endpoint} but did not report its config; stop it with \`daemon stop\` so the next start loads ${expected}`,
    )
  }
  if (canonicalPath(health.config) !== canonicalPath(expected)) {
    throw new Error(
      `a daemon is already running on ${endpoint} with a different config (${health.config}); stop it with \`daemon stop\` to use ${expected}`,
    )
  }
}

/**
 * Stop a running daemon by signalling its serve process (`SIGTERM` by default,
 * which the serve handler turns into a graceful drain + shutdown). Waits, bounded,
 * for the process to exit. Safe + idempotent: a missing daemon or an already-dead
 * PID reports cleanly rather than throwing.
 *
 * Crucially, it **only signals a PID it has confirmed is our daemon**. It calls
 * `/health` (behind the daemon's bearer-token check, so a `200` proves the
 * listener holds our token) AND verifies the PID that endpoint reports equals the
 * one in discovery — so a stale discovery whose PID was recycled by an unrelated
 * process is never signalled, even in the contrived case where something else
 * answered on the same endpoint. If the daemon isn't responding (or reports a
 * different PID), the discovery is treated as stale and **no signal is sent**.
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
  const stale = 'Run `daemon start` to recheck and replace it.'
  const health = await fetchHealth(discovery)
  if (!health) {
    return {
      stopped: false,
      pid,
      reason: `daemon at ${discovery.endpoint} is not responding — the discovery file is likely stale. Not signalling pid ${pid} (it may have been reused by an unrelated process). ${stale}`,
    }
  }
  // REQUIRE a matching pid: our daemon's /health always reports its pid, so an
  // absent or differing pid means the responder isn't the process discovery
  // names — refuse to signal it (closes the PID-reuse hole entirely).
  if (health.pid !== pid) {
    return {
      stopped: false,
      pid,
      reason:
        health.pid === undefined
          ? `the daemon at ${discovery.endpoint} did not report a pid; cannot confirm pid ${pid} is the live daemon — discovery may be stale. ${stale}`
          : `the daemon answering ${discovery.endpoint} reports pid ${health.pid}, not ${pid} — discovery is stale. ${stale}`,
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
