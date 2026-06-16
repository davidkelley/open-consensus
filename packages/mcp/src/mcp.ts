#!/usr/bin/env node
// The `open-consensus-mcp` binary: a stdio MCP server exposing the consensus
// tool surface (D12). It connects to the local daemon and forwards tool calls.
// The single-binary `open-consensus mcp-server` subcommand reuses the same runner.
import { runMcpStdioServer } from './run'

runMcpStdioServer().catch((err: unknown) => {
  process.stderr.write(`open-consensus-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exitCode = 1
})
