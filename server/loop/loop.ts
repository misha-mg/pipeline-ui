// The loop: while it is wanted running and nothing is in flight, takes the queue's head and runs
// it; records every event the session reports and the run's ending; stops itself on the usage
// limit, or when the entry point refuses a run (the ticket stays queued). One tick does one step; the service ticks it every second and on each command, so a
// command written to the database by another process (the CLI) is acted on within a second.
// See .about/adr/queue.md and .about/prd/pipeline-web-ui.md, Queue and loop.
import fs from 'node:fs'
import path from 'node:path'
import type { SessionEnding, SessionEvent } from '../session/driver.ts'
import { nowIso, type Db } from '../store/db.ts'
import { queueHead, takeHead } from '../store/queue.ts'
import {
  addEvent, getRun, insertRun, loopState, stopLoop, updateRun, type Ending, type RunRecord,
} from '../store/runs.ts'
import { newRunDir, readSummary, readVerdict, runDirsOf } from './runfiles.ts'

export type RunExit = { code: number | null; signal: string | null }

export type RunnerHandlers = {
  onEvent: (event: SessionEvent) => void
  /** prepare-worktree.sh's stdout and stderr, and any line on the events pipe that is not an event. */
  onOutput: (chunk: string) => void
  /** Where the session's raw SDK trace goes. */
  tracePath: string
}

/** Starts prepare-worktree.sh for the key and resolves when it has exited; the signal cancels it. */
export type Runner = (key: string, handlers: RunnerHandlers, signal: AbortSignal) => Promise<RunExit>

export type LoopDeps = {
  db: Db
  runner: Runner
  /** webui's .pipeline-runs. */
  runsDir: string
  /** Where each run's log and trace go. */
  logDir: string
  now?: () => string
  /** Called when a run starts or ends, for the service's log. */
  onChange?: (what: string, run: RunRecord) => void
  /** Checked before each run, with the queue's head still queued: null, or why no run may start. */
  preflight?: () => Promise<string | null>
  /** Called when the preflight refused a run and stopped the loop. */
  onRefused?: (why: string) => void
}

export type AbortCause = 'cancelled' | 'restart'

export type Loop = {
  /** One step: cancels the run in flight when asked to, starts the next run when it should. */
  tick: () => void
  /** Ends the run in flight as `restart` and waits for it; for the service's shutdown. */
  shutdown: () => Promise<void>
  /** The id of the run in flight in this process. */
  inFlightId: () => number | null
  /** Resolves when the run in flight is over (at once when none is). */
  settled: () => Promise<void>
}

export function createLoop(deps: LoopDeps): Loop {
  const { db, runner, runsDir, logDir } = deps
  const now = deps.now ?? nowIso
  let current: { id: number; controller: AbortController; done: Promise<void> } | null = null
  let checking = false

  function tick(): void {
    if (current) {
      const run = getRun(db, current.id)
      if (run?.cancelRequestedAt && !current.controller.signal.aborted) current.controller.abort('cancelled' satisfies AbortCause)
      return
    }
    if (checking || loopState(db).wanted !== 'running' || !queueHead(db)) return
    if (!deps.preflight) return begin()
    checking = true
    deps.preflight()
      .catch((error: unknown) => `the entry point could not be checked: ${error instanceof Error ? error.message : String(error)}`)
      .then((refused) => {
        if (refused) {
          stopLoop(db, 'entry-point', { now, detail: refused })
          deps.onRefused?.(refused)
        } else if (!current && loopState(db).wanted === 'running') {
          begin()
        }
      })
      .finally(() => {
        checking = false
      })
  }

  function begin(): void {
    const head = takeHead(db)
    if (!head) return
    const controller = new AbortController()
    const startedAt = now()
    fs.mkdirSync(logDir, { recursive: true })
    const id = insertRun(db, { key: head.key, summary: head.summary, startedAt, logPath: null })
    const logPath = path.join(logDir, `run-${id}-${head.key}.log`)
    const tracePath = path.join(logDir, `run-${id}-${head.key}.trace.jsonl`)
    db.prepare('UPDATE runs SET log_path = ? WHERE id = ?').run(logPath, id)
    deps.onChange?.('started', getRun(db, id)!)
    const done = drive(id, head.key, head.summary, logPath, tracePath, controller).finally(() => {
      current = null
    })
    current = { id, controller, done }
  }

  async function drive(id: number, key: string, summary: string | null, logPath: string, tracePath: string, controller: AbortController): Promise<void> {
    const before = runDirsOf(runsDir, key)
    const log = fs.openSync(logPath, 'a')
    let ended: SessionEnding | null = null
    let events = 0
    let runDir: string | null = null
    const handlers: RunnerHandlers = {
      tracePath,
      onOutput: (chunk) => fs.writeSync(log, chunk),
      onEvent: (event) => {
        events += 1
        addEvent(db, id, event)
        // The run directory appears once the session has started: learn it early, so the
        // console can show the run in flight beside its history entry.
        if (!runDir) {
          runDir = newRunDir(runsDir, key, before)
          if (runDir) updateRun(db, id, { runDir })
        }
        if (event.type === 'stage-start') updateRun(db, id, { stage: event.agent, stageSince: event.at })
        else if (event.type === 'stage-stop') updateRun(db, id, { stage: null, stageSince: null })
        else if (event.type === 'ended') ended = event.ending
      },
    }
    let exit: RunExit
    try {
      exit = await runner(key, handlers, controller.signal)
    } catch (error) {
      fs.writeSync(log, `runner failed: ${error instanceof Error ? error.message : String(error)}\n`)
      exit = { code: null, signal: null }
    }
    fs.closeSync(log)
    const aborted = controller.signal.aborted ? (controller.signal.reason as AbortCause) : null
    const { ending, detail } = endingOf(aborted, ended, exit, events)
    runDir ??= newRunDir(runsDir, key, before)
    const patch: Parameters<typeof updateRun>[2] = { ending, endingDetail: detail, endedAt: now(), runDir, stage: null, stageSince: null }
    if (runDir) {
      patch.verdict = readVerdict(runDir)
      if (!summary) patch.summary = readSummary(runDir)
    }
    updateRun(db, id, patch)
    if (ending === 'usage-limit') {
      const resetsAt = ended && (ended as SessionEnding).kind === 'usage-limit' ? (ended as Extract<SessionEnding, { kind: 'usage-limit' }>).resetsAt : undefined
      stopLoop(db, 'usage-limit', { now, usageLimitResetsAt: resetsAt })
    }
    deps.onChange?.('ended', getRun(db, id)!)
  }

  return {
    tick,
    inFlightId: () => current?.id ?? null,
    settled: async () => {
      while (checking) await new Promise((r) => setTimeout(r, 5))
      await (current?.done ?? Promise.resolve())
    },
    shutdown: async () => {
      if (!current) return
      if (!current.controller.signal.aborted) current.controller.abort('restart' satisfies AbortCause)
      await current.done
    },
  }
}

/**
 * The run's ending from why it was aborted, what the session reported and how
 * prepare-worktree.sh exited. A run that exits without one event means the session program
 * never ran: the launch script had no PIPELINE_SESSION, so the plain CLI ran the ticket
 * unwatched.
 */
export function endingOf(aborted: AbortCause | null, ended: SessionEnding | null, exit: RunExit, events = 1): { ending: Ending; detail: string | null } {
  if (aborted) return { ending: aborted, detail: ended ? `the session reported ${ended.kind}` : 'the session reported no ending' }
  if (!ended) {
    const how = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? 'unknown'}`
    const why = events === 0 ? '; no event arrived at all, so the session program was not run (launch-session.sh without PIPELINE_SESSION?)' : ''
    return { ending: 'exited', detail: `prepare-worktree.sh exited with ${how} before the session reported an ending${why}` }
  }
  switch (ended.kind) {
    case 'completed':
      return { ending: 'completed', detail: null }
    case 'usage-limit':
      return { ending: 'usage-limit', detail: ended.text }
    case 'error':
      return { ending: 'error', detail: ended.reason }
    case 'aborted':
      return ended.reason === 'timeout' ? { ending: 'timeout', detail: null } : { ending: 'cancelled', detail: 'the session was aborted' }
    case 'no-result':
      return { ending: 'no-result', detail: 'the session ended without a result' }
  }
}
