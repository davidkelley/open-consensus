import {
  addAgent,
  addPanel,
  agentSchema,
  configPath,
  listAgents,
  listPanels,
  loadConfig,
  panelSchema,
  saveConfig,
} from '@open-consensus/config'
import type { PathEnv } from '@open-consensus/core'
import { Command } from 'commander'

/**
 * Stage-2 *minimal* config CLI (plan Stage 2): `agent add|list`,
 * `panel create|list`, thin over the config store so Stages 5–7 can be exercised
 * without hand-editing JSON. The full command-core/TUI surface arrives in
 * Stages 8–9. Logic lives here (coverage-gated); `cli.ts` is a thin entrypoint.
 */
export interface CliDeps {
  /** Path to the config file to read/write. */
  configFile: string
  /** Sink for normal output (injected so tests can capture it). */
  out: (line: string) => void
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command()
  program
    .name('open-consensus')
    .description('Open Consensus — manage agents and panels (minimal config CLI)')
    .exitOverride()

  const agent = program.command('agent').description('manage agents')

  agent
    .command('add <id>')
    .description('add an agent backed by an adapter CLI')
    .requiredOption('--adapter <adapter>', 'adapter id (e.g. claude, codex, gemini, opencode)')
    .option('--name <name>', 'human-readable name (defaults to the id)')
    .option('--model <model>', 'model override passed to the adapter')
    .action((id: string, opts: { adapter: string; name?: string; model?: string }) => {
      const config = loadConfig(deps.configFile)
      const agentRecord = agentSchema.parse({
        id,
        name: opts.name ?? id,
        adapter: opts.adapter,
        ...(opts.model ? { model: opts.model } : {}),
      })
      saveConfig(addAgent(config, agentRecord), deps.configFile)
      deps.out(`added agent '${id}' (adapter: ${opts.adapter})`)
    })

  agent
    .command('list')
    .description('list configured agents')
    .action(() => {
      const agents = listAgents(loadConfig(deps.configFile))
      if (agents.length === 0) {
        deps.out('no agents configured')
        return
      }
      for (const a of agents) {
        deps.out(`${a.id}  (${a.adapter}${a.model ? ` / ${a.model}` : ''})`)
      }
    })

  const panel = program.command('panel').description('manage panels')

  panel
    .command('create <id>')
    .description('create a panel from existing agents')
    .requiredOption('--agents <ids>', 'comma-separated agent ids')
    .option('--name <name>', 'human-readable name (defaults to the id)')
    .option('--quorum <n>', 'minimum OK responses (defaults to panel size)')
    .action((id: string, opts: { agents: string; name?: string; quorum?: string }) => {
      const config = loadConfig(deps.configFile)
      const agentIds = opts.agents
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      const quorum = opts.quorum === undefined ? agentIds.length : Number(opts.quorum)
      const panelRecord = panelSchema.parse({ id, name: opts.name ?? id, agentIds, quorum })
      saveConfig(addPanel(config, panelRecord), deps.configFile)
      deps.out(`created panel '${id}' (${agentIds.length} agents, quorum ${quorum})`)
    })

  panel
    .command('list')
    .description('list configured panels')
    .action(() => {
      const panels = listPanels(loadConfig(deps.configFile))
      if (panels.length === 0) {
        deps.out('no panels configured')
        return
      }
      for (const p of panels) {
        deps.out(`${p.id}  [${p.agentIds.join(', ')}]  quorum ${p.quorum}`)
      }
    })

  return program
}

/** Resolve the config file, honoring an explicit override for tests/automation. */
export function resolveConfigFile(
  env: PathEnv & { OPEN_CONSENSUS_CONFIG?: string } = process.env,
): string {
  return env.OPEN_CONSENSUS_CONFIG ?? configPath(env)
}

/** Parse argv and run. Throws on usage/validation errors (caller decides exit). */
export async function run(
  argv: readonly string[],
  deps: CliDeps = { configFile: resolveConfigFile(), out: (line) => console.log(line) },
): Promise<void> {
  await buildProgram(deps).parseAsync(argv as string[])
}
