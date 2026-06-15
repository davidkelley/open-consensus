import { describe, expect, it } from 'vitest'
import { clampWaitMs, parseIntParam, startRoundBodySchema, startRunBodySchema } from './schema'

describe('startRunBodySchema', () => {
  it('accepts a valid body', () => {
    expect(startRunBodySchema.parse({ panel: 'p1', prompt: 'hi' })).toEqual({
      panel: 'p1',
      prompt: 'hi',
    })
  })

  it('rejects an empty prompt, missing panel, and unknown keys', () => {
    expect(startRunBodySchema.safeParse({ panel: 'p1', prompt: '' }).success).toBe(false)
    expect(startRunBodySchema.safeParse({ prompt: 'hi' }).success).toBe(false)
    expect(startRunBodySchema.safeParse({ panel: 'p1', prompt: 'hi', x: 1 }).success).toBe(false)
  })
})

describe('startRoundBodySchema', () => {
  it('accepts a prompt and rejects a missing one', () => {
    expect(startRoundBodySchema.parse({ prompt: 'go' })).toEqual({ prompt: 'go' })
    expect(startRoundBodySchema.safeParse({}).success).toBe(false)
  })
})

describe('clampWaitMs', () => {
  it('defaults to the ceiling when absent', () => {
    expect(clampWaitMs(null, 50_000)).toBe(50_000)
  })
  it('caps at the ceiling', () => {
    expect(clampWaitMs('999999', 50_000)).toBe(50_000)
  })
  it('passes through a value under the ceiling', () => {
    expect(clampWaitMs('1000', 50_000)).toBe(1000)
  })
  it('treats negative / non-numeric as zero', () => {
    expect(clampWaitMs('-5', 50_000)).toBe(0)
    expect(clampWaitMs('abc', 50_000)).toBe(0)
  })
})

describe('parseIntParam', () => {
  it('parses a non-negative integer', () => {
    expect(parseIntParam('42', 7)).toBe(42)
    expect(parseIntParam('0', 7)).toBe(0)
  })
  it('falls back for null, negative, or non-integer', () => {
    expect(parseIntParam(null, 7)).toBe(7)
    expect(parseIntParam('-1', 7)).toBe(7)
    expect(parseIntParam('1.5', 7)).toBe(7)
    expect(parseIntParam('x', 7)).toBe(7)
  })
})
