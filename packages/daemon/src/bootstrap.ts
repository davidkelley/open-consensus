import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, loadConfig } from '@open-consensus/config'
import { type AppPaths, appPaths } from '@open-consensus/core'
import { EngineStore } from '@open-consensus/engine'
import { daemonRequest } from './client'
import { DaemonCore } from './daemon'
import {
  type Discovery,
  type LockInfo,
  acquireLock,
  generateToken,
  releaseLock,
  writeDiscovery,
} from './lifecycle'
import type { AdapterRegistry } from './resolver'
import { DaemonServer, type ListenTarget } from './server'

const SOCKET_NAME = 'd.sock'
const LOCK_NAME = 'daemon.lock'
const DISCOVERY_NAME = 'discovery.json'
const DB_NAME = 'engine.sqlite'
const RAW_DIRNAME = 'raw'
/** A unix socket path longer than this risks the `sun_path` cap (D2). */
const MAX_SOCKET_PATH = 103
const DEFAULT_REAPER_INTERVAL_MS = 60_000

export class DaemonAlreadyRunningError extends Error {
  constructor() {
    super('a daemon already holds the lock')
    this.name = 'DaemonAlreadyRunningError'
  }
}

export interface StartDaemonOptions {
  adapters: AdapterRegistry
  /** Override resolved app dirs (tests). */
  paths?: AppPaths
  /** Override the loaded config (tests). */
  config?: Config
  /** Force the loopback fallback instead of a unix socket. */
  loopback?: boolean
  /** Override the generated bearer token (tests). */
  token?: string
  maxWaitMs?: number
  idleTtlMs?: number
  reaperIntervalMs?: number
  now?: () => number
}

export interface RunningDaemon {
  endpoint: string
  token: string
  core: DaemonCore
  server: DaemonServer
  /** Gracefully stop: drain rounds, close server/store, release lock + discovery. */
  stop(): Promise<void>
}

/**
 * Start the single-instance daemon (plan D2/D14/D15): acquire the atomic lock
 * BEFORE any reconcile, recover crashed in-flight state, listen on a unix socket
 * (or loopback fallback), publish the endpoint + token, and run the idle reaper.
 * Throws {@link DaemonAlreadyRunningError} if another live daemon holds the lock.
 */
export async function startDaemon(opts: StartDaemonOptions): Promise<RunningDaemon> {
  const paths = opts.paths ?? appPaths()
  // Persisted state (SQLite + WAL/SHM), raw blobs, and the socket/lock/discovery
  // files can hold prompts, metadata, and the bearer token — so the directories
  // holding them are restricted to the owner (0700). chmod tightens a pre-existing
  // dir too, since mode= only applies on creation. Directory-level 0700 protects
  // every file inside regardless of the file's own umask-derived mode.
  for (const dir of [paths.runtime, paths.state, paths.data]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }

  const lockPath = join(paths.runtime, LOCK_NAME)
  const discoveryPath = join(paths.runtime, DISCOVERY_NAME)
  const lockInfo: LockInfo = { pid: process.pid, startTime: Date.now() }
  if (!acquireLock(lockPath, lockInfo)) throw new DaemonAlreadyRunningError()

  let store: EngineStore | undefined
  let server: DaemonServer | undefined
  let reaper: ReturnType<typeof setInterval> | undefined
  try {
    const config = opts.config ?? loadConfig()
    store = new EngineStore({
      dbPath: join(paths.state, DB_NAME),
      rawDir: join(paths.data, RAW_DIRNAME),
    })
    const daemonId = randomUUID()
    const core = new DaemonCore({
      store,
      config,
      adapters: opts.adapters,
      daemonId,
      ...(opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {}),
      ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    })

    // Recover crashed in-flight state AND sweep any process groups orphaned by a
    // prior instance — both BEFORE serving any request (D15/D10).
    core.reconcile()
    await core.sweepOrphans()

    const token = opts.token ?? generateToken()
    server = new DaemonServer({ core, token })
    const target = chooseTarget(paths, opts.loopback ?? false)
    const endpoint = await server.listen(target)
    writeDiscovery(discoveryPath, { endpoint, token })

    const intervalMs = opts.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS
    reaper = setInterval(() => core.reapIdle(), intervalMs)
    if (typeof reaper.unref === 'function') reaper.unref()

    const boundServer = server
    const boundStore = store
    const boundReaper = reaper
    return {
      endpoint,
      token,
      core,
      server: boundServer,
      async stop() {
        clearInterval(boundReaper)
        // Stop accepting requests FIRST so no new round slips in during the drain
        // and then keeps running after the store is closed.
        await boundServer.close()
        await core.drain()
        boundStore.close()
        rmSync(discoveryPath, { force: true })
        // Remove the unix socket file (a no-op for a loopback endpoint) so a
        // stale node never lingers on disk after a clean shutdown.
        if (!endpoint.startsWith('http://')) rmSync(endpoint, { force: true })
        releaseLock(lockPath, lockInfo)
      },
    }
  } catch (err) {
    // Roll back partial startup so the lock never strands a half-initialized daemon.
    if (reaper) clearInterval(reaper)
    try {
      if (server) await server.close()
    } catch {
      /* best-effort: never let cleanup mask the original startup error */
    }
    store?.close()
    rmSync(discoveryPath, { force: true })
    releaseLock(lockPath, lockInfo)
    throw err
  }
}

/** Pick a unix socket (preferred) or loopback target based on path length (D2). */
function chooseTarget(paths: AppPaths, forceLoopback: boolean): ListenTarget {
  const socketPath = join(paths.runtime, SOCKET_NAME)
  if (forceLoopback || socketPath.length > MAX_SOCKET_PATH) {
    return { host: '127.0.0.1', port: 0 }
  }
  // A stale socket file (unclean shutdown) would make listen() EADDRINUSE; the
  // lock guarantees no live owner, so removing it is safe.
  rmSync(socketPath, { force: true })
  return { socketPath }
}

/**
 * Wait until a daemon answers a health check (the auto-start race loser polls
 * this rather than spawning a second daemon — D14). Resolves true on readiness,
 * false if the bounded wait elapses.
 */
export async function waitForReady(
  discovery: Discovery,
  opts: { attempts?: number; intervalMs?: number; requestTimeoutMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 50
  const intervalMs = opts.intervalMs ?? 100
  const requestTimeoutMs = opts.requestTimeoutMs ?? 2000
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await daemonRequest(discovery.endpoint, discovery.token, {
        method: 'GET',
        path: '/health',
        timeoutMs: requestTimeoutMs,
      })
      if (res.status === 200) return true
    } catch {
      /* not up yet (connection refused, or a half-open endpoint timed out) */
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
