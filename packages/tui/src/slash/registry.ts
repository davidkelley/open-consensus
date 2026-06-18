import {
  type ConfigContext,
  addAgentCommand,
  createPanelCommand,
  daemonStatusCommand,
  listAgentsCommand,
  listPanelsCommand,
  listRunsCommand,
  removeAgentCommand,
  removePanelCommand,
  setQuorumCommand,
  startRunCommand,
  testAgentCommand,
} from '@open-consensus/command-core'
import type { AdapterRegistry } from '@open-consensus/daemon'
import { theme } from '../theme'
import { type Segment, seg } from '../ui/segments'

/**
 * The TUI slash-command surface (plan D19). Handlers are **thin calls into the
 * stateless `command-core`** — the exact same library the CLI uses, so there's no
 * core-logic duplication; only the presentation (printing lines, starting a live
 * run view) is TUI-specific. The context is injected so the registry unit-tests
 * against fakes without rendering ink.
 */
export interface SlashContext {
  configCtx: ConfigContext
  registry: AdapterRegistry
  discoveryPath: string
  /** Append a line to the transcript (a plain string, or styled segments). */
  print: (line: string | Segment[]) => void
  /** Ensure the daemon is running (auto-start); throws if it can't be reached. */
  ensureDaemon: () => Promise<void>
  /** Begin streaming a run's live timeline into the in-progress region. */
  viewRun: (runId: string) => void
  /** True while a run is already streaming in the live region (single-view UI). */
  hasActiveRun: () => boolean
  /** Request the app to exit. */
  quit: () => void
}

export interface SlashCommand {
  name: string
  summary: string
  usage: string
  run(ctx: SlashContext, args: string[], rest: string): Promise<void>
}

function requireArg(args: string[], i: number, label: string): string {
  const value = args[i]
  if (value === undefined) throw new Error(`missing ${label}`)
  return value
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    summary: 'list available commands',
    usage: '/help',
    async run(ctx) {
      // Pad to the widest usage so summaries align — derived, not a magic constant
      // that silently truncates the longest row.
      const width = Math.max(...SLASH_COMMANDS.map((c) => c.usage.length)) + 2
      for (const c of SLASH_COMMANDS) {
        ctx.print([
          seg(c.usage.padEnd(width), { color: theme.brand }),
          seg(c.summary, { dim: true }),
        ])
      }
    },
  },
  {
    name: 'agents',
    summary: 'list configured agents',
    usage: '/agents',
    async run(ctx) {
      const agents = listAgentsCommand(ctx.configCtx)
      if (agents.length === 0) return ctx.print([seg('no agents configured', { dim: true })])
      for (const a of agents) {
        ctx.print([
          seg(a.id, { bold: true }),
          seg(`  (${a.adapter}${a.model ? ` / ${a.model}` : ''})`, { dim: true }),
        ])
      }
    },
  },
  {
    name: 'agent',
    summary: 'add <id> --adapter <a> | remove <id> | test <id>',
    usage: '/agent <add|remove|test> …',
    async run(ctx, args) {
      const sub = requireArg(args, 0, 'subcommand (add|remove|test)')
      const id = requireArg(args, 1, 'agent id')
      if (sub === 'add') {
        const adapter = flag(args, '--adapter') ?? requireArg(args, 2, 'adapter')
        if (adapter.startsWith('-'))
          throw new Error('missing adapter value (e.g. --adapter claude)')
        const allow = args.includes('--allow-unsandboxed')
        const result = await addAgentCommand(
          ctx.configCtx,
          { id, adapter, ...(allow ? { allowUnsandboxed: true } : {}) },
          ctx.registry,
        )
        ctx.print([
          seg('added agent '),
          seg(`'${result.agent.id}'`, { color: theme.success, bold: true }),
          seg(` (${result.agent.adapter})`, { dim: true }),
        ])
        for (const w of result.warnings) ctx.print([seg(`  warning: ${w}`, { color: theme.warn })])
      } else if (sub === 'remove') {
        removeAgentCommand(ctx.configCtx, id, args.includes('--force'))
        ctx.print([seg('removed agent '), seg(`'${id}'`, { bold: true })])
      } else if (sub === 'test') {
        const r = await testAgentCommand(ctx.configCtx, id, ctx.registry)
        const avail = r.detected.available
          ? `available (${r.detected.version ?? '?'})`
          : `unavailable (${r.detected.reason ?? '?'})`
        ctx.print([
          seg(`${r.adapter}: `, { bold: true }),
          seg(avail, { color: r.detected.available ? theme.success : theme.danger }),
        ])
        ctx.print([
          seg('would run: ', { dim: true }),
          seg(`${r.invocation.file} ${r.invocation.args.join(' ')}`),
        ])
        const envKeys = r.invocation.envKeys.join(', ') || '(none)'
        ctx.print([
          seg(`prompt delivery: ${r.invocation.promptDelivery}  env: ${envKeys}`, { dim: true }),
        ])
      } else {
        throw new Error(`unknown agent subcommand '${sub}'`)
      }
    },
  },
  {
    name: 'panels',
    summary: 'list configured panels',
    usage: '/panels',
    async run(ctx) {
      const panels = listPanelsCommand(ctx.configCtx)
      if (panels.length === 0) return ctx.print([seg('no panels configured', { dim: true })])
      for (const p of panels) {
        ctx.print([
          seg(p.id, { bold: true }),
          seg(`  [${p.agentIds.join(', ')}]  quorum ${p.quorum}`, { dim: true }),
        ])
      }
    },
  },
  {
    name: 'panel',
    summary: 'create <id> <a,b,..> | set-quorum <id> <n> | remove <id>',
    usage: '/panel <create|set-quorum|remove> …',
    async run(ctx, args) {
      const sub = requireArg(args, 0, 'subcommand (create|set-quorum|remove)')
      const id = requireArg(args, 1, 'panel id')
      if (sub === 'create') {
        const agentIds = requireArg(args, 2, 'agent ids (comma-separated)')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const created = createPanelCommand(ctx.configCtx, { id, agentIds })
        ctx.print([
          seg('created panel '),
          seg(`'${created.id}'`, { color: theme.success, bold: true }),
          seg(` (${created.agentIds.length} agents, quorum ${created.quorum})`, { dim: true }),
        ])
      } else if (sub === 'set-quorum') {
        const n = Number(requireArg(args, 2, 'quorum'))
        const updated = setQuorumCommand(ctx.configCtx, id, n)
        ctx.print([
          seg('panel '),
          seg(`'${id}'`, { bold: true }),
          seg(` quorum set to ${updated.quorum}`, { dim: true }),
        ])
      } else if (sub === 'remove') {
        removePanelCommand(ctx.configCtx, id)
        ctx.print([seg('removed panel '), seg(`'${id}'`, { bold: true })])
      } else {
        throw new Error(`unknown panel subcommand '${sub}'`)
      }
    },
  },
  {
    name: 'runs',
    summary: 'list runs the daemon knows about',
    usage: '/runs',
    async run(ctx) {
      await ctx.ensureDaemon()
      const runs = await listRunsCommand(ctx.discoveryPath)
      if (runs.length === 0) return ctx.print([seg('no runs', { dim: true })])
      for (const r of runs) {
        ctx.print([
          seg(r.runId, { color: theme.accent }),
          seg(`  ${r.state}`, { bold: true }),
          seg(`  panel=${r.panelId}`, { dim: true }),
        ])
      }
    },
  },
  {
    name: 'run',
    summary: 'start a consensus run and watch it live',
    usage: '/run <panel> <prompt…>',
    async run(ctx, args, rest) {
      if (ctx.hasActiveRun()) {
        throw new Error('a run is already streaming — press Ctrl+C to cancel it first')
      }
      const panel = requireArg(args, 0, 'panel id')
      const prompt = rest.slice(rest.indexOf(panel) + panel.length).trim()
      if (prompt.length === 0) throw new Error('missing prompt')
      await ctx.ensureDaemon()
      const result = await startRunCommand(ctx.discoveryPath, { panel, prompt })
      ctx.print([
        seg('started run '),
        seg(result.runId, { color: theme.accent, bold: true }),
        seg(` on panel '${panel}'`, { dim: true }),
      ])
      ctx.viewRun(result.runId)
    },
  },
  {
    name: 'daemon',
    summary: 'show daemon status',
    usage: '/daemon status',
    async run(ctx, args) {
      const sub = args[0] ?? 'status'
      if (sub !== 'status') throw new Error(`unknown daemon subcommand '${sub}' (only: status)`)
      const status = await daemonStatusCommand(ctx.discoveryPath)
      if (!status.running) return ctx.print([seg('daemon is not running', { color: theme.danger })])
      ctx.print([
        seg('daemon '),
        seg(status.healthy ? 'running (healthy)' : 'present but not answering', {
          color: status.healthy ? theme.success : theme.warn,
        }),
        seg(` on ${status.endpoint}`, { dim: true }),
      ])
    },
  },
  {
    name: 'quit',
    summary: 'exit the TUI',
    usage: '/quit',
    async run(ctx) {
      ctx.quit()
    },
  },
]

/** Read a `--flag value` pair out of an argv array (returns undefined if absent). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const BY_NAME = new Map(SLASH_COMMANDS.map((c) => [c.name, c]))

export function findCommand(name: string): SlashCommand | undefined {
  return BY_NAME.get(name)
}
