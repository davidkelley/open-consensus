import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  type InvocationRecord,
  type QuorumVerdict,
  type RoundRecord,
  type RunRecord,
  type RunState,
  computeVerdict,
  invocationRecordSchema,
  quorumVerdictSchema,
  roundRecordSchema,
  runRecordSchema,
  runStateSchema,
} from './model'

/**
 * Validate records at the persistence boundary (D17). Inserts/updates validate
 * the record being written, so a bug can never persist a malformed row. Bounded
 * single-record READS (getRun/getRound) also validate, so a hand-edited or
 * migration-corrupted DB row is caught rather than silently propagated — large
 * result sets / raw blobs stay light per D17.
 */
const roundWriteSchema = roundRecordSchema.omit({ invocations: true, verdict: true })
/** Read-side tightening (D17): a `complete` round must carry a verdict, so a row
 * corrupted to complete-without-verdict is caught rather than read back as a
 * finished round with no result. */
const roundReadSchema = roundRecordSchema.refine(
  (r) => r.state !== 'complete' || r.verdict !== undefined,
  { message: 'a complete round must have a verdict' },
)

/** A persisted boolean column is 0 or 1; any other value is corruption (D17). */
function toBool01(n: number): boolean {
  if (n !== 0 && n !== 1) throw new Error(`corrupt boolean column value: ${n}`)
  return n === 1
}

const SCHEMA_VERSION = 3

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
    if (current >= SCHEMA_VERSION) return
    // Ordered, incremental migrations (D17), transactional + idempotent (IF NOT
    // EXISTS) so a restart race or a half-applied prior step can't corrupt schema.
    const tx = this.db.transaction(() => {
      if (current < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS runs (
            runId TEXT PRIMARY KEY,
            panelId TEXT NOT NULL,
            state TEXT NOT NULL,
            createdAt INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS rounds (
            roundId TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            idx INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            quorum INTEGER NOT NULL,
            state TEXT NOT NULL,
            verdict TEXT,
            FOREIGN KEY (runId) REFERENCES runs(runId) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS rounds_runId ON rounds(runId);
          CREATE TABLE IF NOT EXISTS invocations (
            roundId TEXT NOT NULL,
            agentId TEXT NOT NULL,
            status TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            distilled TEXT NOT NULL,
            errorClass TEXT,
            durationMs INTEGER NOT NULL,
            truncated INTEGER NOT NULL,
            rawRef TEXT,
            PRIMARY KEY (roundId, agentId),
            FOREIGN KEY (roundId) REFERENCES rounds(roundId) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            runId TEXT,
            payload TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS events_runId ON events(runId);
        `)
      }
      if (current < 2) {
        // Orphan process-group registry (D10): the daemon records each spawned
        // detached pgid here and sweeps entries left by a prior instance on start.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS pgids (
            pgid INTEGER PRIMARY KEY,
            daemonId TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS pgids_daemonId ON pgids(daemonId);
        `)
      }
      if (current < 3) {
        // Durable idempotency keys (D12): a replayed consensus_start/round returns
        // the original run/round. FK cascade prunes a run's keys with it (D16).
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS idempotency (
            key TEXT PRIMARY KEY,
            runId TEXT NOT NULL,
            roundId TEXT NOT NULL,
            FOREIGN KEY (runId) REFERENCES runs(runId) ON DELETE CASCADE
          );
        `)
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })
    tx()
  }

  // -- writes -------------------------------------------------------------

  createRun(run: RunRecord): void {
    runRecordSchema.parse(run) // validate on write (D17)
    this.db
      .prepare('INSERT INTO runs (runId, panelId, state, createdAt) VALUES (?, ?, ?, ?)')
      .run(run.runId, run.panelId, run.state, run.createdAt)
  }

  setRunState(runId: string, state: RunState): void {
    runStateSchema.parse(state) // validate on write (D17)
    this.db.prepare('UPDATE runs SET state = ? WHERE runId = ?').run(state, runId)
  }

  startRound(round: Omit<RoundRecord, 'invocations' | 'verdict'>): void {
    roundWriteSchema.parse(round) // validate on write (D17)
    this.db
      .prepare(
        'INSERT INTO rounds (roundId, runId, idx, prompt, quorum, state, verdict) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      )
      .run(round.roundId, round.runId, round.index, round.prompt, round.quorum, round.state)
  }

  /**
   * Atomically start a round AND insert a `pending` row for every agent, so a
   * crash mid-setup can never leave a `running` round with a partial agent set
   * (which would make reconcile compute a verdict from missing agents).
   */
  startRoundWithPending(
    round: Omit<RoundRecord, 'invocations' | 'verdict'>,
    agentIds: readonly string[],
  ): void {
    const tx = this.db.transaction(() => {
      this.startRound(round)
      for (const agentId of agentIds) {
        this.upsertInvocation(round.roundId, {
          agentId,
          status: 'pending',
          attempts: 0,
          distilled: '',
          durationMs: 0,
          truncated: false,
        })
      }
    })
    tx()
  }

  upsertInvocation(roundId: string, inv: InvocationRecord): void {
    invocationRecordSchema.parse(inv) // validate on write (D17)
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
    quorumVerdictSchema.parse(verdict) // validate on write (D17)
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

  /**
   * Atomically apply a state mutation AND append its event to the durable log in
   * one transaction, returning the event's durable seq. Guarantees the state
   * tables and the event log never disagree after a crash (the engine emits to
   * the in-memory bus only after this commits).
   */
  commitWithEvent(runId: string, payload: string, mutate: () => void): number {
    let seq = 0
    this.db.transaction(() => {
      mutate()
      seq = this.appendEvent(runId, payload)
    })()
    return seq
  }

  /**
   * Like {@link commitWithEvent} but appends SEVERAL events in one transaction —
   * for an operation that spans multiple state transitions (e.g. open a run AND
   * its first round atomically, D12). Returns the events' durable seqs in order.
   */
  commitWithEvents(runId: string, payloads: readonly string[], mutate: () => void): number[] {
    const seqs: number[] = []
    this.db.transaction(() => {
      mutate()
      for (const p of payloads) seqs.push(this.appendEvent(runId, p))
    })()
    return seqs
  }

  // -- orphan process-group registry (plan D10) --------------------------

  /** Record a spawned detached pgid against the owning daemon instance. */
  recordPgid(pgid: number, daemonId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO pgids (pgid, daemonId) VALUES (?, ?)')
      .run(pgid, daemonId)
  }

  /** Forget a pgid once its child has terminated. */
  removePgid(pgid: number): void {
    this.db.prepare('DELETE FROM pgids WHERE pgid = ?').run(pgid)
  }

  /** Pgids recorded by a PRIOR daemon instance — the startup sweep's targets. */
  foreignPgids(currentDaemonId: string): number[] {
    return (
      this.db.prepare('SELECT pgid FROM pgids WHERE daemonId != ?').all(currentDaemonId) as {
        pgid: number
      }[]
    ).map((r) => r.pgid)
  }

  /** Drop all entries not owned by the current daemon (after sweeping them). */
  clearForeignPgids(currentDaemonId: string): void {
    this.db.prepare('DELETE FROM pgids WHERE daemonId != ?').run(currentDaemonId)
  }

  // -- idempotency (plan D12) --------------------------------------------

  /** Look up the run/round a prior call with this key created (replay dedup). */
  getIdempotent(key: string): { runId: string; roundId: string } | undefined {
    return this.db.prepare('SELECT runId, roundId FROM idempotency WHERE key = ?').get(key) as
      | { runId: string; roundId: string }
      | undefined
  }

  /**
   * Atomically claim a key for (runId, roundId) and return the WINNING mapping —
   * the existing one if a concurrent writer beat us, ours otherwise. The INSERT +
   * read run in one transaction with the key as PRIMARY KEY, so exactly one
   * mapping wins even under concurrency (the caller compares and discards a losing
   * just-created run). FK-valid because the run row already exists at call time.
   */
  reserveIdempotent(
    key: string,
    runId: string,
    roundId: string,
  ): { runId: string; roundId: string } {
    return this.db.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO idempotency (key, runId, roundId) VALUES (?, ?, ?)')
        .run(key, runId, roundId)
      return this.db.prepare('SELECT runId, roundId FROM idempotency WHERE key = ?').get(key) as {
        runId: string
        roundId: string
      }
    })()
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
    let end = Math.min(cursor + maxBytes, buf.byteLength)
    // Never split a multi-byte UTF-8 codepoint across a page boundary (a mid-
    // codepoint cut would decode to U+FFFD and corrupt the reassembled stream).
    // Advance forward over any continuation bytes so the chunk ends on a boundary
    // — `maxBytes` is a soft cap that may be exceeded by up to 3 bytes.
    while (end < buf.byteLength && ((buf[end] as number) & 0xc0) === 0x80) end++
    return {
      chunk: buf.subarray(cursor, end).toString('utf8'),
      nextCursor: end,
      eof: end >= buf.byteLength,
    }
  }

  // -- reads --------------------------------------------------------------

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE runId = ?').get(runId)
    // Validate on read (D17): a hand-edited/corrupt row (e.g. an invalid `state`)
    // is caught here rather than silently propagated into the daemon/TUI.
    return row ? runRecordSchema.parse(row) : undefined
  }

  /**
   * Durable events after `sinceSeq` (snapshot replay + daemon SSE backfill).
   * `hasMore` tells the caller to page again (sinceSeq = last seq) so a long run
   * with > `limit` events is never silently truncated. (Fetches one extra row to
   * detect truncation precisely.)
   */
  readEvents(
    sinceSeq = 0,
    limit = 1000,
  ): { events: { seq: number; runId: string | null; payload: string }[]; hasMore: boolean } {
    const rows = this.db
      .prepare('SELECT seq, runId, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(sinceSeq, limit + 1) as { seq: number; runId: string | null; payload: string }[]
    const hasMore = rows.length > limit
    return { events: hasMore ? rows.slice(0, limit) : rows, hasMore }
  }

  /** Highest durable event seq for a run — the snapshot `stateVersion` (D4/D11). */
  latestSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS seq FROM events WHERE runId = ?')
      .get(runId) as {
      seq: number | null
    }
    return row.seq ?? 0
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
      ? this.db.prepare('SELECT * FROM runs WHERE state = ? ORDER BY createdAt').all(state)
      : this.db.prepare('SELECT * FROM runs ORDER BY createdAt').all()
    return rows.map((row) => runRecordSchema.parse(row)) // validate on read (D17)
  }

  getRound(roundId: string): RoundRecord | undefined {
    const row = this.db.prepare('SELECT * FROM rounds WHERE roundId = ?').get(roundId) as
      | RoundRow
      | undefined
    if (!row) return undefined
    const invRows = this.db
      .prepare('SELECT * FROM invocations WHERE roundId = ? ORDER BY agentId')
      .all(roundId) as InvocationRow[]
    // Validate the assembled record on read (D17) — a corrupt status/verdict/state
    // /boolean is caught here, not propagated downstream.
    return roundReadSchema.parse({
      roundId: row.roundId,
      runId: row.runId,
      index: row.idx,
      prompt: row.prompt,
      quorum: row.quorum,
      state: row.state,
      ...(row.verdict ? { verdict: row.verdict } : {}),
      invocations: invRows.map((r) => ({
        agentId: r.agentId,
        status: r.status,
        attempts: r.attempts,
        distilled: r.distilled,
        ...(r.errorClass ? { errorClass: r.errorClass } : {}),
        durationMs: r.durationMs,
        truncated: toBool01(r.truncated),
        ...(r.rawRef ? { rawRef: r.rawRef } : {}),
      })),
    })
  }

  /** The most recent round of a run (highest index) — used by `status` (D12). */
  latestRound(runId: string): RoundRecord | undefined {
    const row = this.db
      .prepare('SELECT roundId FROM rounds WHERE runId = ? ORDER BY idx DESC LIMIT 1')
      .get(runId) as { roundId: string } | undefined
    return row ? this.getRound(row.roundId) : undefined
  }

  // -- reconcile (plan D15) ----------------------------------------------

  /**
   * Crash recovery: any invocation left `running`/`pending` is advanced to
   * terminal `interrupted` (the external process is gone — never re-issued
   * silently), and any `running` round is recomputed to a terminal verdict.
   * Returns the round ids that were repaired.
   */
  reconcile(): { repairedRounds: string[] } {
    // Startup-only repair: there are no live SSE subscribers yet, so we append
    // the terminal transitions to the DURABLE log (not the in-memory EventBus) —
    // a fresh daemon replays the log and sees a consistent terminal history.
    const repaired: string[] = []
    const tx = this.db.transaction(() => {
      const insertEvent = this.db.prepare('INSERT INTO events (runId, payload) VALUES (?, ?)')
      // Log an invocation-finished(interrupted) for every in-flight agent BEFORE
      // flipping them, so the event log shows each agent reaching a terminal
      // state rather than silently vanishing.
      const interrupted = this.db
        .prepare(
          `SELECT i.roundId, i.agentId, i.attempts, r.runId FROM invocations i
           JOIN rounds r ON r.roundId = i.roundId
           WHERE i.status IN ('running', 'pending')`,
        )
        .all() as { roundId: string; agentId: string; attempts: number; runId: string }[]
      for (const inv of interrupted) {
        insertEvent.run(
          inv.runId,
          JSON.stringify({
            type: 'invocation-finished',
            runId: inv.runId,
            roundId: inv.roundId,
            agentId: inv.agentId,
            status: 'interrupted',
            attempts: inv.attempts,
          }),
        )
      }
      this.db
        .prepare(
          "UPDATE invocations SET status = 'interrupted' WHERE status IN ('running', 'pending')",
        )
        .run()
      const runningRounds = this.db
        .prepare("SELECT roundId, runId, quorum FROM rounds WHERE state = 'running'")
        .all() as { roundId: string; runId: string; quorum: number }[]
      for (const { roundId, runId, quorum } of runningRounds) {
        const round = this.getRound(roundId)
        if (!round) continue
        const verdict = computeVerdict(round.invocations, quorum)
        this.completeRound(roundId, verdict)
        // Append the terminal transition to the durable log so SSE clients on a
        // fresh daemon don't see the round stuck 'running'.
        insertEvent.run(runId, JSON.stringify({ type: 'round-completed', runId, roundId, verdict }))
        repaired.push(roundId)
      }
    })
    tx()
    return { repairedRounds: repaired }
  }

  /** Delete a run and all its rows + raw blobs (coordinated prune, D16). */
  pruneRun(runId: string): void {
    // Delete rows first (committed atomically); then sweep the blobs. A crash
    // between leaves harmless orphan blobs, never dangling rows that point at
    // missing files.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE runId = ?').run(runId)
      // FK ON DELETE CASCADE removes the run's rounds and their invocations.
      this.db.prepare('DELETE FROM runs WHERE runId = ?').run(runId)
    })()
    // Sweep EVERY raw blob for the run (incl. every retry attempt) by filename
    // prefix — not just the rawRefs still referenced by the final invocations.
    const prefix = `${runId.replace(/[^A-Za-z0-9._-]/g, '_')}.`
    for (const name of readdirSync(this.rawDir)) {
      if (name.startsWith(prefix)) rmSync(join(this.rawDir, name), { force: true })
    }
  }

  close(): void {
    this.db.close()
  }
}
