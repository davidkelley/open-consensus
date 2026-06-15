import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * Register the Open Consensus MCP server in a host's config (plan D21 / Stage 8)
 * — Claude Code / Codex use a JSON `mcpServers` map. The operation is **safe**:
 * it parses the target first, **detects an existing/conflicting entry** (idempotent
 * — a matching entry is a no-op), writes **atomically** (temp + rename), and
 * **refuses to touch a malformed host config** so a hand-edit is never corrupted.
 */
export interface McpHostConfig {
  /** Path to the host's JSON config file (e.g. `~/.claude.json`). */
  path: string
  /** Key under `mcpServers` (default `open-consensus`). */
  serverName?: string
}

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

/** The default registered entry: the published `open-consensus-mcp` stdio bin. */
export const DEFAULT_MCP_ENTRY: McpServerEntry = { command: 'open-consensus-mcp', args: [] }

const DEFAULT_SERVER_NAME = 'open-consensus'

export type InstallAction = 'installed' | 'unchanged' | 'updated' | 'conflict'

export interface InstallResult {
  action: InstallAction
  serverName: string
  path: string
  /** The pre-existing entry when a conflict was detected (no write happened). */
  existing?: McpServerEntry
}

export interface InstallOptions {
  host: McpHostConfig
  entry?: McpServerEntry
  /** Overwrite a conflicting existing entry instead of reporting `conflict`. */
  force?: boolean
}

interface HostFile {
  data: Record<string, unknown>
  /** The file's existing mode, preserved on rewrite; undefined if it was absent. */
  mode?: number
}

/** Read + parse the host config; refuse (throw) on a malformed-but-present file. */
function readHost(path: string): HostFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: {} }
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`refusing to modify malformed host config at ${path} (not valid JSON)`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`refusing to modify host config at ${path} (top-level is not a JSON object)`)
  }
  return { data: parsed as Record<string, unknown>, mode: statSync(path).mode & 0o777 }
}

/** Read the `mcpServers` map, validating it is a plain object if present. */
function readServers(host: HostFile, path: string): Record<string, unknown> {
  const existing = host.data.mcpServers
  if (existing === undefined) return {}
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new Error(`refusing to modify host config at ${path} ('mcpServers' is not an object)`)
  }
  return { ...(existing as Record<string, unknown>) }
}

/** Atomically persist the host config, preserving its prior mode (else `0600`). */
function writeHost(path: string, host: HostFile): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  const mode = host.mode ?? 0o600
  try {
    writeFileSync(tmp, `${JSON.stringify(host.data, null, 2)}\n`, { mode })
    chmodSync(tmp, mode) // writeFileSync mode is umask-masked on some platforms
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Shape of a `mcpServers` entry we will read/compare (lenient on extra fields). */
const entrySchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
})

/**
 * Coerce an existing (untrusted, possibly hand-edited) entry into a normalized
 * {@link McpServerEntry}, or `undefined` if it is malformed (null, an array, a
 * string, missing `command`, …). Guards against crashing on a bad host config.
 */
function coerceEntry(value: unknown): McpServerEntry | undefined {
  const parsed = entrySchema.safeParse(value)
  return parsed.success ? normalize(parsed.data) : undefined
}

/**
 * Canonicalize an entry for comparison. `args` are a positional command line —
 * their ORDER IS SIGNIFICANT, so they are copied as-is (sorting them would change
 * the command's meaning). `env` is a map, so its keys are sorted to make
 * idempotency insensitive to hand-edited key order.
 */
function normalize(entry: McpServerEntry): McpServerEntry {
  const out: McpServerEntry = { command: entry.command, args: [...entry.args] }
  const env = entry.env
  if (env && Object.keys(env).length > 0) {
    const sorted: Record<string, string> = {}
    for (const k of Object.keys(env).sort()) {
      const v = env[k]
      if (v !== undefined) sorted[k] = v
    }
    out.env = sorted
  }
  return out
}

function sameEntry(a: McpServerEntry, b: McpServerEntry): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}

/**
 * Install (register) the MCP server. Idempotent: a byte-identical existing entry
 * is `unchanged`; a different existing entry is a `conflict` (no write) unless
 * `force`, which makes it `updated`.
 */
export function mcpInstallCommand(opts: InstallOptions): InstallResult {
  const serverName = opts.host.serverName ?? DEFAULT_SERVER_NAME
  const entry = normalize(opts.entry ?? DEFAULT_MCP_ENTRY)
  const host = readHost(opts.host.path)
  const servers = readServers(host, opts.host.path)

  const current = servers[serverName]
  if (current !== undefined) {
    // A malformed existing value (null/array/string) coerces to undefined — a
    // conflict (refuse without force), never a crash.
    const currentEntry = coerceEntry(current)
    if (currentEntry && sameEntry(currentEntry, entry)) {
      return { action: 'unchanged', serverName, path: opts.host.path }
    }
    if (!opts.force) {
      return {
        action: 'conflict',
        serverName,
        path: opts.host.path,
        ...(currentEntry ? { existing: currentEntry } : {}),
      }
    }
  }

  servers[serverName] = entry
  host.data.mcpServers = servers
  writeHost(opts.host.path, host)
  return {
    action: current === undefined ? 'installed' : 'updated',
    serverName,
    path: opts.host.path,
  }
}

export type UninstallAction = 'removed' | 'absent'

export interface UninstallResult {
  action: UninstallAction
  serverName: string
  path: string
}

/** Remove the MCP server entry. A missing entry/file reports `absent` (no write). */
export function mcpUninstallCommand(host: McpHostConfig): UninstallResult {
  const serverName = host.serverName ?? DEFAULT_SERVER_NAME
  let hostFile: HostFile
  try {
    hostFile = readHost(host.path)
  } catch (err) {
    // A missing file is absent; a malformed file still must not be corrupted.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { action: 'absent', serverName, path: host.path }
    }
    throw err
  }
  const servers = readServers(hostFile, host.path)
  if (servers[serverName] === undefined) {
    return { action: 'absent', serverName, path: host.path }
  }
  delete servers[serverName]
  hostFile.data.mcpServers = servers
  writeHost(host.path, hostFile)
  return { action: 'removed', serverName, path: host.path }
}
