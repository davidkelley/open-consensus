import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type PathEnv,
  appPaths,
  cacheDir,
  configDir,
  dataDir,
  resolveBase,
  runtimeDir,
  stateDir,
} from './paths'

const HOME = '/home/tester'

describe('resolveBase', () => {
  it('prefers an absolute env value', () => {
    expect(resolveBase('/abs', '/fallback', 'home')).toBe('/abs')
  })

  it('falls back to an absolute fallback when the env value is relative or unset', () => {
    expect(resolveBase('relative', '/fallback', 'home')).toBe('/fallback')
    expect(resolveBase(undefined, '/fallback', 'home')).toBe('/fallback')
  })

  it('throws when neither the env value nor the fallback is absolute', () => {
    expect(() => resolveBase('relative', 'also-relative', 'home')).toThrow(
      /absolute home directory/,
    )
    expect(() => resolveBase(undefined, '', 'runtime')).toThrow(/absolute runtime directory/)
  })
})

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

  it('falls back to os.homedir() when HOME is empty, absent, or relative', () => {
    const expected = join(homedir(), '.config', 'open-consensus')
    expect(configDir({ HOME: '' })).toBe(expected)
    expect(configDir({})).toBe(expected)
    expect(configDir({ HOME: 'not/absolute' })).toBe(expected)
  })

  it('runtimeDir uses XDG_RUNTIME_DIR when absolute, regardless of platform', () => {
    expect(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')).toBe(
      '/run/user/1000/open-consensus',
    )
    expect(runtimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 'darwin')).toBe(
      '/run/user/1000/open-consensus',
    )
  })

  it('runtimeDir falls back to a short /tmp on macOS (sun_path limit, D2)', () => {
    expect(runtimeDir({ HOME }, 'darwin')).toBe('/tmp/open-consensus')
  })

  it('runtimeDir falls back to os.tmpdir() off macOS when it is absolute', () => {
    expect(runtimeDir({ HOME }, 'linux')).toBe(join(tmpdir(), 'open-consensus'))
  })

  describe('with a relative TMPDIR off macOS', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('uses /tmp rather than propagating a relative os.tmpdir()', () => {
      vi.stubEnv('TMPDIR', 'relative-tmp')
      expect(runtimeDir({ HOME }, 'linux')).toBe('/tmp/open-consensus')
    })
  })

  it('reads process.env when no env is supplied', () => {
    const dir = configDir()
    expect(dir.startsWith('/')).toBe(true)
    expect(dir.endsWith('/open-consensus')).toBe(true)
  })

  it('appPaths resolves every directory at once (platform threaded through)', () => {
    const env: PathEnv = { HOME }
    // Inject platform explicitly so the runtime assertion is deterministic and
    // not tautological with the implementation's own process.platform.
    expect(appPaths(env, 'darwin')).toEqual({
      config: '/home/tester/.config/open-consensus',
      state: '/home/tester/.local/state/open-consensus',
      data: '/home/tester/.local/share/open-consensus',
      cache: '/home/tester/.cache/open-consensus',
      runtime: '/tmp/open-consensus',
    })
    expect(appPaths(env, 'linux').runtime).toBe(join(tmpdir(), 'open-consensus'))
  })
})
