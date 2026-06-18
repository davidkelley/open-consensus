import {
  type AddAgentInput,
  type ConfigContext,
  type InstallResult,
  type McpServerEntry,
  type RunStatusView,
  addAgentCommand,
  createPanelCommand,
  daemonStatusCommand,
  detectAdaptersCommand,
  ensureDaemonRunning,
  initCommand,
  listAgentsCommand,
  listPanelsCommand,
  listRunsCommand,
  mcpInstallCommand,
  mcpUninstallCommand,
  panelAddAgentCommand,
  panelRemoveAgentCommand,
  removeAgentCommand,
  removePanelCommand,
  runStatusCommand,
  setQuorumCommand,
  startRunCommand,
  stopDaemonCommand,
  testAgentCommand,
  updateAgentCommand,
} from '@open-consensus/command-core'
import { configPath } from '@open-consensus/config'
import type { PathEnv } from '@open-consensus/core'
import type { AdapterRegistry } from '@open-consensus/daemon'
import { Command } from 'commander'

/**
 * The `open-consensus` config + control CLI (plan Stage 8). Every command is a
 * thin wrapper over the stateless `command-core` library — the same library the
 * Stage-9 TUI slash-commands reuse — so there's no logic duplication and the
 * one-shot CLI never hangs at exit (no SSE/stream lifecycle here). The genuinely
 * un-testable bits (the real `startDaemon` foreground loop + the detached spawn)
 * are injected via {@link CliDeps}, so this module stays coverage-gated.
 */
export interface CliDeps {
  /** Path to the config file to read/write. */
  configFile: string
  /** Path to the daemon discovery file. */
  discoveryPath: string
  /** Adapter registry (for detect/sandbox checks); unsandboxed adapters included. */
  registry: AdapterRegistry
  /**
   * The version string surfaced by `--version`. Injected at bundle time (the
   * release version) by `cli.ts`, and stubbed in tests, so `program.ts` stays a
   * pure function of its deps.
   */
  version: string
  /** Sink for normal output (injected so tests can capture it). */
  out: (line: string) => void
  /** Sink for warnings/errors. */
  err: (line: string) => void
  /** Spawn the detached `daemon serve` process (real impl wires `spawn`). */
  launchDaemon: () => void
  /** Run the daemon in the foreground until shutdown (real impl wires `startDaemon`). */
  serveDaemon: () => Promise<void>
  /** Default host-config path for `mcp install` (e.g. `~/.claude.json`). */
  mcpHostPath: string
  /** Launch the interactive TUI (run when `open-consensus` is given no subcommand). */
  launchTui: () => Promise<void>
  /** Run the stdio MCP server (the `mcp-server` subcommand the binary self-registers). */
  runMcpServer: () => Promise<void>
  /**
   * The entry `mcp install` registers when the user passes no `--command`: the
   * packaged binary path + `mcp-server`, or the published `open-consensus-mcp` bin
   * from source (computed in `cli.ts` from `isPackaged()`).
   */
  defaultMcpEntry: McpServerEntry
  /** Readiness poll knobs (tests shrink these). */
  ensureAttempts?: number
  ensureIntervalMs?: number
}

/** Raised by an action to set a non-zero exit without a stack-trace splat. */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

const collect = (value: string, prev: string[]): string[] => [...prev, value]

function parsePositiveInt(value: string, label: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new CliError(`${label} must be a non-negative integer`)
  return n
}

/**
 * Parse repeated `--env KEY=VALUE` flags into a record. A malformed pair could
 * itself be (or contain) a secret, so the error **never echoes any part of the
 * input** — it only names which flag failed.
 */
function parseEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new CliError('--env must be KEY=VALUE with a non-empty key (e.g. FOO=bar)')
    env[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return env
}

function splitlist(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function buildProgram(deps: CliDeps): Command {
  const ctx: ConfigContext = { configFile: deps.configFile }
  const ensureOpts = {
    discoveryPath: deps.discoveryPath,
    launch: deps.launchDaemon,
    // So `daemon start` / `run start` refuse to reuse a daemon already running
    // with a different config than this invocation resolved (D21).
    expectedConfigPath: deps.configFile,
    ...(deps.ensureAttempts !== undefined ? { attempts: deps.ensureAttempts } : {}),
    ...(deps.ensureIntervalMs !== undefined ? { intervalMs: deps.ensureIntervalMs } : {}),
  }

  const program = new Command()
  program
    .name('open-consensus')
    .description('Open Consensus — manage agents, panels, the daemon, and consensus runs')
    .version(deps.version)
    // Route commander's own stdout (`--version`, `--help`) through the injected
    // `out` sink so it honors the CLI's single output discipline and is capturable
    // in tests; one trailing newline is dropped since `out` is line-oriented.
    .configureOutput({ writeOut: (s) => deps.out(s.replace(/\n$/, '')) })
    .exitOverride()
    // No subcommand -> launch the interactive slash-command TUI (D19).
    .action(async () => {
      await deps.launchTui()
    })

  buildAgentCommands(program, deps, ctx)
  buildPanelCommands(program, deps, ctx)
  buildDaemonCommands(program, deps, ensureOpts)
  buildRunCommands(program, deps, ensureOpts)
  buildInitCommand(program, deps, ctx)
  buildMcpCommands(program, deps)

  // The stdio MCP server, multiplexed into the single `open-consensus` binary
  // (D2). This is what `mcp install` registers in a host config when packaged
  // (`<binary> mcp-server`); it owns its own stdin-close lifecycle and does NOT
  // launch the TUI or auto-start the daemon.
  program
    .command('mcp-server')
    .description('run the stdio MCP server (registered into MCP hosts by `mcp install`)')
    .action(async () => {
      await deps.runMcpServer()
    })

  return program
}

// ── agent ─────────────────────────────────────────────────────────────────────

function buildAgentCommands(program: Command, deps: CliDeps, ctx: ConfigContext): void {
  const agent = program.command('agent').description('manage agents')

  agent
    .command('add <id>')
    .description('add an agent backed by an adapter CLI')
    .requiredOption('--adapter <adapter>', 'adapter id (claude, codex, gemini, opencode)')
    .option('--name <name>', 'human-readable name (defaults to the id)')
    .option('--model <model>', 'model override passed to the adapter')
    .option('--arg <value>', 'extra CLI arg (repeatable)', collect, [])
    .option('--env <KEY=VALUE>', 'child env var (repeatable)', collect, [])
    .option('--timeout <ms>', 'per-invocation timeout in ms')
    .option('--retries <n>', 'max retries on failure')
    .option('--allow-unsandboxed', 'acknowledge an adapter with no native sandbox (D20)')
    .action(async (id: string, opts) => {
      const input: AddAgentInput = {
        id,
        adapter: opts.adapter,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.arg.length > 0 ? { args: opts.arg } : {}),
        ...(opts.env.length > 0 ? { env: parseEnv(opts.env) } : {}),
        ...(opts.timeout ? { timeoutMs: parsePositiveInt(opts.timeout, '--timeout') } : {}),
        ...(opts.retries ? { maxRetries: parsePositiveInt(opts.retries, '--retries') } : {}),
        ...(opts.allowUnsandboxed ? { allowUnsandboxed: true } : {}),
      }
      const result = await addAgentCommand(ctx, input, deps.registry)
      deps.out(`added agent '${result.agent.id}' (adapter: ${result.agent.adapter})`)
      for (const w of result.warnings) deps.err(`warning: ${w}`)
    })

  agent
    .command('list')
    .description('list configured agents')
    .action(() => {
      const agents = listAgentsCommand(ctx)
      if (agents.length === 0) {
        deps.out('no agents configured')
        return
      }
      for (const a of agents) {
        const model = a.model ? ` / ${a.model}` : ''
        deps.out(
          `${a.id}  (${a.adapter}${model})  timeout ${a.timeoutMs}ms  retries ${a.maxRetries}`,
        )
      }
    })

  agent
    .command('update <id>')
    .description('update an existing agent')
    .option('--name <name>', 'new name')
    .option('--model <model>', "new model ('-' clears it)")
    .option('--arg <value>', 'replace extra CLI args (repeatable)', collect, [])
    .option('--env <KEY=VALUE>', 'replace child env (repeatable)', collect, [])
    .option('--timeout <ms>', 'new per-invocation timeout in ms')
    .option('--retries <n>', 'new max retries')
    .action((id: string, opts) => {
      const updated = updateAgentCommand(ctx, id, {
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.model ? { model: opts.model === '-' ? null : opts.model } : {}),
        ...(opts.arg.length > 0 ? { args: opts.arg } : {}),
        ...(opts.env.length > 0 ? { env: parseEnv(opts.env) } : {}),
        ...(opts.timeout ? { timeoutMs: parsePositiveInt(opts.timeout, '--timeout') } : {}),
        ...(opts.retries ? { maxRetries: parsePositiveInt(opts.retries, '--retries') } : {}),
      })
      deps.out(`updated agent '${updated.id}'`)
    })

  agent
    .command('remove <id>')
    .description('remove an agent')
    .option('--force', 'also remove it from any panels that use it')
    .action((id: string, opts: { force?: boolean }) => {
      removeAgentCommand(ctx, id, opts.force ?? false)
      deps.out(`removed agent '${id}'`)
    })

  agent
    .command('test <id>')
    .description('show the invocation an agent would use (--live to actually spawn it)')
    .option('--live', 'actually spawn the CLI (can cost money)')
    .action(async (id: string, opts: { live?: boolean }) => {
      const result = await testAgentCommand(ctx, id, deps.registry, { live: opts.live ?? false })
      const d = result.detected
      const avail = d.available
        ? `available (${d.version ?? '?'})`
        : `unavailable (${d.reason ?? '?'})`
      deps.out(`adapter: ${result.adapter}  ${avail}`)
      deps.out(`would run: ${result.invocation.file} ${result.invocation.args.join(' ')}`)
      const envKeys = result.invocation.envKeys.join(', ') || '(none)'
      deps.out(`prompt delivery: ${result.invocation.promptDelivery}  env: ${envKeys}`)
      if (result.live) {
        deps.out(
          `live: ${result.live.status} (${result.live.outcome}, ${result.live.durationMs}ms)`,
        )
        deps.out(result.live.text)
      }
    })
}

// ── panel ─────────────────────────────────────────────────────────────────────

function buildPanelCommands(program: Command, deps: CliDeps, ctx: ConfigContext): void {
  const panel = program.command('panel').description('manage panels')

  panel
    .command('create <id>')
    .description('create a panel from existing agents')
    .requiredOption('--agents <ids>', 'comma-separated agent ids')
    .option('--name <name>', 'human-readable name (defaults to the id)')
    .option('--quorum <n>', 'minimum OK responses (defaults to panel size)')
    .option('--concurrency <n>', 'max concurrent invocations')
    .action((id: string, opts) => {
      const created = createPanelCommand(ctx, {
        id,
        agentIds: splitlist(opts.agents),
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.quorum ? { quorum: parsePositiveInt(opts.quorum, '--quorum') } : {}),
        ...(opts.concurrency
          ? { concurrency: parsePositiveInt(opts.concurrency, '--concurrency') }
          : {}),
      })
      deps.out(
        `created panel '${created.id}' (${created.agentIds.length} agents, quorum ${created.quorum})`,
      )
    })

  panel
    .command('list')
    .description('list configured panels')
    .action(() => {
      const panels = listPanelsCommand(ctx)
      if (panels.length === 0) {
        deps.out('no panels configured')
        return
      }
      for (const p of panels) deps.out(`${p.id}  [${p.agentIds.join(', ')}]  quorum ${p.quorum}`)
    })

  panel
    .command('add-agent <panelId> <agentId>')
    .description('add an agent to a panel')
    .action((panelId: string, agentId: string) => {
      const updated = panelAddAgentCommand(ctx, panelId, agentId)
      deps.out(`panel '${panelId}' now has [${updated.agentIds.join(', ')}]`)
    })

  panel
    .command('remove-agent <panelId> <agentId>')
    .description('remove an agent from a panel')
    .action((panelId: string, agentId: string) => {
      const updated = panelRemoveAgentCommand(ctx, panelId, agentId)
      deps.out(
        `panel '${panelId}' now has [${updated.agentIds.join(', ')}]  quorum ${updated.quorum}`,
      )
    })

  panel
    .command('set-quorum <panelId> <n>')
    .description('set a panel quorum')
    .action((panelId: string, n: string) => {
      const updated = setQuorumCommand(ctx, panelId, parsePositiveInt(n, 'quorum'))
      deps.out(`panel '${panelId}' quorum set to ${updated.quorum}`)
    })

  panel
    .command('remove <panelId>')
    .description('remove a panel')
    .action((panelId: string) => {
      removePanelCommand(ctx, panelId)
      deps.out(`removed panel '${panelId}'`)
    })
}

// ── daemon ────────────────────────────────────────────────────────────────────

type EnsureOpts = Parameters<typeof ensureDaemonRunning>[0]

function buildDaemonCommands(program: Command, deps: CliDeps, ensureOpts: EnsureOpts): void {
  const daemon = program.command('daemon').description('control the consensus daemon')

  daemon
    .command('serve')
    .description('run the daemon in the foreground (used by `daemon start`)')
    .action(async () => {
      await deps.serveDaemon()
    })

  daemon
    .command('start')
    .description('start the daemon in the background if not already running')
    .action(async () => {
      const discovery = await ensureDaemonRunning(ensureOpts)
      deps.out(`daemon running on ${discovery.endpoint}`)
    })

  daemon
    .command('stop')
    .description('stop the running daemon')
    .action(async () => {
      const result = await stopDaemonCommand(deps.discoveryPath)
      if (result.stopped) {
        deps.out(`daemon stopped${result.pid ? ` (pid ${result.pid})` : ''}`)
      } else {
        deps.out(`not stopped: ${result.reason}`)
      }
    })

  daemon
    .command('status')
    .description('report whether the daemon is running')
    .action(async () => {
      const status = await daemonStatusCommand(deps.discoveryPath)
      if (!status.running) {
        deps.out('daemon is not running')
        return
      }
      const health = status.healthy ? 'running (healthy)' : 'present but not answering'
      deps.out(`daemon ${health} on ${status.endpoint}${status.pid ? ` (pid ${status.pid})` : ''}`)
    })
}

// ── run ───────────────────────────────────────────────────────────────────────

function buildRunCommands(program: Command, deps: CliDeps, ensureOpts: EnsureOpts): void {
  const run = program.command('run').description('start and inspect consensus runs')

  run
    .command('start <panel> <prompt...>')
    .description('start a consensus run (auto-starts the daemon if needed)')
    .action(async (panel: string, promptParts: string[]) => {
      await ensureDaemonRunning(ensureOpts)
      const result = await startRunCommand(deps.discoveryPath, {
        panel,
        prompt: promptParts.join(' '),
      })
      deps.out(`started run ${result.runId} (round ${result.roundId})`)
    })

  run
    .command('status <runId>')
    .description('show a run status snapshot')
    .action(async (runId: string) => {
      formatRunStatus(await runStatusCommand(deps.discoveryPath, runId), deps.out)
    })

  run
    .command('list')
    .description('list runs the daemon knows about')
    .option('--state <state>', 'filter by state (running|abandoned)')
    .action(async (opts: { state?: string }) => {
      if (opts.state !== undefined && opts.state !== 'running' && opts.state !== 'abandoned') {
        throw new CliError(`--state must be 'running' or 'abandoned' (got '${opts.state}')`)
      }
      const runs = await listRunsCommand(deps.discoveryPath, opts.state)
      if (runs.length === 0) {
        deps.out('no runs')
        return
      }
      for (const r of runs) deps.out(`${r.runId}  ${r.state}  panel=${r.panelId}`)
    })
}

function formatRunStatus(view: RunStatusView, out: (line: string) => void): void {
  out(`run ${view.run.runId}  ${view.run.state}  panel=${view.run.panelId}  v${view.stateVersion}`)
  const round = view.round
  if (!round) return
  out(`  round ${round.index}: ${round.state}${round.verdict ? ` (${round.verdict})` : ''}`)
  for (const inv of round.invocations) {
    out(`    ${inv.agentId}: ${inv.status}${inv.errorClass ? ` [${inv.errorClass}]` : ''}`)
  }
}

// ── init ──────────────────────────────────────────────────────────────────────

function buildInitCommand(program: Command, deps: CliDeps, ctx: ConfigContext): void {
  program
    .command('init')
    .description('auto-detect installed CLIs and seed a default panel')
    .option('--force', 'overwrite an existing config')
    .option('--allow-unsandboxed', 'include adapters with no native sandbox (D20)')
    .option('--panel <id>', 'id for the seeded panel (default: default)')
    .option('--detect-only', 'only report detection, do not write a config')
    .action(async (opts) => {
      if (opts.detectOnly) {
        for (const d of await detectAdaptersCommand(deps.registry)) deps.out(formatDetection(d))
        return
      }
      const report = await initCommand(ctx, deps.registry, {
        ...(opts.force ? { force: true } : {}),
        ...(opts.allowUnsandboxed ? { allowUnsandboxed: true } : {}),
        ...(opts.panel ? { panelId: opts.panel } : {}),
      })
      for (const d of report.detections) deps.out(formatDetection(d))
      if (!report.wrote) {
        deps.err(`did not write config: ${report.reason}`)
        return
      }
      deps.out(
        report.seededAgents.length > 0
          ? `seeded agents: ${report.seededAgents.join(', ')}`
          : 'no agents seeded',
      )
      if (report.seededPanel) deps.out(`seeded panel: ${report.seededPanel}`)
      for (const s of report.skipped) deps.err(`skipped ${s.id}: ${s.reason}`)
    })
}

function formatDetection(d: {
  id: string
  available: boolean
  version?: string
  reason?: string
  sandbox: boolean
}): string {
  const mark = d.available ? '✓' : '✗'
  const detail = d.available ? (d.version ?? 'available') : (d.reason ?? 'not detected')
  return `${mark} ${d.id}  ${detail}${d.sandbox ? '' : '  (unsandboxed)'}`
}

// ── mcp ───────────────────────────────────────────────────────────────────────

function buildMcpCommands(program: Command, deps: CliDeps): void {
  const mcp = program.command('mcp').description('register the MCP server with a host')

  mcp
    .command('install')
    .description('register the Open Consensus MCP server in a host config')
    .option('--config <path>', 'host config path (default: the Claude Code config)')
    .option('--name <serverName>', 'entry name under mcpServers')
    .option('--command <command>', 'command to run the MCP server')
    .option('--arg <value>', 'arg for the MCP server command (repeatable)', collect, [])
    .option('--force', 'overwrite a conflicting existing entry')
    .action((opts) => {
      if (opts.arg.length > 0 && !opts.command) {
        throw new CliError('--arg only applies with --command (it sets that command’s args)')
      }
      // No --command -> register the entry appropriate to how WE were launched: the
      // packaged binary path + `mcp-server`, or `open-consensus-mcp` from source.
      const entry: McpServerEntry = opts.command
        ? { command: opts.command, args: opts.arg }
        : deps.defaultMcpEntry
      const result = mcpInstallCommand({
        host: {
          path: opts.config ?? deps.mcpHostPath,
          ...(opts.name ? { serverName: opts.name } : {}),
        },
        entry,
        ...(opts.force ? { force: true } : {}),
      })
      reportInstall(result, deps)
    })

  mcp
    .command('uninstall')
    .description('remove the Open Consensus MCP server from a host config')
    .option('--config <path>', 'host config path (default: the Claude Code config)')
    .option('--name <serverName>', 'entry name under mcpServers')
    .action((opts) => {
      const result = mcpUninstallCommand({
        path: opts.config ?? deps.mcpHostPath,
        ...(opts.name ? { serverName: opts.name } : {}),
      })
      deps.out(`${result.action} '${result.serverName}' in ${result.path}`)
    })
}

function reportInstall(result: InstallResult, deps: CliDeps): void {
  if (result.action === 'conflict') {
    deps.err(
      `'${result.serverName}' already exists in ${result.path} with a different command; pass --force to overwrite`,
    )
    throw new CliError('mcp install: conflicting entry')
  }
  deps.out(`${result.action} '${result.serverName}' in ${result.path}`)
}

// ── shared ─────────────────────────────────────────────────────────────────────

/** Resolve the config file, honoring an explicit override for tests/automation. */
export function resolveConfigFile(
  env: PathEnv & { OPEN_CONSENSUS_CONFIG?: string } = process.env,
): string {
  const override = env.OPEN_CONSENSUS_CONFIG
  return override && override.length > 0 ? override : configPath(env)
}

/** Parse argv and run. Throws on usage/validation errors (caller decides exit). */
export async function run(argv: readonly string[], deps: CliDeps): Promise<void> {
  await buildProgram(deps).parseAsync(argv as string[])
}
