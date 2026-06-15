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
  /gh[posu]_[A-Za-z0-9]{16,}/g, // GitHub tokens (ghp_/gho_/ghs_/ghu_)
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack tokens
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\b(?:Bearer|Basic|token)[=:\s]+[A-Za-z0-9._~+/=-]{12,}/gi, // auth headers
]

const SECRET_KEY_RE =
  /(?:secret|token|password|passwd|api[_-]?key|apikey|credential|auth|access[_-]?key|private[_-]?key|session[_-]?(?:id|key|token))/i

/** Replace any value-shaped secrets found inside a string. */
export function redactString(input: string): string {
  let out = input
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/** True when a key *name* (env var / config field) implies a secret value. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key)
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
 * Recursively redact every string in a JSON-like value. A string held under a
 * secret-looking key is fully masked; other strings are scanned for value-shaped
 * secrets; arrays/objects are walked; other scalars pass through unchanged.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as T
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSecretKey(key) && typeof child === 'string' ? REDACTED : redactDeep(child)
    }
    return out as T
  }
  return value
}
