import type { Adapter } from '@open-consensus/adapters'
import {
  type Config,
  type Panel,
  agentSchema,
  loadConfig,
  panelSchema,
  saveConfig,
} from '@open-consensus/config'
import type { AdapterRegistry } from '@open-consensus/daemon'
import type { ConfigContext } from './config-ops'

/**
 * First-run UX (plan D21 / Stage 8): auto-detect installed agent CLIs and seed a
 * sensible default panel so the orchestrator is never handed an empty roster.
 * The interactive confirm/override (so an nvm/Homebrew-shadowed binary isn't
 * silently mis-picked) is the caller's surface — the CLI exposes `--force` and
 * the unsandboxed acknowledgment, the TUI a prompt; this layer is stateless.
 */
export interface DetectionReport {
  id: string
  available: boolean
  version?: string
  reason?: string
  /** False for adapters with no native read-only/sandbox mode (D20). */
  sandbox: boolean
}

/** Probe every adapter in the registry, sorted by id for deterministic output. */
export async function detectAdaptersCommand(registry: AdapterRegistry): Promise<DetectionReport[]> {
  const adapters = [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))
  return Promise.all(adapters.map((adapter) => probe(adapter)))
}

async function probe(adapter: Adapter): Promise<DetectionReport> {
  const result = await adapter.detect()
  return {
    id: adapter.id,
    available: result.available,
    ...(result.version ? { version: result.version } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    sandbox: adapter.capabilities.sandbox,
  }
}

export interface InitOptions {
  /** Overwrite an existing non-empty config instead of refusing. */
  force?: boolean
  /** Include detected-but-unsandboxed adapters (e.g. opencode) in the seed (D20). */
  allowUnsandboxed?: boolean
  /** Panel id to seed (default `default`). */
  panelId?: string
}

export interface InitReport {
  detections: DetectionReport[]
  seededAgents: string[]
  seededPanel?: string
  /** Detected adapters deliberately left out of the seed, with why. */
  skipped: { id: string; reason: string }[]
  /** False when an existing config blocked the seed (re-run with force). */
  wrote: boolean
  reason?: string
}

/**
 * Seed the config from detected CLIs. Refuses to clobber an existing non-empty
 * config unless `force`. Each available, sandboxed adapter becomes an agent; an
 * unsandboxed one is included only with `allowUnsandboxed`. A default panel is
 * created over the seeded agents with a strict-majority quorum.
 */
export async function initCommand(
  ctx: ConfigContext,
  registry: AdapterRegistry,
  opts: InitOptions = {},
): Promise<InitReport> {
  const detections = await detectAdaptersCommand(registry)
  const existing = loadConfig(ctx.configFile)
  if ((existing.agents.length > 0 || existing.panels.length > 0) && !opts.force) {
    return {
      detections,
      seededAgents: [],
      skipped: [],
      wrote: false,
      reason: 'config already has agents/panels; re-run with force to overwrite',
    }
  }

  const seededAgents: string[] = []
  const skipped: { id: string; reason: string }[] = []
  const agents: Config['agents'] = []
  for (const d of detections) {
    if (!d.available) {
      skipped.push({ id: d.id, reason: d.reason ?? 'not detected' })
      continue
    }
    if (!d.sandbox && !opts.allowUnsandboxed) {
      skipped.push({
        id: d.id,
        reason: 'unsandboxed (D20) — re-run with the unsandboxed acknowledgment',
      })
      continue
    }
    agents.push(agentSchema.parse({ id: d.id, name: d.id, adapter: d.id }))
    seededAgents.push(d.id)
  }

  let panel: Panel | undefined
  if (seededAgents.length > 0) {
    const panelId = opts.panelId ?? 'default'
    panel = panelSchema.parse({
      id: panelId,
      name: 'Default panel',
      agentIds: seededAgents,
      // Strict majority: the round is valid when more than half the panel is ok,
      // tolerating a minority of down/slow agents (D13). The user can adjust it.
      quorum: Math.floor(seededAgents.length / 2) + 1,
    })
  }

  const config = configWith(agents, panel ? [panel] : [])
  saveConfig(config, ctx.configFile)
  return {
    detections,
    seededAgents,
    ...(panel ? { seededPanel: panel.id } : {}),
    skipped,
    wrote: true,
  }
}

function configWith(agents: Config['agents'], panels: Config['panels']): Config {
  return { schemaVersion: 1, agents: [...agents], panels: [...panels] }
}
