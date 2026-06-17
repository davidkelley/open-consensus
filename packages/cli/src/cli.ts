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
  daemonLaunchSpec,
  defaultMcpEntry,
  ensureDaemonRunning,
  runDaemonForeground,
  spawnDetachedDaemon,
} from '@open-consensus/command-core'
import { isPackaged } from '@open-consensus/core'
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

// `import.meta.url` is a real file path from source (used for the from-source
// daemon re-exec); inside a packaged binary the daemon re-execs the binary itself
// via a shell-interposed clean execve — see `daemonLaunchSpec`.
const cliEntry = fileURLToPath(import.meta.url)
const packaged = isPackaged()
const configFile = resolveConfigFile()
const discoveryPath = daemonDiscoveryPath()
const launchDaemon = (): void => {
  spawnDetachedDaemon(daemonLaunchSpec({ packaged, execPath: process.execPath, cliEntry }))
}

// Top-level await (not a floating `.then/.catch`): the packaged SEA dispatcher
// only keeps the event loop alive for the AWAITED entry promise, so a floating
// promise's later ticks (e.g. the daemon-start readiness poll) would be dropped
// and the process would exit early. ESM + SEA enhanced mode both support this.
try {
  await run(process.argv, {
    configFile,
    discoveryPath,
    registry: daemonRegistry(),
    out: (line) => console.log(line),
    err: (line) => process.stderr.write(`${line}\n`),
    launchDaemon,
    serveDaemon,
    mcpHostPath: `${homedir()}/.claude.json`,
    // The stdio MCP server, lazily imported so one-shot commands never load the MCP
    // SDK. `mcp install` registers this via `<binary> mcp-server` when packaged.
    runMcpServer: async () => {
      const { runMcpStdioServer } = await import('@open-consensus/mcp')
      await runMcpStdioServer()
    },
    defaultMcpEntry: defaultMcpEntry({ packaged, execPath: process.execPath }),
    // Launch the interactive TUI on a bare `open-consensus`, wiring the same daemon
    // auto-start (with the config-path guard) the one-shot commands use. The TUI
    // (ink/React) is imported lazily so one-shot commands never load it.
    launchTui: async () => {
      const { launchTui } = await import('@open-consensus/tui')
      await launchTui({
        configFile,
        discoveryPath,
        registry: daemonRegistry(),
        ensureDaemon: async () => {
          await ensureDaemonRunning({
            discoveryPath,
            launch: launchDaemon,
            expectedConfigPath: configFile,
          })
        },
      })
    },
  })
} catch (err: unknown) {
  if (err instanceof CommanderError) {
    process.exitCode = err.exitCode
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
