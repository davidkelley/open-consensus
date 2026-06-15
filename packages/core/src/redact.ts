/**
 * Secret redaction (plan D10/D20). Secrets must be scrubbed **before** anything
 * is written to logs, the SSE stream, the TUI, or persistence. Two layers:
 *  - value-shape patterns (API-key / token / JWT / auth-header formats), and
 *  - key-name heuristics (env vars / config fields whose *name* implies a secret).
 *
 * This is defense-in-depth, not a guarantee: redaction is best-effort and errs
 * toward over-redaction. Callers should still avoid logging raw env/argv.
 */

export const REDACTED = '[REDACTED]'

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{12,}/g, // Anthropic API keys
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /sk_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe secret keys
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /gh[posu]_[A-Za-z0-9]{16,}/g, // GitHub classic tokens (ghp_/gho_/ghs_/ghu_)
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /AIza[A-Za-z0-9_-]{20,}/g, // Google API keys
  /xox[abprse]-[A-Za-z0-9-]{8,}/g, // Slack tokens (incl. xoxe)
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\b(?:Bearer|Basic|token)[=:\s]+[A-Za-z0-9._~+/=-]{12,}/gi, // auth headers
]

const SECRET_KEY_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'apikey',
  'credential',
  'credentials',
  'auth',
  'authorization',
  'accesskey',
  'privatekey',
  'sessionkey',
  'sessiontoken',
  'sessionid',
])

/** Split a key name into lowercase word tokens (camelCase + separators). */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0)
}

/** Replace any value-shaped secrets found inside a string. */
export function redactString(input: string): string {
  let out = input
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/**
 * True when a key *name* implies a secret value. Token-aware so `AUTH_TOKEN` /
 * `apiKey` match while `author` / `authenticated` / `tokenizer` do not. Adjacent
 * tokens are also joined so `api_key` and `apiKey` both resolve to `apikey`.
 */
export function isSecretKey(key: string): boolean {
  const tokens = keyTokens(key)
  for (let i = 0; i < tokens.length; i++) {
    if (SECRET_KEY_WORDS.has(tokens[i] as string)) return true
    const joined = `${tokens[i]}${tokens[i + 1] ?? ''}`
    if (i + 1 < tokens.length && SECRET_KEY_WORDS.has(joined)) return true
  }
  return false
}

/**
 * Redact an environment map for logging/persistence: keys are preserved, but a
 * value is fully masked when its key looks secret, otherwise scanned for
 * value-shaped secrets. `undefined` values are dropped.
 */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    out[key] = isSecretKey(key) ? REDACTED : redactString(value)
  }
  return out
}

/**
 * Recursively redact every string in a JSON-like value. A secret-looking key
 * **taints its entire subtree** — every string nested under it is fully masked
 * (objects/arrays included), not just an immediate string child. Strings outside
 * a secret subtree are scanned for value-shaped secrets; non-string scalars pass
 * through unchanged.
 */
export function redactDeep<T>(value: T, inSecretContext = false): T {
  if (typeof value === 'string') return (inSecretContext ? REDACTED : redactString(value)) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, inSecretContext)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactDeep(child, inSecretContext || isSecretKey(key))
    }
    return out as T
  }
  return value
}
