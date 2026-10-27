// What became of a run's pull request, from the Bitbucket Cloud API, kept in the database. A
// merged or declined PR never changes again, so it is read once; an open one is read again
// when its copy is older than MAX_AGE. Without a token every PR's state is `unknown` and the
// rest of the console works. Reads happen in the service's background round, never in a request.
import type { Db } from '../store/db.ts'

export type PullRequestState = {
  url: string
  /** OPEN, MERGED, DECLINED or SUPERSEDED as Bitbucket says; 'unknown' when it was not read. */
  state: string
  closedOn: string | null
  /** When the state was read; null for unknown. */
  fetchedAt: string | null
  error: string | null
}

export type BitbucketConfig = { token: string }

export const MAX_AGE_MS = 10 * 60 * 1000
const TIMEOUT_MS = 10_000
const PER_ROUND = 20
const PR_URL = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)$/

export function bitbucketConfig(env: Record<string, string | undefined>): BitbucketConfig | null {
  return env.BITBUCKET_TOKEN ? { token: env.BITBUCKET_TOKEN } : null
}

export function ensurePullRequestTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pull_requests (
    url TEXT PRIMARY KEY, state TEXT NOT NULL, closed_on TEXT, fetched_at TEXT, error TEXT
  )`)
}

/** The known states, by URL; a URL never read is not in the map. */
export function pullRequestStates(db: Db): Map<string, PullRequestState> {
  ensurePullRequestTable(db)
  const rows = db.prepare('SELECT url, state, closed_on, fetched_at, error FROM pull_requests').all()
  return new Map(rows.map((r) => [r.url as string, { url: r.url as string, state: r.state as string, closedOn: (r.closed_on as string | null) ?? null, fetchedAt: (r.fetched_at as string | null) ?? null, error: (r.error as string | null) ?? null }]))
}

export function isFinal(state: string): boolean {
  return state === 'MERGED' || state === 'DECLINED' || state === 'SUPERSEDED'
}

/**
 * Reads the PRs among `urls` whose state is unknown or open and stale, at most PER_ROUND of
 * them, and writes what it found. Without a config it records nothing: the state stays
 * unknown. Returns how many it read.
 */
export async function refreshPullRequests(
  db: Db,
  urls: Iterable<string>,
  config: BitbucketConfig | null,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
): Promise<number> {
  if (!config) return 0
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  const known = pullRequestStates(db)
  const due = [...new Set(urls)].filter((url) => {
    const k = known.get(url)
    if (!k || k.state === 'unknown') return true
    if (isFinal(k.state)) return false
    return !k.fetchedAt || now().getTime() - Date.parse(k.fetchedAt) > MAX_AGE_MS
  })
  const write = db.prepare('INSERT INTO pull_requests (url, state, closed_on, fetched_at, error) VALUES (?, ?, ?, ?, ?) ON CONFLICT (url) DO UPDATE SET state = excluded.state, closed_on = excluded.closed_on, fetched_at = excluded.fetched_at, error = excluded.error')
  let read = 0
  for (const url of due.slice(0, PER_ROUND)) {
    const m = PR_URL.exec(url)
    if (!m) continue
    const api = `https://api.bitbucket.org/2.0/repositories/${m[1]}/${m[2]}/pullrequests/${m[3]}?fields=state,closed_on,updated_on`
    try {
      const res = await fetchFn(api, { headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) {
        write.run(url, known.get(url)?.state ?? 'unknown', known.get(url)?.closedOn ?? null, now().toISOString(), `Bitbucket answered ${res.status}`)
        continue
      }
      const body = (await res.json()) as { state?: unknown; closed_on?: unknown; updated_on?: unknown }
      const state = typeof body.state === 'string' ? body.state : 'unknown'
      const closed = isFinal(state) ? (typeof body.closed_on === 'string' ? body.closed_on : typeof body.updated_on === 'string' ? body.updated_on : null) : null
      write.run(url, state, closed, now().toISOString(), null)
      read += 1
    } catch (error) {
      write.run(url, known.get(url)?.state ?? 'unknown', known.get(url)?.closedOn ?? null, now().toISOString(), error instanceof Error ? error.message : String(error))
    }
  }
  return read
}
