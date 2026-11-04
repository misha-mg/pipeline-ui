// The service's one SQLite file: the queue, the loop's state, the runs the service started and
// their events, the pull requests and the tickets the history reads. node:sqlite, so nothing to
// install. See .about/adr/queue.md.
//
// The schema is versioned: `PRAGMA user_version` counts the migrations a database has had, and
// MIGRATIONS lists them in order. Before a migration runs on a file, a copy of it is made next
// to it (`<db>.before-v<N>-<time>`), so a migration gone wrong costs nothing. A database from
// before the versions (user_version 0 with its tables) gets only what it lacks (ADR unification).
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

export type Db = DatabaseSync

const SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (
  key TEXT PRIMARY KEY,
  summary TEXT,
  position INTEGER NOT NULL,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  summary TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  ending TEXT,
  ending_detail TEXT,
  verdict TEXT,
  run_dir TEXT,
  stage TEXT,
  stage_since TEXT,
  cancel_requested_at TEXT,
  log_path TEXT
);
CREATE INDEX IF NOT EXISTS runs_in_flight ON runs(ending) WHERE ending IS NULL;
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events(run_id);
CREATE TABLE IF NOT EXISTS loop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  wanted TEXT NOT NULL,
  stopped_reason TEXT,
  stopped_at TEXT,
  usage_limit_resets_at INTEGER,
  started_at TEXT,
  stopped_detail TEXT
);
INSERT OR IGNORE INTO loop (id, wanted) VALUES (1, 'stopped');
CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pull_requests (
  url TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  closed_on TEXT,
  fetched_at TEXT,
  error TEXT,
  created_on TEXT,
  destination TEXT,
  draft INTEGER,
  changes TEXT,
  compared_at TEXT
);
CREATE TABLE IF NOT EXISTS tickets (
  key TEXT PRIMARY KEY,
  summary TEXT,
  status TEXT,
  status_category TEXT,
  done_at TEXT,
  fetched_at TEXT NOT NULL,
  moves TEXT
);
`

/** Adds the column unless the table has it: for tables made before the column was. */
function addColumn(db: Db, table: string, column: string, type: string): void {
  const have = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name as string)
  if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

/**
 * The schema's versions, in order; `PRAGMA user_version` says how many a database has had.
 * Only ever appended to: a migration that has run on a database is history.
 */
export const MIGRATIONS: ((db: Db) => void)[] = [
  // 1 (2026-11-04): every table as it was when the versions began, and the columns databases
  // from before got by ad-hoc ALTERs (the loop's start and detail, 2026-10-30; the pull
  // requests' and tickets' statistics columns, 2026-11-04). On a database from before the
  // versions, CREATE TABLE IF NOT EXISTS leaves its tables and addColumn adds what it lacks.
  (db) => {
    db.exec(SCHEMA)
    addColumn(db, 'loop', 'started_at', 'TEXT')
    addColumn(db, 'loop', 'stopped_detail', 'TEXT')
    for (const [column, type] of [
      ['created_on', 'TEXT'],
      ['destination', 'TEXT'],
      ['draft', 'INTEGER'],
      ['changes', 'TEXT'],
      ['compared_at', 'TEXT'],
    ] as const)
      addColumn(db, 'pull_requests', column, type)
    addColumn(db, 'tickets', 'moves', 'TEXT')
  },
]

export type OpenOptions = {
  /** The time in the backup copy's name; tests set it. */
  now?: () => string
  /** Told of a migration before it runs, with the copy made; the service logs it. */
  onMigrate?: (info: { from: number; to: number; copy: string | null }) => void
}

/** Opens (and creates) the database at `file`, or in memory for ':memory:', and brings it to the latest version. */
export function openDb(file: string, options: OpenOptions = {}): Db {
  const inMemory = file === ':memory:'
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true })
  const existed = !inMemory && fs.existsSync(file)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  const version = schemaVersion(db)
  if (version < MIGRATIONS.length) {
    let copy: string | null = null
    if (existed) {
      copy = `${file}.before-v${MIGRATIONS.length}-${(options.now ?? nowIso)().replace(/[:.]/g, '')}`
      backupDb(db, copy)
    }
    options.onMigrate?.({ from: version, to: MIGRATIONS.length, copy })
    for (let v = version; v < MIGRATIONS.length; v++) {
      transaction(db, () => {
        MIGRATIONS[v]!(db)
        db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }
  return db
}

/** How many migrations the database has had. */
export function schemaVersion(db: Db): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

/** A consistent copy of the open database at `to`, taken while the service may be writing it. */
export function backupDb(db: Db, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`)
}

/** A consistent copy of the database file at `file`, opened read-only for it (`maintain`). */
export function backupFile(file: string, to: string): void {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    backupDb(db, to)
  } finally {
    db.close()
  }
}

/** Runs `fn` in one transaction; rolls back when it throws. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export const nowIso = (): string => new Date().toISOString()
