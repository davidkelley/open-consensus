import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { appPaths } from '@open-consensus/core'
import { type Discovery, readDiscovery, waitForReady } from '@open-consensus/daemon'
import { type DaemonClient, DaemonError, httpDaemonClient } from './client'
import { TOOLS } from './tools'

const DISCOVERY_NAME = 'discovery.json'

/** Build the MCP server and register the full D12 tool surface over `client`. */
export function createMcpServer(client: DaemonClient): McpServer {
  const server = new McpServer({ name: 'open-consensus', version: '0.0.0' })
  const ctx = { client }
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title },
      },
      // The SDK parses `args` against inputSchema before calling us.
      async (args: unknown) => {
        try {
          const result = await tool.handler(ctx, args as never)
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
        } catch (err) {
          const message = err instanceof DaemonError ? err.message : String(err)
          return {
            content: [{ type: 'text' as const, text: `error: ${message}` }],
            isError: true,
          }
        }
      },
    )
  }
  return server
}

/** Path to the daemon's discovery file under the resolved runtime dir. */
export function discoveryPath(): string {
  return join(appPaths().runtime, DISCOVERY_NAME)
}

/**
 * Resolve a client to the running daemon by reading its discovery file and
 * waiting for it to answer a health check. (Auto-starting an absent daemon by
 * spawning one is the CLI's shared job — Stage 8; here an absent daemon is a
 * clear, actionable error rather than a silent hang — D21.)
 */
export async function resolveClient(
  path = discoveryPath(),
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<DaemonClient> {
  const discovery: Discovery | undefined = readDiscovery(path)
  if (!discovery) {
    throw new Error(
      'open-consensus daemon is not running — start it with `open-consensus daemon start`',
    )
  }
  const ready = await waitForReady(discovery, {
    attempts: opts.attempts ?? 20,
    intervalMs: opts.intervalMs ?? 100,
  })
  if (!ready) {
    throw new Error('open-consensus daemon did not become ready')
  }
  return httpDaemonClient(discovery.endpoint, discovery.token)
}
