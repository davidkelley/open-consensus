# Distribution & install

Open Consensus ships as a **single self-contained binary** (no Node runtime
required) for macOS and Linux. The recommended install is the curl one-liner; you
can also build from source for development.

## Install (curl)

```sh
curl -fsSL https://openconsensus.dev/install | sh
```

This script (served from `openconsensus.dev`, source in
[`apps/installer/install.sh`](../apps/installer/install.sh)):

1. detects your OS + architecture and the matching release asset,
2. downloads `open-consensus-<target>.tar.gz` and `SHA256SUMS` from the GitHub
   release,
3. **verifies the SHA-256** of the asset before installing (fail-closed),
4. installs the `open-consensus` binary to `/usr/local/bin` (falling back to
   `~/.local/bin` if that isn't writable).

Prefer to read before you run? `curl -fsSL https://openconsensus.dev/install` prints
the script without executing it.

### Knobs (environment variables)

| Variable | Effect |
| --- | --- |
| `OPEN_CONSENSUS_VERSION` | Install a specific release, e.g. `0.1.0` or `v0.1.0` (default: latest). |
| `OPEN_CONSENSUS_INSTALL_DIR` | Install directory (default `/usr/local/bin`, fallback `~/.local/bin`). |
| `OPEN_CONSENSUS_BIN_NAME` | Installed binary name (default `open-consensus`). |

```sh
# Pin a version and install to a user dir:
OPEN_CONSENSUS_VERSION=0.1.0 OPEN_CONSENSUS_INSTALL_DIR="$HOME/.local/bin" \
  sh -c "$(curl -fsSL https://openconsensus.dev/install)"

# Or pin directly in the URL (the worker templates the version into the script):
curl -fsSL "https://openconsensus.dev/install?version=0.1.0" | sh
```

If the chosen directory isn't on your `PATH`, the script prints a note (common on
macOS for `~/.local/bin`); add it to your shell profile to run `open-consensus`
directly.

## Supported platforms

| Target | Asset |
| --- | --- |
| macOS arm64 (Apple Silicon) | `open-consensus-aarch64-apple-darwin.tar.gz` |
| macOS x86_64 (Intel) | `open-consensus-x86_64-apple-darwin.tar.gz` |
| Linux x86_64 | `open-consensus-x86_64-unknown-linux-gnu.tar.gz` |
| Linux arm64 | `open-consensus-aarch64-unknown-linux-gnu.tar.gz` |

**Windows is a non-goal** (uncertified): the process tree-kill and `0600` file
permissions the daemon relies on are unverified there. Use WSL — building from source
on native Windows does not lift that uncertified status.

## macOS Gatekeeper

The binary is **ad-hoc signed**, not Apple Developer-ID notarized. The install
script clears the `com.apple.quarantine` flag so the binary runs from the terminal
without an "unidentified developer" prompt. If you move/redownload the binary by
other means and macOS blocks it, clear it manually (use the binary's real path — the
`$(command -v …)` form below only works once the install dir is on your `PATH`):

```sh
xattr -d com.apple.quarantine "$(command -v open-consensus)"
```

Notarization (a smoother first-launch-from-Finder experience) is a planned future
improvement.

## Verifying the download yourself

Every release publishes a `SHA256SUMS` file. To check an asset by hand:

```sh
shasum -a 256 --ignore-missing -c SHA256SUMS    # macOS
sha256sum --ignore-missing -c SHA256SUMS        # Linux
```

`SHA256SUMS` covers all four platform assets, so `--ignore-missing` skips the ones
you didn't download (without it you'll see harmless `FAILED open or read` lines for
them — only your asset's `OK` matters).

The checksum protects **integrity** (corruption, TLS-MITM) — the trust chain is
GitHub + Cloudflare TLS plus GitHub account security. There is **no** out-of-band
cryptographic signature yet (cosign / minisign / SLSA provenance is a documented
future hardening), so `curl … | sh` carries the usual trust assumptions.

## MCP registration

`open-consensus mcp install` registers the server with your agent host (e.g. Claude
Code's `~/.claude.json`). When you run it from the **installed binary**, it registers
the binary's own absolute path invoked as `open-consensus mcp-server`:

```json
{ "mcpServers": { "open-consensus": { "command": "/usr/local/bin/open-consensus", "args": ["mcp-server"] } } }
```

If you later **move the binary**, re-run `open-consensus mcp install` to refresh the
recorded path.

## Uninstall

```sh
open-consensus mcp uninstall                 # remove the MCP host entry
rm -f "$(command -v open-consensus)"         # remove the binary (use your name if
                                             # you set OPEN_CONSENSUS_BIN_NAME)
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/open-consensus" \
       "${XDG_CONFIG_HOME:-$HOME/.config}/open-consensus" \
       "${XDG_DATA_HOME:-$HOME/.local/share}/open-consensus" \
       "${XDG_CACHE_HOME:-$HOME/.cache}/open-consensus"   # config, state, data, cache
```

## Build from source

For development, or an unsupported platform:

```sh
git clone https://github.com/davidkelley/open-consensus && cd open-consensus
npm install && npm run build          # needs Node >= 22 (ink + React TUI)
node packages/cli/dist/cli.js --help  # or `npm link` to put `open-consensus` on PATH
```

Build the single binary locally with `npm run build:binary` (host target) and
smoke it with `npm run smoke:binary`. See
[`apps/installer/README.md`](../apps/installer/README.md) for the worker behind
`openconsensus.dev/install`.
