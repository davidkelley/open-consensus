# open-consensus-installer

The Cloudflare Worker behind `https://openconsensus.dev/install` — it serves the
`curl | sh` install script for the Open Consensus single binary.

```sh
curl -fsSL https://openconsensus.dev/install | sh
```

## How it works

- `install.sh` is **embedded** in the worker (`wrangler` Text rule) and served from
  the edge — no dependency on `raw.githubusercontent.com` at install time (D-PKG9).
- The default script downloads `github.com/davidkelley/open-consensus/releases/latest/download/open-consensus-<triple>.tar.gz`,
  so **a new CLI release needs no worker redeploy** — only a change to `install.sh`
  does. A pinned install: `…/install?version=0.1.0` (or `OPEN_CONSENSUS_VERSION=0.1.0`
  in the user's env).
- The script **verifies the SHA-256** of the asset against the release's `SHA256SUMS`
  before installing (D-PKG10), fail-closed. This is **integrity** against corruption
  / TLS-MITM, **not provenance**: both files come from the same release, so the trust
  chain is GitHub + Cloudflare TLS + GitHub account security — there is no out-of-band
  signature (cosign / minisign / SLSA is a documented future hardening).
- `OPEN_CONSENSUS_VERSION` (and the `?version=` query) are validated as a semver
  before reaching any URL or the shell.
- macOS: it clears `com.apple.quarantine` on the temp file and re-ad-hoc-signs so
  Gatekeeper accepts the ad-hoc-signed binary (D-PKG6).

## This is an isolated sub-project (not a root workspace member)

It is a Cloudflare Workers / `wrangler` / `vitest@3` (Workers pool) stack — a
different toolchain from the Node monorepo (`tsup` / `vitest@2`). Keeping it out of
the root npm workspaces avoids a `vitest` major-version conflict and keeps `workerd`
out of every monorepo install. Install + work on it from here:

```sh
cd apps/installer
npm install
npm test                 # vitest (Cloudflare Workers pool)
npx shellcheck install.sh
npm run dev              # wrangler dev; then `curl localhost:8787/install`
```

## Deploy (prerequisites)

`wrangler deploy` requires, all user-owned and **gating the deploy only**:

1. `openconsensus.dev` purchased and added as a **Cloudflare zone**.
2. The real `zone_id` set in `wrangler.jsonc` (currently a placeholder).
3. `wrangler login` (or a `CLOUDFLARE_API_TOKEN`).

The worker + script build and test fully **without** any of the above.
