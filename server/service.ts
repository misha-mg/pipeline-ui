// The service process: opens the database, closes whatever it had in flight before it died
// (ended by the restart; nothing starts until someone starts the loop), serves the console
// over HTTP, then ticks the loop every second, writes its heartbeat, and once a minute checks
// the dependencies and reads the open pull requests' states. SIGTERM/SIGINT end the run in
// flight as `restart`. Its log is one JSON line per event on stdout (log.ts); the events are
// listed in .about/architecture.md.
import fs from 'node:fs'
import type { Config } from './config.ts'
import { describeError, log } from './log.ts'
import { checkHealth, type Health } from './health.ts'
import { bitbucketConfig, compareMerged, refreshPullRequests } from './history/bitbucket.ts'
import { loadRuns } from './history/runs.ts'
import { refreshTickets } from './history/tickets.ts'
import { createServer } from './http/api.ts'
import { entryLabel, entryOf, gitIn, prepareEntry } from './loop/entry.ts'
import { createLoop } from './loop/loop.ts'
import { createRunner } from './loop/runner.ts'
import { nowIso, openDb } from './store/db.ts'
import { jiraConfig, jiraLookup, jiraSearch, jiraSiteUrl, jiraStatuses } from './store/jira.ts'
import { markRestart, serviceHeartbeat, stopLoop } from './store/runs.ts'

const TICK_MS = 1000
const ROUND_MS = 60_000

export async function serve(config: Config): Promise<void> {
  const db = openDb(config.dbPath)
  for (const run of markRestart(db))
    log.warn('run_ended', { runId: run.id, key: run.key, ending: 'restart', note: 'in flight when the service last stopped' })
  const startedAt = nowIso()
  serviceHeartbeat(db, process.pid, startedAt)
  const entryConfig = { webuiDir: config.webuiDir, baseBranch: config.baseBranch, entryDir: config.entryDir }
  const setup = { entry: entryLabel(entryConfig), baseBranch: config.baseBranch, pullRequests: config.pullRequests }
  log.info('service_start', {
    pid: process.pid,
    db: config.dbPath,
    webui: config.webuiDir,
    entry: setup.entry,
    baseBranch: config.baseBranch,
    pullRequests: setup.pullRequests,
    loop: 'stopped',
  })

  const runner = createRunner({ ...config, entry: entryOf(entryConfig), pullRequests: config.pullRequests })
  const loop = createLoop({
    db,
    runner,
    runsDir: config.runsDir,
    logDir: config.logDir,
    onChange: (what, run) =>
      what === 'started'
        ? log.info('run_started', { runId: run.id, key: run.key, summary: run.summary })
        : log.info('run_ended', { runId: run.id, key: run.key, ending: run.ending, verdict: run.verdict, runDir: run.runDir }),
    preflight: () => prepareEntry(entryConfig),
    onRefused: (why) => log.error('loop_refused', { why }),
  })
  const timer = setInterval(() => {
    serviceHeartbeat(db, process.pid, startedAt)
    loop.tick()
  }, TICK_MS)

  let health: Health | null = null
  let healthSaid = ''
  let rounding = false
  let ticketsSay = ''
  const git = gitIn(config.webuiDir)
  const statuses = jiraStatuses(jiraConfig(process.env))
  const round = async () => {
    if (rounding) return
    rounding = true
    try {
      health = await checkHealth(config)
      // Said when it changes, not every minute.
      const notOk = Object.entries(health)
        .filter(([, c]) => !c.ok)
        .map(([n, c]) => `${n}: ${c.detail}`)
      const said = notOk.join('; ')
      if (said !== healthSaid && (healthSaid || notOk.length)) {
        if (notOk.length) log.warn('health_changed', { ok: false, problems: notOk })
        else log.info('health_changed', { ok: true })
      }
      healthSaid = said
      const runs = loadRuns(config.runsDir)
      const urls = runs.map((r) => r.prUrl).filter((u): u is string => u !== null)
      const read = await refreshPullRequests(db, urls, bitbucketConfig(process.env))
      if (read) log.info('pull_requests_read', { count: read })
      const compared = await compareMerged(db, bitbucketConfig(process.env), git)
      if (compared) log.info('pull_requests_compared', { count: compared })
      const tickets = await refreshTickets(
        db,
        runs.map((r) => r.key),
        statuses,
      )
      // Said when it changes, as the health is.
      const ticketsSaid = typeof tickets === 'string' ? tickets : ''
      if (ticketsSaid !== ticketsSay) {
        if (ticketsSaid) log.warn('ticket_statuses', { ok: false, error: ticketsSaid })
        else log.info('ticket_statuses', { ok: true, count: tickets })
      }
      ticketsSay = ticketsSaid
    } catch (error) {
      log.error('round_failed', { error: describeError(error) })
    } finally {
      rounding = false
    }
  }
  void round()
  const rounds = setInterval(() => void round(), ROUND_MS)

  const uiDir = fs.existsSync(config.uiDir) ? config.uiDir : undefined
  const server = createServer({
    db,
    runsDir: config.runsDir,
    health: () => health,
    setup,
    jiraSite: jiraSiteUrl(process.env),
    readers: { bitbucket: bitbucketConfig(process.env) !== null, jira: jiraConfig(process.env) !== null },
    loop,
    lookup: jiraLookup(jiraConfig(process.env)),
    search: jiraSearch(jiraConfig(process.env)),
    uiDir,
  })
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(config.port, config.host, resolve))
  log.info('console_listening', {
    url: `http://${config.host}:${config.port}/`,
    ui: uiDir !== undefined,
    note: uiDir ? undefined : 'API only: the UI is not built, npm run build',
  })

  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log.info('service_stopping', { signal, inFlight: loop.inFlightId(), ending: loop.inFlightId() !== null ? 'restart' : undefined })
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
  log.info('service_stopped', { pid: process.pid })
}
