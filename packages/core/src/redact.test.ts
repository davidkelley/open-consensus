import { describe, expect, it } from 'vitest'
import { REDACTED, isSecretKey, redactDeep, redactEnv, redactString } from './redact'

describe('redactString', () => {
  it('masks value-shaped secrets', () => {
    expect(redactString('key sk-ant-abcdefgh0123456789 end')).toBe(`key ${REDACTED} end`)
    expect(redactString('OPENAI sk-abcdefghijklmnop0123')).toContain(REDACTED)
    expect(redactString('stripe sk_live_abcdefghijklmnop')).toContain(REDACTED)
    expect(redactString('finegrained github_pat_abcdefghijklmnopqrst')).toContain(REDACTED)
    expect(redactString('classic ghp_abcdefghijklmnop0123')).toContain(REDACTED)
    expect(redactString('aws AKIAIOSFODNN7EXAMPLE here')).toContain(REDACTED)
    expect(redactString('google AIzaSyABCDEFGHIJKLMNOPQRSTUV here')).toContain(REDACTED)
    expect(redactString('slack xoxe-12345678-abcd here')).toContain(REDACTED)
    expect(redactString('Authorization: Bearer abcdef0123456789xyz')).toContain(REDACTED)
    expect(redactString('jwt eyJabcdefgh.eyJabcdefgh.signature01')).toContain(REDACTED)
  })

  it('leaves ordinary text untouched', () => {
    expect(redactString('the quick brown fox')).toBe('the quick brown fox')
  })
})

describe('isSecretKey', () => {
  it('flags secret-looking key names (token-aware, case-insensitive)', () => {
    for (const k of [
      'API_KEY',
      'apiKey',
      'APIKey',
      'xApiKeyHeader',
      'AUTH_TOKEN',
      'bearerToken',
      'password',
      'AWS_SECRET_ACCESS_KEY',
      'sessionId',
      'authorization',
      'creds',
      'pat',
    ]) {
      expect(isSecretKey(k)).toBe(true)
    }
  })

  it('does not flag look-alike non-secret names', () => {
    for (const k of [
      'HOME',
      'PATH',
      'model',
      'timeoutMs',
      'author',
      'authenticated',
      'authorship',
      'tokenizer',
    ]) {
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
  it('walks objects/arrays, masking value-shaped secrets outside secret subtrees', () => {
    expect(
      redactDeep({
        note: 'sk-ant-abcdefgh0123456789',
        list: ['plain', 'ghp_abcdefghijklmnop0123'],
        enabled: true,
        empty: null,
      }),
    ).toEqual({
      note: REDACTED,
      list: ['plain', REDACTED],
      enabled: true,
      empty: null,
    })
  })

  it('taints the entire subtree under a secret-looking key (nested + arrays)', () => {
    expect(
      redactDeep({
        credentials: { value: 'plain-not-a-pattern', nested: { again: 'still-plain' } },
        tokens: ['plain-one', 'plain-two'],
        count: 3,
      }),
    ).toEqual({
      credentials: { value: REDACTED, nested: { again: REDACTED } },
      tokens: [REDACTED, REDACTED],
      count: 3,
    })
  })

  it('passes scalars through unchanged', () => {
    expect(redactDeep(42)).toBe(42)
    expect(redactDeep(null)).toBe(null)
    expect(redactDeep(false)).toBe(false)
  })
})
