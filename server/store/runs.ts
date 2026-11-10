// The runs the service started, their events as the session reported them, the loop's state
// and the service's heartbeat. The ending is the service's word on how the session ended; the
// verdict is the pipeline's, read from the run's state.md. See .about/glossary.md.
import type { SessionEvent } from '../session/driver.ts'
import { nowIso, transaction, type Db } from './db.ts'

export type Ending = 'completed' | 'usage-limit' | 'error' | 'cancelled' | 'timeout' | 'restart' | 'exited' | 'no-result'

export type RunRecord = {
  id: number
  key: string
  summary: string | null
  /** A screen migration, as the ticket's Jira labels said when it was queued or its assignment says. */
  migration: boolean
  startedAt: string
  endedAt: string | null
  ending: Ending | null
  endingDetail: string | null
  verdict: string | null
  runDir: string | null
  stage: string | null
  stageSince: string | null
  cancelRequestedAt: string | null
  logPath: string | null
}

export type RunEvent = { id: number; runId: number; at: string; type: SessionEvent['type']; event: SessionEvent }

export type LoopState = {
  wanted: 'running' | 'stopped'
  stoppedReason: 'operator' | 'usage-limit' | 'restart' | 'entry-point' | null
  stoppedAt: string | null
  /** Why the entry point refused a run, when that stopped the loop. */
  stoppedDetail: string | null
  usageLimitResetsAt: number | null
  /** When the loop was last started; null before the first start. */
  startedAt: string | null
}

export type ServiceInfo = { pid: number; startedAt: string; seenAt: string }

const RUN_COLUMNS =
  'id, key, summary, migration, started_at, ended_at, ending, ending_detail, verdict, run_dir, stage, stage_since, cancel_requested_at, log_path'

export function insertRun(
  db: Db,
  run: { key: string; summary: string | null; migration?: boolean; startedAt: string; logPath: string | null },
): number {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO runs (key, summary, migration, started_at, log_path) VALUES (?, ?, ?, ?, ?)')
    .run(run.key, run.summary, run.migration ? 1 : 0, run.startedAt, run.logPath)
  return Number(lastInsertRowid)
}

export function getRun(db: Db, id: number): RunRecord | null {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id)
  return row ? runOf(row) : null
}

/** The run going on now: at most one. */
export function inFlight(db: Db): RunRecord | null {
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE ending IS NULL ORDER BY id DESC LIMIT 1`).get()
  return row ? runOf(row) : null
}

export function listRuns(db: Db, limit = 20): RunRecord[] {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT ?`).all(limit).map(runOf)
}

export function updateRun(
  db: Db,
  id: number,
  patch: Partial<
    Pick<
      RunRecord,
      'summary' | 'migration' | 'endedAt' | 'ending' | 'endingDetail' | 'verdict' | 'runDir' | 'stage' | 'stageSince' | 'cancelRequestedAt'
    >
  >,
): void {
  const columns: Record<string, string> = {
    summary: 'summary',
    migration: 'migration',
    endedAt: 'ended_at',
    ending: 'ending',
    endingDetail: 'ending_detail',
    verdict: 'verdict',
    runDir: 'run_dir',
    stage: 'stage',
    stageSince: 'stage_since',
    cancelRequestedAt: 'cancel_requested_at',
  }
  const entries = Object.entries(patch).filter(([k]) => k in columns)
  if (entries.length === 0) return
  const sets = entries.map(([k]) => `${columns[k]} = ?`).join(', ')
  // SQLite has no boolean: a flag is bound as 0 or 1.
  db.prepare(`UPDATE runs SET ${sets} WHERE id = ?`).run(
    ...entries.map(([, v]) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null))),
    id,
  )
}

export function addEvent(db: Db, runId: number, event: SessionEvent): void {
  db.prepare('INSERT INTO run_events (run_id, at, type, payload) VALUES (?, ?, ?, ?)').run(
    runId,
    event.at,
    event.type,
    JSON.stringify(event),
  )
}

export function listEvents(db: Db, runId: number): RunEvent[] {
  return db
    .prepare('SELECT id, run_id, at, type, payload FROM run_events WHERE run_id = ? ORDER BY id')
    .all(runId)
    .map((row) => ({
      id: row.id as number,
      runId: row.run_id as number,
      at: row.at as string,
      type: row.type as SessionEvent['type'],
      event: JSON.parse(row.payload as string) as SessionEvent,
    }))
}

/** Asks for the run in flight to be cancelled; the loop acts on it on its next tick. */
export function requestCancel(
  db: Db,
  now: () => string = nowIso,
): { ok: true; run: RunRecord } | { ok: false; reason: 'nothing-in-flight'; message: string } {
  const run = inFlight(db)
  if (!run) return { ok: false, reason: 'nothing-in-flight', message: 'no run is in flight' }
  if (!run.cancelRequestedAt) updateRun(db, run.id, { cancelRequestedAt: now() })
  return { ok: true, run }
}

export function loopState(db: Db): LoopState {
  const row = db
    .prepare('SELECT wanted, stopped_reason, stopped_at, stopped_detail, usage_limit_resets_at, started_at FROM loop WHERE id = 1')
    .get()!
  return {
    wanted: row.wanted as LoopState['wanted'],
    stoppedReason: (row.stopped_reason as LoopState['stoppedReason']) ?? null,
    stoppedAt: (row.stopped_at as string | null) ?? null,
    stoppedDetail: (row.stopped_detail as string | null) ?? null,
    usageLimitResetsAt: (row.usage_limit_resets_at as number | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
  }
}

export function startLoop(db: Db, now: () => string = nowIso): void {
  db.prepare(
    'UPDATE loop SET wanted = ?, stopped_reason = NULL, stopped_at = NULL, stopped_detail = NULL, usage_limit_resets_at = NULL, started_at = ? WHERE id = 1',
  ).run('running', now())
}

export function stopLoop(
  db: Db,
  reason: NonNullable<LoopState['stoppedReason']>,
  opts: { now?: () => string; usageLimitResetsAt?: number | undefined; detail?: string } = {},
): void {
  db.prepare(
    'UPDATE loop SET wanted = ?, stopped_reason = ?, stopped_at = ?, stopped_detail = ?, usage_limit_resets_at = ? WHERE id = 1',
  ).run('stopped', reason, (opts.now ?? nowIso)(), opts.detail ?? null, opts.usageLimitResetsAt ?? null)
}

/**
 * What a starting service does first: the run it had in flight, if any, ended with the restart,
 * and the loop is stopped until someone starts it. Returns the runs it closed.
 */
export function markRestart(db: Db, now: () => string = nowIso): RunRecord[] {
  return transaction(db, () => {
    const open = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE ending IS NULL`).all().map(runOf)
    for (const run of open)
      updateRun(db, run.id, { ending: 'restart', endedAt: now(), endingDetail: 'the service restarted while the run was in flight' })
    stopLoop(db, 'restart', { now })
    return open
  })
}

export function serviceHeartbeat(db: Db, pid: number, startedAt: string, now: () => string = nowIso): void {
  db.prepare(
    'INSERT INTO service (id, pid, started_at, seen_at) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at, seen_at = excluded.seen_at',
  ).run(pid, startedAt, now())
}

export function serviceInfo(db: Db): ServiceInfo | null {
  const row = db.prepare('SELECT pid, started_at, seen_at FROM service WHERE id = 1').get()
  return row ? { pid: row.pid as number, startedAt: row.started_at as string, seenAt: row.seen_at as string } : null
}

/** Whether the service wrote its heartbeat within `staleMs`. */
export function serviceAlive(db: Db, staleMs = 5000, now: () => number = Date.now): boolean {
  const info = serviceInfo(db)
  return info !== null && now() - Date.parse(info.seenAt) < staleMs
}

function runOf(row: Record<string, unknown>): RunRecord {
  const s = (v: unknown) => (v === undefined || v === null ? null : (v as string))
  return {
    id: row.id as number,
    key: row.key as string,
    summary: s(row.summary),
    migration: row.migration === 1,
    startedAt: row.started_at as string,
    endedAt: s(row.ended_at),
    ending: s(row.ending) as Ending | null,
    endingDetail: s(row.ending_detail),
    verdict: s(row.verdict),
    runDir: s(row.run_dir),
    stage: s(row.stage),
    stageSince: s(row.stage_since),
    cancelRequestedAt: s(row.cancel_requested_at),
    logPath: s(row.log_path),
  }
}
