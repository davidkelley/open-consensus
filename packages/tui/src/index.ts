import type { AdapterRegistry } from '@open-consensus/daemon'
import { render } from 'ink'
import { createElement } from 'react'
import { App } from './app'

/**
 * `@open-consensus/tui` — the ink + React slash-command TUI (plan D19). It owns
 * the long-lived `tui-session` concerns (SSE subscription lifecycle + transcript
 * state + Ctrl+C cancellation) that the stateless `command-core` deliberately
 * lacks, while delegating every command's logic to `command-core` verbatim. The
 * `open-consensus` CLI launches it when invoked with no subcommand.
 */
export { App } from './app'
export type { AppProps } from './app'
export * from './session/sse'
export * from './session/timeline'
export * from './slash/parser'
export * from './slash/autocomplete'
export * from './slash/registry'
export { useDaemonEvents } from './hooks/useDaemonEvents'
export * from './theme'
export * from './ui/segments'
export * from './ui/banner'

export interface LaunchOptions {
  configFile: string
  discoveryPath: string
  registry: AdapterRegistry
  ensureDaemon: () => Promise<void>
  /** Release version shown in the banner. */
  version?: string
}

/** Render the TUI and resolve when the user exits. `exitOnCtrlC` is off so the
 * App's own handler owns Ctrl+C (cancel an active run vs. exit). */
export async function launchTui(opts: LaunchOptions): Promise<void> {
  const { waitUntilExit } = render(createElement(App, opts), { exitOnCtrlC: false })
  await waitUntilExit()
}
