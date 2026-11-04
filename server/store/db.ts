// The service's one SQLite file: the queue, the loop's state, the runs the service started and
// their events. node:sqlite, so nothing to install. See .about/adr/queue.md.
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
`

/** Opens (and creates) the database at `file`, or in memory for ':memory:'. */
export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** Columns added after the first databases were made; CREATE TABLE IF NOT EXISTS skips them. */
function migrate(db: Db): void {
  const columns = (table: string) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name as string)
  if (!columns('loop').includes('started_at')) db.exec('ALTER TABLE loop ADD COLUMN started_at TEXT')
  if (!columns('loop').includes('stopped_detail')) db.exec('ALTER TABLE loop ADD COLUMN stopped_detail TEXT')
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
