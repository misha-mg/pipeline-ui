// The entry point a run goes through, checked before every run: webui's script that prepares
// the ticket's worktree from origin/<base>, and the script it hands over to, which launches the
// session. The service starts a run only when that launch script knows PIPELINE_SESSION, since
// an older one runs the plain CLI unwatched, to a pull request.
//
// Both come from the base branch (PIPELINE_BASE_BRANCH, master by default, or the one set in the
// console: store/settings.ts): the prepare script is
// origin/<base>'s, copied into the data directory, so a run does not depend on the branch webui's
// checkout is on; its last line names the launch script, which is the worktree's own, made from
// origin/<base>. A base other than master needs a prepare script that reads PIPELINE_BASE_BRANCH:
// an older one builds the worktree from master whatever the variable says. ADR webui-entry-point.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Git } from '../history/changes.ts'

export type EntryConfig = {
  webuiDir: string
  /** The branch the worktree starts from and the pull request goes to. */
  baseBranch: string
  /** Where the copied prepare script is written. */
  entryDir: string
}

/** The script the runner starts in the webui checkout. */
export type Entry = { prepareWorktree: string }

export type { Git } from '../history/changes.ts'

const PREPARE = 'tools/ticket-pipeline/prepare-worktree.sh'
/** How the prepare script hands over: its last line, naming the launch script. */
const HANDOVER = /^exec (tools\/ticket-pipeline\/[A-Za-z0-9._-]+\.sh) "\$@"$/
const exec = promisify(execFile)

/** The entry point a run takes, fixed: what the runner starts once `prepareEntry` said yes. */
export function entryOf(config: EntryConfig): Entry {
  return { prepareWorktree: path.join(config.entryDir, 'prepare-worktree.sh') }
}

/** The entry point's origin as the console shows it. */
export function entryLabel(config: EntryConfig): string {
  return `worktree and session launch from origin/${config.baseBranch}`
}

/**
 * Fetches origin, checks the launch script a run would go through and writes the copy the
 * runner starts. Resolves with null when a run may start, or with why it may not.
 */
export async function prepareEntry(config: EntryConfig, git: Git = gitIn(config.webuiDir)): Promise<string | null> {
  const checked = await checkEntry(config, git)
  if (typeof checked === 'string') return checked
  const { prepareWorktree } = entryOf(config)
  fs.mkdirSync(config.entryDir, { recursive: true })
  fs.writeFileSync(prepareWorktree, checked.prepare, { mode: 0o755 })
  return null
}

/**
 * The check alone, for a base branch someone is about to set: fetches origin and reads the
 * branch's scripts, and writes nothing, since a run in flight may be reading the copy. Resolves
 * with the prepare script when a run may start from the branch, or with why it may not.
 */
export async function checkEntry(config: EntryConfig, git: Git = gitIn(config.webuiDir)): Promise<{ prepare: string } | string> {
  try {
    await git(['fetch', '--quiet', 'origin'])
  } catch (error) {
    return `git fetch origin failed in ${config.webuiDir}: ${firstLine(error)}`
  }
  const base = config.baseBranch
  const ref = `origin/${base}`
  const show = async (file: string): Promise<string | null> => {
    try {
      return await git(['show', `${ref}:${file}`])
    } catch {
      return null
    }
  }
  try {
    await git(['rev-parse', '--quiet', '--verify', `refs/remotes/${ref}^{commit}`])
  } catch {
    return `origin has no branch ${base}`
  }

  const prepare = await show(PREPARE)
  if (prepare === null) return `${ref} has no ${PREPARE}`
  const lines = prepare.split('\n')
  const at = lines.findLastIndex((l) => HANDOVER.test(l))
  if (at === -1)
    return `${ref}'s ${PREPARE} no longer ends with \`exec tools/ticket-pipeline/<script> "$@"\`: the script that launches the session cannot be found`
  const handsOverTo = HANDOVER.exec(lines[at]!)![1]!
  const launch = await show(handsOverTo)
  if (launch === null) return `${ref}'s ${PREPARE} hands over to ${handsOverTo}, which ${ref} does not have`
  if (!launch.includes('PIPELINE_SESSION'))
    return `${ref}'s ${handsOverTo} has no PIPELINE_SESSION: a run would go unwatched to a pull request`
  if (base !== 'master' && !prepare.includes('PIPELINE_BASE_BRANCH')) {
    return `${ref}'s ${PREPARE} has no PIPELINE_BASE_BRANCH: it would build the worktree from master and open the pull request there`
  }
  return { prepare }
}

/** origin's branches as the checkout last fetched them, for the console to offer; none when git fails. */
export async function originBranches(git: Git): Promise<string[]> {
  try {
    const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
    return refs
      .split('\n')
      .map((r) => r.trim().replace(/^origin\//, ''))
      .filter((r) => r && r !== 'origin' && r !== 'HEAD')
      .sort()
  } catch {
    return []
  }
}

export function gitIn(dir: string): Git {
  return async (args) => (await exec('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })).stdout
}

function firstLine(error: unknown): string {
  const e = error as { stderr?: string; message?: string }
  return ((e.stderr || e.message) ?? String(error)).trim().split('\n')[0] ?? ''
}
