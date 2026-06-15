import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * XDG-resolved application directories (plan D2/D7/Stage 1).
 *
 * We deliberately use the XDG Base Directory layout on **macOS too**, rather
 * than `~/Library/Application Support`. It keeps config/state portable and
 * scriptable across macOS + Linux (the certified targets) and matches how the
 * agent CLIs we drive lay out their own dotfiles. This is an intentional choice,
 * documented here and in the README.
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
  return env.HOME && env.HOME.length > 0 ? env.HOME : homedir()
}

/**
 * Per the XDG spec, a directory variable is honored only if it holds an
 * **absolute** path; otherwise it is ignored and the fallback is used.
 */
function absoluteOr(value: string | undefined, fallback: string): string {
  return value?.startsWith('/') ? value : fallback
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
 * `XDG_RUNTIME_DIR` (short, user-private, tmpfs); falls back to the OS temp dir.
 * Kept short to stay under the ~104-byte `sun_path` limit (plan D2).
 */
export function runtimeDir(env?: PathEnv): string {
  const e = resolveEnv(env)
  return join(absoluteOr(e.XDG_RUNTIME_DIR, tmpdir()), APP)
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
