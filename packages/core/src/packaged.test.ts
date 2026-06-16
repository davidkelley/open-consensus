import { describe, expect, it } from 'vitest'
import { isPackaged } from './packaged'

describe('isPackaged', () => {
  it('is true when process.pkg is present (a @yao-pkg/pkg binary)', () => {
    expect(isPackaged({ pkg: { entrypoint: '/snapshot/cli.js' } })).toBe(true)
  })

  it('is false from source (no process.pkg)', () => {
    expect(isPackaged({})).toBe(false)
  })

  it('defaults to the real process (not packaged under the test runner)', () => {
    expect(isPackaged()).toBe(false)
  })
})
