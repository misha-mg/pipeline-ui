import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, openDb, schemaVersion } from './db.ts'

const temps: string[] = []
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-db-'))
  temps.push(dir)
  return dir
}
const columns = (db: DatabaseSync, table: string) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name as string)

describe('openDb', () => {
  it('makes a new database at the latest version without a copy, and opens it again without another migration', () => {
    const dir = tempDir()
    const file = path.join(dir, 'pipeline.db')
    const migrations: unknown[] = []
    const db = openDb(file, { onMigrate: (m) => migrations.push(m) })
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(migrations).toEqual([{ from: 0, to: MIGRATIONS.length, copy: null }])
    db.close()
    const again = openDb(file, { onMigrate: (m) => migrations.push(m) })
    expect(migrations).toHaveLength(1)
    again.close()
    expect(fs.readdirSync(dir).filter((f) => f.includes('.before-v'))).toEqual([])
  })

  it('brings a database from before the versions to the latest one with only what it lacks, after a copy of it', () => {
    const dir = tempDir()
    const file = path.join(dir, 'pipeline.db')
    const old = new DatabaseSync(file)
    old.exec(`
      CREATE TABLE queue (key TEXT PRIMARY KEY, summary TEXT, position INTEGER NOT NULL, added_at TEXT NOT NULL);
      CREATE TABLE loop (id INTEGER PRIMARY KEY CHECK (id = 1), wanted TEXT NOT NULL, stopped_reason TEXT, stopped_at TEXT, usage_limit_resets_at INTEGER);
      INSERT INTO loop (id, wanted) VALUES (1, 'running');
      INSERT INTO queue (key, summary, position, added_at) VALUES ('KAZ-1', 'kept', 1, '2026-10-20T00:00:00Z');
      CREATE TABLE pull_requests (url TEXT PRIMARY KEY, state TEXT NOT NULL, closed_on TEXT, fetched_at TEXT, error TEXT);
    `)
    old.close()
    const migrations: { from: number; to: number; copy: string | null }[] = []
    const db = openDb(file, { now: () => '2026-11-04T04:30:00.000Z', onMigrate: (m) => migrations.push(m) })
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    expect(migrations).toEqual([{ from: 0, to: MIGRATIONS.length, copy: `${file}.before-v${MIGRATIONS.length}-2026-11-04T043000000Z` }])
    expect(fs.existsSync(migrations[0]!.copy!)).toBe(true)
    // The rows and the old state stay; the columns and tables added since are there.
    expect(db.prepare('SELECT key, summary FROM queue').all()).toEqual([{ key: 'KAZ-1', summary: 'kept' }])
    expect(db.prepare('SELECT wanted FROM loop').get()).toEqual({ wanted: 'running' })
    expect(columns(db, 'loop')).toEqual(expect.arrayContaining(['started_at', 'stopped_detail']))
    expect(columns(db, 'pull_requests')).toEqual(expect.arrayContaining(['created_on', 'destination', 'draft', 'changes', 'compared_at']))
    expect(columns(db, 'tickets')).toContain('moves')
    expect(columns(db, 'service')).toEqual(['id', 'pid', 'started_at', 'seen_at'])
    db.close()
    // The copy is the database as it was.
    const copy = new DatabaseSync(migrations[0]!.copy!, { readOnly: true })
    expect(columns(copy, 'loop')).not.toContain('started_at')
    expect(copy.prepare('SELECT key FROM queue').all()).toEqual([{ key: 'KAZ-1' }])
    copy.close()
  })

  it('runs in memory without a file or a copy', () => {
    const db = openDb(':memory:')
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    db.close()
  })
})
