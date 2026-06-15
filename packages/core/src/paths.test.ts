import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type PathEnv, appPaths, cacheDir, configDir, dataDir, runtimeDir, stateDir } from './paths'

const HOME = '/home/tester'

describe('paths', () => {
  it('honors absolute XDG_* overrides', () => {
    const env: PathEnv = {
      HOME,
      XDG_CONFIG_HOME: '/xdg/cfg',
      XDG_STATE_HOME: '/xdg/state',
      XDG_DATA_HOME: '/xdg/data',
      XDG_CACHE_HOME: '/xdg/cache',
      XDG_RUNTIME_DIR: '/run/user/1000',
    }
    expect(configDir(env)).toBe('/xdg/cfg/open-consensus')
    expect(stateDir(env)).toBe('/xdg/state/open-consensus')
    expect(dataDir(env)).toBe('/xdg/data/open-consensus')
    expect(cacheDir(env)).toBe('/xdg/cache/open-consensus')
    expect(runtimeDir(env)).toBe('/run/user/1000/open-consensus')
  })

  it('falls back to HOME-based defaults when XDG vars are unset', () => {
    const env: PathEnv = { HOME }
    expect(configDir(env)).toBe('/home/tester/.config/open-consensus')
    expect(stateDir(env)).toBe('/home/tester/.local/state/open-consensus')
    expect(dataDir(env)).toBe('/home/tester/.local/share/open-consensus')
    expect(cacheDir(env)).toBe('/home/tester/.cache/open-consensus')
  })

  it('ignores non-absolute XDG values per the spec', () => {
    const env: PathEnv = { HOME, XDG_CONFIG_HOME: 'relative/path' }
    expect(configDir(env)).toBe('/home/tester/.config/open-consensus')
  })

  it('runtimeDir falls back to the OS temp dir when XDG_RUNTIME_DIR is unset', () => {
    expect(runtimeDir({ HOME })).toBe(join(tmpdir(), 'open-consensus'))
  })

  it('falls back to os.homedir() when HOME is empty or absent', () => {
    const expected = join(homedir(), '.config', 'open-consensus')
    expect(configDir({ HOME: '' })).toBe(expected)
    expect(configDir({})).toBe(expected)
  })

  it('reads process.env when no env is supplied', () => {
    const dir = configDir()
    expect(dir.startsWith('/')).toBe(true)
    expect(dir.endsWith('/open-consensus')).toBe(true)
  })

  it('appPaths resolves every directory at once', () => {
    const env: PathEnv = { HOME }
    expect(appPaths(env)).toEqual({
      config: '/home/tester/.config/open-consensus',
      state: '/home/tester/.local/state/open-consensus',
      data: '/home/tester/.local/share/open-consensus',
      cache: '/home/tester/.cache/open-consensus',
      runtime: join(tmpdir(), 'open-consensus'),
    })
  })
})
