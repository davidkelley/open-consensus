import { z } from 'zod'

/**
 * Wire schemas (plan D17): every request body crossing the socket is parsed
 * through zod before it reaches the engine. Bodies are bounded (the server caps
 * raw byte length first), so deep-parsing them is off the event-loop hot path.
 */

const promptSchema = z.string().min(1, 'prompt is required').max(1_000_000)
const idempotencyKeySchema = z.string().min(1).max(200).optional()

export const startRunBodySchema = z
  .object({
    panel: z.string().min(1).max(64),
    prompt: promptSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict()
export type StartRunBody = z.infer<typeof startRunBodySchema>

export const startRoundBodySchema = z
  .object({ prompt: promptSchema, idempotencyKey: idempotencyKeySchema })
  .strict()
export type StartRoundBody = z.infer<typeof startRoundBodySchema>

/** Clamp a client-supplied long-poll wait to the daemon ceiling (D4). */
export function clampWaitMs(raw: string | null, maxWaitMs: number): number {
  if (raw === null) return maxWaitMs
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, maxWaitMs)
}

/** Parse a non-negative integer query param, falling back to a default. */
export function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}
