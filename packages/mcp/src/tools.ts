import type { RoundSnapshot } from '@open-consensus/daemon'
import { z } from 'zod'
import type { DaemonClient } from './client'

/**
 * The driving model's next step (plan D12). Lets the orchestrator run the
 * start -> poll -> decide -> round loop deterministically off the tool result.
 */
export type NextAction =
  | 'keep_polling'
  | 'review_results'
  | 'start_next_round'
  | 'finalize'
  | 'handle_degraded'

/** Cap a client-supplied long-poll wait so a single tool call stays well under a
 * typical MCP host's tool timeout (the daemon also caps it). */
const MAX_POLL_WAIT_MS = 45_000

function nextActionFor(snapshot: RoundSnapshot): NextAction {
  if (!snapshot.done || !snapshot.round) return 'keep_polling'
  return snapshot.round.verdict === 'met' ? 'review_results' : 'handle_degraded'
}

/**
 * Shape a round snapshot for the model (D4/D6): while the round is in flight,
 * return only per-agent status/attempts (a tiny payload, so repeated polls barely
 * touch the orchestrator's context); once terminal, return the full distilled
 * answers + provenance, and flag truncation so a code-bearing reply isn't judged
 * on a clipped tail.
 */
export function shapeRound(snapshot: RoundSnapshot): Record<string, unknown> {
  const round = snapshot.round
  if (!round) {
    return { done: false, stateVersion: snapshot.stateVersion, next_action: 'keep_polling' }
  }
  const done = snapshot.done
  const agents = round.invocations.map((inv) =>
    done
      ? {
          agentId: inv.agentId,
          status: inv.status,
          attempts: inv.attempts,
          distilled: inv.distilled,
          truncated: inv.truncated,
          durationMs: inv.durationMs,
          ...(inv.errorClass ? { errorClass: inv.errorClass } : {}),
          ...(inv.rawRef ? { rawRef: inv.rawRef } : {}),
        }
      : {
          agentId: inv.agentId,
          status: inv.status,
          attempts: inv.attempts,
          ...(inv.errorClass ? { errorClass: inv.errorClass } : {}),
        },
  )
  const anyTruncated = done && round.invocations.some((i) => i.truncated)
  return {
    runId: round.runId,
    roundId: round.roundId,
    index: round.index,
    quorum: round.quorum,
    stateVersion: snapshot.stateVersion,
    done,
    ...(round.verdict ? { verdict: round.verdict } : {}),
    agents,
    next_action: nextActionFor(snapshot),
    ...(anyTruncated
      ? {
          note: 'some outputs were truncated — call consensus_get_raw for the full text before judging',
        }
      : {}),
  }
}

/** A connection error is transient (D4): the run keeps progressing in the daemon;
 * the orchestrator should simply re-poll the same runId/roundId. */
function isTransport(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code
  return (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOENT' ||
    code === 'EPIPE' ||
    (err instanceof Error && /timed out/.test(err.message))
  )
}

export interface ToolContext {
  client: DaemonClient
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  title: string
  description: string
  inputSchema: S
  handler(ctx: ToolContext, args: z.objectOutputType<S, z.ZodTypeAny>): Promise<unknown>
}

const idempotencyKey = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe('Optional dedup key: a retried call with the same key returns the original result.')

export const TOOLS: ToolDef[] = [
  {
    name: 'consensus_list_panels',
    title: 'List panels',
    description:
      'List the configured consensus panels (id, name, member agents, quorum). Call this first to choose a panel for consensus_start.',
    inputSchema: {},
    async handler(ctx) {
      return { panels: await ctx.client.listPanels() }
    },
  },
  {
    name: 'consensus_list_runs',
    title: 'List runs',
    description:
      'List consensus runs, optionally filtered by state. Use this to re-anchor to in-flight runs after you (the orchestrator) restart — a parked/abandoned run can be re-adopted by polling it.',
    inputSchema: { state: z.enum(['running', 'abandoned']).optional() },
    async handler(ctx, args) {
      return { runs: await ctx.client.listRuns(args.state) }
    },
  },
  {
    name: 'consensus_start',
    title: 'Start a consensus run',
    description:
      'Start a consensus run: fan the prompt out to every agent in `panel` as round 0. Returns runId + roundId immediately (non-blocking). Then call consensus_poll(runId, roundId) until it is done, review the agents, and either consensus_round for another round or finalize. Pass a unique idempotencyKey to make a retry safe.',
    inputSchema: {
      panel: z.string().min(1).describe('Panel id from consensus_list_panels.'),
      prompt: z.string().min(1).describe('Fully-composed prompt for this round.'),
      idempotencyKey,
    },
    async handler(ctx, args) {
      const { runId, roundId } = await ctx.client.startRun(
        args.panel,
        args.prompt,
        args.idempotencyKey,
      )
      return { runId, roundId, next_action: 'keep_polling' satisfies NextAction }
    },
  },
  {
    name: 'consensus_round',
    title: 'Add a round to a run',
    description:
      'Add another round to an existing run with a fresh, fully-composed prompt (you carry the context — rounds are stateless). Requires a valid runId. Returns the new roundId; then poll it. Pass a unique idempotencyKey to make a retry safe.',
    inputSchema: {
      runId: z.string().min(1),
      prompt: z.string().min(1).describe('Fully-composed prompt for the new round.'),
      idempotencyKey,
    },
    async handler(ctx, args) {
      const { roundId } = await ctx.client.startRound(args.runId, args.prompt, args.idempotencyKey)
      return { runId: args.runId, roundId, next_action: 'keep_polling' satisfies NextAction }
    },
  },
  {
    name: 'consensus_poll',
    title: 'Poll a round (long-poll)',
    description:
      'Long-poll a round: returns the moment every agent is terminal, else after wait_ms. While running it returns only per-agent statuses (tiny). When done it returns each agent’s distilled answer, the quorum verdict, and a next_action. A tool error/timeout is TRANSIENT — just call consensus_poll again with the same runId/roundId (the run keeps progressing in the daemon).',
    inputSchema: {
      runId: z.string().min(1),
      roundId: z.string().min(1),
      wait_ms: z.number().int().min(0).max(MAX_POLL_WAIT_MS).optional(),
    },
    async handler(ctx, args) {
      const wait = Math.min(args.wait_ms ?? MAX_POLL_WAIT_MS, MAX_POLL_WAIT_MS)
      try {
        return shapeRound(await ctx.client.poll(args.runId, args.roundId, wait))
      } catch (err) {
        if (isTransport(err)) {
          return {
            transient: true,
            next_action: 'keep_polling' satisfies NextAction,
            note: 'daemon temporarily unreachable; re-poll the same runId/roundId',
          }
        }
        throw err
      }
    },
  },
  {
    name: 'consensus_status',
    title: 'Run status',
    description:
      'Snapshot a run and its most recent round without blocking. Also heartbeats the run so the idle reaper does not park it while you reason. Returns a next_action hint.',
    inputSchema: { runId: z.string().min(1) },
    async handler(ctx, args) {
      const s = await ctx.client.status(args.runId)
      return {
        run: s.run,
        stateVersion: s.stateVersion,
        round: s.round
          ? shapeRound({
              round: s.round,
              stateVersion: s.stateVersion,
              done: s.round.state === 'complete',
            })
          : undefined,
      }
    },
  },
  {
    name: 'consensus_cancel',
    title: 'Cancel a run',
    description:
      'Cancel a run: tree-kills every in-flight agent of every in-flight round. Returns how many rounds were cancelled.',
    inputSchema: { runId: z.string().min(1) },
    async handler(ctx, args) {
      return ctx.client.cancelRun(args.runId)
    },
  },
  {
    name: 'consensus_cancel_agent',
    title: 'Cancel a round (an agent’s round)',
    description:
      'Cancel the round containing an agent. NOTE: v1 cancels at ROUND granularity (the whole round, hence all its agents) — finer per-agent cancellation is a future enhancement. Returns whether a round was cancelled.',
    inputSchema: {
      runId: z.string().min(1),
      roundId: z.string().min(1),
      agentId: z
        .string()
        .min(1)
        .describe('Recorded for forward-compat; v1 cancels the whole round.'),
    },
    async handler(ctx, args) {
      return ctx.client.cancelRound(args.runId, args.roundId)
    },
  },
  {
    name: 'consensus_get_raw',
    title: 'Fetch raw agent output (paginated)',
    description:
      'Fetch the full raw output for a rawRef (from a poll result), paginated by byte cursor with a hard per-call cap. Page with `cursor` until `eof`. Use this when an answer was truncated or you need the complete transcript — never returns an unbounded payload.',
    inputSchema: {
      rawRef: z.string().min(1),
      cursor: z.number().int().min(0).optional(),
      maxBytes: z.number().int().min(1).optional(),
    },
    async handler(ctx, args) {
      return ctx.client.getRaw(args.rawRef, args.cursor, args.maxBytes)
    },
  },
]
