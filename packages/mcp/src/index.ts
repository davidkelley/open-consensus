/**
 * `@open-consensus/mcp` library surface. The published artifact is primarily the
 * `open-consensus-mcp` stdio bin (`mcp.ts`), but exporting the server + client
 * factories lets the integration tier (Stage 10 e2e) drive the full
 * MCP → daemon → engine stack in-process, and lets embedders reuse the pieces.
 */
export { createMcpServer, resolveClient, discoveryPath } from './server'
export {
  type DaemonClient,
  type PanelSummary,
  type RunStatus,
  type RawPage,
  DaemonError,
  httpDaemonClient,
} from './client'
export { TOOLS } from './tools'
