# Changelog

All notable changes to Open Consensus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project will adopt
[Semantic Versioning](https://semver.org/) on its first published release.

## [Unreleased]

The initial vertical slice — built stage-by-stage, each cleared by a multi-agent
`/consensus` reviewer panel.

### Added

- **Core** — XDG path resolution, shared zod schemas, secret redaction.
- **Config** — agent/panel model with referential integrity, atomic store,
  ordered schema migrations, and a minimal management CLI.
- **Process runner** — hardened spawn boundary: `shell:false`, own process group,
  tree-kill on timeout/cancel/overflow, byte caps + backpressure, ANSI-strip,
  and secret redaction before persistence.
- **Adapters** — `claude`, `codex`, `gemini`, `opencode` with read-only/sandbox
  defaults and deny-list-validated config args, plus a deterministic `mock` and a
  spawnable fake-binary fixture. `opencode` is elevated-opt-in (no native sandbox).
- **Engine** — run/round/invocation state machine, bounded + per-tool-serialized
  concurrency, per-agent timeout, retry with backoff+jitter, failure isolation,
  quorum verdicts, deterministic distillation, SQLite metadata + event log with
  raw blobs on disk, and reconcile-on-start.
- **Daemon** — single-instance (`proper-lockfile`) daemon over a unix socket
  (loopback+token fallback), snapshot long-poll, SSE with `Last-Event-ID`,
  scoped orphan sweep, idle-run reaper, detached auto-start.
- **MCP server** — the full `consensus_*` tool surface (start/round/poll/status/
  cancel/list/get-raw) with durable idempotency and `next_action` hints; the
  `open-consensus-mcp` stdio bin and a reusable library entry.
- **CLI + command-core** — a stateless command layer shared by the CLI and TUI;
  `agent`/`panel`/`daemon`/`run` commands plus `init` (auto-detect + seed) and
  `mcp install`/`uninstall` (safe, atomic, idempotent host-config registration).
- **TUI** — a claude-code-style ink + React slash-command app with a `<Static>`
  scrollback, a live consensus timeline streamed over SSE, `/command` autocomplete
  + history, and Ctrl+C cancellation.
- **Tests** — per-package vitest with a ≥90% line/branch/function coverage gate,
  a mock-stack E2E (`npm run test:e2e`), and an isolated opt-in live-E2E
  (`npm run test:e2e:live`) — the documented final release quality-gate.

### Notes

- Requires **Node ≥ 22**. macOS/Linux certified; Windows experimental.
- Read-only execution is best-effort, **not** a sandbox (see the README).
