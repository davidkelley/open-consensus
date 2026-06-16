import type { Adapter } from '@open-consensus/adapters'
import type { Config } from '@open-consensus/config'
import type { Panel, PanelAgent } from '@open-consensus/engine'

/** Adapter id -> adapter instance (the daemon's installed adapter registry). */
export type AdapterRegistry = Map<string, Adapter>

/**
 * Resolve a configured panel into a runnable engine {@link Panel}: look up each
 * agent and bind it to its adapter instance. An agent whose adapter id is not in
 * the registry can't be dispatched (e.g. a hand-edited/typo'd, or a removed/
 * renamed-on-upgrade adapter id — the config schema accepts any adapter string
 * and isn't cross-checked against the runtime registry); its id is surfaced as
 * `unavailableAgentIds` so the engine records it as a terminal `unavailable`
 * invocation (reported by name, D13) rather than silently dropping it — a silent
 * drop could read a false `met` verdict while a declared panel member never ran.
 * Returns `undefined` when the panel id is unknown.
 */
export function resolvePanel(
  config: Config,
  registry: AdapterRegistry,
  panelId: string,
): Panel | undefined {
  const panel = config.panels.find((p) => p.id === panelId)
  if (!panel) return undefined

  const agents: PanelAgent[] = []
  const unavailableAgentIds: string[] = []
  for (const agentId of panel.agentIds) {
    const agent = config.agents.find((a) => a.id === agentId)
    // A dangling agent ref is rejected by the config schema's referential-
    // integrity check, but guard anyway — and report it like an unknown adapter.
    if (!agent) {
      unavailableAgentIds.push(agentId)
      continue
    }
    const adapter = registry.get(agent.adapter)
    if (!adapter) {
      unavailableAgentIds.push(agent.id)
      continue
    }
    agents.push({
      agentId: agent.id,
      adapter,
      ...(agent.model ? { model: agent.model } : {}),
      args: agent.args,
      env: agent.env,
      timeoutMs: agent.timeoutMs,
      maxRetries: agent.maxRetries,
    })
  }

  return {
    panelId: panel.id,
    quorum: panel.quorum,
    ...(panel.concurrency ? { concurrency: panel.concurrency } : {}),
    agents,
    ...(unavailableAgentIds.length > 0 ? { unavailableAgentIds } : {}),
  }
}
