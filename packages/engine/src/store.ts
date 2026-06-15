import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  type InvocationRecord,
  type QuorumVerdict,
  type RoundRecord,
  type RunRecord,
  type RunState,
  computeVerdict,
} from './model'

const SCHEMA_VERSION = 1

export interface StoreOptions {
  /** SQLite file path (`:memory:` for tests). */
  dbPath: string
  /** Directory for raw output blobs. */
  rawDir: string
}

/** Safe, reversible filename for a `runId/roundId/agentId/attempt` raw ref. */
function rawFilename(rawRef: string): string {
  return `${rawRef.replace(/[^A-Za-z0-9._-]/g, '_')}.raw`
}

interface RoundRow {
  roundId: string
  runId: string
  idx: number
  prompt: string
  quorum: number
  state: string
  verdict: string | null
}

interface InvocationRow {
  agentId: string
  status: string
  attempts: number
  distilled: string
  errorClass: string | null
  durationMs: number
  truncated: number
  rawRef: string | null
}

/**
 * Engine persistence (plan D9): small metadata + an append-only event log in
 * SQLite; raw output blobs streamed to capped files on disk. Synchronous
 * (better-sqlite3) — rows are kept small so reads stay off the event-loop
 * critical path.
 */
export class EngineStore {
  private readonly db: Database.Database
  private readonly rawDir: string

  constructor(options: StoreOptions) {
    this.db = new Database(options.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.rawDir = options.rawDir
    mkdirSync(this.rawDir, { recursive: true })
    this.migrate()
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number
    if (current < 1) {
      this.db.exec(`
        CREATE TABLE runs (
          runId TEXT PRIMARY KEY,
          panelId TEXT NOT NULL,
          state TEXT NOT NULL,
          createdAt INTEGER NOT NULL
        );
        CREATE TABLE rounds (
          roundId TEXT PRIMARY KEY,
          runId TEXT NOT NULL,
          idx INTEGER NOT NULL,
          prompt TEXT NOT NULL,
          quorum INTEGER NOT NULL,
          state TEXT NOT NULL,
          verdict TEXT
        );
        CREATE INDEX rounds_runId ON rounds(runId);
        CREATE TABLE invocations (
          roundId TEXT NOT NULL,
          agentId TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          distilled TEXT NOT NULL,
          errorClass TEXT,
          durationMs INTEGER NOT NULL,
          truncated INTEGER NOT NULL,
          rawRef TEXT,
          PRIMARY KEY (roundId, agentId)
        );
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          runId TEXT,
          payload TEXT NOT NULL
        );
      `)
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    }
  }

  // -- writes -------------------------------------------------------------

  createRun(run: RunRecord): void {
    this.db
      .prepare('INSERT INTO runs (runId, panelId, state, createdAt) VALUES (?, ?, ?, ?)')
      .run(run.runId, run.panelId, run.state, run.createdAt)
  }

  setRunState(runId: string, state: RunState): void {
    this.db.prepare('UPDATE runs SET state = ? WHERE runId = ?').run(state, runId)
  }

  startRound(round: Omit<RoundRecord, 'invocations' | 'verdict'>): void {
    this.db
      .prepare(
        'INSERT INTO rounds (roundId, runId, idx, prompt, quorum, state, verdict) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(round.roundId, round.runId, round.index, round.prompt, round.quorum, round.state)
  }

  upsertInvocation(roundId: string, inv: InvocationRecord): void {
    this.db
      .prepare(`
        INSERT INTO invocations
          (roundId, agentId, status, attempts, distilled, errorClass, durationMs, truncated, rawRef)
        VALUES (@roundId, @agentId, @status, @attempts, @distilled, @errorClass, @durationMs, @truncated, @rawRef)
        ON CONFLICT(roundId, agentId) DO UPDATE SET
          status=@status, attempts=@attempts, distilled=@distilled, errorClass=@errorClass,
          durationMs=@durationMs, truncated=@truncated, rawRef=@rawRef
      `)
      .run({
        roundId,
        agentId: inv.agentId,
        status: inv.status,
        attempts: inv.attempts,
        distilled: inv.distilled,
        errorClass: inv.errorClass ?? null,
        durationMs: inv.durationMs,
        truncated: inv.truncated ? 1 : 0,
        rawRef: inv.rawRef ?? null,
      })
  }

  completeRound(roundId: string, verdict: QuorumVerdict): void {
    this.db
      .prepare("UPDATE rounds SET state = 'complete', verdict = ? WHERE roundId = ?")
      .run(verdict, roundId)
  }

  appendEvent(runId: string | null, payload: string): number {
    const info = this.db
      .prepare('INSERT INTO events (runId, payload) VALUES (?, ?)')
      .run(runId, payload)
    return Number(info.lastInsertRowid)
  }

  // -- raw blobs ----------------------------------------------------------

  writeRaw(rawRef: string, data: Buffer): void {
    writeFileSync(join(this.rawDir, rawFilename(rawRef)), data, { mode: 0o600 })
  }

  /** Paginated raw read (plan D6/D12): byte-offset cursor, hard per-call cap. */
  readRaw(
    rawRef: string,
    cursor = 0,
    maxBytes = 64_000,
  ): { chunk: string; nextCursor: number; eof: boolean } {
    let buf: Buffer
    try {
      buf = readFileSync(join(this.rawDir, rawFilename(rawRef)))
    } catch {
      return { chunk: '', nextCursor: cursor, eof: true }
    }
    const end = Math.min(cursor + maxBytes, buf.byteLength)
    return {
      chunk: buf.subarray(cursor, end).toString('utf8'),
      nextCursor: end,
      eof: end >= buf.byteLength,
    }
  }

  // -- reads --------------------------------------------------------------

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE runId = ?').get(runId) as
      | (RunRecord & { state: string })
      | undefined
    return row ? { ...row, state: row.state as RunState } : undefined
  }

  countRounds(runId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE runId = ?').get(runId) as {
        n: number
      }
    ).n
  }

  listRuns(state?: RunState): RunRecord[] {
    const rows = state
      ? (this.db
          .prepare('SELECT * FROM runs WHERE state = ? ORDER BY createdAt')
          .all(state) as RunRecord[])
      : (this.db.prepare('SELECT * FROM runs ORDER BY createdAt').all() as RunRecord[])
    return rows
  }

  getRound(roundId: string): RoundRecord | undefined {
    const row = this.db.prepare('SELECT * FROM rounds WHERE roundId = ?').get(roundId) as
      | RoundRow
      | undefined
    if (!row) return undefined
    const invRows = this.db
      .prepare('SELECT * FROM invocations WHERE roundId = ? ORDER BY agentId')
      .all(roundId) as InvocationRow[]
    return {
      roundId: row.roundId,
      runId: row.runId,
      index: row.idx,
      prompt: row.prompt,
      quorum: row.quorum,
      state: row.state as RoundRecord['state'],
      ...(row.verdict ? { verdict: row.verdict as QuorumVerdict } : {}),
      invocations: invRows.map((r) => ({
        agentId: r.agentId,
        status: r.status as InvocationRecord['status'],
        attempts: r.attempts,
        distilled: r.distilled,
        ...(r.errorClass ? { errorClass: r.errorClass } : {}),
        durationMs: r.durationMs,
        truncated: r.truncated === 1,
        ...(r.rawRef ? { rawRef: r.rawRef } : {}),
      })),
    }
  }

  // -- reconcile (plan D15) ----------------------------------------------

  /**
   * Crash recovery: any invocation left `running`/`pending` is advanced to
   * terminal `interrupted` (the external process is gone — never re-issued
   * silently), and any `running` round is recomputed to a terminal verdict.
   * Returns the round ids that were repaired.
   */
  reconcile(): { repairedRounds: string[] } {
    const repaired: string[] = []
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE invocations SET status = 'interrupted' WHERE status IN ('running', 'pending')",
        )
        .run()
      const runningRounds = this.db
        .prepare("SELECT roundId, quorum FROM rounds WHERE state = 'running'")
        .all() as { roundId: string; quorum: number }[]
      for (const { roundId, quorum } of runningRounds) {
        const round = this.getRound(roundId)
        if (!round) continue
        const verdict = computeVerdict(round.invocations, quorum)
        this.completeRound(roundId, verdict)
        repaired.push(roundId)
      }
    })
    tx()
    return { repairedRounds: repaired }
  }

  /** Delete a run and all its rows + raw blobs (coordinated prune, D16). */
  pruneRun(runId: string): void {
    const tx = this.db.transaction(() => {
      const rounds = this.db.prepare('SELECT roundId FROM rounds WHERE runId = ?').all(runId) as {
        roundId: string
      }[]
      for (const { roundId } of rounds) {
        const invs = this.db
          .prepare('SELECT rawRef FROM invocations WHERE roundId = ? AND rawRef IS NOT NULL')
          .all(roundId) as { rawRef: string }[]
        for (const { rawRef } of invs) {
          rmSync(join(this.rawDir, rawFilename(rawRef)), { force: true })
        }
        this.db.prepare('DELETE FROM invocations WHERE roundId = ?').run(roundId)
      }
      this.db.prepare('DELETE FROM rounds WHERE runId = ?').run(runId)
      this.db.prepare('DELETE FROM events WHERE runId = ?').run(runId)
      this.db.prepare('DELETE FROM runs WHERE runId = ?').run(runId)
    })
    tx()
  }

  close(): void {
    this.db.close()
  }
}
