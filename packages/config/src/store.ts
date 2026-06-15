import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type PathEnv, configDir } from '@open-consensus/core'
import { migrate } from './migrations'
import {
  type Agent,
  CONFIG_SCHEMA_VERSION,
  type Config,
  type Panel,
  configSchema,
  formatZodError,
} from './schema'

/** Config file failed to parse as JSON (truncated/corrupt) — never overwrite it. */
export class ConfigCorruptError extends Error {
  override name = 'ConfigCorruptError'
}

/** Config content is structurally invalid (failed schema validation). */
export class ConfigInvalidError extends Error {
  override name = 'ConfigInvalidError'
}

/** A CRUD operation would break referential integrity. */
export class ConfigIntegrityError extends Error {
  override name = 'ConfigIntegrityError'
}

export const CONFIG_FILENAME = 'config.json'

export function configPath(env?: PathEnv): string {
  return join(configDir(env), CONFIG_FILENAME)
}

/** An empty, valid config at the current schema version. */
export function defaultConfig(): Config {
  return configSchema.parse({ schemaVersion: CONFIG_SCHEMA_VERSION })
}

/** Parse + migrate + validate, surfacing actionable errors. Throws on invalid. */
export function parseConfig(json: unknown, source = 'config'): Config {
  const migrated = migrate(json)
  const result = configSchema.safeParse(migrated)
  if (!result.success) {
    throw new ConfigInvalidError(`${source} is invalid:\n${formatZodError(result.error)}`)
  }
  return result.data
}

/**
 * Load the config from disk. A missing file yields an empty default config; a
 * corrupt (non-JSON) file is reported and **never silently overwritten**; an
 * invalid one yields an actionable validation error.
 */
export function loadConfig(path = configPath()): Config {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig()
    throw err
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new ConfigCorruptError(`config at ${path} is not valid JSON: ${(err as Error).message}`)
  }
  return parseConfig(json, `config at ${path}`)
}

/**
 * Persist the config atomically (temp file in the same dir + rename) with `0600`
 * perms (it can hold env secrets). Re-validates first, so an integrity violation
 * never reaches disk; on a write failure the temp file is removed (no orphans).
 *
 * Contract: callers must **load-then-save** (`loadConfig` refuses a corrupt
 * file), so a corrupt target is never overwritten by a normal mutation flow.
 * Writes are not yet inter-process locked — concurrent CLI invocations are
 * last-writer-wins; the single-instance daemon (D14) will own serialized writes
 * in a later stage.
 */
export function saveConfig(config: Config, path = configPath()): void {
  const validated = configSchema.parse(config)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Re-validate a mutated config, rethrowing schema failures as integrity errors. */
function revalidate(config: Config): Config {
  const result = configSchema.safeParse(config)
  if (!result.success) {
    throw new ConfigIntegrityError(formatZodError(result.error))
  }
  return result.data
}

// ---------------------------------------------------------------------------
// Pure CRUD over a Config (immutable: each returns a new, validated Config).
// ---------------------------------------------------------------------------

export function listAgents(config: Config): readonly Agent[] {
  return config.agents
}

export function getAgent(config: Config, id: string): Agent | undefined {
  return config.agents.find((a) => a.id === id)
}

export function addAgent(config: Config, agent: Agent): Config {
  if (getAgent(config, agent.id)) {
    throw new ConfigIntegrityError(`agent '${agent.id}' already exists`)
  }
  return revalidate({ ...config, agents: [...config.agents, agent] })
}

export function updateAgent(config: Config, id: string, patch: Partial<Omit<Agent, 'id'>>): Config {
  if (!getAgent(config, id)) {
    throw new ConfigIntegrityError(`agent '${id}' not found`)
  }
  return revalidate({
    ...config,
    agents: config.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
  })
}

export function removeAgent(config: Config, id: string, opts: { force?: boolean } = {}): Config {
  if (!getAgent(config, id)) {
    throw new ConfigIntegrityError(`agent '${id}' not found`)
  }
  const usedBy = config.panels.filter((p) => p.agentIds.includes(id))
  if (usedBy.length > 0 && !opts.force) {
    throw new ConfigIntegrityError(
      `agent '${id}' is used by panel(s): ${usedBy.map((p) => p.id).join(', ')}; pass force to also remove it from them`,
    )
  }
  const panels = config.panels.map((p) => {
    const agentIds = p.agentIds.filter((a) => a !== id)
    // Clamp quorum so force-removing from a quorum===size panel actually works
    // instead of being blocked by the quorum>size integrity check.
    return { ...p, agentIds, quorum: Math.min(p.quorum, agentIds.length) }
  })
  const emptied = panels.filter((p) => p.agentIds.length === 0)
  if (emptied.length > 0) {
    throw new ConfigIntegrityError(
      `removing '${id}' would leave panel(s) empty: ${emptied.map((p) => p.id).join(', ')}; remove the panel first`,
    )
  }
  return revalidate({ ...config, agents: config.agents.filter((a) => a.id !== id), panels })
}

export function listPanels(config: Config): readonly Panel[] {
  return config.panels
}

export function getPanel(config: Config, id: string): Panel | undefined {
  return config.panels.find((p) => p.id === id)
}

export function addPanel(config: Config, panel: Panel): Config {
  if (getPanel(config, panel.id)) {
    throw new ConfigIntegrityError(`panel '${panel.id}' already exists`)
  }
  return revalidate({ ...config, panels: [...config.panels, panel] })
}

export function updatePanel(config: Config, id: string, patch: Partial<Omit<Panel, 'id'>>): Config {
  if (!getPanel(config, id)) {
    throw new ConfigIntegrityError(`panel '${id}' not found`)
  }
  return revalidate({
    ...config,
    panels: config.panels.map((p) => (p.id === id ? { ...p, ...patch } : p)),
  })
}

export function removePanel(config: Config, id: string): Config {
  if (!getPanel(config, id)) {
    throw new ConfigIntegrityError(`panel '${id}' not found`)
  }
  return revalidate({ ...config, panels: config.panels.filter((p) => p.id !== id) })
}
