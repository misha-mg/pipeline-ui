// What a run leaves under .pipeline-runs/<KEY>/run-N/: the service finds the directory a run
// made by comparing the key's run directories before and after, and reads the verdict (the last
// line of state.md) and the summary (00-assignment.md) from it. Formats: webui's ADR
// ticket-pipeline.
import fs from 'node:fs'
import path from 'node:path'

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

/** The last non-empty line of state.md; null while the run is not closed. */
export function readVerdict(runDir: string): string | null {
  const text = readText(path.join(runDir, 'state.md'))
  if (text === null) return null
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.at(-1) ?? null
}

/** The `- Summary:` line of 00-assignment.md. */
export function readSummary(runDir: string): string | null {
  const text = readText(path.join(runDir, '00-assignment.md'))
  const match = text?.match(/^- Summary:\s*(.+)$/m)
  return match?.[1]?.trim() ?? null
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
