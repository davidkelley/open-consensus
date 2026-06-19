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

  it('prefix-matches case-insensitively, shortest name first', () => {
    expect(autocomplete('/PA').map((s) => s.value)).toEqual(['/panel', '/panels'])
  })

  it('ranks by relevance: exact then shortest (/r → /run before /runs)', () => {
    expect(autocomplete('/r').map((s) => s.value)).toEqual(['/run', '/runs'])
    expect(autocomplete('/run')[0]?.value).toBe('/run') // exact match wins
  })

  it('orders bare-slash suggestions by length, then alphabetically (tie-break)', () => {
    expect(autocomplete('/').map((s) => s.value)).toEqual([
      '/run', // length 3
      '/help',
      '/quit',
      '/runs', // length 4, alpha
      '/agent',
      '/panel', // length 5, alpha
      '/agents',
      '/daemon',
      '/panels', // length 6, alpha
    ])
  })

  it('stops suggesting once into the arguments', () => {
    expect(autocomplete('/run ')).toEqual([])
  })

  it('applies a suggestion with a trailing space', () => {
    expect(applySuggestion({ value: '/run', summary: '' })).toBe('/run ')
  })
})
