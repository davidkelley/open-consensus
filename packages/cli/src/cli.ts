#!/usr/bin/env node
// Thin entrypoint for the `open-consensus` binary. All command logic lives in
// `program.ts` (coverage-gated) over the stateless `command-core` library; this
// file only wires the real, un-testable side effects — the detached daemon spawn
// and the foreground `startDaemon` loop — and maps errors to exit codes.
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defaultRegistry } from '@open-consensus/adapters'
import {
  type ForegroundDaemon,
  runDaemonForeground,
  spawnDetachedDaemon,
} from '@open-consensus/command-core'
import { daemonDiscoveryPath, startDaemon } from '@open-consensus/daemon'
import { CommanderError } from 'commander'
import { resolveConfigFile, run } from './program'

/**
 * The CLI/daemon registry: every REAL adapter, with the test-only `mock`
 * excluded so `init`/`agent` never auto-seed it. The unsandboxed opt-in is
 * included because that risk was already acknowledged at config time (D20).
 */
const daemonRegistry = () => defaultRegistry({ includeUnsandboxed: true, includeMock: false })

/** Resolve when a shutdown signal arrives (the foreground `daemon serve` loop). */
function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
      resolve()
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
  })
}

async function serveDaemon(): Promise<void> {
  await runDaemonForeground({
    start: async (): Promise<ForegroundDaemon> => {
      // Thread the same config-path override the user's commands use, so an
      // auto-started daemon reads the config they actually wrote (D21).
      const daemon = await startDaemon({
        adapters: daemonRegistry(),
        configPath: resolveConfigFile(),
      })
      return { endpoint: daemon.endpoint, stop: () => daemon.stop() }
    },
    onStarted: (endpoint) =>
      process.stderr.write(`open-consensus daemon listening on ${endpoint}\n`),
    waitForShutdown,
  })
}

const cliEntry = fileURLToPath(import.meta.url)

run(process.argv, {
  configFile: resolveConfigFile(),
  discoveryPath: daemonDiscoveryPath(),
  registry: daemonRegistry(),
  out: (line) => console.log(line),
  err: (line) => process.stderr.write(`${line}\n`),
  launchDaemon: () =>
    spawnDetachedDaemon({ command: process.execPath, args: [cliEntry, 'daemon', 'serve'] }),
  serveDaemon,
  mcpHostPath: `${homedir()}/.claude.json`,
}).catch((err: unknown) => {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode
    return
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
