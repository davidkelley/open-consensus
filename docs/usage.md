# Usage

Two ways to drive a consensus: an **orchestrator** (Claude Code / Codex) via the
MCP tools, or **you** interactively in the TUI. Both go through the same daemon.

## First run

```sh
open-consensus init          # auto-detect installed CLIs + seed a 'default' panel
open-consensus mcp install   # register the MCP server with Claude Code
```

`init` probes each adapter's `detect()`, adds an agent per available sandboxed
CLI, and creates a strict-majority-quorum `default` panel. Adapters with no
native sandbox (e.g. `opencode`) need `--allow-unsandboxed`.

## Driving from an orchestrator (MCP)

Tell your orchestrator to *use Open Consensus*. The loop it runs:

1. `consensus_list_panels` → pick a panel.
2. `consensus_start({ panel, prompt })` → returns `{ runId, roundId }` immediately.
3. `consensus_poll({ runId, roundId, wait_ms })` → repeat until `done: true`.
   - While running: a tiny per-agent status payload.
   - When done: each agent's `distilled` answer, `attempts`, `rawRef`, the quorum
     `verdict`, and a `next_action` hint.
4. Read the per-agent answers and decide:
   - `consensus_round({ runId, prompt })` to run another round (you compose the
     next prompt — rounds are stateless), or **finalize by simply stopping**
     (there is no "finalize" tool — you just stop adding rounds).
5. `consensus_get_raw({ rawRef, cursor?, maxBytes? })` to page the full output of
   an agent whose answer was truncated, without bloating context.
6. `consensus_cancel({ runId })` (or `consensus_cancel_agent({ runId, roundId,
   agentId })`, which in v1 cancels at **round** granularity — the whole round)
   to abort in-flight work — the daemon tree-kills the children so nothing keeps
   running server-side.

Re-entry after an orchestrator restart: `consensus_list_runs({ state? })` surfaces
in-flight + parked runs; `consensus_status({ runId })` re-adopts a parked run so
you can continue it with `consensus_round`. Idempotency: pass a unique
`idempotencyKey` to `consensus_start`/`consensus_round` so a retried call returns
the original run/round instead of duplicating it.

A tool error or host timeout is **transient** — just re-poll the same
`runId`/`roundId`; the run keeps progressing inside the daemon regardless.

## Driving interactively (TUI)

```sh
open-consensus               # bare command -> the slash-command TUI
```

Slash commands (Tab to autocomplete, ↑/↓ for history):

```
/agents                       list configured agents
/agent add <id> --adapter <a> add an agent
/panels                       list panels
/panel create <id> a,b,c      create a panel
/run <panel> <prompt…>        start a run and watch it live
/runs                         list runs the daemon knows about
/daemon status                is the daemon up?
/help   /quit
```

A `/run` streams a live per-agent timeline (pending → running → ok/error …) that
is committed to the scrollback when it completes. **Ctrl+C** cancels an active
run server-side (the daemon tree-kills the child) — a second Ctrl+C always exits;
when idle, a single Ctrl+C exits.
