#!/usr/bin/env node
// The `open-consensus-mcp` binary: a stdio MCP server exposing the consensus
// tool surface (D12). It connects to the local daemon and forwards tool calls.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer, resolveClient } from './server'

async function main(): Promise<void> {
  const client = await resolveClient()
  const server = createMcpServer(client)
  await server.connect(new StdioServerTransport())
}

main().catch((err: unknown) => {
  process.stderr.write(`open-consensus-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
