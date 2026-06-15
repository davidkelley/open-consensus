import { z } from 'zod'

/** Bump when the persisted config shape changes; add a migration step (D17). */
export const CONFIG_SCHEMA_VERSION = 1

/** Lowercase kebab-case identifier used for agents and panels. */
export const idSchema = z
  .string()
  .max(64, 'id must be at most 64 characters')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be lowercase kebab-case (a-z, 0-9, hyphen)')

export const sessionModeSchema = z.enum(['stateless', 'resume'])
export type SessionMode = z.infer<typeof sessionModeSchema>

/** A configured agent: a CLI tool (adapter) plus how to invoke it (D7). */
export const agentSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1, 'name is required').max(200),
    adapter: z.string().min(1, 'adapter is required').max(64),
    model: z.string().min(1).max(200).optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    timeoutMs: z.number().int().positive().default(120_000),
    maxRetries: z.number().int().min(0).default(2),
    sessionMode: sessionModeSchema.default('stateless'),
  })
  .strict()
export type Agent = z.infer<typeof agentSchema>
export type AgentInput = z.input<typeof agentSchema>

export const roundDefaultsSchema = z
  .object({
    timeoutMs: z.number().int().positive().optional(),
    maxRetries: z.number().int().min(0).optional(),
  })
  .strict()

/** A panel: a named group of agents with a quorum (D7/D13). */
export const panelSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1, 'name is required').max(200),
    agentIds: z.array(idSchema).min(1, 'a panel needs at least one agent'),
    quorum: z.number().int().positive(),
    concurrency: z.number().int().positive().optional(),
    roundDefaults: roundDefaultsSchema.optional(),
  })
  .strict()
export type Panel = z.infer<typeof panelSchema>
export type PanelInput = z.input<typeof panelSchema>

/** The whole config file: schemaVersion + agents + panels, with cross-refs. */
export const configSchema = z
  .object({
    schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
    agents: z.array(agentSchema).default([]),
    panels: z.array(panelSchema).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const agentIds = new Set<string>()
    cfg.agents.forEach((agent, i) => {
      if (agentIds.has(agent.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['agents', i, 'id'],
          message: `duplicate agent id '${agent.id}'`,
        })
      }
      agentIds.add(agent.id)
    })

    const panelIds = new Set<string>()
    cfg.panels.forEach((panel, i) => {
      if (panelIds.has(panel.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['panels', i, 'id'],
          message: `duplicate panel id '${panel.id}'`,
        })
      }
      panelIds.add(panel.id)

      panel.agentIds.forEach((agentId, j) => {
        if (!agentIds.has(agentId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['panels', i, 'agentIds', j],
            message: `panel '${panel.id}' references unknown agent '${agentId}'`,
          })
        }
      })
      if (new Set(panel.agentIds).size !== panel.agentIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['panels', i, 'agentIds'],
          message: `panel '${panel.id}' lists a duplicate agent`,
        })
      }
      if (panel.quorum > panel.agentIds.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['panels', i, 'quorum'],
          message: `quorum (${panel.quorum}) exceeds panel size (${panel.agentIds.length})`,
        })
      }
    })
  })
export type Config = z.infer<typeof configSchema>

/** Render a ZodError as readable, path-prefixed lines for CLI/error output. */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}
