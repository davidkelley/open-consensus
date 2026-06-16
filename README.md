# Open Consensus

Robust multi-agent **consensus execution substrate**. A driving agent (Claude
Code, Codex, …) calls Open Consensus through an **MCP tool** to fan a prompt out
to a *panel* of configured CLI coding agents (`claude`, `codex`, `gemini`,
`opencode`), and Open Consensus runs them, isolates failures, retries
internally, and returns *distilled, provenance-tagged* per-agent responses — so
the orchestrator's context is never bloated by retries or garbage. The
orchestrator owns the consensus **judgment**; Open Consensus owns **execution**.

Users manage their agents and panels, and watch consensus unfold in a live
terminal timeline, through a claude-code-style slash-command CLI/TUI.

## Quickstart

Requires **Node ≥ 22** (the ink + React TUI needs it; `.nvmrc` pins 24).

```sh
# 1. Install + build (until published, from a clone)
npm install && npm run build

# 2. First run: auto-detect installed agent CLIs and seed a default panel
open-consensus init                 # add --allow-unsandboxed to include opencode

# 3. Inspect / adjust your roster
open-consensus agent list
open-consensus panel create review --agents claude,codex,gemini --quorum 2

# 4. Register the MCP server so your orchestrator can call it
open-consensus mcp install          # writes the Claude Code config (~/.claude.json)

# 5a. Drive a consensus from your orchestrator via the MCP tools
#     (consensus_start -> consensus_poll -> consensus_round; finalize = just stop), or…

# 5b. …drive + watch it interactively in the TUI
open-consensus                      # bare command launches the slash-command TUI
#   › /run review "Critique this plan: …"
```

The daemon is auto-started on demand (a per-user singleton); you never run it
by hand. Tell your orchestrator to "use Open Consensus" — see
[docs/usage.md](docs/usage.md).

## Documentation

| Doc | What |
| --- | --- |
| [usage.md](docs/usage.md) | Driving a consensus (MCP loop + the TUI) |
| [configuration.md](docs/configuration.md) | Agents, panels, the config file, env |
| [cli.md](docs/cli.md) | The `open-consensus` command surface |
| [mcp.md](docs/mcp.md) | The MCP tool surface + host registration |
| [adapters.md](docs/adapters.md) | Per-CLI capability matrix + read-only defaults |
| [architecture.md](docs/architecture.md) | How the pieces fit (MCP → daemon → engine → adapters) |

## Layout

This is a [Turborepo](https://turborepo.dev) monorepo. Packages under
[`packages/`](packages/) are built per-component:

| Package | Role |
| --- | --- |
| `@open-consensus/core` | XDG paths, shared zod schemas/types, secret redaction |
| `@open-consensus/config` | Config model (agents, panels) + atomic store + migrations |
| `@open-consensus/proc` | Hardened process runner (tree-kill, byte caps, ANSI/redaction) |
| `@open-consensus/adapters` | Per-CLI adapters (claude/codex/gemini/opencode) + mock |
| `@open-consensus/engine` | Run/round/invocation state machine, quorum, distillation, SQLite |
| `@open-consensus/daemon` | Single-instance daemon: HTTP/socket, SSE, lifecycle, reconcile |
| `@open-consensus/command-core` | Stateless command layer (config ops + daemon RPC) shared by CLI + TUI |
| `@open-consensus/cli` | `open-consensus` binary (CLI + TUI launcher) |
| `@open-consensus/tui` | ink + React slash-command TUI |
| `@open-consensus/mcp` | `open-consensus-mcp` binary (stdio MCP server) + library |

## Develop

```sh
npm install
npm run build         # turbo: build every package
npm test              # turbo: vitest (mock-only, no real CLIs, ≥90% coverage gate)
npm run test:e2e      # mock-stack E2E: MCP → daemon → engine → mock (no spend)
npm run test:e2e:live # OPT-IN: real agent CLIs, REAL SPEND (final release gate)
npm run lint          # Biome + the async-safety ESLint overlay
npm run typecheck     # strict tsc across packages
```

The default `npm test` / `npm run test:e2e` tiers use the deterministic **mock**
adapter (a tiny `node -e` program through the real runner) and a **fake-binary**
fixture only — zero real CLIs, zero network, zero spend. The live tier is
mechanically isolated: its own config + dir, only runs under
`OPEN_CONSENSUS_E2E_LIVE=1` (which the default suite asserts is *unset*), and
skips cleanly when no real CLI is installed.

## Security & limitations

Open Consensus drives real coding CLIs. **Read-only mode is best-effort, not a
sandbox.** Each agent invocation runs in an ephemeral scratch working directory
to prevent *relative-path* accidents, but a confused or malicious agent given an
absolute path — or making network calls — retains full user-level filesystem and
network access. The scratch directory is **not** an isolation boundary. Adapters
without a native read-only mode (e.g. `opencode`) are **elevated-opt-in only**,
behind an explicit acknowledgment that they can read, write, or exfiltrate
anything your account can reach.

macOS and Linux are the certified targets; **Windows is experimental/uncertified**
(process tree-termination and `0600` file permissions are unverified there).

## License

MIT © David Kelley
