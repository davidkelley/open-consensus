/**
 * Single-binary detection. `@yao-pkg/pkg` sets `process.pkg` when the app runs as
 * a packaged single executable; in that mode `import.meta.url`/`__filename` resolve
 * to a virtual `/snapshot/...` path that does NOT exist on disk, so the daemon
 * self-spawn + MCP registration must target `process.execPath` (the binary itself)
 * plus a subcommand rather than a file path. `proc` is injectable for testing both
 * branches without actually being packaged.
 */
export function isPackaged(
  proc: { pkg?: unknown } = process as unknown as { pkg?: unknown },
): boolean {
  return proc.pkg !== undefined
}
