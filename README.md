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

> Status: **early development.** See [`.design/PLAN-open-consensus.md`](.design/PLAN-open-consensus.md)
> for the full, panel-reviewed implementation plan.

## Layout

This is a [Turborepo](https://turborepo.dev) monorepo. Packages under
[`packages/`](packages/) are built per-component:

| Package | Role |
| --- | --- |
| `@open-consensus/core` | XDG paths, shared zod schemas/types, secret redaction |
| `@open-consensus/cli` | `open-consensus` binary (CLI + TUI launcher) |
| `@open-consensus/mcp` | `open-consensus-mcp` binary (stdio MCP server) |

More packages (config, proc, adapters, engine, daemon, command-core, tui) land
as the staged plan is implemented.

## Develop

```sh
npm install
npm run build       # turbo: build every package
npm test            # turbo: vitest (mock-only, no real CLIs, ≥90% coverage gate)
npm run lint        # Biome + the async-safety ESLint overlay
npm run typecheck   # strict tsc across packages
```

Requires Node ≥ 20 (`.nvmrc` pins 24).

## Security & limitations

Open Consensus drives real coding CLIs. **Read-only mode is best-effort, not a
sandbox.** Each agent invocation runs in an ephemeral scratch working directory
to prevent *relative-path* accidents, but a confused or malicious agent given an
absolute path — or making network calls — retains full user-level filesystem and
network access. The scratch directory is **not** an isolation boundary. macOS and
Linux are the certified targets; Windows is experimental/uncertified (process
termination and `0600` file permissions are unverified there).

## License

MIT © David Kelley
