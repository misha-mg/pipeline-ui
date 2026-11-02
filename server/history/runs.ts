// Every run under webui's .pipeline-runs/, runs from before the console included, read from
// the files a run leaves: 00-assignment.md (start time, summary), the stage reports, state.md
// (a line per stage, the pull request's URL, the reason, the verdict last) and timings.tsv (each
// stage's agent, start and seconds). The formats are the pipeline's contract with pipeline-tui,
// which reads them the same way; older runs wrote state.md by hand, in half a dozen stage-line
// shapes, so the parsing is lenient. A stage that ran several times (review, app-test, a rework's
// implement) has a line each time: lines are matched to timings.tsv's rows in order, never by name.
import fs from 'node:fs'
import path from 'node:path'
import { parseVerdict, stageKey, verdictFamily, type Verdict } from './outcome.ts'

export type HistoryStage = { label: string; agent: string | null; startedAt: string | null; seconds: number | null; result: string | null }

export type HistoryRun = {
  key: string
  number: number
  /** The run directory. */
  path: string
  startedAt: string
  /** When state.md was written; null while the run has none. */
  finishedAt: string | null
  /** Seconds from the start to state.md, or to the last stage's end when that is later. */
  seconds: number | null
  summary: string | null
  verdict: Verdict | null
  /** Why the run stopped: state.md's `reason:` line, or, for a stop without one, its last free line. */
  reason: string | null
  prUrl: string | null
  stages: HistoryStage[]
  /** The report file names, in order: 00-assignment.md, 01-investigate.md, ... */
  reports: string[]
}

const TICKET_DIR = /^[A-Z]+-\d+$/
const RUN_DIR = /^run-(\d+)$/
const REPORT = /^\d\d-.+\.md$/
const PR_URL = /https:\/\/bitbucket\.org\/\S+?\/pull-requests\/\d+/
const SUMMARY = /(?:\*\*)?Summary:(?:\*\*)?[ \t]*(.+)/
// A quoted summary runs to the line's last quote: quotes inside it may or may not be escaped.
const QUOTED = /^"(.*)"/
const START_LINE = /^- (?:Time|Started|Start): (.+)$/m
// A stage line: an optional number, the stage, then the agent and the result in one of the shapes
// below (canonical first): `review — change-reviewer (-) — pass`, `03 review (change-reviewer):
// pass`, `review: change-reviewer (-) — pass`, `review · change-reviewer · pass`.
const STAGE_LINE = /^(?:\d\d[ -])?(investigate|implement|review|app-test|pull-request|pull request)\b(.*)$/i
// app-test's summary line (`app-test: unverified:app-test — …`, `app-test: passed`) is not a stage.
const APP_TEST_SUMMARY = /^app-test\s*[:·]\s*(?:unverified|passed|not[ -]applicable)/i
// The lines that say something else than a stage: `reason:`, `pr:`, `note:`, `app-test:`, `known-defects:`.
const FIELD_LINE = /^(reason|pr|note|app-test|known-defects)\s*:/i
const AGENT = /^([a-z]+(?:-[a-z]+)+)(?:\s*\(([^)]*)\))?$/

/** Every run under `runsDir`, the most recently started first. */
export function loadRuns(runsDir: string): HistoryRun[] {
  const runs: HistoryRun[] = []
  for (const ticket of safeReaddir(runsDir)) {
    if (!TICKET_DIR.test(ticket)) continue
    for (const name of safeReaddir(path.join(runsDir, ticket))) {
      const match = RUN_DIR.exec(name)
      if (match) runs.push(loadRun(path.join(runsDir, ticket, name), ticket, Number(match[1])))
    }
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.number - a.number)
}

function loadRun(runDir: string, key: string, number: number): HistoryRun {
  const files = safeReaddir(runDir)
  const assignment = readText(path.join(runDir, '00-assignment.md'))
  const state = readText(path.join(runDir, 'state.md'))
  const verdict = verdictOf(state)
  const startedAt = startOf(assignment) ?? mtime(path.join(runDir, '00-assignment.md')) ?? mtime(runDir) ?? new Date(0).toISOString()
  const finishedAt = state === null ? null : mtime(path.join(runDir, 'state.md'))
  const stages = stagesOf(readText(path.join(runDir, 'timings.tsv')), state)
  const lastStageEnd = stages.reduce<number>((end, s) => (s.startedAt && s.seconds !== null ? Math.max(end, Date.parse(s.startedAt) + s.seconds * 1000) : end), 0)
  const endMs = finishedAt ? Math.max(Date.parse(finishedAt), lastStageEnd) : lastStageEnd || null
  return {
    key,
    number,
    path: runDir,
    startedAt,
    finishedAt,
    seconds: endMs ? Math.max(0, Math.round((endMs - Date.parse(startedAt)) / 1000)) : null,
    summary: summaryOf(assignment) ?? summaryOf(readText(path.join(runDir, '01-investigate.md'))),
    verdict,
    reason: reasonOf(state, verdict),
    prUrl: state?.match(PR_URL)?.[0] ?? (verdict?.startsWith('done:') ? prUrlOfReports(runDir, files) : null),
    stages,
    reports: files.filter((f) => REPORT.test(f)).sort(),
  }
}

/** The verdict: state.md's last line that is one (a hand-written file may end on a note). */
export function verdictOf(state: string | null): Verdict | null {
  const lines = state?.split('\n') ?? []
  for (let i = lines.length - 1; i >= 0; i--) {
    const verdict = parseVerdict(lines[i]!)
    if (verdict) return verdict
  }
  return null
}

/**
 * Why the run stopped: the `reason:` line with any lines that carry it on, or, for a blocked or
 * failed run without one, its last line that is neither a stage, a field nor the verdict.
 */
export function reasonOf(state: string | null, verdict: Verdict | null): string | null {
  const lines = (state ?? '').split('\n').map((l) => l.trim())
  const at = lines.findIndex((l) => /^reason\s*:/i.test(l))
  if (at !== -1) {
    const more = []
    for (const line of lines.slice(at + 1)) {
      if (!line || FIELD_LINE.test(line) || STAGE_LINE.test(line) || parseVerdict(line)) break
      more.push(line)
    }
    return [lines[at]!.replace(/^reason\s*:\s*/i, ''), ...more].join(' ').trim() || null
  }
  const family = verdictFamily(verdict)
  if (family !== 'blocked' && family !== 'failed') return null
  const free = lines.filter((l) => l && !FIELD_LINE.test(l) && !STAGE_LINE.test(l) && !parseVerdict(l) && !/^#/.test(l))
  return free.at(-1) ?? null
}

/** The pull request a done run's pull-request report names, for a state.md that does not. */
function prUrlOfReports(runDir: string, files: string[]): string | null {
  const report = files.filter((f) => /^\d\d-pull-request\.md$/.test(f)).sort().at(-1)
  return report ? readText(path.join(runDir, report))?.match(PR_URL)?.[0] ?? null : null
}

type StateStage = { key: string; agent: string | null; mode: string | null; result: string | null }

/** state.md's stage lines, in order, in whichever shape they were written. */
export function stateStages(state: string | null): StateStage[] {
  const out: StateStage[] = []
  for (const raw of state?.split('\n') ?? []) {
    const line = raw.trim()
    if (APP_TEST_SUMMARY.test(line)) continue
    const m = STAGE_LINE.exec(line)
    if (!m) continue
    const key = m[1]!.toLowerCase().replace(' ', '-')
    let rest = m[2]!.trim()
    let agent: string | null = null
    let mode: string | null = null
    const paren = /^\(([a-z-]+)(?:,\s*([^)]*))?\)\s*:?\s*(.*)$/.exec(rest)
    if (paren) {
      ;[agent, mode, rest] = [paren[1]!, paren[2]?.trim() || null, paren[3]!]
    } else {
      const parts = rest.replace(/^[:·—–-]\s*/, '').split(/\s+[—·]\s+/).filter(Boolean)
      const who = AGENT.exec(parts[0] ?? '')
      if (who) {
        ;[agent, mode] = [who[1]!, who[2]?.trim() || null]
        parts.shift()
      }
      rest = parts.join(' · ')
    }
    out.push({ key, agent, mode: mode === '-' ? null : mode, result: rest.trim() || null })
  }
  return out
}

/**
 * The stages: timings.tsv's rows when the run wrote one, each given the result of the next unused
 * state.md line of its stage; else state.md's lines, a rework's implement named `rework N`.
 */
export function stagesOf(timings: string | null, state: string | null): HistoryStage[] {
  const lines = stateStages(state)
  if (timings) {
    const rows = timings.split('\n').slice(1).map((l) => l.split('\t')).filter((r) => r.length >= 4 && r[0])
    if (rows.length > 0) {
      const queues = new Map<string, StateStage[]>()
      for (const line of lines) queues.set(line.key, [...(queues.get(line.key) ?? []), line])
      return rows.map(([label, agent, started, seconds]) => {
        const key = stageKey(label!)
        return {
          label: label!,
          agent: agent || null,
          startedAt: started || null,
          seconds: seconds && !Number.isNaN(Number(seconds)) ? Number(seconds) : null,
          result: (key ? queues.get(key)?.shift()?.result : null) ?? null,
        }
      })
    }
  }
  let reworks = 0
  return lines.map((l) => ({
    label: l.key === 'implement' && l.mode === 'rework' ? `rework ${++reworks}` : l.key === 'pull-request' ? 'pull request' : l.key,
    agent: l.agent,
    startedAt: null,
    seconds: null,
    result: l.result,
  }))
}

/** The ticket's summary from a report's `Summary:` line, unquoted. */
export function summaryOf(text: string | null): string | null {
  const m = text?.match(SUMMARY)
  if (!m?.[1]) return null
  const raw = m[1].trim()
  const quoted = QUOTED.exec(raw)
  return (quoted ? quoted[1]!.replace(/\\"/g, '"') : raw.replace(/\.$/, '')) || null
}

function startOf(assignment: string | null): string | null {
  const raw = assignment?.match(START_LINE)?.[1]?.trim()
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

export function readReport(runDir: string, name: string): string | null {
  if (!REPORT.test(name) && name !== 'state.md') return null
  return readText(path.join(runDir, name))
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function mtime(file: string): string | null {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return null
  }
}
