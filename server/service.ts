// The service process: opens the database, closes whatever it had in flight before it died
// (ended by the restart; nothing starts until someone starts the loop), then ticks the loop
// every second and writes its heartbeat. SIGTERM/SIGINT end the run in flight as `restart`.
import { createLoop } from './loop/loop.ts'
import { createRunner } from './loop/runner.ts'
import { openDb, nowIso } from './store/db.ts'
import { markRestart, serviceHeartbeat, stopLoop } from './store/runs.ts'
import type { Config } from './config.ts'

const TICK_MS = 1000

export async function serve(config: Config, log: (line: string) => void = (l) => console.log(`${nowIso()} ${l}`)): Promise<void> {
  const db = openDb(config.dbPath)
  for (const run of markRestart(db)) log(`run ${run.id} ${run.key} was in flight when the service last stopped: ended by restart`)
  const startedAt = nowIso()
  serviceHeartbeat(db, process.pid, startedAt)
  log(`service started, pid ${process.pid}, database ${config.dbPath}, webui ${config.webuiDir}; the loop is stopped`)

  const runner = createRunner(config)
  const loop = createLoop({
    db,
    runner,
    runsDir: config.runsDir,
    logDir: config.logDir,
    onChange: (what, run) => log(`run ${run.id} ${run.key} ${what}${run.ending ? `: ${run.ending}${run.verdict ? ` (${run.verdict})` : ''}` : ''}`),
  })
  const timer = setInterval(() => {
    serviceHeartbeat(db, process.pid, startedAt)
    loop.tick()
  }, TICK_MS)

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log(`${signal}: stopping${loop.inFlightId() !== null ? `, ending run ${loop.inFlightId()} as restart` : ''}`)
      clearInterval(timer)
      void loop.shutdown().then(resolve)
    }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
  })
  // Nothing resumes by itself after a restart: the loop stays stopped until someone starts it.
  stopLoop(db, 'restart')
  db.close()
  log('service stopped')
}
