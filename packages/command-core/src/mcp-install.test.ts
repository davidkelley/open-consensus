import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MCP_ENTRY, mcpInstallCommand, mcpUninstallCommand } from './mcp-install'

let dir: string
let hostPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-mcp-'))
  hostPath = join(dir, 'host.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function readHost(): Record<string, unknown> {
  return JSON.parse(readFileSync(hostPath, 'utf8'))
}

describe('mcp install', () => {
  it('installs into a missing file, creating the mcpServers map', () => {
    const result = mcpInstallCommand({ host: { path: hostPath } })
    expect(result.action).toBe('installed')
    expect(result.serverName).toBe('open-consensus')
    expect(readHost()).toEqual({ mcpServers: { 'open-consensus': DEFAULT_MCP_ENTRY } })
  })

  it('is idempotent: re-installing an identical entry is unchanged (no rewrite)', () => {
    mcpInstallCommand({ host: { path: hostPath } })
    const before = statSync(hostPath).mtimeMs
    const result = mcpInstallCommand({ host: { path: hostPath } })
    expect(result.action).toBe('unchanged')
    expect(statSync(hostPath).mtimeMs).toBe(before)
  })

  it('detects a conflicting existing entry and refuses to overwrite without force', () => {
    writeFileSync(
      hostPath,
      JSON.stringify({ mcpServers: { 'open-consensus': { command: 'old', args: ['x'] } } }),
    )
    const result = mcpInstallCommand({ host: { path: hostPath } })
    expect(result.action).toBe('conflict')
    expect(result.existing).toEqual({ command: 'old', args: ['x'] })
    // The conflicting entry is left untouched.
    expect(readHost().mcpServers).toEqual({ 'open-consensus': { command: 'old', args: ['x'] } })
  })

  it('overwrites a conflict with force (action: updated)', () => {
    writeFileSync(
      hostPath,
      JSON.stringify({ mcpServers: { 'open-consensus': { command: 'old', args: [] } } }),
    )
    const result = mcpInstallCommand({ host: { path: hostPath }, force: true })
    expect(result.action).toBe('updated')
    expect((readHost().mcpServers as Record<string, unknown>)['open-consensus']).toEqual(
      DEFAULT_MCP_ENTRY,
    )
  })

  it('preserves other top-level keys and sibling mcpServers entries', () => {
    writeFileSync(
      hostPath,
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x', args: [] } } }),
    )
    mcpInstallCommand({ host: { path: hostPath }, entry: { command: 'oc', args: ['--flag'] } })
    const host = readHost()
    expect(host.theme).toBe('dark')
    expect(host.mcpServers).toEqual({
      other: { command: 'x', args: [] },
      'open-consensus': { command: 'oc', args: ['--flag'] },
    })
  })

  it('honors a custom server name and includes env when present', () => {
    const result = mcpInstallCommand({
      host: { path: hostPath, serverName: 'oc-dev' },
      entry: { command: 'node', args: ['mcp.js'], env: { OC_DEBUG: '1' } },
    })
    expect(result.action).toBe('installed')
    expect((readHost().mcpServers as Record<string, unknown>)['oc-dev']).toEqual({
      command: 'node',
      args: ['mcp.js'],
      env: { OC_DEBUG: '1' },
    })
  })

  it('refuses to modify a malformed (non-JSON) host config', () => {
    writeFileSync(hostPath, '{ not json')
    expect(() => mcpInstallCommand({ host: { path: hostPath } })).toThrow(/malformed/)
    expect(readFileSync(hostPath, 'utf8')).toBe('{ not json')
  })

  it('refuses when the top-level is not an object', () => {
    writeFileSync(hostPath, '[]')
    expect(() => mcpInstallCommand({ host: { path: hostPath } })).toThrow(/not a JSON object/)
  })

  it('refuses when mcpServers is present but not an object', () => {
    writeFileSync(hostPath, JSON.stringify({ mcpServers: 'oops' }))
    expect(() => mcpInstallCommand({ host: { path: hostPath } })).toThrow(/'mcpServers' is not/)
  })
})

describe('mcp uninstall', () => {
  it('removes an installed entry (action: removed)', () => {
    mcpInstallCommand({ host: { path: hostPath } })
    const result = mcpUninstallCommand({ path: hostPath })
    expect(result.action).toBe('removed')
    expect(readHost().mcpServers).toEqual({})
  })

  it('reports absent when the entry is not present', () => {
    writeFileSync(hostPath, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }))
    const result = mcpUninstallCommand({ path: hostPath })
    expect(result.action).toBe('absent')
  })

  it('reports absent for a missing file (no write)', () => {
    const result = mcpUninstallCommand({ path: join(dir, 'nope.json') })
    expect(result.action).toBe('absent')
  })

  it('refuses to touch a malformed host config', () => {
    writeFileSync(hostPath, 'nonsense')
    expect(() => mcpUninstallCommand({ path: hostPath })).toThrow(/malformed/)
  })
})
