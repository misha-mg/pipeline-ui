// The run settings the operator may change from the console or the command line without a
// restart: the base branch, whether a run may open its pull request (or only a draft) and how
// long one session may take. The environment (config.ts) gives each its default; a value set
// here is kept in the database and wins over it, and one set back to the default is forgotten,
// so a later change of the environment shows again. The service reads them when a run starts:
// a change is for the next run, never for the one in flight. ADR run-settings.
import type { PullRequests } from '../config.ts'
import { nowIso, transaction, type Db } from './db.ts'

export type RunSettings = {
  /** The webui branch a run's worktree starts from and its pull request goes to. */
  baseBranch: string
  /** `on`: the run opens the pull request it decides on; `draft`: drafts only; `off`: no push, no pull request. */
  pullRequests: PullRequests
  /** How long one session may take before the driver ends it. */
  timeoutHours: number
}

export const PULL_REQUESTS: readonly PullRequests[] = ['on', 'draft', 'off']
/** One session may be given at most a day. */
export const MAX_TIMEOUT_HOURS = 24

const NAMES = ['baseBranch', 'pullRequests', 'timeoutHours'] as const

/** The settings a run starts with: the default of each, unless one was set. */
export function readRunSettings(db: Db, defaults: RunSettings): RunSettings {
  const set = new Map(
    db
      .prepare('SELECT name, value FROM settings')
      .all()
      .map((r) => [r.name as string, r.value as string]),
  )
  const hours = Number(set.get('timeoutHours'))
  const prs = set.get('pullRequests') as PullRequests | undefined
  return {
    baseBranch: set.get('baseBranch') || defaults.baseBranch,
    pullRequests: prs && PULL_REQUESTS.includes(prs) ? prs : defaults.pullRequests,
    timeoutHours: hours > 0 && hours <= MAX_TIMEOUT_HOURS ? hours : defaults.timeoutHours,
  }
}

/** Keeps what differs from the defaults and forgets what does not. */
export function writeRunSettings(db: Db, settings: RunSettings, defaults: RunSettings, now: () => string = nowIso): void {
  transaction(db, () => {
    for (const name of NAMES) {
      if (settings[name] === defaults[name]) db.prepare('DELETE FROM settings WHERE name = ?').run(name)
      else
        db.prepare(
          'INSERT INTO settings (name, value, set_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, set_at = excluded.set_at',
        ).run(name, String(settings[name]), now())
    }
  })
}

export type Parsed = { ok: true; settings: RunSettings } | { ok: false; message: string }

/**
 * The settings asked for over the current ones: a name left out keeps its value. Says what is
 * wrong with a value; whether origin has the branch and its entry point is the caller's check.
 */
export function parseRunSettings(input: unknown, current: RunSettings): Parsed {
  const asked = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const bad = (message: string): Parsed => ({ ok: false, message })
  const next = { ...current }
  if (asked.baseBranch !== undefined) {
    const branch = typeof asked.baseBranch === 'string' ? asked.baseBranch.trim().replace(/^origin\//, '') : ''
    if (!branchName(branch)) return bad('the branch is a branch name, such as dev or release/5.9')
    next.baseBranch = branch
  }
  if (asked.pullRequests !== undefined) {
    if (!PULL_REQUESTS.includes(asked.pullRequests as PullRequests)) return bad('pull requests are on, draft or off')
    next.pullRequests = asked.pullRequests as PullRequests
  }
  if (asked.timeoutHours !== undefined) {
    const hours = typeof asked.timeoutHours === 'string' ? Number(asked.timeoutHours) : asked.timeoutHours
    if (typeof hours !== 'number' || !(hours > 0) || hours > MAX_TIMEOUT_HOURS)
      return bad(`a session's time limit is more than 0 and at most ${MAX_TIMEOUT_HOURS} hours`)
    next.timeoutHours = hours
  }
  return { ok: true, settings: next }
}

/** A name git takes for a branch, and nothing a command line could read as an option or a range. */
function branchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock')
  )
}

/** What changed between two settings, by name, for the log and the notification. */
export function changedSettings(before: RunSettings, after: RunSettings): Partial<RunSettings> {
  return Object.fromEntries(NAMES.filter((n) => before[n] !== after[n]).map((n) => [n, after[n]]))
}
