// What became of a run's pull request, from the Bitbucket Cloud API, kept in the database. A
// merged or declined PR never changes again, so it is read once; an open one is read again
// when its copy is older than MAX_AGE. A merged one is then compared, once, with what the
// pipeline opened (compareMerged: changes.ts reads the two patches from the webui checkout).
// Without a token every PR's state is `unknown` and the rest of the console works. Reads happen
// in the service's background round, never in a request.
import type { Db } from '../store/db.ts'
import { compareRanges, type DiffStat, type Git } from './changes.ts'

/**
 * A merged PR set against what the pipeline opened: `changed` when the lines it added and
 * removed are not the ones the pipeline pushed (a rebase alone changes nothing). Null `changed`
 * with `why` when the two could not be compared.
 */
export type PrChanges = { changed: boolean; opened: DiffStat; merged: DiffStat } | { changed: null; why: string }

export type PullRequestState = {
  url: string
  /** OPEN, MERGED, DECLINED or SUPERSEDED as Bitbucket says; 'unknown' when it was not read. */
  state: string
  createdOn: string | null
  closedOn: string | null
  /** The branch it goes to (`master`, `dev`); null until it was read. */
  destination: string | null
  draft: boolean | null
  /** For a merged PR, once compared; null before. */
  changes: PrChanges | null
  /** When the state was read; null for unknown. */
  fetchedAt: string | null
  error: string | null
}

export type BitbucketConfig = { token: string }

const MAX_AGE_MS = 10 * 60 * 1000
/** How long a comparison that could not be made waits before it is tried again. */
const RETRY_COMPARE_MS = 60 * 60 * 1000
const TIMEOUT_MS = 10_000
const PER_ROUND = 50
const COMPARE_PER_ROUND = 10
const PR_URL = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)$/

export function bitbucketConfig(env: Record<string, string | undefined>): BitbucketConfig | null {
  return env.BITBUCKET_TOKEN ? { token: env.BITBUCKET_TOKEN } : null
}

function ensurePullRequestTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pull_requests (
    url TEXT PRIMARY KEY, state TEXT NOT NULL, closed_on TEXT, fetched_at TEXT, error TEXT
  )`)
  // Columns added with the statistics page (2026-11-04); a PR read before them is read again once.
  const have = db
    .prepare('PRAGMA table_info(pull_requests)')
    .all()
    .map((r) => r.name as string)
  for (const [name, type] of [
    ['created_on', 'TEXT'],
    ['destination', 'TEXT'],
    ['draft', 'INTEGER'],
    ['changes', 'TEXT'],
    ['compared_at', 'TEXT'],
  ] as const) {
    if (!have.includes(name)) db.exec(`ALTER TABLE pull_requests ADD COLUMN ${name} ${type}`)
  }
}

/** The known states, by URL; a URL never read is not in the map. */
export function pullRequestStates(db: Db): Map<string, PullRequestState> {
  ensurePullRequestTable(db)
  const rows = db
    .prepare('SELECT url, state, created_on, closed_on, destination, draft, changes, fetched_at, error FROM pull_requests')
    .all()
  return new Map(
    rows.map((r) => [
      r.url as string,
      {
        url: r.url as string,
        state: r.state as string,
        createdOn: (r.created_on as string | null) ?? null,
        closedOn: (r.closed_on as string | null) ?? null,
        destination: (r.destination as string | null) ?? null,
        draft: r.draft === null || r.draft === undefined ? null : r.draft === 1,
        changes: r.changes ? (JSON.parse(r.changes as string) as PrChanges) : null,
        fetchedAt: (r.fetched_at as string | null) ?? null,
        error: (r.error as string | null) ?? null,
      },
    ]),
  )
}

/** A PR known by its URL alone: not read yet, or there is no token to read it with. */
export function unknownPullRequest(url: string): PullRequestState {
  return {
    url,
    state: 'unknown',
    createdOn: null,
    closedOn: null,
    destination: null,
    draft: null,
    changes: null,
    fetchedAt: null,
    error: null,
  }
}

function isFinal(state: string): boolean {
  return state === 'MERGED' || state === 'DECLINED' || state === 'SUPERSEDED'
}

function apiBase(url: string): string | null {
  const m = PR_URL.exec(url)
  return m ? `https://api.bitbucket.org/2.0/repositories/${m[1]}/${m[2]}/pullrequests/${m[3]}` : null
}

type Deps = { fetch?: typeof fetch; now?: () => Date }

/**
 * Reads the PRs among `urls` whose state is unknown or open and stale, or that were read before
 * their creation and destination were asked, at most PER_ROUND of them, and writes what it
 * found. Without a config it records nothing: the state stays unknown. Returns how many it read.
 */
export async function refreshPullRequests(
  db: Db,
  urls: Iterable<string>,
  config: BitbucketConfig | null,
  deps: Deps = {},
): Promise<number> {
  if (!config) return 0
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  const known = pullRequestStates(db)
  const due = [...new Set(urls)].filter((url) => {
    const k = known.get(url)
    if (!k || k.state === 'unknown') return true
    if (isFinal(k.state)) return k.createdOn === null && !k.error
    return !k.fetchedAt || now().getTime() - Date.parse(k.fetchedAt) > MAX_AGE_MS
  })
  const write =
    db.prepare(`INSERT INTO pull_requests (url, state, created_on, closed_on, destination, draft, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (url) DO UPDATE SET state = excluded.state, created_on = excluded.created_on, closed_on = excluded.closed_on, destination = excluded.destination, draft = excluded.draft, fetched_at = excluded.fetched_at, error = excluded.error`)
  const failed = (url: string, error: string) => {
    const k = known.get(url)
    write.run(
      url,
      k?.state ?? 'unknown',
      k?.createdOn ?? null,
      k?.closedOn ?? null,
      k?.destination ?? null,
      k?.draft === null || k?.draft === undefined ? null : Number(k.draft),
      now().toISOString(),
      error,
    )
  }
  let read = 0
  for (const url of due.slice(0, PER_ROUND)) {
    const api = apiBase(url)
    if (!api) continue
    try {
      const res = await fetchFn(`${api}?fields=state,created_on,closed_on,updated_on,draft,destination.branch.name`, {
        headers: headers(config),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) {
        failed(url, `Bitbucket answered ${res.status}`)
        continue
      }
      const body = (await res.json()) as {
        state?: unknown
        created_on?: unknown
        closed_on?: unknown
        updated_on?: unknown
        draft?: unknown
        destination?: { branch?: { name?: unknown } }
      }
      const state = typeof body.state === 'string' ? body.state : 'unknown'
      const closed = isFinal(state) ? (str(body.closed_on) ?? str(body.updated_on)) : null
      const draft = typeof body.draft === 'boolean' ? Number(body.draft) : null
      write.run(url, state, str(body.created_on), closed, str(body.destination?.branch?.name), draft, now().toISOString(), null)
      read += 1
    } catch (error) {
      failed(url, error instanceof Error ? error.message : String(error))
    }
  }
  return read
}

/**
 * Compares each merged PR not compared yet (or whose comparison failed an hour ago) with what
 * the pipeline opened, at most COMPARE_PER_ROUND of them: the source and destination commits of
 * the PR's first update in Bitbucket's activity are what the pipeline pushed; the PR's commits
 * as merged, from the parent of the oldest, are what went in. Returns how many it compared.
 */
export async function compareMerged(db: Db, config: BitbucketConfig | null, git: Git, deps: Deps = {}): Promise<number> {
  if (!config) return 0
  const fetchFn = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  ensurePullRequestTable(db)
  const rows = db
    .prepare(
      `SELECT url, destination, compared_at FROM pull_requests WHERE state = 'MERGED' AND (changes IS NULL OR json_extract(changes, '$.changed') IS NULL)`,
    )
    .all()
  const due = rows.filter((r) => !r.compared_at || now().getTime() - Date.parse(r.compared_at as string) > RETRY_COMPARE_MS)
  const write = db.prepare('UPDATE pull_requests SET changes = ?, compared_at = ? WHERE url = ?')
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetchFn(url, { headers: headers(config), signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Bitbucket answered ${res.status}`)
    return (await res.json()) as T
  }
  /**
   * Every page of a paged list, up to `pages` of them. A longer list is refused: the activity's
   * first update and the oldest commit are on its last page, so a cut list would name the wrong
   * commits and compare the wrong patches.
   */
  const all = async <T>(url: string, pages: number, what: string): Promise<T[]> => {
    const out: T[] = []
    let next: string | undefined = url
    for (let i = 0; next && i < pages; i++) {
      const page: { values?: T[]; next?: string } = await get(next)
      out.push(...(page.values ?? []))
      next = page.next
    }
    if (next) throw new Error(`more than ${pages} pages of ${what}`)
    return out
  }
  let compared = 0
  for (const row of due.slice(0, COMPARE_PER_ROUND)) {
    const url = row.url as string
    const api = apiBase(url)
    if (!api) continue
    let changes: PrChanges
    try {
      type Update = { date?: string; source?: { commit?: { hash?: string } }; destination?: { commit?: { hash?: string } } }
      const [pr, activity, commits] = await Promise.all([
        get<{ source?: { commit?: { hash?: string } } }>(`${api}?fields=source.commit.hash`),
        all<{ update?: Update }>(`${api}/activity?pagelen=50`, 10, 'activity'),
        all<{ hash: string; parents?: { hash: string }[] }>(
          `${api}/commits?pagelen=50&fields=next,values.hash,values.parents.hash`,
          4,
          'commits',
        ),
      ])
      const updates = activity
        .map((a) => a.update)
        .filter((u): u is Update => !!u?.date)
        .sort((a, b) => a.date!.localeCompare(b.date!))
      const first = updates[0]
      const opened = { from: first?.destination?.commit?.hash, to: first?.source?.commit?.hash }
      const merged = { from: commits.at(-1)?.parents?.[0]?.hash, to: pr.source?.commit?.hash }
      if (!opened.from || !opened.to || !merged.from || !merged.to)
        changes = { changed: null, why: 'Bitbucket did not say which commits it was opened and merged with' }
      else {
        const result = await compareRanges(
          git,
          opened as { from: string; to: string },
          merged as { from: string; to: string },
          (row.destination as string | null) ?? null,
        )
        changes = 'why' in result ? { changed: null, why: result.why } : result
      }
    } catch (error) {
      changes = { changed: null, why: error instanceof Error ? error.message : String(error) }
    }
    write.run(JSON.stringify(changes), now().toISOString(), url)
    if (changes.changed !== null) compared += 1
  }
  return compared
}

function headers(config: BitbucketConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.token}`, Accept: 'application/json' }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
