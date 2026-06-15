import { type DaemonResponse, type RoundSnapshot, daemonRequest } from '@open-consensus/daemon'
import type { RoundRecord, RunRecord } from '@open-consensus/engine'

/** A daemon panel summary (as returned by GET /panels). */
export interface PanelSummary {
  id: string
  name: string
  agentIds: string[]
  quorum: number
}

export interface RunStatus {
  run: RunRecord
  round: RoundRecord | undefined
  stateVersion: number
}

export interface RawPage {
  chunk: string
  nextCursor: number
  eof: boolean
}

/** A non-2xx response from the daemon (the tool layer maps it to an MCP error). */
export class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DaemonError'
  }
}

/**
 * Typed view of the daemon's HTTP surface (plan D12). The MCP tools speak to this
 * rather than to `daemonRequest` directly, so they can be unit-tested against a
 * fake client and the real client stays a thin adapter.
 */
export interface DaemonClient {
  listPanels(): Promise<PanelSummary[]>
  listRuns(state?: 'running' | 'abandoned'): Promise<RunRecord[]>
  startRun(
    panel: string,
    prompt: string,
    idempotencyKey?: string,
  ): Promise<{ runId: string; roundId: string }>
  startRound(runId: string, prompt: string, idempotencyKey?: string): Promise<{ roundId: string }>
  poll(runId: string, roundId: string, waitMs?: number): Promise<RoundSnapshot>
  status(runId: string): Promise<RunStatus>
  cancelRun(runId: string): Promise<{ cancelled: number }>
  cancelRound(runId: string, roundId: string): Promise<{ cancelled: boolean }>
  getRaw(rawRef: string, cursor?: number, maxBytes?: number): Promise<RawPage>
}

/** Cap a forwarded error string so an unexpected (e.g. proxy) body can't dump an
 * unbounded blob into the orchestrator's context. */
const MAX_ERROR_CHARS = 500

function parse<T>(res: DaemonResponse): T {
  if (res.status < 200 || res.status >= 300) {
    let message = res.body
    try {
      const parsed = (JSON.parse(res.body) as { error?: unknown }).error
      if (typeof parsed === 'string') message = parsed
    } catch {
      /* non-JSON error body */
    }
    throw new DaemonError(res.status, String(message).slice(0, MAX_ERROR_CHARS))
  }
  return JSON.parse(res.body) as T
}

const enc = encodeURIComponent

/** The production client: every call is one round-trip to the daemon endpoint. */
export function httpDaemonClient(endpoint: string, token: string): DaemonClient {
  const req = (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<DaemonResponse> =>
    daemonRequest(endpoint, token, {
      method,
      path,
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })

  return {
    async listPanels() {
      return parse<{ panels: PanelSummary[] }>(await req('GET', '/panels')).panels
    },
    async listRuns(state) {
      const q = state ? `?state=${state}` : ''
      return parse<{ runs: RunRecord[] }>(await req('GET', `/runs${q}`)).runs
    },
    async startRun(panel, prompt, idempotencyKey) {
      return parse(
        await req('POST', '/runs', {
          panel,
          prompt,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      )
    },
    async startRound(runId, prompt, idempotencyKey) {
      return parse(
        await req('POST', `/runs/${enc(runId)}/rounds`, {
          prompt,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        }),
      )
    },
    async poll(runId, roundId, waitMs) {
      const q = waitMs !== undefined ? `?wait_ms=${waitMs}` : ''
      // The long-poll legitimately blocks; no client timeout.
      return parse(await req('GET', `/runs/${enc(runId)}/rounds/${enc(roundId)}${q}`))
    },
    async status(runId) {
      return parse(await req('GET', `/runs/${enc(runId)}/status`))
    },
    async cancelRun(runId) {
      return parse(await req('POST', `/runs/${enc(runId)}/cancel`))
    },
    async cancelRound(runId, roundId) {
      return parse(await req('POST', `/runs/${enc(runId)}/rounds/${enc(roundId)}/cancel`))
    },
    async getRaw(rawRef, cursor, maxBytes) {
      const params = new URLSearchParams({ ref: rawRef })
      if (cursor !== undefined) params.set('cursor', String(cursor))
      if (maxBytes !== undefined) params.set('maxBytes', String(maxBytes))
      return parse(await req('GET', `/raw?${params.toString()}`))
    },
  }
}
