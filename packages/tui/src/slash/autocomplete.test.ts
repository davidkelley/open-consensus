import { describe, expect, it } from 'vitest'
import { applySuggestion, autocomplete } from './autocomplete'

describe('autocomplete', () => {
  it('returns nothing for non-slash input', () => {
    expect(autocomplete('hello')).toEqual([])
    expect(autocomplete('')).toEqual([])
  })

  it('suggests all commands for a bare slash', () => {
    const values = autocomplete('/').map((s) => s.value)
    expect(values).toContain('/help')
    expect(values).toContain('/run')
    expect(values).toContain('/quit')
  })

  it('prefix-matches case-insensitively', () => {
    expect(autocomplete('/PA').map((s) => s.value)).toEqual(['/panels', '/panel'])
  })

  it('stops suggesting once into the arguments', () => {
    expect(autocomplete('/run ')).toEqual([])
  })

  it('applies a suggestion with a trailing space', () => {
    expect(applySuggestion({ value: '/run', summary: '' })).toBe('/run ')
  })
})
