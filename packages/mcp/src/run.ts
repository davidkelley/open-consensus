// Default-wired stdio entry, shared by BOTH the `open-consensus-mcp` bin (`mcp.ts`)
// and the single binary's `open-consensus mcp-server` subcommand, so there is
// exactly one wiring. This is an un-unit-testable side-effect stub (real stdio +
// real daemon discovery) — like `mcp.ts`/`cli.ts` it is excluded from the coverage
// gate; its constituent parts (`createMcpServer`, `resolveClient`) are tested.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer, resolveClient } from './server'

/**
 * Resolve the daemon client, expose the D12 tool surface, and serve it over stdio.
 * Resolves when the transport closes (stdin EOF). Does NOT launch the TUI or
 * auto-start the daemon — an absent daemon is a clear, actionable error (D21).
 */
export async function runMcpStdioServer(): Promise<void> {
  const client = await resolveClient()
  const server = createMcpServer(client)
  await server.connect(new StdioServerTransport())
}
