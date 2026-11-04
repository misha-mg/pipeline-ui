// `pipeline maintain`, run daily by deploy/pipeline-ui-maintain.timer: a consistent copy of the
// database into the backup directory (the latest KEEP kept), and the service's log file cut
// down once it is past LOG_MAX_BYTES. Safe while the service runs: the copy is SQLite's own
// (VACUUM INTO), and the log is copied to `<log>.1` then emptied in place, so the unit, which
// appends to the same file, never notices. A line appended between the copy and the cut would
// be in neither file, so the cut is made only when the file is still the size that was copied;
// otherwise the next day's run tries again.
import fs from 'node:fs'
import path from 'node:path'
import type { Config } from './config.ts'
import { log } from './log.ts'
import { backupFile } from './store/db.ts'

/** Daily backups kept: two weeks to notice that something went wrong. */
export const KEEP = 14
/** The log is cut past this size, months of events; the cut part is kept as `<log>.1`. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

export type MaintainConfig = Pick<Config, 'dbPath' | 'backupDir' | 'logFile'>

export function maintain(config: MaintainConfig, now: () => Date = () => new Date()): void {
  if (!fs.existsSync(config.dbPath)) throw new Error(`No database at ${config.dbPath}: the service has not started yet`)
  fs.mkdirSync(config.backupDir, { recursive: true })
  const name = path.basename(config.dbPath, path.extname(config.dbPath))
  const stamp = now().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const backup = path.join(config.backupDir, `${name}-${stamp}.db`)
  // A second run within the same second replaces its own copy (SQLite refuses an existing file).
  fs.rmSync(backup, { force: true })
  backupFile(config.dbPath, backup)
  const old = fs
    .readdirSync(config.backupDir)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.db'))
    .sort()
    .slice(0, -KEEP)
  for (const f of old) fs.rmSync(path.join(config.backupDir, f))
  log.info('backup', { file: backup, bytes: fs.statSync(backup).size, removed: old.length })

  if (!fs.existsSync(config.logFile) || fs.statSync(config.logFile).size <= LOG_MAX_BYTES) return
  const bytes = fs.statSync(config.logFile).size
  const kept = `${config.logFile}.1`
  fs.copyFileSync(config.logFile, kept)
  if (fs.statSync(config.logFile).size !== bytes) {
    log.warn('log_cut_skipped', { file: config.logFile, bytes, reason: 'the service wrote to it meanwhile' })
    return
  }
  fs.truncateSync(config.logFile, 0)
  log.info('log_cut', { file: config.logFile, bytes, keptAs: kept })
}
