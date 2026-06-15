import { describe, expect, it } from 'vitest'
import { REDACTED, isSecretKey, redactDeep, redactEnv, redactString } from './redact'

describe('redactString', () => {
  it('masks value-shaped secrets', () => {
    expect(redactString('key sk-ant-abcdefgh0123456789 end')).toBe(`key ${REDACTED} end`)
    expect(redactString('OPENAI sk-abcdefghijklmnop0123')).toContain(REDACTED)
    expect(redactString('token ghp_abcdefghijklmnop0123')).toContain(REDACTED)
    expect(redactString('aws AKIAIOSFODNN7EXAMPLE here')).toContain(REDACTED)
    expect(redactString('slack xoxb-12345678-abcd here')).toContain(REDACTED)
    expect(redactString('Authorization: Bearer abcdef0123456789xyz')).toContain(REDACTED)
    expect(redactString('jwt eyJabcdefgh.eyJabcdefgh.signature01')).toContain(REDACTED)
  })

  it('leaves ordinary text untouched', () => {
    expect(redactString('the quick brown fox')).toBe('the quick brown fox')
  })
})

describe('isSecretKey', () => {
  it('flags secret-looking key names (case-insensitive)', () => {
    for (const k of ['API_KEY', 'apiKey', 'AUTH_TOKEN', 'password', 'AWS_SECRET_ACCESS_KEY']) {
      expect(isSecretKey(k)).toBe(true)
    }
  })

  it('does not flag ordinary key names', () => {
    for (const k of ['HOME', 'PATH', 'model', 'timeoutMs']) {
      expect(isSecretKey(k)).toBe(false)
    }
  })
})

describe('redactEnv', () => {
  it('masks secret-keyed values, scans others, drops undefined', () => {
    const out = redactEnv({
      ANTHROPIC_API_KEY: 'sk-ant-abcdefgh0123456789',
      HOME: '/home/x',
      NOTE: 'contains sk-abcdefghijklmnop0123 inline',
      MISSING: undefined,
    })
    expect(out.ANTHROPIC_API_KEY).toBe(REDACTED)
    expect(out.HOME).toBe('/home/x')
    expect(out.NOTE).toContain(REDACTED)
    expect('MISSING' in out).toBe(false)
  })
})

describe('redactDeep', () => {
  it('walks objects and arrays, masking secret-keyed strings and value-shaped secrets', () => {
    const input = {
      token: 'whatever-string',
      nested: { note: 'sk-ant-abcdefgh0123456789', count: 3 },
      list: ['plain', 'ghp_abcdefghijklmnop0123'],
      enabled: true,
      empty: null,
    }
    expect(redactDeep(input)).toEqual({
      token: REDACTED,
      nested: { note: REDACTED, count: 3 },
      list: ['plain', REDACTED],
      enabled: true,
      empty: null,
    })
  })

  it('recurses (not masks) a non-string value under a secret-looking key', () => {
    expect(redactDeep({ secret: { inner: 'plain' } })).toEqual({ secret: { inner: 'plain' } })
  })

  it('passes scalars through unchanged', () => {
    expect(redactDeep(42)).toBe(42)
    expect(redactDeep(null)).toBe(null)
    expect(redactDeep(false)).toBe(false)
  })
})
