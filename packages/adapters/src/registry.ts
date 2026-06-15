import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import { createGeminiAdapter } from './gemini'
import { createMockAdapter } from './mock'
import { createOpencodeAdapter } from './opencode'
import type { AdapterOptions } from './shared'
import type { Adapter, AdapterCapabilities } from './types'

/** The real agent CLIs (excludes the test-only `mock`). */
export const REAL_ADAPTER_IDS = ['claude', 'codex', 'gemini', 'opencode'] as const
export type RealAdapterId = (typeof REAL_ADAPTER_IDS)[number]

/** Build a single adapter by id (binPath overridable for tests). */
export function createAdapter(id: string, options?: AdapterOptions): Adapter | undefined {
  switch (id) {
    case 'claude':
      return createClaudeAdapter(options)
    case 'codex':
      return createCodexAdapter(options)
    case 'gemini':
      return createGeminiAdapter(options)
    case 'opencode':
      return createOpencodeAdapter(options)
    case 'mock':
      return createMockAdapter()
    default:
      return undefined
  }
}

/**
 * Build the daemon's adapter registry: every built-in real adapter plus the
 * deterministic `mock` (so a mock-backed config still resolves). Unknown ids in a
 * user config are simply not present (the resolver drops them).
 */
export function defaultRegistry(): Map<string, Adapter> {
  const registry = new Map<string, Adapter>()
  for (const id of [...REAL_ADAPTER_IDS, 'mock']) {
    const adapter = createAdapter(id)
    if (adapter) registry.set(id, adapter)
  }
  return registry
}

export type CapabilityRow = AdapterCapabilities & { id: string }

/** The capability matrix (docs / `agent test`): which tool supports which modes. */
export function capabilityMatrix(): CapabilityRow[] {
  return REAL_ADAPTER_IDS.map((id) => createAdapter(id))
    .filter((a): a is Adapter => a !== undefined)
    .map((a) => ({ id: a.id, ...a.capabilities }))
}
