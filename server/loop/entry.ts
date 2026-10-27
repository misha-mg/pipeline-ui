// Which start.sh a run goes through, checked before every run. By default webui's own run.sh,
// whose worktree comes from origin/master and whose start.sh is that worktree's: the service
// starts a run only when origin/master's start.sh knows PIPELINE_SESSION, since an older one
// runs the plain CLI unwatched, to a pull request. With PIPELINE_START_SH_REF the worktree still
// comes from origin/master, but its start.sh is taken from that ref (a branch that has the entry
// point while origin/master does not): origin/master's run.sh is copied into the data directory
// with its last line pointed at that start.sh. ADR webui-entry-point, During the code freeze.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export type EntryConfig = {
  webuiDir: string
  /** The ref whose start.sh runs instead of the worktree's; null for webui's run.sh as it is. */
  startShRef: string | null
  /** Where the copied run.sh and start.sh are written. */
  entryDir: string
}

/** The command the runner starts in the webui checkout, and what it adds to the environment. */
export type Entry = { runSh: string; env: Record<string, string> }

/** Runs git in the webui checkout and resolves with its stdout; rejects when it fails. */
export type Git = (args: string[]) => Promise<string>

const RUN_SH = 'tools/ticket-pipeline/run.sh'
const START_SH = 'tools/ticket-pipeline/start.sh'
const HANDOVER = 'exec tools/ticket-pipeline/start.sh "$@"'
const HANDOVER_COPY = 'exec bash "$PIPELINE_START_SH" "$@"'
const exec = promisify(execFile)

/** The entry point a run takes, fixed: what the runner starts once `prepareEntry` said yes. */
export function entryOf(config: EntryConfig): Entry {
  if (!config.startShRef) return { runSh: RUN_SH, env: {} }
  return { runSh: path.join(config.entryDir, 'run.sh'), env: { PIPELINE_START_SH: path.join(config.entryDir, 'start.sh') } }
}

/** The entry point's origin as the console shows it. */
export function entryLabel(config: EntryConfig): string {
  return config.startShRef ? `run.sh from origin/master, start.sh from ${config.startShRef}` : 'run.sh and start.sh from origin/master'
}

/**
 * Fetches origin and checks the start.sh a run would go through; with a ref, writes the copies
 * the runner starts. Resolves with null when a run may start, or with why it may not.
 */
export async function prepareEntry(config: EntryConfig, git: Git = gitIn(config.webuiDir)): Promise<string | null> {
  try {
    await git(['fetch', '--quiet', 'origin'])
  } catch (error) {
    return `git fetch origin failed in ${config.webuiDir}: ${firstLine(error)}`
  }
  const show = async (ref: string, file: string): Promise<string | null> => {
    try {
      return await git(['show', `${ref}:${file}`])
    } catch {
      return null
    }
  }
  if (!config.startShRef) {
    const start = await show('origin/master', START_SH)
    if (start === null) return `origin/master has no ${START_SH}`
    if (!start.includes('PIPELINE_SESSION')) {
      return `origin/master's start.sh has no PIPELINE_SESSION: a run would go unwatched to a pull request. Set PIPELINE_START_SH_REF to a branch whose start.sh has it`
    }
    return null
  }
  const start = await show(config.startShRef, START_SH)
  if (start === null) return `${config.startShRef} has no ${START_SH} (PIPELINE_START_SH_REF)`
  if (!start.includes('PIPELINE_SESSION')) return `${config.startShRef}'s start.sh has no PIPELINE_SESSION (PIPELINE_START_SH_REF)`
  const run = await show('origin/master', RUN_SH)
  if (run === null) return `origin/master has no ${RUN_SH}`
  const lines = run.split('\n')
  const at = lines.lastIndexOf(HANDOVER)
  if (at === -1) return `origin/master's run.sh no longer ends with \`${HANDOVER}\`: the start.sh it hands over to cannot be swapped (PIPELINE_START_SH_REF)`
  lines[at] = HANDOVER_COPY
  const entry = entryOf(config)
  fs.mkdirSync(config.entryDir, { recursive: true })
  fs.writeFileSync(entry.runSh, lines.join('\n'), { mode: 0o755 })
  fs.writeFileSync(entry.env.PIPELINE_START_SH!, start, { mode: 0o755 })
  return null
}

function gitIn(dir: string): Git {
  return async (args) => (await exec('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })).stdout
}

function firstLine(error: unknown): string {
  const e = error as { stderr?: string; message?: string }
  return ((e.stderr || e.message) ?? String(error)).trim().split('\n')[0] ?? ''
}
