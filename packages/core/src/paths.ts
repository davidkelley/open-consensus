import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * XDG-resolved application directories (plan D2/D7/Stage 1).
 *
 * We deliberately use the XDG Base Directory layout on **macOS too**, rather
 * than `~/Library/Application Support`. It keeps config/state portable and
 * scriptable across macOS + Linux (the certified targets) and matches how the
 * agent CLIs we drive lay out their own dotfiles. This is an intentional choice,
 * documented here and in the README.
 *
 * Every resolved directory is **absolute**: XDG variables are honored only when
 * absolute (per the spec), and fallbacks come from `os.homedir()` / `os.tmpdir()`,
 * which Node guarantees to be absolute.
 */

const APP = 'open-consensus'

/** Environment inputs used to resolve directories. Injectable for testing. */
export interface PathEnv {
  HOME?: string | undefined
  XDG_CONFIG_HOME?: string | undefined
  XDG_STATE_HOME?: string | undefined
  XDG_DATA_HOME?: string | undefined
  XDG_CACHE_HOME?: string | undefined
  XDG_RUNTIME_DIR?: string | undefined
}

function resolveEnv(env: PathEnv | undefined): PathEnv {
  return env ?? (process.env as PathEnv)
}

function homeOf(env: PathEnv): string {
  // Honor HOME only when it is an absolute path; otherwise a relative/empty
  // HOME would silently scatter app files into the cwd, so fall back to homedir.
  return env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
}

/**
 * Per the XDG spec, a directory variable is honored only if it holds an
 * **absolute** path; otherwise it is ignored and the fallback is used.
 * `path.isAbsolute` (rather than `startsWith('/')`) keeps this correct across
 * platforms.
 */
function absoluteOr(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback
}

/** Config dir, e.g. `~/.config/open-consensus`. Holds agents + panels JSON. */
export function configDir(env?: PathEnv): string {
  const e = resolveEnv(env)
  return join(absoluteOr(e.XDG_CONFIG_HOME, join(homeOf(e), '.config')), APP)
}

/** State dir, e.g. `~/.local/state/open-consensus`. Holds SQLite + lockfile. */
export function stateDir(env?: PathEnv): string {
  const e = resolveEnv(env)
  return join(absoluteOr(e.XDG_STATE_HOME, join(homeOf(e), '.local', 'state')), APP)
}

/** Data dir, e.g. `~/.local/share/open-consensus`. Holds raw output blobs. */
export function dataDir(env?: PathEnv): string {
  const e = resolveEnv(env)
  return join(absoluteOr(e.XDG_DATA_HOME, join(homeOf(e), '.local', 'share')), APP)
}

/** Cache dir, e.g. `~/.cache/open-consensus`. */
export function cacheDir(env?: PathEnv): string {
  const e = resolveEnv(env)
  return join(absoluteOr(e.XDG_CACHE_HOME, join(homeOf(e), '.cache')), APP)
}

/**
 * Runtime dir for the daemon socket + endpoint discovery file. Prefers
 * `XDG_RUNTIME_DIR` (short, user-private, tmpfs). The fallback is kept **short**
 * to stay under the ~104-byte `sun_path` limit for the daemon's unix socket
 * (plan D2): on macOS `os.tmpdir()` is a deep `/var/folders/...` path, so we use
 * the short, stable `/tmp` there instead.
 */
export function runtimeDir(env?: PathEnv, platform: NodeJS.Platform = process.platform): string {
  const e = resolveEnv(env)
  const fallback = platform === 'darwin' ? '/tmp' : tmpdir()
  return join(absoluteOr(e.XDG_RUNTIME_DIR, fallback), APP)
}

/** All resolved application directories. */
export interface AppPaths {
  config: string
  state: string
  data: string
  cache: string
  runtime: string
}

/** Resolve every application directory at once. */
export function appPaths(env?: PathEnv): AppPaths {
  return {
    config: configDir(env),
    state: stateDir(env),
    data: dataDir(env),
    cache: cacheDir(env),
    runtime: runtimeDir(env),
  }
}
