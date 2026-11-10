// What a run leaves under .pipeline-runs/<KEY>/run-N/: the service finds the directory a run
// made by comparing the key's run directories before and after, and reads the verdict (state.md's
// last verdict line, history/runs.ts) and the summary (00-assignment.md) from it. Formats: webui's ADR
// ticket-pipeline.
import fs from 'node:fs'
import path from 'node:path'
import type { Verdict } from '../history/outcome.ts'
import { verdictOf } from '../history/runs.ts'

const RUN_DIR = /^run-(\d+)$/

/** The key's run directory names, lowest number first. */
export function runDirsOf(runsDir: string, key: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(path.join(runsDir, key))
  } catch {
    return []
  }
  return names.filter((n) => RUN_DIR.test(n)).sort((a, b) => runNumber(a) - runNumber(b))
}

/** The run directory that appeared since `before`, the newest when several did; null for none. */
export function newRunDir(runsDir: string, key: string, before: string[]): string | null {
  const fresh = runDirsOf(runsDir, key).filter((n) => !before.includes(n))
  const last = fresh.at(-1)
  return last ? path.join(runsDir, key, last) : null
}

/** The run's verdict, read from state.md as the history reads it; null while the run is not closed. */
export function readVerdict(runDir: string): Verdict | null {
  return verdictOf(readText(path.join(runDir, 'state.md')))
}

/** The `- Summary:` line of 00-assignment.md. */
export function readSummary(runDir: string): string | null {
  const text = readText(path.join(runDir, '00-assignment.md'))
  const match = text?.match(/^- Summary:\s*(.+)$/m)
  return match?.[1]?.trim() ?? null
}

/** Whether the assignment names the screen-migration workflow (webui's ticket-pipeline skill writes the line). */
export function readMigration(runDir: string): boolean {
  return /^- Workflow: screen-migration\b/m.test(readText(path.join(runDir, '00-assignment.md')) ?? '')
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function runNumber(name: string): number {
  return Number(RUN_DIR.exec(name)?.[1] ?? 0)
}
