import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { theme } from '../theme'
import { bannerLines } from './banner'

const flat = (rows: { text: string }[][]): string =>
  rows.map((r) => r.map((s) => s.text).join('')).join('\n')

describe('bannerLines', () => {
  it('renders a brand wordmark with the version', () => {
    const text = flat(bannerLines({ version: '1.2.3', cwd: '/work/x' }))
    expect(text).toContain('OPEN CONSENSUS')
    expect(text).toContain('v1.2.3')
    // the wordmark carries the bold brand color
    const wordmark = bannerLines({ version: '1.2.3', cwd: '/work/x' })[0] ?? []
    expect(
      wordmark.some((s) => s.text === 'OPEN CONSENSUS' && s.color === theme.brand && s.bold),
    ).toBe(true)
  })

  it('defaults the version to "dev"', () => {
    expect(flat(bannerLines({ cwd: '/work/x' }))).toContain('vdev')
  })

  it('shows the cwd verbatim when not under home', () => {
    expect(flat(bannerLines({ cwd: '/work/project' }))).toContain('/work/project')
  })

  it('abbreviates the home directory to ~', () => {
    const text = flat(bannerLines({ cwd: join(homedir(), 'code', 'oc') }))
    expect(text).toContain('~/code/oc')
    expect(text).not.toContain(homedir())
  })

  it('includes a hint line with the key commands', () => {
    const text = flat(bannerLines())
    expect(text).toContain('/help')
    expect(text).toContain('/run <panel> <prompt>')
    expect(text).toContain('Ctrl+C')
  })
})
