// The entry point a run goes through, checked before every run: webui's script that prepares
// the ticket's worktree from origin/master, and the script it hands over to, which launches the
// session. The service starts a run only when that launch script knows PIPELINE_SESSION, since
// an older one runs the plain CLI unwatched, to a pull request.
//
// The prepare script is always origin/master's, copied into the data directory, so a run does
// not depend on the branch webui's checkout is on; its last line names the launch script, which
// is the worktree's own. With PIPELINE_LAUNCH_SESSION_REF the worktree still comes from
// origin/master, but the launch script is taken from that ref (a branch that has the entry point
// while origin/master does not): the copy's last line is pointed at it. ADR webui-entry-point,
// During the code freeze.
//
// webui named the scripts run.sh and start.sh until 214abfefb, which reaches origin/master after
// the freeze; both names are found, the new ones first.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export type EntryConfig = {
  webuiDir: string
  /** The ref whose launch script runs instead of the worktree's; null for origin/master's own. */
  launchSessionRef: string | null
  /** Where the copied scripts are written. */
  entryDir: string
}

/** The script the runner starts in the webui checkout, and what it adds to the environment. */
export type Entry = { prepareWorktree: string; env: Record<string, string> }

/** Runs git in the webui checkout and resolves with its stdout; rejects when it fails. */
export type Git = (args: string[]) => Promise<string>

const DIR = 'tools/ticket-pipeline'
const PREPARE_NAMES = ['prepare-worktree.sh', 'run.sh']
const LAUNCH_NAMES = ['launch-session.sh', 'start.sh']
/** How the prepare script hands over: its last line, naming the launch script. */
const HANDOVER = /^exec (tools\/ticket-pipeline\/[A-Za-z0-9._-]+\.sh) "\$@"$/
const HANDOVER_COPY = 'exec bash "$PIPELINE_LAUNCH_SESSION" "$@"'
const REF_VAR = 'PIPELINE_LAUNCH_SESSION_REF'
const exec = promisify(execFile)

/** The entry point a run takes, fixed: what the runner starts once `prepareEntry` said yes. */
export function entryOf(config: EntryConfig): Entry {
  const prepareWorktree = path.join(config.entryDir, 'prepare-worktree.sh')
  if (!config.launchSessionRef) return { prepareWorktree, env: {} }
  return { prepareWorktree, env: { PIPELINE_LAUNCH_SESSION: path.join(config.entryDir, 'launch-session.sh') } }
}

/** The entry point's origin as the console shows it. */
export function entryLabel(config: EntryConfig): string {
  return config.launchSessionRef
    ? `worktree from origin/master, session launch from ${config.launchSessionRef}`
    : 'worktree and session launch from origin/master'
}

/**
 * Fetches origin, checks the launch script a run would go through and writes the copies the
 * runner starts. Resolves with null when a run may start, or with why it may not.
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
  const find = async (ref: string, names: string[]): Promise<{ file: string; text: string } | null> => {
    for (const name of names) {
      const text = await show(ref, `${DIR}/${name}`)
      if (text !== null) return { file: `${DIR}/${name}`, text }
    }
    return null
  }
  const either = (names: string[]) => names.map((n) => `${DIR}/${n}`).join(' nor ')

  const prepare = await find('origin/master', PREPARE_NAMES)
  if (!prepare) return `origin/master has neither ${either(PREPARE_NAMES)}`
  const lines = prepare.text.split('\n')
  const at = lines.findLastIndex((l) => HANDOVER.test(l))
  if (at === -1) return `origin/master's ${prepare.file} no longer ends with \`exec ${DIR}/<script> "$@"\`: the script that launches the session cannot be found`
  const handsOverTo = HANDOVER.exec(lines[at]!)![1]!

  const entry = entryOf(config)
  const write = (file: string, text: string) => {
    fs.mkdirSync(config.entryDir, { recursive: true })
    fs.writeFileSync(file, text, { mode: 0o755 })
  }
  const ref = config.launchSessionRef
  if (!ref) {
    const launch = await show('origin/master', handsOverTo)
    if (launch === null) return `origin/master's ${prepare.file} hands over to ${handsOverTo}, which origin/master does not have`
    if (!launch.includes('PIPELINE_SESSION')) {
      return `origin/master's ${handsOverTo} has no PIPELINE_SESSION: a run would go unwatched to a pull request. Set ${REF_VAR} to a branch whose launch script has it`
    }
    write(entry.prepareWorktree, prepare.text)
    return null
  }
  const launch = await find(ref, LAUNCH_NAMES)
  if (!launch) return `${ref} has neither ${either(LAUNCH_NAMES)} (${REF_VAR})`
  if (!launch.text.includes('PIPELINE_SESSION')) return `${ref}'s ${launch.file} has no PIPELINE_SESSION (${REF_VAR})`
  lines[at] = HANDOVER_COPY
  write(entry.prepareWorktree, lines.join('\n'))
  write(entry.env.PIPELINE_LAUNCH_SESSION!, launch.text)
  return null
}

function gitIn(dir: string): Git {
  return async (args) => (await exec('git', ['-C', dir, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 })).stdout
}

function firstLine(error: unknown): string {
  const e = error as { stderr?: string; message?: string }
  return ((e.stderr || e.message) ?? String(error)).trim().split('\n')[0] ?? ''
}
