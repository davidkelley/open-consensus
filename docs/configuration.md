# Configuration

Open Consensus stores a single validated JSON config file. All of it is managed
through the CLI/TUI (`agent`/`panel`/`init` commands) or, if you prefer,
hand-edited — it is re-validated on every read.

## Location

XDG-resolved (the same on macOS — we deliberately use XDG paths, not
`~/Library`):

- Config: `${XDG_CONFIG_HOME:-~/.config}/open-consensus/config.json`
- State / data / runtime: `${XDG_STATE_HOME}` / `${XDG_DATA_HOME}` / `${XDG_RUNTIME_DIR}`

Override the config path for a single invocation with `OPEN_CONSENSUS_CONFIG=…`.
Note the daemon is a per-user singleton that snapshots its config at startup — if
you point `OPEN_CONSENSUS_CONFIG` at a different file while a daemon is already
running, commands won't silently use the wrong roster; they error and tell you to
`open-consensus daemon stop` first.

## Model

```jsonc
{
  "schemaVersion": 1,
  "agents": [
    {
      "id": "claude",            // lowercase kebab-case
      "name": "Claude",
      "adapter": "claude",       // claude | codex | gemini | opencode
      "model": "opus",           // optional model override
      "args": [],                // extra CLI args (validated; no read-only-bypass flags)
      "env": {},                 // child env (secrets travel here, never argv)
      "timeoutMs": 120000,       // per-invocation timeout (tree-kill on expiry)
      "maxRetries": 2,           // internal retries (exp backoff + jitter)
      "sessionMode": "stateless" // v1 is always stateless; 'resume' is schema-ready
    }
  ],
  "panels": [
    {
      "id": "review",
      "name": "Review panel",
      "agentIds": ["claude", "codex", "gemini"],
      "quorum": 2,               // minimum OK responses for a 'met' verdict
      "concurrency": 3           // optional cap on concurrent invocations
    }
  ]
}
```

### Referential integrity

The store enforces it: a panel can't reference an unknown agent, can't list a
duplicate agent, and `quorum` can't exceed the panel size. You can't delete an
agent a panel still uses without `--force` (which also prunes it from panels).

### Adapters

Each `adapter` id maps to a built-in adapter with a read-only default and a
capability profile — see [adapters.md](adapters.md). `agent add` warns (does not
fail) if the CLI isn't installed yet, and refuses an unsandboxed adapter unless
you pass the unsandboxed acknowledgment.

### Secrets

Agent `env` values and any secret-looking tokens are **redacted before anything
is persisted, logged, streamed over SSE, or rendered** in the CLI/TUI. Secrets
travel via `env`, never argv (so they don't leak via `ps`).
