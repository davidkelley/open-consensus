import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Adapter, DetectResult } from '@open-consensus/adapters'
import {
  type Agent,
  type Config,
  type Panel,
  addAgent,
  addPanel,
  agentSchema,
  getAgent,
  getPanel,
  listAgents,
  listPanels,
  loadConfig,
  panelSchema,
  removeAgent,
  removePanel,
  saveConfig,
  updateAgent,
  updatePanel,
} from '@open-consensus/config'
import { redactString } from '@open-consensus/core'
import type { AdapterRegistry } from '@open-consensus/daemon'
import { runProcess } from '@open-consensus/proc'

/** Byte cap per stream for `agent test --live` (a diagnostic, not a real round). */
const TEST_OUTPUT_CAP = 256 * 1024

/**
 * Stateless config command-core (plan D19 / Stage 8). Every function loads the
 * config from a path, applies one change, and saves it — there is **no retained
 * state** between calls and **no SSE/stream lifecycle**, so the one-shot CLI
 * never hangs at exit. The Stage-9 TUI slash-commands reuse these verbatim.
 *
 * Functions return structured data (not formatted strings) so the CLI and TUI
 * can each render in their own style; warnings (e.g. an undetected binary) are
 * returned, never thrown — adding an agent for a not-yet-installed CLI is valid.
 */
export interface ConfigContext {
  /** Path to the config file to read/write. */
  configFile: string
}

/** A non-secret sample prompt used by `agent test`'s dry-run invocation. */
const SAMPLE_PROMPT = 'Respond with OK to confirm you are reachable.'

function read(ctx: ConfigContext): Config {
  return loadConfig(ctx.configFile)
}

// ── agents ──────────────────────────────────────────────────────────────────

export interface AddAgentInput {
  id: string
  adapter: string
  name?: string
  model?: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
  maxRetries?: number
  /** Required acknowledgment to add an agent backed by an unsandboxed adapter. */
  allowUnsandboxed?: boolean
}

export interface AddAgentResult {
  agent: Agent
  warnings: string[]
  detected?: DetectResult
}

/**
 * Add an agent. Validates the record through the zod schema, runs the adapter's
 * `detect()` to *warn* (not error) on a missing binary, and **refuses** an
 * unsandboxed adapter (e.g. opencode) unless `allowUnsandboxed` acknowledges the
 * elevated risk (D20). Async because `detect()` probes the binary's `--version`.
 */
export async function addAgentCommand(
  ctx: ConfigContext,
  input: AddAgentInput,
  registry: AdapterRegistry,
): Promise<AddAgentResult> {
  const agent = agentSchema.parse({
    id: input.id,
    name: input.name ?? input.id,
    adapter: input.adapter,
    ...(input.model ? { model: input.model } : {}),
    ...(input.args ? { args: input.args } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
  })

  const warnings: string[] = []
  const adapter = registry.get(agent.adapter)
  if (!adapter) {
    warnings.push(
      `adapter '${agent.adapter}' is not a known adapter — this agent will be 'unavailable' at run time`,
    )
  } else if (adapter.capabilities.sandbox === false && !input.allowUnsandboxed) {
    throw new Error(
      `adapter '${agent.adapter}' has no native read-only/sandbox mode — it can read, write, or exfiltrate anything your account can reach. Re-run with the unsandboxed acknowledgment to add it anyway (D20).`,
    )
  }

  let detected: DetectResult | undefined
  if (adapter) {
    detected = await adapter.detect()
    if (!detected.available) {
      warnings.push(
        `adapter '${agent.adapter}' binary not detected: ${detected.reason ?? 'unknown'}`,
      )
    }
  }

  saveConfig(addAgent(read(ctx), agent), ctx.configFile)
  return { agent, warnings, ...(detected ? { detected } : {}) }
}

export function listAgentsCommand(ctx: ConfigContext): readonly Agent[] {
  return listAgents(read(ctx))
}

export interface UpdateAgentInput {
  name?: string
  model?: string | null
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
  maxRetries?: number
}

/**
 * Patch an existing agent's mutable fields. `model: null` clears the override;
 * `undefined` fields are left untouched. Throws if the agent does not exist.
 */
export function updateAgentCommand(ctx: ConfigContext, id: string, patch: UpdateAgentInput): Agent {
  const config = read(ctx)
  if (!getAgent(config, id)) throw new Error(`unknown agent '${id}'`)
  const next: Parameters<typeof updateAgent>[2] = {}
  if (patch.name !== undefined) next.name = patch.name
  if (patch.model !== undefined) next.model = patch.model ?? undefined
  if (patch.args !== undefined) next.args = patch.args
  if (patch.env !== undefined) next.env = patch.env
  if (patch.timeoutMs !== undefined) next.timeoutMs = patch.timeoutMs
  if (patch.maxRetries !== undefined) next.maxRetries = patch.maxRetries
  const updated = updateAgent(config, id, next)
  saveConfig(updated, ctx.configFile)
  const result = getAgent(updated, id)
  if (!result) throw new Error(`unknown agent '${id}'`) // unreachable: updateAgent validated it
  return result
}

/**
 * Remove an agent. Refuses (via the store's referential-integrity check) to drop
 * an agent a panel still uses unless `force`, which also prunes it from panels.
 */
export function removeAgentCommand(ctx: ConfigContext, id: string, force = false): void {
  saveConfig(removeAgent(read(ctx), id, { force }), ctx.configFile)
}

export interface AgentTestResult {
  agentId: string
  adapter: string
  /** Availability probe; `unknown-adapter` when the id isn't in the registry. */
  detected: DetectResult
  /** The invocation the adapter would run — prompt elided, env shown by key. */
  invocation: { file: string; args: string[]; promptDelivery: 'stdin' | 'arg'; envKeys: string[] }
  /** Present only with `live: true`: the parsed result of an actual spawn. */
  live?: { status: string; text: string; errorClass?: string; durationMs: number; outcome: string }
}

/**
 * `agent test` (plan Stage 8): run the adapter's `detect()` and **print the
 * invocation it would use without executing the real CLI**. The prompt is elided
 * from the shown args (it can appear in argv for arg-delivery adapters) and the
 * env is shown by key only. With `live`, it additionally spawns the real CLI in
 * an ephemeral scratch dir and returns the parsed result — an explicit opt-in
 * that can cost money (never exercised by the default, no-spend test suite).
 */
export async function testAgentCommand(
  ctx: ConfigContext,
  id: string,
  registry: AdapterRegistry,
  opts: { live?: boolean } = {},
): Promise<AgentTestResult> {
  const agent = getAgent(read(ctx), id)
  if (!agent) throw new Error(`unknown agent '${id}'`)
  const adapter = registry.get(agent.adapter)
  if (!adapter) {
    return {
      agentId: id,
      adapter: agent.adapter,
      detected: { available: false, reason: `unknown adapter '${agent.adapter}'` },
      invocation: { file: agent.adapter, args: [], promptDelivery: 'arg', envKeys: [] },
    }
  }

  const detected = await adapter.detect()
  const invocation = buildPreviewInvocation(adapter, agent)
  const result: AgentTestResult = { agentId: id, adapter: agent.adapter, detected, invocation }

  if (opts.live) result.live = await runLive(adapter, agent)
  return result
}

function buildPreviewInvocation(adapter: Adapter, agent: Agent): AgentTestResult['invocation'] {
  const env = { ...agent.env }
  const spec = adapter.buildInvocation({
    prompt: SAMPLE_PROMPT,
    ...(agent.model ? { model: agent.model } : {}),
    args: [...agent.args],
    env,
    cwd: '<scratch>',
  })
  const promptDelivery = spec.stdin !== undefined ? 'stdin' : 'arg'
  // Elide the (non-secret, but illustrative) prompt from argv so the preview
  // demonstrates how the prompt is delivered without echoing it inline.
  const args = spec.args.map((a) => (a === SAMPLE_PROMPT ? '<prompt>' : a))
  return { file: spec.file, args, promptDelivery, envKeys: Object.keys(spec.env) }
}

async function runLive(adapter: Adapter, agent: Agent): Promise<AgentTestResult['live']> {
  const scratch = mkdtempSync(join(tmpdir(), 'open-consensus-test-'))
  try {
    const env: Record<string, string> = {}
    if (process.env.PATH) env.PATH = process.env.PATH
    Object.assign(env, agent.env)
    const spec = adapter.buildInvocation({
      prompt: SAMPLE_PROMPT,
      ...(agent.model ? { model: agent.model } : {}),
      args: [...agent.args],
      env,
      cwd: scratch,
    })
    const run = await runProcess(
      {
        file: spec.file,
        args: spec.args,
        env: spec.env,
        cwd: scratch,
        ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
      },
      { timeoutMs: agent.timeoutMs, maxOutputBytes: TEST_OUTPUT_CAP },
    )
    const parsed = adapter.parse(run, {
      prompt: SAMPLE_PROMPT,
      ...(agent.model ? { model: agent.model } : {}),
      args: [...agent.args],
      env,
      cwd: scratch,
    })
    return {
      status: parsed.status,
      text: redactString(parsed.text),
      ...(parsed.errorClass ? { errorClass: parsed.errorClass } : {}),
      durationMs: run.durationMs,
      outcome: run.outcome,
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ── panels ──────────────────────────────────────────────────────────────────

export interface CreatePanelInput {
  id: string
  agentIds: string[]
  name?: string
  quorum?: number
  concurrency?: number
}

/** Create a panel. Quorum defaults to the panel size (everyone must be ok). */
export function createPanelCommand(ctx: ConfigContext, input: CreatePanelInput): Panel {
  const panel = panelSchema.parse({
    id: input.id,
    name: input.name ?? input.id,
    agentIds: input.agentIds,
    quorum: input.quorum ?? input.agentIds.length,
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
  })
  saveConfig(addPanel(read(ctx), panel), ctx.configFile)
  return panel
}

export function listPanelsCommand(ctx: ConfigContext): readonly Panel[] {
  return listPanels(read(ctx))
}

/** Add an agent to a panel (no-op if already a member). Re-validates the panel. */
export function panelAddAgentCommand(ctx: ConfigContext, panelId: string, agentId: string): Panel {
  const config = read(ctx)
  const panel = getPanel(config, panelId)
  if (!panel) throw new Error(`unknown panel '${panelId}'`)
  if (panel.agentIds.includes(agentId)) return panel
  const next = panelSchema.parse({ ...panel, agentIds: [...panel.agentIds, agentId] })
  saveConfig(savePanel(config, next), ctx.configFile)
  return next
}

/** Remove an agent from a panel. Keeps quorum ≤ size by clamping if needed. */
export function panelRemoveAgentCommand(
  ctx: ConfigContext,
  panelId: string,
  agentId: string,
): Panel {
  const config = read(ctx)
  const panel = getPanel(config, panelId)
  if (!panel) throw new Error(`unknown panel '${panelId}'`)
  const agentIds = panel.agentIds.filter((a) => a !== agentId)
  if (agentIds.length === 0) {
    throw new Error(`panel '${panelId}' would have no agents — remove the panel instead`)
  }
  const quorum = Math.min(panel.quorum, agentIds.length)
  const next = panelSchema.parse({ ...panel, agentIds, quorum })
  saveConfig(savePanel(config, next), ctx.configFile)
  return next
}

/** Set a panel's quorum. Rejects a quorum that exceeds the panel size. */
export function setQuorumCommand(ctx: ConfigContext, panelId: string, quorum: number): Panel {
  const config = read(ctx)
  const panel = getPanel(config, panelId)
  if (!panel) throw new Error(`unknown panel '${panelId}'`)
  const next = panelSchema.parse({ ...panel, quorum })
  saveConfig(savePanel(config, next), ctx.configFile)
  return next
}

export function removePanelCommand(ctx: ConfigContext, panelId: string): void {
  saveConfig(removePanel(read(ctx), panelId), ctx.configFile)
}

/** Replace a panel in-place via the store's update (validates referential integrity). */
function savePanel(config: Config, panel: Panel): Config {
  return updatePanel(config, panel.id, panel)
}
