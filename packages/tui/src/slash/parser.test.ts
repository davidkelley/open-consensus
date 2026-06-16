import { describe, expect, it } from 'vitest'
import { parseLine } from './parser'

describe('parseLine', () => {
  it('treats blank input as empty', () => {
    expect(parseLine('')).toEqual({ kind: 'empty' })
    expect(parseLine('   ')).toEqual({ kind: 'empty' })
  })

  it('treats non-slash input as text', () => {
    expect(parseLine('hello there')).toEqual({ kind: 'text', text: 'hello there' })
  })

  it('parses a bare command', () => {
    expect(parseLine('/help')).toEqual({ kind: 'command', name: 'help', args: [], rest: '' })
  })

  it('lowercases the command name and splits args, preserving rest', () => {
    expect(parseLine('/RUN review  this   plan')).toEqual({
      kind: 'command',
      name: 'run',
      args: ['review', 'this', 'plan'],
      rest: 'review  this   plan',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseLine('  /panels  ')).toMatchObject({ kind: 'command', name: 'panels' })
  })
})
