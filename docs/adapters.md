# Open Consensus — adapters

An **adapter** teaches the engine how to drive one CLI tool non-interactively
(plan D8): detect it, build a safe invocation, and classify the result. The
contract is frozen (`packages/adapters/src/types.ts`). Every invocation runs
through the hardened process runner (`shell:false`, own process group, byte caps,
ANSI strip, secret redaction) in an ephemeral scratch cwd — which is **not** a
security boundary (D20).

## Capability matrix

| Adapter  | Non-interactive invocation                                  | Read-only default        | Structured output | Prompt via | Native sandbox |
|----------|-------------------------------------------------------------|--------------------------|-------------------|------------|----------------|
| claude   | `claude -p --output-format json --permission-mode plan`     | `--permission-mode plan` | yes (`json`)      | stdin      | yes            |
| codex    | `codex exec --sandbox read-only --skip-git-repo-check`      | `--sandbox read-only`    | no (text)         | stdin      | yes            |
| gemini   | `gemini -p <prompt> --approval-mode plan -o json`           | `--approval-mode plan`   | yes (`json`)      | arg        | yes            |
| opencode | `opencode run <message>`                                    | — (none)                 | no (text)         | arg        | **no**         |

- `--model` (claude/gemini/opencode) / `--model` aka `-m` (codex) is appended when
  an agent configures one; extra `args` from the agent config follow.
- **claude / gemini** parse the CLI's JSON envelope to extract the final answer
  (claude `.result`; gemini `.response`/`.text`/`.content`, defensively), falling
  back to raw text if it isn't JSON. **codex / opencode** return the cleaned text.
- Verdict classification is per-adapter (D8): a non-zero exit → `error` (with an
  `exit-N` class); claude's `is_error`/`subtype` envelope → `error`. The runner's
  mechanical outcomes (timeout, cancel, output-overflow, spawn-error) are mapped
  first.

## Read-only is best-effort, not a sandbox (D20)

Each adapter applies its tool's strongest native constraint as the default. But a
permission flag cannot *guarantee* read-only: a coding CLI can still reach the
network or an absolute path. **opencode `run` exposes no native read-only flag**,
so its `sandbox` capability is `false` — it is **elevated-opt-in only**, behind an
explicit acknowledgment that it can read/write/exfiltrate anything the account can
reach. True OS-level jailing (bwrap / Docker / seatbelt) is out of v1 scope.

## Availability

`detect()` runs `<bin> --version`: a spawn error means the CLI is absent
(`unavailable`); a non-zero exit means an unexpected interface. Missing/unauthed
CLIs are handled failure modes (the round stays valid if quorum is met; the agent
is reported by name), never hard errors.

## Testing

Adapters are covered by a spawnable **fake binary**
(`packages/adapters/test/fixtures/fake-cli.mjs`) that reproduces version probing,
stdin/arg prompt delivery, JSON/text/ANSI output, and exit codes — driven by
`FAKE_*` env vars. CI **never spawns a real (paid) CLI**; the documented flag sets
above are verified against each tool's installed `--help` and re-validated by the
opt-in live-E2E suite (Stage 10).
