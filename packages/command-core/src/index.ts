/**
 * `@open-consensus/command-core` — the stateless command layer shared verbatim
 * by the `commander` CLI (Stage 8) and the ink TUI slash-commands (Stage 9).
 *
 * It is request/response only: config CRUD, daemon RPC, daemon lifecycle
 * (start/ensure/stop), `init` auto-detect+seed, and `mcp install/uninstall`. It
 * deliberately holds **no SSE subscription / stream lifecycle** — those live in
 * the TUI's `tui-session` layer (D19), keeping the one-shot CLI from hanging at
 * exit. A CI test (`boundary.test.ts`) enforces that this package never imports
 * `tui-session`.
 */
export * from './config-ops'
export * from './daemon-control'
export * from './init'
export * from './mcp-install'
