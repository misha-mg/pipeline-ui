import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseLogLine, setLogSink } from './log.ts'
import { KEEP, LOG_MAX_BYTES, maintain } from './maintain.ts'
import { openDb } from './store/db.ts'

const temps: string[] = []
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true })
  setLogSink((line) => process.stdout.write(`${line}\n`))
})

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-maintain-'))
  temps.push(dir)
  const dbPath = path.join(dir, 'pipeline.db')
  const db = openDb(dbPath)
  db.prepare("INSERT INTO queue (key, summary, position, added_at) VALUES ('KAZ-1', 'one', 1, '2026-11-04T00:00:00Z')").run()
  const lines: string[] = []
  setLogSink((line) => lines.push(line))
  const events = () => lines.map((l) => parseLogLine(l)!)
  return { dir, db, config: { dbPath, backupDir: path.join(dir, 'backups'), logFile: path.join(dir, 'serve.log') }, events }
}

describe('maintain', () => {
  it('copies the database into the backup directory, keeps the latest 14, and logs it', () => {
    const { db, config, events } = setup()
    fs.mkdirSync(config.backupDir)
    for (let i = 1; i <= KEEP + 2; i++)
      fs.writeFileSync(path.join(config.backupDir, `pipeline-202610${String(i).padStart(2, '0')}-043000.db`), '')
    fs.writeFileSync(path.join(config.backupDir, 'other.db'), '')
    maintain(config, () => new Date('2026-11-04T04:30:00Z'))
    const backups = fs.readdirSync(config.backupDir).sort()
    expect(backups).toHaveLength(KEEP + 1)
    expect(backups).toContain('pipeline-20261104-043000.db')
    expect(backups).toContain('other.db')
    expect(backups).not.toContain('pipeline-20261001-043000.db')
    expect(backups).not.toContain('pipeline-20261003-043000.db')
    // The copy is a database with the rows, readable while the original stays open.
    const copy = openDb(path.join(config.backupDir, 'pipeline-20261104-043000.db'))
    expect(copy.prepare('SELECT key FROM queue').all()).toEqual([{ key: 'KAZ-1' }])
    copy.close()
    db.close()
    expect(events()).toEqual([expect.objectContaining({ level: 'info', event: 'backup', removed: 3 })])
  })

  it('cuts the log once past 5 MB, keeping the cut part as .1, and leaves a small one alone', () => {
    const { db, config, events } = setup()
    fs.writeFileSync(config.logFile, 'small\n')
    maintain(config)
    expect(fs.readFileSync(config.logFile, 'utf8')).toBe('small\n')
    expect(fs.existsSync(`${config.logFile}.1`)).toBe(false)
    fs.writeFileSync(config.logFile, 'x'.repeat(LOG_MAX_BYTES + 1))
    maintain(config)
    expect(fs.statSync(config.logFile).size).toBe(0)
    expect(fs.statSync(`${config.logFile}.1`).size).toBe(LOG_MAX_BYTES + 1)
    db.close()
    expect(events().map((e) => e.event)).toEqual(['backup', 'backup', 'log_cut'])
  })

  it('refuses to run without a database', () => {
    const { config } = setup()
    expect(() => maintain({ ...config, dbPath: path.join(config.backupDir, 'none.db') })).toThrow(/No database/)
  })
})
