# CLI & command-core

The `open-consensus` CLI manages your agents, panels, the daemon, and consensus
runs. Every command is a thin wrapper over the **stateless `command-core`**
library — the same library the Stage-9 TUI slash-commands reuse — so the CLI and
TUI never drift, and the one-shot CLI never hangs at exit (no SSE/stream
lifecycle lives in `command-core`; a CI test enforces that boundary).

## First run

```sh
open-consensus init                 # auto-detect installed CLIs + seed a default panel
open-consensus init --detect-only   # just show what was detected, write nothing
open-consensus init --force         # overwrite an existing config
open-consensus init --allow-unsandboxed   # also seed adapters with no native sandbox (D20)
```

`init` probes every adapter's `detect()`, seeds one agent per available
**sandboxed** adapter, and creates a `default` panel with a strict-majority
quorum. Adapters with no native read-only/sandbox mode (e.g. `opencode`) are
**skipped unless you pass `--allow-unsandboxed`**, acknowledging that such a tool
can read, write, or exfiltrate anything your account can reach — the ephemeral
scratch cwd is *not* a security boundary.

## Agents

```sh
open-consensus agent add claude --adapter claude --model opus
open-consensus agent add oc --adapter opencode --allow-unsandboxed
open-consensus agent list
open-consensus agent update claude --timeout 90000 --model -   # '-' clears the model
open-consensus agent remove claude --force                     # also prune from panels
open-consensus agent test claude          # print the invocation it WOULD run (no spend)
open-consensus agent test claude --live   # actually spawn the CLI (can cost money)
```

`agent add` validates the adapter id and **warns** (does not fail) if the binary
isn't currently detected — you can configure an agent before installing its CLI.
`agent test` runs `detect()` and prints the exact `file + args` it would use, with
the prompt elided and the env shown by key; `--live` is the only path that spawns
the real CLI.

## Panels

```sh
open-consensus panel create review --agents claude,codex,gemini --quorum 2
open-consensus panel list
open-consensus panel add-agent review opencode
open-consensus panel remove-agent review gemini
open-consensus panel set-quorum review 2
open-consensus panel remove review
```

## Daemon

```sh
open-consensus daemon start    # start it in the background if not already running
open-consensus daemon status   # running? healthy? endpoint + pid
open-consensus daemon stop      # graceful drain + shutdown
open-consensus daemon serve     # run in the foreground (what `start` spawns)
```

`daemon start` is idempotent: it auto-starts a detached `daemon serve` only when
no healthy daemon is already listening. `run start` auto-starts the daemon too.

The daemon is a **per-user singleton** and snapshots its config at startup. If you
point `OPEN_CONSENSUS_CONFIG` at a different file while a daemon is already
running, commands won't silently dispatch against the wrong roster — they error
and tell you to `daemon stop` first so the next start picks up the new config.

## Runs

```sh
open-consensus run start review "Critique this plan: ..."   # auto-starts the daemon
open-consensus run status <runId>
open-consensus run list --state running
```

The CLI's run commands are for manual/dev use; the orchestrator normally drives
runs through the MCP tool surface (see [mcp.md](./mcp.md)).

## MCP registration

```sh
open-consensus mcp install                 # register in the Claude Code config (~/.claude.json)
open-consensus mcp install --config <path> --name <serverName>
open-consensus mcp install --force         # overwrite a conflicting existing entry
open-consensus mcp uninstall
open-consensus mcp-server                  # run the stdio MCP server (what mcp install registers)
```

`mcp install` registers the right command for **how you installed**: a packaged
single binary self-registers its absolute path as `{command: <binary>, args:
["mcp-server"]}` (the host may not share your `PATH`); a from-source/npm install
registers the published `open-consensus-mcp` bin. `mcp-server` is the stdio MCP
server subcommand the host launches — you don't normally run it by hand.

`mcp install` is **safe and idempotent**: it parses the host config first,
reports a byte-identical entry as `unchanged`, refuses to overwrite a *different*
existing entry without `--force` (reported as a conflict, exit non-zero), writes
atomically (temp + rename), and **refuses to touch a malformed host config**.
