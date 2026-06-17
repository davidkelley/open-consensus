#!/bin/sh
# Open Consensus installer.
#   curl -fsSL https://openconsensus.dev/install | sh
#
# Downloads the latest (or a pinned) release binary, VERIFIES its SHA-256 against
# the release's SHA256SUMS, and installs it. POSIX sh (no bashisms) for max
# portability under `curl | sh`. macOS + Linux only — Windows is a non-goal.
set -eu

OWNER="davidkelley"
REPO="open-consensus"
BIN_DEFAULT="open-consensus"

err() {
  echo "error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "required command '$1' not found in PATH"
}

# OS/arch -> the Rust-style target triple used in the release asset names. The
# triple set MUST match the release matrix (.github/workflows/release.yml).
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin)
      case "$arch" in
        arm64 | aarch64) echo "aarch64-apple-darwin" ;;
        x86_64 | amd64) echo "x86_64-apple-darwin" ;;
        *) err "unsupported macOS architecture: $arch" ;;
      esac
      ;;
    Linux)
      case "$arch" in
        x86_64 | amd64) echo "x86_64-unknown-linux-gnu" ;;
        aarch64 | arm64) echo "aarch64-unknown-linux-gnu" ;;
        *) err "unsupported Linux architecture: $arch" ;;
      esac
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      err "Windows is not supported (a documented non-goal); use WSL or build from source"
      ;;
    *)
      err "unsupported OS: $os"
      ;;
  esac
}

download() {
  # download <url> <dest> — bounded so a hung connection can't hang the installer.
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 30 --max-time 600 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=600 -O "$2" "$1"
  else
    err "need 'curl' or 'wget' to download release artifacts"
  fi
}

# Print the SHA-256 of a file using whatever tool exists (macOS has no sha256sum).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    err "need one of 'sha256sum', 'shasum', or 'openssl' to verify the download"
  fi
}

choose_install_dir() {
  preferred="${OPEN_CONSENSUS_INSTALL_DIR:-/usr/local/bin}"
  fallback="$HOME/.local/bin"
  if [ -d "$preferred" ] && [ -w "$preferred" ]; then
    echo "$preferred"
    return
  fi
  if mkdir -p "$preferred" 2>/dev/null && [ -w "$preferred" ]; then
    echo "$preferred"
    return
  fi
  mkdir -p "$fallback" 2>/dev/null ||
    err "cannot create an install dir; set OPEN_CONSENSUS_INSTALL_DIR to a writable path"
  echo "$fallback"
}

TARGET="$(detect_target)"

VERSION="${OPEN_CONSENSUS_VERSION:-latest}"
if [ "$VERSION" != "latest" ]; then
  # Validate before it ever reaches a URL or the shell — a value with `/`, `;`,
  # `$(…)` etc. must be rejected, not normalized (the worker validates `?version`
  # the same way, but a user's own env var bypasses the worker).
  if ! printf '%s' "$VERSION" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$'; then
    err "invalid OPEN_CONSENSUS_VERSION '$VERSION' (expected e.g. 0.1.0 or v0.1.0)"
  fi
  [ "${VERSION#v}" != "$VERSION" ] || VERSION="v$VERSION"
fi
if [ "$VERSION" = "latest" ]; then
  BASE_URL="https://github.com/$OWNER/$REPO/releases/latest/download"
else
  BASE_URL="https://github.com/$OWNER/$REPO/releases/download/$VERSION"
fi

ASSET="open-consensus-${TARGET}.tar.gz"
SUMS="SHA256SUMS"

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t open-consensus)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM HUP

echo "Detected target: $TARGET"
echo "Fetching:        $BASE_URL/$ASSET"
download "$BASE_URL/$ASSET" "$TMP/$ASSET"
download "$BASE_URL/$SUMS" "$TMP/$SUMS"

# Verify integrity against the release checksum BEFORE extracting/installing —
# fail-closed: an empty/missing expected checksum aborts. This is INTEGRITY against
# corruption/TLS-MITM only; the trust anchor is GitHub + Cloudflare TLS + the
# GitHub account, NOT an out-of-band signature (cosign/minisign is future work).
# Tolerate the optional `*` (binary-mode) prefix some sha256sum outputs use.
expected="$(awk -v a="$ASSET" '{f=$2; sub(/^\*/, "", f)} f == a {print $1}' "$TMP/$SUMS")"
[ -n "$expected" ] || err "no checksum for $ASSET in $SUMS"
actual="$(sha256_of "$TMP/$ASSET")"
if [ "$expected" != "$actual" ]; then
  err "checksum mismatch for $ASSET (expected $expected, got $actual)"
fi
echo "Checksum OK:     $actual"

need_cmd tar
# Extract ONLY the expected binary — a (checksum-valid but) hostile tarball can't
# drop extra files via this path.
tar -xzf "$TMP/$ASSET" -C "$TMP" "$BIN_DEFAULT"
BIN_PATH="$TMP/$BIN_DEFAULT"
[ -f "$BIN_PATH" ] || err "binary '$BIN_DEFAULT' not found in $ASSET"
chmod 0755 "$BIN_PATH"

# macOS: clear the quarantine flag on the TEMP file (before it ever lands at the
# install path, so Finder never sees a quarantined binary). No re-sign needed — the
# binary is already ad-hoc-signed in CI and the embedded Mach-O signature survives
# tar/cp (D-PKG6).
case "$TARGET" in
  *apple-darwin*) xattr -d com.apple.quarantine "$BIN_PATH" 2>/dev/null || true ;;
esac

DEST_DIR="$(choose_install_dir)"
INSTALL_NAME="${OPEN_CONSENSUS_BIN_NAME:-$BIN_DEFAULT}"
DEST="$DEST_DIR/$INSTALL_NAME"
mkdir -p "$DEST_DIR"
if command -v install >/dev/null 2>&1; then
  install -m 0755 "$BIN_PATH" "$DEST"
else
  cp "$BIN_PATH" "$DEST" && chmod 0755 "$DEST"
fi
echo "Installed:       $DEST"

case ":$PATH:" in
  *":$DEST_DIR:"*) ;;
  *) echo "note: $DEST_DIR is not on your PATH; add it to run '$INSTALL_NAME' directly" ;;
esac

echo
echo "Done. Next steps:"
echo "  $INSTALL_NAME init            # detect installed agent CLIs + seed a panel"
echo "  $INSTALL_NAME mcp install     # register the MCP server with your agent host"
echo "  $INSTALL_NAME                 # launch the interactive TUI"
