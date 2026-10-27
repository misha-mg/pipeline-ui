// Every run under webui's .pipeline-runs/, runs from before the console included, read from
// the files a run leaves: 00-assignment.md (start time, summary), the stage reports, state.md
// (a line per stage, the pull request's URL, the verdict last) and timings.tsv (each stage's
// agent, start and seconds). The formats are the pipeline's contract with pipeline-tui, which
// reads them the same way; older runs wrote state.md by hand, so the parsing is lenient.
import fs from 'node:fs'
import path from 'node:path'

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
  verdict: string | null
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
const REASON = /^reason: (.+)$/m
const SUMMARY = /(?:\*\*)?Summary:(?:\*\*)?[ \t]*(.+)/
// A quoted summary runs to the line's last quote: quotes inside it may or may not be escaped.
const QUOTED = /^"(.*)"/
const START_LINE = /^- (?:Time|Started|Start): (.+)$/m
const STAGE_LINE = /^(?:\d\d[ -])?(investigate|diff|implement|review|app-test|pull-request)\b(.*)$/i

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

export function loadRun(runDir: string, key: string, number: number): HistoryRun {
  const files = safeReaddir(runDir)
  const assignment = readText(path.join(runDir, '00-assignment.md'))
  const state = readText(path.join(runDir, 'state.md'))
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
    verdict: verdictOf(state),
    reason: state?.match(REASON)?.[1] ?? null,
    prUrl: state?.match(PR_URL)?.[0] ?? null,
    stages,
    reports: files.filter((f) => REPORT.test(f)).sort(),
  }
}

/** The verdict, the last non-empty line of state.md. */
export function verdictOf(state: string | null): string | null {
  const lines = state?.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines?.at(-1) ?? null
}

/** The stages: from timings.tsv when the run wrote one, else the stage lines of state.md. */
export function stagesOf(timings: string | null, state: string | null): HistoryStage[] {
  const results = new Map<string, string>()
  for (const line of state?.split('\n') ?? []) {
    const m = STAGE_LINE.exec(line.trim())
    if (m && m[1] && !results.has(m[1].toLowerCase())) results.set(m[1].toLowerCase(), resultOf(m[2] ?? ''))
  }
  if (timings) {
    const rows = timings.split('\n').slice(1).map((l) => l.split('\t')).filter((r) => r.length >= 4 && r[0])
    if (rows.length > 0) {
      return rows.map(([label, agent, started, seconds]) => ({
        label: label!,
        agent: agent || null,
        startedAt: started || null,
        seconds: seconds && !Number.isNaN(Number(seconds)) ? Number(seconds) : null,
        result: results.get(label!.replace(' ', '-')) ?? null,
      }))
    }
  }
  return [...results].map(([label, result]) => ({ label, agent: null, startedAt: null, seconds: null, result: result || null }))
}

/**
 * What a stage's state.md line says after its name: in the pipeline's own format
 * (`— agent (mode) — result`) the result alone; a hand-written line as it is.
 */
function resultOf(rest: string): string {
  const text = rest.trim()
  if (!text.startsWith('—')) return text
  const parts = text.split(' — ').map((p) => p.trim()).filter(Boolean)
  return parts.at(-1) ?? ''
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
