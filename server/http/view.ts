// What the console shows, assembled from the database, the run directories and the health
// checks: the state (service, loop, run in flight, queue, counts, health) and the history
// (every run, with its ending and its pull request's state). Pure functions over the sources,
// so the API and the tests share them.
import fs from 'node:fs'
import path from 'node:path'
import { loadRuns, readReport, type HistoryRun } from '../history/runs.ts'
import { pullRequestStates, unknownPullRequest, type PullRequestState } from '../history/bitbucket.ts'
import { ticketStatuses, type KnownTicket } from '../history/tickets.ts'
import type { PullRequests } from '../config.ts'
import type { Health } from '../health.ts'
import { SHOWN_ENDINGS, stageOfAgent, verdictFamily, type ShownEnding } from '../history/outcome.ts'
import { structuredOutput } from '../session/transcript.ts'
import type { Db } from '../store/db.ts'
import { listQueue, type QueueItem } from '../store/queue.ts'
import {
  inFlight,
  listEvents,
  listRuns,
  loopState,
  serviceAlive,
  serviceInfo,
  type LoopState,
  type RunRecord,
  type ServiceInfo,
} from '../store/runs.ts'

export type { ShownEnding } from '../history/outcome.ts'
// Every ending the service records is one the console can show: a new one without a word there fails here.
const _everyEndingShown: ShownEnding = '' as RunRecord['ending'] & string
void _everyEndingShown

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
  /** How the service starts a run: which launch script, and whether it may open a pull request. */
  setup: RunSetup | null
  /** The Jira site a ticket key links to (JIRA_BASE_URL); null when it is not set. */
  jiraSite: string | null
}

/** How each run is set up: the entry point as the console shows it, the webui branch it starts from and its pull request goes to, and whether it may open one, or only a draft. */
export type RunSetup = { entry: string; baseBranch: string; pullRequests: PullRequests }

export type ViewSources = {
  db: Db
  runsDir: string
  health: () => Health | null
  setup?: RunSetup
  jiraSite?: string | null
  /** Whether Bitbucket (BITBUCKET_TOKEN) and Jira (the JIRA_* settings) are set up, for the statistics to say why a number is missing. */
  readers?: { bitbucket: boolean; jira: boolean }
  now?: () => Date
}

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
    setup: src.setup ?? null,
    jiraSite: src.jiraSite ?? null,
  }
}

function inFlightView(db: Db, run: RunRecord, now: Date): InFlightView {
  const reworks = agentStages(db, run.id).filter((s) => s.label.startsWith('rework ')).length
  return { ...run, rework: reworks, seconds: Math.max(0, Math.round((now.getTime() - Date.parse(run.startedAt)) / 1000)) }
}

/** Every run under the runs directory with what the service knows of it, newest first. */
export function shownRuns(src: ViewSources): ShownRun[] {
  const byDir = new Map(
    listRuns(src.db, 10_000)
      .filter((r) => r.runDir)
      .map((r) => [r.runDir!, r]),
  )
  const flying = inFlight(src.db)
  const prs = pullRequestStates(src.db)
  const runs = loadRuns(src.runsDir).map((h): ShownRun => {
    const rec = byDir.get(h.path) ?? null
    // A run the service did not drive has no ending of its own: its files closed it (unwatched) or not (died).
    const ending: ShownEnding =
      rec?.ending ?? (rec ? 'in-flight' : h.verdict ? 'unwatched' : flying?.key === h.key && !flying.runDir ? 'in-flight' : 'died')
    return {
      ...h,
      serviceRunId: rec?.id ?? null,
      ending,
      endingDetail: rec?.endingDetail ?? null,
      pr: h.prUrl ? (prs.get(h.prUrl) ?? unknownPullRequest(h.prUrl)) : null,
    }
  })
  // A run the service started whose directory never appeared (prepare-worktree.sh failed before the session).
  for (const rec of listRuns(src.db, 10_000)) {
    if (rec.runDir || rec.ending === null) continue
    runs.push({
      key: rec.key,
      number: 0,
      path: '',
      startedAt: rec.startedAt,
      finishedAt: rec.endedAt,
      seconds: rec.endedAt ? Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000) : null,
      summary: rec.summary,
      verdict: null,
      reason: null,
      prUrl: null,
      stages: [],
      reports: [],
      serviceRunId: rec.id,
      ending: rec.ending,
      endingDetail: rec.endingDetail,
      pr: null,
    })
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.number - a.number)
}

/** `verdict`: a family (`done`), a verdict (`done:pr-opened`) or `none`; `ending`: a shown ending. */
export type HistoryFilter = { verdict?: string | undefined; ending?: string | undefined }

/** Why a filter is not one the history knows; null when it is. */
export function filterProblem(filter: HistoryFilter): string | null {
  if (filter.verdict && !/^(none|[a-z]+(:[a-z0-9-]+)?)$/.test(filter.verdict))
    return `verdict is a family, a verdict or none, not ${filter.verdict}`
  if (filter.ending && !(SHOWN_ENDINGS as readonly string[]).includes(filter.ending))
    return `ending is one of ${SHOWN_ENDINGS.join(', ')}, not ${filter.ending}`
  return null
}

/**
 * The runs the filter lets through, and the counts each filter's choices would show: the
 * verdicts' among the runs of the chosen ending, the endings' among the runs of the chosen verdict.
 */
export function historyView(
  src: ViewSources,
  filter: HistoryFilter = {},
): { runs: ShownRun[]; total: number; verdicts: Counts; endings: Counts } {
  const all = shownRuns(src)
  const verdictMatches = (r: ShownRun) =>
    !filter.verdict ||
    (filter.verdict === 'none' ? r.verdict === null : verdictFamily(r.verdict) === filter.verdict || r.verdict === filter.verdict)
  const endingMatches = (r: ShownRun) => !filter.ending || r.ending === filter.ending
  return {
    runs: all.filter((r) => verdictMatches(r) && endingMatches(r)),
    total: all.length,
    verdicts: tally(all.filter(endingMatches).map((r) => r.verdict ?? 'none')),
    endings: tally(all.filter(verdictMatches).map((r) => r.ending)),
  }
}

/**
 * One agent of a run the service drove, from its session's SubagentStart/SubagentStop events, in
 * the order they started: known while the run is in flight, when the pipeline has not yet written
 * its reports (it writes them at the end). `endedAt` is null while the agent works, or when the
 * session ended under it; `text` is its last message, null before 2026-11-02's sessions sent it.
 */
export type AgentStage = {
  agent: string
  agentId: string
  /** The stage, named as timings.tsv names it: `investigate`, `rework 1`, `pull request`, `same cause?`. */
  label: string
  startedAt: string
  endedAt: string | null
  text: string | null
  /** The word it ended on, from the short fields of what it handed back: `pass`, `done`, `confidence low`. */
  result: string | null
}

/** A run with its reports as the files read, and its agents as the service saw them (empty for a run it did not drive). */
export type RunDetail = ShownRun & { files: { name: string; text: string }[]; agents: AgentStage[] }

export function runView(src: ViewSources, key: string, number: number): RunDetail | null {
  const run = shownRuns(src).find((r) => r.key === key && r.number === number)
  if (!run) return null
  const names = [...run.reports, ...(fs.existsSync(path.join(run.path, 'state.md')) ? ['state.md'] : [])]
  return {
    ...run,
    files: names.map((name) => ({ name, text: readReport(run.path, name) ?? '' })),
    agents: run.serviceRunId ? agentStages(src.db, run.serviceRunId, run.ending !== 'in-flight') : [],
  }
}

// An agent's transcript does not change once it stopped: what it handed back is read once.
const handedBackCache = new Map<string, string>()
function handedBack(transcript: string): string | null {
  const known = handedBackCache.get(transcript)
  if (known !== undefined) return known
  const text = structuredOutput(transcript)
  if (text !== null) handedBackCache.set(transcript, text)
  return text
}

/** `ended`: the run is over, so the last agent was its last stage. */
export function agentStages(db: Db, runId: number, ended = false): AgentStage[] {
  const stages: AgentStage[] = []
  for (const { event } of listEvents(db, runId)) {
    if (event.type === 'stage-start')
      stages.push({
        agent: event.agent,
        agentId: event.agentId,
        label: stageOfAgent(event.agent),
        startedAt: event.at,
        endedAt: null,
        text: null,
        result: null,
      })
    else if (event.type === 'stage-stop') {
      // The UI's type check sees this file with ES2022's library, which has no findLast.
      const open = [...stages].reverse().find((s) => s.agentId === event.agentId && s.endedAt === null)
      if (!open) continue
      const text = event.text ?? (event.transcript ? handedBack(event.transcript) : null)
      Object.assign(open, { endedAt: event.at, text, result: resultOf(text) })
    }
  }
  return labelImplementers(stages, ended)
}

/** The word an agent ended on: its `verdict:` or `outcome:` field, else its `confidence:`. */
function resultOf(text: string | null): string | null {
  const field = (name: string) => text?.match(new RegExp(`^${name}: (\\S+)$`, 'm'))?.[1] ?? null
  const confidence = field('confidence')
  return field('verdict') ?? field('outcome') ?? (confidence ? `confidence ${confidence}` : null)
}

/**
 * The implementer works three stages: the first implement, a rework when a review or a test
 * failed, the pull request at the end. A later implementer is a rework when a diff follows it,
 * the pull request when another agent follows or the run ended on it; until then, the stage
 * before it says which (a `fail` sends it to rework), or it is not known yet.
 */
function labelImplementers(stages: AgentStage[], ended: boolean): AgentStage[] {
  let reworks = 0
  let implementers = 0
  stages.forEach((s, i) => {
    if (s.agent !== 'ticket-implementer' || implementers++ === 0) return
    const after = stages.slice(i + 1)
    const before = stages[i - 1]
    // A rework is always followed by a diff: in a run that is over, the last one was the pull request.
    const rework =
      after.length || ended
        ? after.some((n) => n.agent === 'diff-preparer')
        : before?.result === 'fail'
          ? true
          : before?.result
            ? false
            : null
    s.label = rework === null ? 'rework or pull request' : rework ? `rework ${++reworks}` : 'pull request'
  })
  return stages
}

/** A run as the statistics count it. */
export type StatsRun = Pick<
  ShownRun,
  'key' | 'number' | 'startedAt' | 'finishedAt' | 'seconds' | 'summary' | 'verdict' | 'ending' | 'prUrl'
> & { inLastBatch: boolean }

/**
 * What the statistics page counts, as it is: every run, the pull requests they opened, and their
 * tickets' Jira statuses. The page sums them up for the period it shows (server/history/stats.ts).
 */
export type StatsView = {
  now: string
  runs: StatsRun[]
  /** The run's pull requests by URL, as Bitbucket last said. */
  pullRequests: Record<string, PullRequestState>
  /** The tickets' statuses by key, as Jira last said; a ticket never read is not here. */
  tickets: Record<string, KnownTicket>
  lastBatchLabel: string
  /** When Bitbucket and Jira were last read; null when never. */
  readAt: { pullRequests: string | null; tickets: string | null }
  readers: { bitbucket: boolean; jira: boolean }
  jiraSite: string | null
}

export function statsView(src: ViewSources): StatsView {
  const now = (src.now ?? (() => new Date()))()
  const runs = shownRuns(src)
  const last = lastBatch(src, runs)
  const batch = new Set(last.members)
  const tickets = ticketStatuses(src.db)
  const pullRequests: Record<string, PullRequestState> = {}
  for (const r of runs) if (r.pr) pullRequests[r.pr.url] = r.pr
  const newest = (dates: (string | null)[]) =>
    dates
      .filter((d): d is string => !!d)
      .sort()
      .at(-1) ?? null
  return {
    now: now.toISOString(),
    runs: runs.map((r) => ({
      key: r.key,
      number: r.number,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      seconds: r.seconds,
      summary: r.summary,
      verdict: r.verdict,
      ending: r.ending,
      prUrl: r.prUrl,
      inLastBatch: batch.has(r),
    })),
    pullRequests,
    tickets: Object.fromEntries([...new Set(runs.map((r) => r.key))].flatMap((k) => (tickets.has(k) ? [[k, tickets.get(k)!]] : []))),
    lastBatchLabel: last.label,
    readAt: {
      pullRequests: newest(Object.values(pullRequests).map((p) => p.fetchedAt)),
      tickets: newest([...tickets.values()].map((t) => t.fetchedAt)),
    },
    readers: src.readers ?? { bitbucket: false, jira: false },
    jiraSite: src.jiraSite ?? null,
  }
}

function counts(src: ViewSources, runs: ShownRun[], now: Date): StateView['counts'] {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString()
  // Verdicts only: a run with none counts as `none`, whatever its ending.
  const verdictOf = (r: ShownRun) => r.verdict ?? 'none'
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
    batchDir =
      fs
        .readdirSync(src.runsDir)
        .filter((n) => /^batch-\d{8}-\d{6}$/.test(n))
        .sort()
        .at(-1) ?? null
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
    paths = fs
      .readFileSync(path.join(src.runsDir, batchDir, 'summary.tsv'), 'utf8')
      .split('\n')
      .map((l) => l.split('\t')[3] ?? '')
      .filter((p) => p.startsWith('/'))
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
