# Architecture

```
   Orchestrator (Claude Code, Codex, …)
        │  MCP (stdio)
        ▼
   open-consensus-mcp  ── thin client; auto-starts + forwards to the daemon
        │  unix socket (0600) default / loopback HTTP + bearer token fallback
        ▼
   Daemon (long-lived, single-instance per user)
     • Engine: runs → rounds → invocations; quorum; distillation
     • Process runner: spawn / tree-kill / byte caps / ANSI-strip / redact
     • Concurrency, per-agent timeout, retry, failure isolation
     • SQLite (metadata + event log) + raw blobs on disk
        │  execFile (shell:false, own process group, read-only flags)
        ▼
   claude / codex / gemini / opencode CLIs        SSE (/events, Last-Event-ID)
                                                       │
                                                       ▼
                                          TUI (ink + React, separate process)
```

## Load-bearing decisions

- **The orchestrator owns the *judgment*; Open Consensus owns *execution*.** It
  fans a round out to every panel agent, isolates failures, retries *inside* the
  daemon (never replayed to the orchestrator), and returns distilled,
  provenance-tagged per-agent results. The orchestrator reads them and decides
  whether to run another round or finalize. There is no automatic semantic
  "consensus reached" detection in v1.

- **A persistent local daemon is the source of truth.** A run outlives any single
  MCP call or TUI session, so a single-instance daemon (enforced by a
  `proper-lockfile` lock acquired before any reconcile) holds engine state. The
  MCP server and TUI are thin clients that discover it via an atomically-written
  `0600` discovery file (endpoint + token + pid).

- **Async job model with snapshot long-poll.** `consensus_start` returns a
  `runId`+`roundId` immediately; `consensus_poll` is a bounded long-poll that
  returns the instant the round is terminal, else after `wait_ms`. Polls are
  idempotent and carry a monotonic `stateVersion`; an in-progress poll returns a
  tiny counts-only payload. Connection errors / host timeouts are *transient* —
  re-poll the same ids.

- **SSE and long-poll are two views over one persisted event log.** Every engine
  transition is appended to the SQLite event log with a durable sequence number.
  Long-poll reads a complete snapshot at a `stateVersion`; SSE (`/events`) is a
  live tail with `Last-Event-ID` back-fill (which doubles as the snapshot for a
  reconnecting TUI). One source of truth, two consumers (model vs human).

- **Round completion & quorum.** A round is complete only when *every* agent is
  terminal (`ok | refusal | timeout | error | unavailable | cancelled |
  interrupted`). Quorum counts only `ok` responses: `met` (≥ quorum), `degraded`
  (some ok, < quorum), `failed` (0 ok). Missing/errored agents are always listed
  by name with their error class. Per-agent timeouts guarantee liveness — a round
  never hangs.

- **Crash recovery is reconcile + re-dispatch, not resume.** External CLI children
  can't be resumed after a daemon restart. Startup reconcile: sweep orphaned
  process groups (driven by a persisted PGID registry), advance every leftover
  `running` invocation to `interrupted`, recompute the round verdict, sweep
  prompt temp files, and repair row↔blob prune mismatches. Re-dispatch is an
  explicit orchestrator action (a new round), never a hidden retry.

- **Read-only is best-effort, not a sandbox.** Each adapter uses the tool's
  strongest native constraint as its default and runs in an ephemeral scratch cwd
  — which is *not* a security boundary (see the README's Security section).

See [`.design/PLAN-open-consensus.md`](../.design/PLAN-open-consensus.md) for the
full decision log (D1–D22) and failure-mode matrix.
