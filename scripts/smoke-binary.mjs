#!/usr/bin/env node
// Stage 2 smoke (plan): prove the packaged binary actually works WITHOUT spend or
// real agent CLIs. Exercises the riskiest packaged paths:
//   - `--help` (the binary runs at all)
//   - `daemon start`/`status`/`stop` (self-spawn via execPath + native SQLite load
//     + unix socket INSIDE the binary — this is the R1 native-addon proof)
//   - `mcp-server` over stdio: protocol initialize + tools/list (MCP + daemon RPC)
//   - `mcp install` writes the PACKAGED entry `{command:<binary>, args:['mcp-server']}`
//   - `init --detect-only` (adapters load + detect; mock NOT exercised)
// All against an ISOLATED XDG/config sandbox so it never touches the user's daemon.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function hostTriple() {
  const p = osPlatform()
  const a = osArch()
  if (p === 'darwin') return a === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (p === 'linux') return a === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  throw new Error(`unsupported host platform: ${p}/${a}`)
}

const argBin = process.argv.indexOf('--bin')
const bin =
  argBin >= 0 ? process.argv[argBin + 1] : join(root, 'dist-bin', `open-consensus-${hostTriple()}`)

const sandbox = mkdtempSync(join(tmpdir(), 'oc-smoke-bin-'))
const configPath = join(sandbox, 'config.json')
writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, agents: [], panels: [] }))
const sandboxHome = join(sandbox, 'home')
const sandboxTmp = join(sandbox, 'tmp')
mkdirSync(sandboxHome, { recursive: true })
mkdirSync(sandboxTmp, { recursive: true })
// Isolate EVERY path so the smoke daemon can't collide with (or leak into) the
// user's real daemon — incl. HOME/TMPDIR (any XDG fallback resolves through them).
const env = {
  ...process.env,
  OPEN_CONSENSUS_CONFIG: configPath,
  HOME: sandboxHome,
  TMPDIR: sandboxTmp,
  XDG_CONFIG_HOME: join(sandbox, 'config'),
  XDG_STATE_HOME: join(sandbox, 'state'),
  XDG_DATA_HOME: join(sandbox, 'data'),
  XDG_CACHE_HOME: join(sandbox, 'cache'),
  XDG_RUNTIME_DIR: join(sandbox, 'run'),
}
// Don't let a CI-set OPEN_CONSENSUS_DAEMON_LOG redirect the smoke daemon's stdio.
Reflect.deleteProperty(env, 'OPEN_CONSENSUS_DAEMON_LOG')

const log = (m) => console.log(`[smoke-binary] ${m}`)
const fail = (m) => {
  console.error(`[smoke-binary] FAIL: ${m}`)
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(1)
}
const oc = (args, opts = {}) =>
  execFileSync(bin, args, { env, encoding: 'utf8', timeout: 30_000, ...opts })

let client
try {
  log(`binary: ${bin}`)

  // 1. --help
  const help = oc(['--help'])
  if (!/Open Consensus/.test(help)) fail('`--help` did not print the program description')
  log('--help OK')

  // 2. init --detect-only (adapters load + detect; no spawn of any real CLI)
  const detect = oc(['init', '--detect-only'])
  log(`init --detect-only OK (${detect.trim().split('\n').length} adapters reported)`)

  // 2b. agent test dry-run: add an agent and preview its invocation (no --live ->
  //     no spawn, no spend). Exercises the config store + the adapter
  //     buildInvocation path inside the binary.
  oc(['agent', 'add', 'claude', '--adapter', 'claude'])
  const agentTest = oc(['agent', 'test', 'claude'])
  if (!/would run:/.test(agentTest))
    fail(`agent test did not preview an invocation: ${agentTest.trim()}`)
  log('agent test OK (dry-run invocation preview, no spawn)')

  // NOTE: the interactive TUI (ink/yoga/React) render path is NOT smoked here — it
  // needs a PTY. Manual check: run `open-consensus`, confirm the slash-command
  // prompt renders, then Ctrl+C exits cleanly. (Verified during the Stage-2 spike.)

  // 3. daemon start -> status (R1: self-spawn + native SQLite + socket in the binary)
  const started = oc(['daemon', 'start'])
  if (!/daemon running on/.test(started)) fail(`daemon start unexpected output: ${started.trim()}`)
  log('daemon start OK (native SQLite loaded + socket bound inside the binary)')
  const status = oc(['daemon', 'status'])
  if (!/running \(healthy\)/.test(status)) fail(`daemon not healthy: ${status.trim()}`)
  log('daemon status: healthy')

  // 4. mcp-server over stdio: initialize + tools/list (spawns `binary mcp-server`,
  //    which connects to the running daemon and serves the tool surface)
  const transport = new StdioClientTransport({ command: bin, args: ['mcp-server'], env })
  client = new Client({ name: 'smoke', version: '0' })
  await client.connect(transport) // protocol initialize handshake
  const tools = (await client.listTools()).tools.map((t) => t.name)
  if (!tools.includes('consensus_start'))
    fail(`mcp-server tools/list missing consensus_start: ${tools}`)
  log(`mcp-server OK (initialize + tools/list -> ${tools.length} tools)`)
  await client.close()
  client = undefined

  // 5. mcp install writes the PACKAGED entry (binary path + mcp-server subcommand)
  const hostCfg = join(sandbox, 'host.json')
  oc(['mcp', 'install', '--config', hostCfg])
  const entry = JSON.parse(readFileSync(hostCfg, 'utf8')).mcpServers['open-consensus']
  if (entry.command !== bin || JSON.stringify(entry.args) !== JSON.stringify(['mcp-server'])) {
    fail(
      `mcp install wrote the wrong entry: ${JSON.stringify(entry)} (expected {command:'${bin}', args:['mcp-server']})`,
    )
  }
  log(`mcp install OK (registered ${entry.command} ${entry.args.join(' ')})`)

  // 6. daemon stop
  const stopped = oc(['daemon', 'stop'])
  if (!/daemon stopped/.test(stopped)) fail(`daemon stop unexpected output: ${stopped.trim()}`)
  log('daemon stop OK')

  log('ALL CHECKS PASSED ✓')
} finally {
  if (client) await client.close().catch(() => {})
  // Best-effort: ensure no smoke daemon is left running.
  spawnSync(bin, ['daemon', 'stop'], { env, timeout: 10_000 })
  rmSync(sandbox, { recursive: true, force: true })
}
