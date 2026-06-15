import type { Adapter } from '@open-consensus/adapters'
import type { Config } from '@open-consensus/config'
import type { Panel, PanelAgent } from '@open-consensus/engine'

/** Adapter id -> adapter instance (the daemon's installed adapter registry). */
export type AdapterRegistry = Map<string, Adapter>

/**
 * Resolve a configured panel into a runnable engine {@link Panel}: look up each
 * agent and bind it to its adapter instance. An agent whose adapter id is not in
 * the registry is dropped (a misconfig — the registry should carry every real
 * adapter; runtime unavailability is handled later by `detect()`/spawn-error).
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
  for (const agentId of panel.agentIds) {
    const agent = config.agents.find((a) => a.id === agentId)
    if (!agent) continue
    const adapter = registry.get(agent.adapter)
    if (!adapter) continue
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
  }
}
