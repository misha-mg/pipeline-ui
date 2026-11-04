// The command line for the queue and the loop, for checks without the web UI:
//
//   pipeline serve                    run the service (one per database)
//   pipeline enqueue KEY [--front]    add a ticket at the end, or at the front
//   pipeline remove KEY
//   pipeline reorder KEY...           these first, in this order; the rest keep their order
//   pipeline list                     the queue
//   pipeline start | stop             the loop
//   pipeline cancel                   the run in flight
//   pipeline status
//   pipeline runs [N]                 the last N runs (20)
//   pipeline events RUN_ID            a run's events as the session reported them
//   pipeline maintain                 a backup of the database, the log cut down (daily, deploy/)
//
// Every command but serve and maintain writes to the database and returns; the service acts
// within a second.
import { configFromEnv } from './config.ts'
import { fmtDuration } from './format.ts'
import { describeError, log } from './log.ts'
import { maintain } from './maintain.ts'
import { serve } from './service.ts'
import { openDb } from './store/db.ts'
import { jiraLookup } from './store/jira.ts'
import { enqueue, listQueue, remove, reorder } from './store/queue.ts'
import {
  getRun,
  inFlight,
  listEvents,
  listRuns,
  loopState,
  requestCancel,
  serviceAlive,
  serviceInfo,
  startLoop,
  stopLoop,
} from './store/runs.ts'

const USAGE = `usage: pipeline serve | enqueue KEY [--front] | remove KEY | reorder KEY... | list | start | stop | cancel | status | runs [N] | events RUN_ID | maintain`

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === 'serve') {
    // The service logs JSON lines (log.ts); an error before it serves anything (a bad setting
    // included) is one too.
    try {
      await serve(configFromEnv())
      return 0
    } catch (error) {
      log.error('fatal', { error: describeError(error) })
      return 1
    }
  }
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE)
    return command ? 0 : 2
  }
  const config = configFromEnv()
  if (command === 'maintain') {
    // Run by the timer, so it logs as the service does.
    try {
      maintain(config)
      return 0
    } catch (error) {
      log.error('fatal', { command, error: describeError(error) })
      return 1
    }
  }
  const db = openDb(config.dbPath)
  const out = (line: string) => console.log(line)
  const fail = (message: string) => {
    console.error(message)
    return 1
  }
  const serviceNote = () => (serviceAlive(db) ? '' : ' (the service is not running: pipeline serve)')
  try {
    switch (command) {
      case 'enqueue': {
        const key = args.find((a) => !a.startsWith('--'))
        if (!key) return fail(USAGE)
        const added = await enqueue(db, key, { front: args.includes('--front'), lookup: jiraLookup(config.jira) })
        if (!added.ok) return fail(added.message)
        if (added.warning) console.error(`warning: ${added.warning}`)
        out(
          `queued ${added.item.key}${added.item.summary ? ` — ${added.item.summary}` : ''} at ${position(db, key)} of ${listQueue(db).length}${serviceNote()}`,
        )
        return 0
      }
      case 'remove': {
        if (!args[0]) return fail(USAGE)
        const removed = remove(db, args[0])
        return removed.ok ? (out(`removed ${args[0]}`), 0) : fail(removed.message)
      }
      case 'reorder': {
        if (args.length === 0) return fail(USAGE)
        const done = reorder(db, args)
        if (!done.ok) return fail(done.message)
        printQueue(done.queue, out)
        return 0
      }
      case 'list':
        printQueue(listQueue(db), out)
        return 0
      case 'start': {
        const state = loopState(db)
        if (state.wanted === 'running') out(`the loop is already running${serviceNote()}`)
        else {
          startLoop(db)
          out(`loop started${serviceNote()}`)
        }
        return 0
      }
      case 'stop': {
        const run = inFlight(db)
        stopLoop(db, 'operator')
        out(`loop stopped${run ? `; run ${run.id} ${run.key} finishes` : ''}`)
        return 0
      }
      case 'cancel': {
        const asked = requestCancel(db)
        if (!asked.ok) return fail(asked.message)
        out(`cancelling run ${asked.run.id} ${asked.run.key}${asked.run.stage ? ` in ${asked.run.stage}` : ''}${serviceNote()}`)
        return 0
      }
      case 'status':
        printStatus(db, out)
        return 0
      case 'runs':
        for (const run of listRuns(db, Number(args[0] ?? 20)).reverse()) {
          out(
            [
              run.id,
              run.key,
              run.startedAt,
              duration(run.startedAt, run.endedAt),
              run.ending ?? (run.stage ? `in flight: ${run.stage}` : 'in flight'),
              run.verdict ?? '-',
              run.runDir ?? '-',
            ].join('\t'),
          )
        }
        return 0
      case 'events': {
        const id = Number(args[0])
        if (!id || !getRun(db, id)) return fail(`no run ${args[0] ?? ''}`)
        for (const e of listEvents(db, id)) out(`${e.at}\t${JSON.stringify(e.event)}`)
        return 0
      }
      default:
        return fail(USAGE)
    }
  } finally {
    db.close()
  }
}

function position(db: ReturnType<typeof openDb>, key: string): number {
  return listQueue(db).findIndex((i) => i.key === key) + 1
}

function printQueue(queue: ReturnType<typeof listQueue>, out: (l: string) => void): void {
  if (queue.length === 0) out('the queue is empty')
  queue.forEach((item, i) => out(`${i + 1}\t${item.key}\t${item.summary ?? '-'}`))
}

function printStatus(db: ReturnType<typeof openDb>, out: (l: string) => void): void {
  const info = serviceInfo(db)
  out(
    `service: ${serviceAlive(db) ? `running, pid ${info?.pid}, since ${info?.startedAt}` : info ? `not running (last seen ${info.seenAt})` : 'never started'}`,
  )
  const state = loopState(db)
  const since = state.stoppedAt ? ` since ${state.stoppedAt}` : ''
  const resets = state.usageLimitResetsAt ? `, resets at ${new Date(state.usageLimitResetsAt * 1000).toISOString()}` : ''
  out(`loop: ${state.wanted}${state.wanted === 'stopped' && state.stoppedReason ? ` (${state.stoppedReason}${since}${resets})` : ''}`)
  const run = inFlight(db)
  out(
    run
      ? `in flight: run ${run.id} ${run.key}${run.summary ? ` — ${run.summary}` : ''}, ${run.stage ? `${run.stage} since ${run.stageSince}` : 'between stages'}, ${duration(run.startedAt, null)} so far${run.cancelRequestedAt ? ', cancel requested' : ''}`
      : 'in flight: nothing',
  )
  const queue = listQueue(db)
  out(`queue: ${queue.length === 0 ? 'empty' : queue.map((i) => i.key).join(', ')}`)
  const last = listRuns(db, 1)[0]
  if (last && last.ending)
    out(`last run: ${last.id} ${last.key} ${last.ending}${last.verdict ? ` (${last.verdict})` : ''} at ${last.endedAt}`)
}

function duration(from: string, to: string | null): string {
  return fmtDuration((Date.parse(to ?? new Date().toISOString()) - Date.parse(from)) / 1000)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2))
}
