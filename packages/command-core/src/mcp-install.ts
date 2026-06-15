import { randomBytes } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'

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

function normalize(entry: McpServerEntry): McpServerEntry {
  return {
    command: entry.command,
    args: [...entry.args],
    ...(entry.env && Object.keys(entry.env).length > 0 ? { env: { ...entry.env } } : {}),
  }
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
    const currentEntry = current as McpServerEntry
    if (sameEntry(currentEntry, entry)) {
      return { action: 'unchanged', serverName, path: opts.host.path }
    }
    if (!opts.force) {
      return { action: 'conflict', serverName, path: opts.host.path, existing: currentEntry }
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
