// What the console shows, assembled from the database, the run directories and the health
// checks: the state (service, loop, run in flight, queue, counts, health) and the history
// (every run, with its ending and its pull request's state). Pure functions over the sources,
// so the API and the tests share them.
import fs from 'node:fs'
import path from 'node:path'
import { loadRuns, readReport, type HistoryRun } from '../history/runs.ts'
import { pullRequestStates, type PullRequestState } from '../history/bitbucket.ts'
import type { Health } from '../health.ts'
import type { Db } from '../store/db.ts'
import { listQueue, type QueueItem } from '../store/queue.ts'
import { inFlight, listEvents, listRuns, loopState, serviceAlive, serviceInfo, type LoopState, type RunRecord, type ServiceInfo } from '../store/runs.ts'

/** How a run ended, as the console says it: the service's ending, or what the files tell. */
export type ShownEnding = RunRecord['ending'] | 'in-flight' | 'died'

export type ShownRun = HistoryRun & {
  /** The service's record of the run, when it started it. */
  serviceRunId: number | null
  ending: ShownEnding
  endingDetail: string | null
  pr: PullRequestState | null
}

export type InFlightView = RunRecord & {
  /** The rework rounds so far: implementer stages after the first. */
  rework: number
  seconds: number
}

export type Counts = Record<string, number>

export type StateView = {
  now: string
  service: { alive: boolean } & Partial<ServiceInfo>
  loop: LoopState
  inFlight: InFlightView | null
  queue: QueueItem[]
  counts: { lastBatch: Counts; last7Days: Counts; allTime: Counts; lastBatchLabel: string }
  health: Health | null
}

export type ViewSources = { db: Db; runsDir: string; health: () => Health | null; now?: () => Date }

export function stateView(src: ViewSources): StateView {
  const now = (src.now ?? (() => new Date()))()
  const info = serviceInfo(src.db)
  const run = inFlight(src.db)
  const runs = shownRuns(src)
  return {
    now: now.toISOString(),
    service: { alive: serviceAlive(src.db, 5000, () => now.getTime()), ...(info ?? {}) },
    loop: loopState(src.db),
    inFlight: run ? inFlightView(src.db, run, now) : null,
    queue: listQueue(src.db),
    counts: counts(src, runs, now),
    health: src.health(),
  }
}

function inFlightView(db: Db, run: RunRecord, now: Date): InFlightView {
  const implementer = listEvents(db, run.id).filter((e) => e.type === 'stage-start' && e.event.type === 'stage-start' && e.event.agent === 'ticket-implementer').length
  return { ...run, rework: Math.max(0, implementer - 1), seconds: Math.max(0, Math.round((now.getTime() - Date.parse(run.startedAt)) / 1000)) }
}

/** Every run under the runs directory with what the service knows of it, newest first. */
export function shownRuns(src: ViewSources): ShownRun[] {
  const byDir = new Map(listRuns(src.db, 10_000).filter((r) => r.runDir).map((r) => [r.runDir!, r]))
  const flying = inFlight(src.db)
  const prs = pullRequestStates(src.db)
  const runs = loadRuns(src.runsDir).map((h): ShownRun => {
    const rec = byDir.get(h.path) ?? null
    const ending: ShownEnding = rec?.ending ?? (rec ? 'in-flight' : h.verdict ? 'completed' : flying?.key === h.key && !flying.runDir ? 'in-flight' : 'died')
    return { ...h, serviceRunId: rec?.id ?? null, ending, endingDetail: rec?.endingDetail ?? null, pr: h.prUrl ? prs.get(h.prUrl) ?? { url: h.prUrl, state: 'unknown', closedOn: null, fetchedAt: null, error: null } : null }
  })
  // A run the service started whose directory never appeared (run.sh failed before the session).
  for (const rec of listRuns(src.db, 10_000)) {
    if (rec.runDir || rec.ending === null) continue
    runs.push({
      key: rec.key, number: 0, path: '', startedAt: rec.startedAt, finishedAt: rec.endedAt, seconds: rec.endedAt ? Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000) : null,
      summary: rec.summary, verdict: null, reason: null, prUrl: null, stages: [], reports: [], serviceRunId: rec.id, ending: rec.ending, endingDetail: rec.endingDetail, pr: null,
    })
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.number - a.number)
}

export type HistoryFilter = { verdict?: string; ending?: string }

export function historyView(src: ViewSources, filter: HistoryFilter = {}): { runs: ShownRun[]; verdicts: Counts; endings: Counts } {
  const all = shownRuns(src)
  const runs = all.filter((r) => (!filter.verdict || verdictFamily(r.verdict) === filter.verdict || r.verdict === filter.verdict) && (!filter.ending || r.ending === filter.ending))
  return { runs, verdicts: tally(all.map((r) => r.verdict ?? '-')), endings: tally(all.map((r) => r.ending ?? '-')) }
}

export function runView(src: ViewSources, key: string, number: number): (ShownRun & { files: { name: string; text: string }[] }) | null {
  const run = shownRuns(src).find((r) => r.key === key && r.number === number)
  if (!run) return null
  const names = [...run.reports, ...(fs.existsSync(path.join(run.path, 'state.md')) ? ['state.md'] : [])]
  return { ...run, files: names.map((name) => ({ name, text: readReport(run.path, name) ?? '' })) }
}

/** `done`, `blocked`, `failed`: the part before the colon. */
export function verdictFamily(verdict: string | null): string | null {
  return verdict ? verdict.split(':')[0]! : null
}

function counts(src: ViewSources, runs: ShownRun[], now: Date): StateView['counts'] {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
  const verdictOf = (r: ShownRun) => r.verdict ?? r.ending ?? '-'
  const { label, members } = lastBatch(src, runs)
  return {
    allTime: tally(runs.map(verdictOf)),
    last7Days: tally(runs.filter((r) => r.startedAt >= weekAgo).map(verdictOf)),
    lastBatch: tally(members.map(verdictOf)),
    lastBatchLabel: label,
  }
}

/**
 * The last batch: the service's runs since the loop was last started, or, when the newest
 * batch summary (batch-<time>/summary.tsv) under the runs directory is later, the runs it lists.
 */
function lastBatch(src: ViewSources, runs: ShownRun[]): { label: string; members: ShownRun[] } {
  const loop = loopState(src.db)
  let batchDir: string | null = null
  try {
    batchDir = fs.readdirSync(src.runsDir).filter((n) => /^batch-\d{8}-\d{6}$/.test(n)).sort().at(-1) ?? null
  } catch {
    batchDir = null
  }
  const batchAt = batchDir ? batchTime(batchDir) : null
  if (loop.startedAt && (!batchAt || loop.startedAt > batchAt)) {
    return { label: `loop since ${loop.startedAt}`, members: runs.filter((r) => r.serviceRunId !== null && r.startedAt >= loop.startedAt!) }
  }
  if (!batchDir) return { label: 'no batch yet', members: [] }
  let paths: string[] = []
  try {
    paths = fs.readFileSync(path.join(src.runsDir, batchDir, 'summary.tsv'), 'utf8').split('\n').map((l) => l.split('\t')[3] ?? '').filter((p) => p.startsWith('/'))
  } catch {
    /* a batch without a summary yet */
  }
  return { label: batchDir, members: runs.filter((r) => paths.includes(r.path)) }
}

function batchTime(name: string): string {
  const m = /^batch-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name)!
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString()
}

function tally(values: string[]): Counts {
  const out: Counts = {}
  for (const v of values) out[v] = (out[v] ?? 0) + 1
  return out
}
