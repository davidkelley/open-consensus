# Open Consensus — Packaging & Distribution Plan

Slug: `packaging-distribution`. Executed stage-by-stage per the `/consensus` protocol (per-stage commit + 4-reviewer loop). This plan was hardened by one read-only review round (Gemini + opencode substantive; Codex slow-to-return inline; Grok unavailable — 403 spend limit).

## Context

`open-consensus` is feature-complete and consensus-clean, but is only installable from a clone (`npm install && npm run build`). We want a one-line install of a self-contained binary — `curl -fsSL https://openconsensus.dev/install | sh` — so users need neither Node nor a build step. This plan makes the app packageable as a single binary, builds per-platform binaries in CI on GitHub Releases, and ships a Cloudflare-Worker installer (adapted from `searchlite-installer`) on `openconsensus.dev`.

## Decisions made (user-confirmed unless noted)

- **D-PKG1 — Packager: `@yao-pkg/pkg`, not Node SEA.** SEA can't package this app without dropping features: `ink → yoga-layout` inits its WASM with a **module-level top-level `await`** (esbuild can't emit that as the single CommonJS file SEA needs), `better-sqlite3` is a **native `.node`** SEA won't embed, and the daemon self-spawn resolves a real file path. `@yao-pkg/pkg` snapshots a real Node 22 runtime, so the ESM TUI, TLA/WASM, and native `better-sqlite3` work unchanged — no `node:sqlite` migration, Node runtime preserved for the hardened proc/daemon layer.
- **D-PKG2 — One binary multiplexes everything.** The single `open-consensus` binary serves CLI/TUI/daemon AND the MCP server via an `open-consensus mcp-server` subcommand (no second binary, no symlink). The `mcp-server` path must NOT launch the TUI or auto-start the daemon, and must own its own stdio lifecycle without racing the CLI's module-level SIGTERM/SIGINT handlers.
- **D-PKG3 — Daemon self-spawn, packaged branch is explicit.** When `isPackaged()`, spawn `process.execPath` with args `['daemon','serve']` **and no `cliEntry`** (the current `fileURLToPath(import.meta.url)` resolves to a non-existent `/snapshot/...` path inside the pkg archive). From-source keeps `[cliEntry,'daemon','serve']`. Unit tests assert the exact args array for both branches.
- **D-PKG4 — Native addon is extracted + loaded from disk.** pkg cannot `require()` a `.node` from its virtual FS. `better-sqlite3` resolves its binary via `node-gyp-build`/`bindings` probing `prebuilds/<platform>-<arch>/`; the spike must confirm pkg's asset extraction serves that probe (extracting to a real path / temp on first run). This is the #1 risk (R1).
- **D-PKG5 — `mcp install` registers the packaged entry.** When `isPackaged()`, write `{ command: <abs path of process.execPath>, args: ["mcp-server"] }`; else keep `{ command: "open-consensus-mcp", args: [] }`. The packaged shape is asserted by a Stage-2 smoke check (most user-visible distribution property).
- **D-PKG6 — macOS: ad-hoc codesign + clear quarantine.** CI ad-hoc-signs (`codesign --force --sign -`); `install.sh` clears `com.apple.quarantine` on the temp file **before** moving to the install path (so Finder never sees a quarantined binary) and re-ad-hoc-signs the installed file as belt-and-suspenders. Notarization deferred (no Apple account). (User-confirmed.)
- **D-PKG7 — Channel: curl installer only** (no npm/Homebrew; matches prefer-simplicity). `scripts/smoke-pack.mjs` stays as a sanity check; we do not publish to npm. (User-confirmed.)
- **D-PKG8 — Platforms: macOS arm64 + x64, Linux x64 + arm64. Windows deferred** (existing "Windows uncertified" non-goal).
- **D-PKG9 — Worker EMBEDS a version-templated `install.sh` (not searchlite's raw-GitHub proxy).** The script is bundled into the worker (text import) and served at `/install` only (the bare domain `/` is reserved for a future landing page, not the installer — adjusted from the original "+ /"). The DEFAULT script downloads from GitHub `releases/latest/download/...`, which always resolves to the newest release — so **a new CLI release needs NO worker redeploy**; the worker is redeployed only when the *script* changes. An explicit pin (`?version=` / `OPEN_CONSENSUS_VERSION`) is templated in for reproducible installs.
- **D-PKG10 — Checksum verification (improvement over searchlite, which has none).** `install.sh` downloads `SHA256SUMS` from the release and verifies the asset using whichever of `sha256sum` / `shasum -a 256` / `openssl dgst -sha256` exists (macOS lacks `sha256sum`). Trust anchor is GitHub + Cloudflare TLS (not a signature over the sums file); SLSA/cosign provenance is a documented future non-goal.
- **D-PKG11 — Asset-name contract is a shared constant.** `<target>` is the Rust-style triple, identical in `release.yml` and `install.sh`: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`; asset = `open-consensus-<target>.tar.gz`. A mismatch is a 404, so the mapping is documented once and referenced by both.

## Assumptions / prerequisites (user-owned, gate the deploy step only)

- Purchase `openconsensus.dev`, add it as a **Cloudflare zone** (provides the real `zone_id` — scrub searchlite's hardcoded `3fa13705176d4d95b8320b1f3ad138b1`), and make **`davidkelley/open-consensus` public** with Releases. Worker + script build/test fully locally without these; only `wrangler deploy` + live install need them.
- `@yao-pkg/pkg` ships Node 22 base binaries for the 4 targets (cached in CI via `~/.pkg-cache`). Each target's `better-sqlite3` `.node` is built on a **native-arch runner** (no cross-compiling the addon).

## Non-goals

Windows binaries/certification; npm + Homebrew; Apple notarization; self-update/`upgrade`; SLSA/cosign; `node:sqlite` migration (fallback only); any consensus/engine behavior change.

## Highest risks (de-risk early)

- **R1 (high):** pkg + ESM + yoga top-level-await + native `better-sqlite3` extraction (D-PKG4). **Stage 2 is a timeboxed spike that must yield one working local binary before any CI/installer work.** Hard gate: if the binary can't load SQLite + render the TUI after the spike timebox, fall back in order: (a) ship `better_sqlite3.node` as a sidecar next to the binary; (b) migrate storage to `node:sqlite`; (c) re-evaluate `bun build --compile`. The chosen path is recorded in the Stage-2 commit.
- **R2 (med):** linux-arm64 — build on `ubuntu-24.04-arm` (native arm64 runner), NOT cross-compiled on x64 (which would silently ship an x64 `.node` that crashes on ARM).
- **R3 (med):** the mock adapter spawns `process.execPath -e <script>`, which fails inside a binary (the binary isn't a general `node`). Mock is excluded from the production registry (`includeMock:false`), so the binary's real paths are unaffected; the Stage-2 smoke must NOT exercise mock (uses real-adapter `detect()` dry-run only). Documented, asserted unreachable.

---

## Stages

### Stage 1 — Single-binary readiness (no packaging yet; from-source behavior unchanged)
**Files:** `packages/core/src/` (`isPackaged()` = `typeof (process as any).pkg !== 'undefined'`), `packages/cli/src/{cli.ts,program.ts}` (add `mcp-server` subcommand reusing `@open-consensus/mcp`'s server/transport; gate daemon self-spawn args), `packages/command-core/src/{daemon-control.ts,mcp-install.ts}`, `packages/cli` dep on `@open-consensus/mcp`, `*.test.ts`.
**Acceptance:**
- `open-consensus mcp-server` runs the same stdio MCP server as `open-consensus-mcp` — WITHOUT launching the TUI or auto-starting the daemon, owning its own stdin-close shutdown and not double-binding the CLI's SIGTERM/SIGINT handlers. Unit-tested via the in-memory MCP harness (protocol `initialize` + `tools/list`).
- Daemon self-spawn: packaged branch emits exactly `{command: process.execPath, args:['daemon','serve']}` (no `cliEntry`); from-source emits `[cliEntry,'daemon','serve']`. Both args arrays asserted.
- `mcp install`: packaged writes `{command: <execPath>, args:['mcp-server']}`; else `{command:'open-consensus-mcp', args:[]}`. Both branches unit-tested.
- All existing tests + ≥90% coverage stay green; the new `mcp-server`/branch logic kept thin enough not to crater branch coverage in `cli`/`command-core`.

### Stage 2 — Packaging pipeline + spike (one working local binary)
**Files:** `scripts/build-binary.mjs` (esbuild bundle the cli entry: `format=esm, platform=node, target=node22`, externalize `better-sqlite3`; then `@yao-pkg/pkg` → `dist-bin/open-consensus-<target>`, including `better-sqlite3`'s `prebuilds/` via `pkg.assets`), `pkg` config, `scripts/smoke-binary.mjs`, root `package.json` scripts (`build:binary`, `smoke:binary`) + devDeps (`@yao-pkg/pkg`, `esbuild`).
**Acceptance:**
- A runnable host-target binary at a documented path (`dist-bin/open-consensus-<host-target>`).
- **Native-addon load proven:** the binary opens the SQLite DB (extract/probe of `better_sqlite3.node` works packaged) — if not, R1 fallback is applied + recorded.
- `smoke-binary.mjs` (no spend, no real CLIs): `--help`; `daemon start`→`status`→`stop` (self-spawn + native SQLite + unix socket inside the binary); `mcp-server` protocol `initialize` + `tools/list` over stdio (MCP + daemon RPC); `mcp install --config <tmp>` then assert the written entry is `{command:<binary path>, args:['mcp-server']}`; `agent test` dry-run on real adapters (`detect()` only, no spawn — mock NOT exercised). TUI render-and-exit smoke where a PTY is available, else a documented manual check.
- Binary size + any R1 fallback recorded in the commit.

### Stage 3 — Release CI (GitHub Actions)
**Files:** `.github/workflows/ci.yml` (PR gate: `build`, `typecheck`, `lint`, `test`+coverage, `test:e2e`, `smoke:pack` — repo has no CI today), `.github/workflows/release.yml`.
- `release.yml` on tag `v*`: matrix on **native-arch runners** (`macos-14`=arm64, `macos-13`=x64, `ubuntu-24.04`=x64, `ubuntu-24.04-arm`=arm64) → `npm ci` (builds the matching `better-sqlite3` `.node`) → `build:binary` (cache `~/.pkg-cache`) → ad-hoc `codesign` on macOS → `tar.gz` as `open-consensus-<target>.tar.gz` → emit per-job `SHA256SUMS.<target>`; a final job concatenates them into one `SHA256SUMS` and creates/uploads the GitHub Release (avoids concurrent last-write-wins on the sums file).
**Acceptance:** assets match D-PKG11 exactly + `SHA256SUMS`; macOS assets ad-hoc signed; `ci.yml` green; release job validated on a throwaway pre-release tag before going live; verify a downloaded asset's checksum + that it runs on each arch.

### Stage 4 — Installer app (`apps/installer/`) + monorepo wiring
**Files:** root `package.json` `workspaces` += `apps/*`; `turbo.json` filter so `apps/installer` is OUTSIDE the engine-style coverage gate; `apps/installer/{wrangler.jsonc,src/index.ts,install.sh,package.json (private:true),test/*,tsconfig.json,vitest.config.mts}`.
- `install.sh` (retargeted, NOT a copy of searchlite's): `OWNER=davidkelley REPO=open-consensus`; `set -euo pipefail`; OS/arch detect (mac+linux; explicit error on Windows); default URL `releases/latest/download` with `OPEN_CONSENSUS_VERSION` pin; download asset + `SHA256SUMS`; **verify via `sha256sum`/`shasum -a 256`/`openssl`** (whichever exists); extract; on macOS clear `com.apple.quarantine` on the temp file then re-ad-hoc-sign; install to `/usr/local/bin` (fallback `~/.local/bin`); **print a PATH advisory if the chosen dir isn't on `$PATH`** (esp. macOS `~/.local/bin`); `OPEN_CONSENSUS_INSTALL_DIR`/`_BIN_NAME` overrides.
- `src/index.ts` (worker): EMBED `install.sh` (text import), template the version, serve at `/install` (+ `/`) with correct `content-type` + `Cache-Control`; 404 elsewhere. wrangler.jsonc: name `open-consensus-installer`, route `openconsensus.dev/install*` (+ root), **`zone_id` placeholder (searchlite's scrubbed)**.
- Installer `private:true`, excluded from npm publish + the binary + the coverage gate (own `@cloudflare/vitest-pool-workers` config).
**Acceptance:** `wrangler dev` + `curl localhost/install` returns a valid, version-templated script; `shellcheck install.sh` clean; worker tests cover serve + version templating + 404; OS/arch→asset mapping unit-tested against D-PKG11; root `npm test`/`build` still green with `apps/*` present (installer not pulled into the 90% gate). `wrangler deploy` documented, gated on the domain/zone prerequisite.

### Stage 5 — Docs & release glue
**Files:** `README.md` (curl one-liner primary; from-source for dev), `docs/distribution.md` (install flow, version pin, checksum + the TLS-not-signature trust note, macOS quarantine/ad-hoc-sign caveat, uninstall, platforms + Windows non-goal, curl|sh trust model, the `mcp install` absolute-path caveat: re-run after moving the binary), `docs/mcp.md` + `mcp install` help (binary self-registers via `mcp-server`), `CHANGELOG.md`.
**Acceptance:** docs read correctly; every install knob + caveat documented; `mcp install` docs match Stage-1 behavior.

---

## Verification (end-to-end)

1. **Stage 1:** `npm test` green (both spawn + mcp-install branches asserted); `open-consensus mcp-server` handshakes over stdio without TUI/daemon side-effects.
2. **Stage 2:** `node scripts/build-binary.mjs` → `node scripts/smoke-binary.mjs` passes (SQLite load + daemon lifecycle + MCP handshake + packaged mcp-install entry + adapters-load, no spend).
3. **Stage 3:** pre-release tag → 4 native-built signed tar.gz + merged `SHA256SUMS`; verify a checksum + run on each arch.
4. **Stage 4:** `cd apps/installer && npm test && npx shellcheck install.sh`; `wrangler dev` + `curl localhost/install | sh` (against a real pre-release) installs a working `open-consensus`.
5. **Full path (post-prereqs):** deploy the worker → on a clean machine `curl -fsSL https://openconsensus.dev/install | sh` → `open-consensus init` → `open-consensus mcp install` → drive a consensus (live-agent run via the existing opt-in `test:e2e:live`).

## Reviewer pushback (accepted-as-is / rejected)

- **Checksum is integrity, not provenance (opencode M2):** verifying the asset against `SHA256SUMS` served over the same TLS channel does not protect against a fully-compromised release; the trust anchor is GitHub + Cloudflare TLS. Accepted for v1 and documented; cryptographic signing (cosign/SLSA) is a recorded future non-goal — not worth the key-management overhead for a curl|sh tool now.
- **Panel status (plan round):** Codex returned no substantive findings inline (slow-to-return, as in the prior build); Grok unavailable all round (403 spend limit). Their per-stage scrutiny resumes during execution. No findings were rejected on merits; all critical/high/sound-medium items above were folded in.

## As-built reconciliations (recorded during execution + final review)

The spike + per-stage reviews refined several decisions; the plan above is updated, and the deltas are:

- **D-PKG1/D-PKG3 — packaging is @yao-pkg/pkg ENHANCED SEA mode** (not standard pkg). The spike found standard pkg can't load ESM from its snapshot; SEA mode is the documented ESM path. The packaged daemon self-spawn is therefore NOT `{execPath, ['daemon','serve']}` (pkg's patched child_process mangles a binary-spawns-itself call) but a shell-interposed clean execve: `daemonLaunchSpec` → `{command:'/bin/sh', args:['-c','exec "$0" daemon serve', execPath]}`. Two further spike fixes were load-bearing: the cli entry is top-level-await (the SEA dispatcher only keeps the AWAITED entry alive), and `delay()` is no longer unref'd (an unref'd poll timer let the minimal SEA binary exit after one iteration).
- **D-PKG6 — the install.sh macOS re-ad-hoc-sign was DROPPED** (per the Stage-4 review): redundant + a silent-failure risk, since the binary is already ad-hoc-signed in CI and the embedded Mach-O signature survives tar/cp. Only the quarantine clear remains.
- **Stage 4 — `apps/installer` is an ISOLATED sub-project, NOT a root npm-workspace member** (deviates from "apps/* in workspaces"): it's a Cloudflare/wrangler/vitest@3 stack that would conflict with the Node monorepo's vitest@2 and bloat every install with `workerd`. Isolation keeps the root gate clean; a dedicated `installer` CI job + the `apps/installer/README.md` cover it.
- **install.sh uses `set -eu`, not `set -euo pipefail`** — `pipefail` is non-POSIX (breaks `dash`); the checksum verify is fail-closed regardless (empty actual ≠ expected → abort).
- **`mcp-server` protocol acceptance:** the in-memory `initialize`+`tools/list` harness IS exercised — by `createMcpServer`'s existing server.test.ts (the tool surface) — and `runMcpStdioServer`'s thin stdio wiring is the excluded entry stub proven end-to-end by the binary smoke (real stdio initialize + tools/list). `program.test.ts` additionally asserts the subcommand wires the runner and launches no TUI/daemon.
- **`detect_target` OS/arch→asset mapping** is verified by the cross-stage asset-name contract check (build-binary `TARGETS` ↔ release.yml matrix ↔ install.sh ↔ docs) + shellcheck, rather than a dedicated shell unit test (extracting it from the run-on script wasn't worth the harness).
- **First release:** `release.yml` guards that the `v*` tag matches `package.json` (currently `0.0.0`); bump `package.json` to the release version before cutting the first tag.
