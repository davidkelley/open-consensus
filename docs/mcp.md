# Open Consensus — MCP server

`open-consensus-mcp` is a stdio [MCP](https://modelcontextprotocol.io) server that
lets a driving agent (Claude Code, Codex, …) run multi-agent consensus rounds. It
is a **thin client**: every tool call forwards to the local Open Consensus daemon,
which owns execution (spawning the panel's CLIs, parallelism, timeouts, retries,
failure isolation, distillation). The daemon is the source of truth; the MCP
server holds no run state.

## How the orchestrator drives a consensus

The tools are designed so the loop is deterministic — every poll/status result
carries a `next_action` hint:

1. `consensus_list_panels` → pick a panel.
2. `consensus_start({ panel, prompt })` → returns `{ runId, roundId }` immediately
   (non-blocking) with `next_action: keep_polling`.
3. `consensus_poll({ runId, roundId, wait_ms })` → a bounded long-poll. While the
   round is in flight it returns only per-agent **statuses** (a tiny payload, so
   repeated polls barely touch your context). When every agent is terminal it
   returns each agent's **distilled** answer, the quorum **verdict**, and a
   `next_action`:
   - `review_results` (verdict `met`) — read the answers and decide.
   - `handle_degraded` (verdict `degraded`/`failed`) — some/all agents didn't
     produce an `ok`; missing/errored agents are listed by name with an error
     class.
   - `keep_polling` — still running; poll again.
   - **A tool error or timeout is transient** — just call `consensus_poll` again
     with the same `runId`/`roundId`. The run keeps progressing inside the daemon;
     retries/backoff happen there and are never replayed to you (only summarized
     as attempt counts).
4. Decide: `consensus_round({ runId, prompt })` for another round (you compose the
   next prompt — rounds are stateless), or finalize.

Other tools:

- `consensus_status({ runId })` — non-blocking snapshot of a run + its latest
  round; also heartbeats the run so the idle reaper doesn't park it while you
  reason quietly.
- `consensus_list_runs({ state? })` — **re-anchor** after you restart: a parked
  (`abandoned`) run is re-adopted (un-parked back to running) by calling
  `consensus_status` on it, after which you can continue it with `consensus_round`.
- `consensus_get_raw({ rawRef, cursor?, maxBytes? })` — fetch an agent's full raw
  output, **paginated** by byte cursor with a hard per-call cap (never an
  unbounded payload). Use it when a result is `truncated` before judging.
- `consensus_cancel({ runId })` — tree-kill every in-flight agent of the run.
- `consensus_cancel_agent({ runId, roundId, agentId })` — v1 cancels at **round**
  granularity (finer per-agent cancellation is a future enhancement).

### Idempotency

`consensus_start` and `consensus_round` accept an optional `idempotencyKey`. A
retried call with the same key returns the **original** run/round instead of
starting duplicate work — the dedup is persisted in the daemon and survives a
daemon restart for the run's lifetime.

## Registering the server

The daemon auto-starts on first use (a future CLI release wires `open-consensus
daemon start`; until then start it explicitly). Register the stdio server with
your host:

**Claude Code** (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "open-consensus": { "command": "open-consensus-mcp" }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.open-consensus]
command = "open-consensus-mcp"
```

Then tell the orchestrator to "use Open Consensus" for multi-agent review/consensus
tasks. `open-consensus mcp install` (Stage 8) writes these entries safely and
idempotently.

> If the daemon isn't running, the tools return a clear, actionable error
> (`daemon is not running — start it with open-consensus daemon start`) rather
> than hanging.
