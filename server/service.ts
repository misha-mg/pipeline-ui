// The service process: opens the database, closes whatever it had in flight before it died
// (ended by the restart; nothing starts until someone starts the loop), serves the console
// over HTTP, then ticks the loop every second, writes its heartbeat, and once a minute checks
// the dependencies and reads the open pull requests' states. SIGTERM/SIGINT end the run in
// flight as `restart`.
import fs from 'node:fs'
import type { Config } from './config.ts'
import { checkHealth, type Health } from './health.ts'
import { bitbucketConfig, refreshPullRequests } from './history/bitbucket.ts'
import { loadRuns } from './history/runs.ts'
import { createServer } from './http/api.ts'
import { entryLabel, entryOf, prepareEntry } from './loop/entry.ts'
import { createLoop } from './loop/loop.ts'
import { createRunner } from './loop/runner.ts'
import { nowIso, openDb } from './store/db.ts'
import { jiraConfig, jiraLookup, jiraSearch } from './store/jira.ts'
import { markRestart, serviceHeartbeat, stopLoop } from './store/runs.ts'

const TICK_MS = 1000
const ROUND_MS = 60_000

export async function serve(config: Config, log: (line: string) => void = (l) => console.log(`${nowIso()} ${l}`)): Promise<void> {
  const db = openDb(config.dbPath)
  for (const run of markRestart(db)) log(`run ${run.id} ${run.key} was in flight when the service last stopped: ended by restart`)
  const startedAt = nowIso()
  serviceHeartbeat(db, process.pid, startedAt)
  const entryConfig = { webuiDir: config.webuiDir, baseBranch: config.baseBranch, entryDir: config.entryDir }
  const setup = { entry: entryLabel(entryConfig), baseBranch: config.baseBranch, pullRequests: config.pullRequests }
  log(`service started, pid ${process.pid}, database ${config.dbPath}, webui ${config.webuiDir}; ${setup.entry}; pull requests ${setup.pullRequests ? 'on' : 'off'}; the loop is stopped`)

  const runner = createRunner({ ...config, entry: entryOf(entryConfig), pullRequests: config.pullRequests })
  const loop = createLoop({
    db,
    runner,
    runsDir: config.runsDir,
    logDir: config.logDir,
    onChange: (what, run) => log(`run ${run.id} ${run.key} ${what}${run.ending ? `: ${run.ending}${run.verdict ? ` (${run.verdict})` : ''}` : ''}`),
    preflight: () => prepareEntry(entryConfig),
    onRefused: (why) => log(`loop stopped, no run started: ${why}`),
  })
  const timer = setInterval(() => {
    serviceHeartbeat(db, process.pid, startedAt)
    loop.tick()
  }, TICK_MS)

  let health: Health | null = null
  let healthSaid = ''
  let rounding = false
  const round = async () => {
    if (rounding) return
    rounding = true
    try {
      health = await checkHealth(config)
      // Said when it changes, not every minute.
      const notOk = Object.entries(health).filter(([, c]) => !c.ok).map(([n, c]) => `${n}: ${c.detail}`)
      const said = notOk.length ? `health: ${notOk.join('; ')}` : 'health: every dependency is OK'
      if (said !== healthSaid && (healthSaid || notOk.length)) log(said)
      healthSaid = said
      const urls = loadRuns(config.runsDir).map((r) => r.prUrl).filter((u): u is string => u !== null)
      const read = await refreshPullRequests(db, urls, bitbucketConfig(process.env))
      if (read) log(`pull requests: ${read} read`)
    } catch (error) {
      log(`round failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      rounding = false
    }
  }
  void round()
  const rounds = setInterval(() => void round(), ROUND_MS)

  const uiDir = fs.existsSync(config.uiDir) ? config.uiDir : undefined
  const server = createServer({ db, runsDir: config.runsDir, health: () => health, setup, loop, lookup: jiraLookup(jiraConfig(process.env)), search: jiraSearch(jiraConfig(process.env)), uiDir })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(config.port, config.host, resolve))
  log(`console at http://${config.host}:${config.port}/${uiDir ? '' : ' (API only: the UI is not built, npm run build)'}`)

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log(`${signal}: stopping${loop.inFlightId() !== null ? `, ending run ${loop.inFlightId()} as restart` : ''}`)
      clearInterval(timer)
      clearInterval(rounds)
      server.close()
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
