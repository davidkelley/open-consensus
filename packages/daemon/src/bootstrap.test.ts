import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockAdapter } from '@open-consensus/adapters'
import { type Config, parseConfig } from '@open-consensus/config'
import type { AppPaths } from '@open-consensus/core'
import { EngineStore } from '@open-consensus/engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonAlreadyRunningError, startDaemon, waitForReady } from './bootstrap'
import { daemonRequest } from './client'
import { acquireLock, readDiscovery } from './lifecycle'
import type { AdapterRegistry } from './resolver'

const registry: AdapterRegistry = new Map([['mock', createMockAdapter()]])
const config: Config = parseConfig({
  schemaVersion: 1,
  agents: [{ id: 'a-ok', name: 'OK', adapter: 'mock', model: 'mock:ok', maxRetries: 0 }],
  panels: [{ id: 'p-ok', name: 'OK', agentIds: ['a-ok'], quorum: 1 }],
})

function makePaths(base: string): AppPaths {
  return {
    config: join(base, 'config'),
    state: join(base, 'state'),
    data: join(base, 'data'),
    cache: join(base, 'cache'),
    runtime: join(base, 'runtime'),
  }
}

describe('startDaemon lifecycle', () => {
  const dirs: string[] = []
  function freshDir(prefix = join(tmpdir(), 'oc-bs-')): string {
    const dir = mkdtempSync(prefix)
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('starts over loopback, drives a run end-to-end, and stops cleanly', async () => {
    const paths = makePaths(freshDir())
    // Exercise the explicit-option plumbing (maxWaitMs/idleTtlMs/now/reaper).
    const daemon = await startDaemon({
      adapters: registry,
      config,
      paths,
      loopback: true,
      maxWaitMs: 5000,
      idleTtlMs: 60_000,
      reaperIntervalMs: 3_600_000,
      now: () => 1_000_000,
    })
    expect(daemon.endpoint.startsWith('http://127.0.0.1:')).toBe(true)
    expect(readDiscovery(join(paths.runtime, 'discovery.json'))?.token).toBe(daemon.token)

    const start = JSON.parse(
      (
        await daemonRequest(daemon.endpoint, daemon.token, {
          method: 'POST',
          path: '/runs',
          body: { panel: 'p-ok', prompt: 'hi' },
        })
      ).body,
    )
    const poll = JSON.parse(
      (
        await daemonRequest(daemon.endpoint, daemon.token, {
          method: 'GET',
          path: `/runs/${start.runId}/rounds/${start.roundId}?wait_ms=5000`,
        })
      ).body,
    )
    expect(poll.round.verdict).toBe('met')

    await daemon.stop()
    // The discovery file and lock are gone after a clean stop.
    expect(readDiscovery(join(paths.runtime, 'discovery.json'))).toBeUndefined()
  })

  it('listens on a unix socket when the path is short enough', async () => {
    const paths = makePaths(freshDir(join('/tmp', 'oc-sk-')))
    const daemon = await startDaemon({ adapters: registry, config, paths, loopback: false })
    expect(daemon.endpoint).toBe(join(paths.runtime, 'd.sock'))
    const res = await daemonRequest(daemon.endpoint, daemon.token, {
      method: 'GET',
      path: '/health',
    })
    expect(res.status).toBe(200)
    await daemon.stop()
  })

  it('falls back to loopback when the socket path would be too long', async () => {
    const base = freshDir()
    const paths = { ...makePaths(base), runtime: join(base, 'x'.repeat(120)) }
    const daemon = await startDaemon({ adapters: registry, config, paths, loopback: false })
    expect(daemon.endpoint.startsWith('http://')).toBe(true)
    await daemon.stop()
  })

  it('refuses a second daemon on the same lock; the loser waits for readiness', async () => {
    const paths = makePaths(freshDir())
    const first = await startDaemon({ adapters: registry, config, paths, loopback: true })
    await expect(
      startDaemon({ adapters: registry, config, paths, loopback: true }),
    ).rejects.toBeInstanceOf(DaemonAlreadyRunningError)

    const discovery = readDiscovery(join(paths.runtime, 'discovery.json'))
    if (!discovery) throw new Error('discovery file missing')
    expect(await waitForReady(discovery, { attempts: 10, intervalMs: 20 })).toBe(true)
    await first.stop()
  })

  it('waitForReady gives up when nothing answers', async () => {
    const ok = await waitForReady(
      { endpoint: 'http://127.0.0.1:1', token: 'x' },
      { attempts: 2, intervalMs: 10 },
    )
    expect(ok).toBe(false)
  })

  it('rolls back and releases the lock when startup fails', async () => {
    const paths = makePaths(freshDir())
    mkdirSync(paths.state, { recursive: true })
    // Make the DB path a directory so EngineStore construction throws mid-startup.
    mkdirSync(join(paths.state, 'engine.sqlite'))
    await expect(
      startDaemon({ adapters: registry, config, paths, loopback: true }),
    ).rejects.toBeDefined()
    // The lock was released by the rollback, so a fresh acquire succeeds.
    expect(
      acquireLock(join(paths.runtime, 'daemon.lock'), { pid: process.pid, startTime: 1 }),
    ).toBe(true)
    expect(readDiscovery(join(paths.runtime, 'discovery.json'))).toBeUndefined()
  })

  it('reconciles crashed in-flight state before serving', async () => {
    const paths = makePaths(freshDir())
    mkdirSync(paths.state, { recursive: true })
    // Seed a DB with a round left mid-flight (an invocation stuck `running`).
    const seed = new EngineStore({
      dbPath: join(paths.state, 'engine.sqlite'),
      rawDir: join(paths.data, 'raw'),
    })
    seed.createRun({ runId: 'r1', panelId: 'p-ok', state: 'running', createdAt: 1 })
    seed.startRoundWithPending(
      { roundId: 'rd1', runId: 'r1', index: 0, prompt: 'x', quorum: 1, state: 'running' },
      ['a-ok'],
    )
    seed.upsertInvocation('rd1', {
      agentId: 'a-ok',
      status: 'running',
      attempts: 1,
      distilled: '',
      durationMs: 0,
      truncated: false,
    })
    seed.close()

    const daemon = await startDaemon({ adapters: registry, config, paths, loopback: true })
    const status = daemon.core.status('r1')
    expect(status?.round?.state).toBe('complete')
    expect(status?.round?.invocations[0]?.status).toBe('interrupted')
    await daemon.stop()
  })
})
