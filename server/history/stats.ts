// What the statistics page says, summed up from /api/stats for one period: the runs started in
// it (or the last batch's), their tickets, the pull requests they opened and what became of
// them, the tickets that reached Done in Jira, and the same day by day or week by week. A period
// picks runs, not events: a PR from a run in the period counts with its merge, whenever it came.
// No Node imports: the console's bundle loads this file, and the tests run it as it is.
import type { PrChanges, PullRequestState } from './bitbucket.ts'
import type { KnownTicket } from './tickets.ts'
import type { StatsRun, StatsView } from '../http/view.ts'
import { verdictFamily } from './outcome.ts'

export const PERIODS = ['batch', '7d', '30d', '90d', 'all'] as const
export type Period = (typeof PERIODS)[number]

const DAY_MS = 24 * 3600 * 1000

/** The runs a period covers: started within its days, or the last batch's. */
export function periodRuns(view: StatsView, period: Period): StatsRun[] {
  if (period === 'batch') return view.runs.filter((r) => r.inLastBatch)
  if (period === 'all') return view.runs
  const since = new Date(Date.parse(view.now) - Number(period.slice(0, -1)) * DAY_MS).toISOString()
  return view.runs.filter((r) => r.startedAt >= since)
}

/**
 * What became of a pull request: open, merged as the pipeline opened it, merged with changes,
 * merged but not compared (yet, or it could not be), declined; `unknown` before Bitbucket said.
 */
export type PrOutcome = 'open' | 'merged-as-opened' | 'merged-with-changes' | 'merged-not-compared' | 'declined' | 'unknown'

export function prOutcome(pr: PullRequestState): PrOutcome {
  if (pr.state === 'OPEN') return 'open'
  if (pr.state === 'DECLINED' || pr.state === 'SUPERSEDED') return 'declined'
  if (pr.state !== 'MERGED') return 'unknown'
  return pr.changes?.changed === true ? 'merged-with-changes' : pr.changes?.changed === false ? 'merged-as-opened' : 'merged-not-compared'
}

export const PR_OUTCOME_LABEL: Record<PrOutcome, string> = {
  open: 'open',
  'merged-as-opened': 'merged as opened',
  'merged-with-changes': 'merged with changes',
  'merged-not-compared': 'merged, not compared',
  declined: 'declined',
  unknown: 'unknown',
}

/** A pull request as the page lists it, with the run that opened it and its ticket's status. */
export type PrRow = {
  url: string
  number: string
  key: string
  run: number
  summary: string | null
  outcome: PrOutcome
  pr: PullRequestState
  /** When it was opened: Bitbucket's date, or the run's end before Bitbucket said. */
  openedAt: string | null
  changes: PrChanges | null
  ticket: KnownTicket | null
}

export function prRows(view: StatsView, runs: StatsRun[]): PrRow[] {
  const rows = new Map<string, PrRow>()
  // Oldest first, so the run that opened it wins over a later one that named it again.
  for (const r of [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const pr = r.prUrl ? view.pullRequests[r.prUrl] : undefined
    if (!pr || rows.has(pr.url)) continue
    rows.set(pr.url, {
      url: pr.url, number: pr.url.match(/(\d+)$/)?.[1] ?? '', key: r.key, run: r.number, summary: r.summary ?? view.tickets[r.key]?.summary ?? null,
      outcome: prOutcome(pr), pr, openedAt: pr.createdOn ?? r.finishedAt, changes: pr.changes, ticket: view.tickets[r.key] ?? null,
    })
  }
  return [...rows.values()].sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? '') || Number(b.number) - Number(a.number))
}

/** How a run ended for the statistics: done with or without a pull request, nothing to build, stopped (blocked or failed), or no verdict. */
export type RunKind = 'done' | 'nothing' | 'stopped' | 'none'

export function runKind(run: Pick<StatsRun, 'verdict'>): RunKind {
  const family = verdictFamily(run.verdict)
  if (family === 'done') return run.verdict === 'done:nothing-to-build' ? 'nothing' : 'done'
  return family ? 'stopped' : 'none'
}

export type Summary = {
  runs: number
  tickets: number
  /** Runs by how they ended. */
  kinds: Record<RunKind, number>
  /** The blocked and failed verdicts, the most common first. */
  stopReasons: [string, number][]
  /** Tickets none of whose runs in the period ended done, nor is one in flight. */
  ticketsNotFinished: number
  prs: Record<PrOutcome, number> & { opened: number; merged: number; drafts: number; into: [string, number][] }
  /** Merged out of merged and declined; null before any closed. */
  mergeRate: number | null
  /** Merged as opened out of the merged that were compared; null before any. */
  asOpenedRate: number | null
  medianToMerge: number | null
  medianRun: number | null
  /** Tickets: run, with a pull request, with one merged, and of those, Done in Jira. */
  funnel: { run: number; pr: number; merged: number; done: number }
  /** Tickets with a merged pull request whose Jira status is not known (not read, or Jira is off). */
  mergedTicketsUnknown: number
}

export function summarize(view: StatsView, runs: StatsRun[]): Summary {
  const prs = prRows(view, runs)
  const kinds: Record<RunKind, number> = { done: 0, nothing: 0, stopped: 0, none: 0 }
  for (const r of runs) kinds[runKind(r)] += 1
  const stops = tally(runs.filter((r) => runKind(r) === 'stopped').map((r) => r.verdict!))
  const keys = [...new Set(runs.map((r) => r.key))]
  const finished = new Set(runs.filter((r) => verdictFamily(r.verdict) === 'done' || r.ending === 'in-flight').map((r) => r.key))
  const outcomes = Object.fromEntries(Object.keys(PR_OUTCOME_LABEL).map((o) => [o, 0])) as Record<PrOutcome, number>
  for (const p of prs) outcomes[p.outcome] += 1
  const merged = prs.filter((p) => p.pr.state === 'MERGED')
  const declined = outcomes.declined
  const compared = outcomes['merged-as-opened'] + outcomes['merged-with-changes']
  const toMerge = merged.flatMap((p) => (p.openedAt && p.pr.closedOn ? [(Date.parse(p.pr.closedOn) - Date.parse(p.openedAt)) / 1000] : []))
  const withPr = new Set(prs.map((p) => p.key))
  const mergedKeys = new Set(merged.map((p) => p.key))
  const doneKeys = [...mergedKeys].filter((k) => view.tickets[k]?.statusCategory === 'done')
  return {
    runs: runs.length,
    tickets: keys.length,
    kinds,
    stopReasons: stops,
    ticketsNotFinished: keys.filter((k) => !finished.has(k)).length,
    prs: { ...outcomes, opened: prs.length, merged: merged.length, drafts: prs.filter((p) => p.pr.draft).length, into: tally(merged.map((p) => p.pr.destination ?? 'unknown')) },
    mergeRate: merged.length + declined ? merged.length / (merged.length + declined) : null,
    asOpenedRate: compared ? outcomes['merged-as-opened'] / compared : null,
    medianToMerge: median(toMerge),
    medianRun: median(runs.flatMap((r) => (r.seconds === null || r.ending === 'in-flight' ? [] : [r.seconds]))),
    funnel: { run: keys.length, pr: withPr.size, merged: mergedKeys.size, done: doneKeys.length },
    mergedTicketsUnknown: [...mergedKeys].filter((k) => !view.tickets[k]?.statusCategory).length,
  }
}

/** One day or week of the timeline, by its first day (`2026-10-12`). */
export type Bucket = {
  day: string
  runs: Record<RunKind, number>
  opened: number
  closed: { asOpened: number; withChanges: number; merged: number; declined: number }
  /** Tickets with a merged pull request that moved into Done in Jira. */
  done: number
}

export type TimelineOptions = {
  bucket: 'day' | 'week'
  /** The calendar day an instant falls on where the page is read, as `YYYY-MM-DD`. */
  dayOf: (iso: string) => string
  /** The first day shown; the earliest run's when not given. */
  from?: string
  /** The last day shown: today. */
  to: string
}

/**
 * The period's events in buckets from `from` to `to`, every bucket there even when nothing
 * happened in it: runs by the day they started, pull requests by the day they were opened and
 * closed, tickets by the day they moved into Done.
 */
export function timeline(view: StatsView, runs: StatsRun[], options: TimelineOptions): Bucket[] {
  const { dayOf, bucket } = options
  const startOf = (day: string) => (bucket === 'week' ? mondayOf(day) : day)
  const first = options.from ?? runs.map((r) => dayOf(r.startedAt)).sort()[0] ?? options.to
  const buckets = new Map<string, Bucket>()
  for (let day = startOf(first); day <= options.to; day = addDays(day, bucket === 'week' ? 7 : 1)) {
    buckets.set(day, { day, runs: { done: 0, nothing: 0, stopped: 0, none: 0 }, opened: 0, closed: { asOpened: 0, withChanges: 0, merged: 0, declined: 0 }, done: 0 })
  }
  const at = (iso: string | null) => (iso ? buckets.get(startOf(dayOf(iso))) : undefined)
  for (const r of runs) {
    const b = at(r.startedAt)
    if (b) b.runs[runKind(r)] += 1
  }
  const prs = prRows(view, runs)
  for (const p of prs) {
    const opened = at(p.openedAt)
    if (opened) opened.opened += 1
    const closed = at(p.pr.closedOn)
    if (!closed) continue
    if (p.outcome === 'merged-as-opened') closed.closed.asOpened += 1
    else if (p.outcome === 'merged-with-changes') closed.closed.withChanges += 1
    else if (p.outcome === 'merged-not-compared') closed.closed.merged += 1
    else if (p.outcome === 'declined') closed.closed.declined += 1
  }
  for (const key of new Set(prs.filter((p) => p.pr.state === 'MERGED').map((p) => p.key))) {
    const b = at(view.tickets[key]?.doneAt ?? null)
    if (b) b.done += 1
  }
  return [...buckets.values()]
}

/** The day `n` days after `day`, both `YYYY-MM-DD`: calendar arithmetic, no time zone in it. */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return addDays(day, -((weekday + 6) % 7))
}

function tally(values: string[]): [string, number][] {
  const m = new Map<string, number>()
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2)
}
