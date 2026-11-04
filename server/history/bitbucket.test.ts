import { describe, expect, it } from 'vitest'
import { openDb } from '../store/db.ts'
import { compareMerged, pullRequestStates, refreshPullRequests } from './bitbucket.ts'
import type { Git } from './changes.ts'

const PR = (n: number) => `https://bitbucket.org/example/webui/pull-requests/${n}`
const answers = (map: Record<string, { status: number; body?: unknown }>) => {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    calls.push(url)
    const a = map[url.match(/pullrequests\/(\d+)/)![1]!] ?? { status: 404 }
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status })
  }) as unknown as typeof fetch
  return { fetchFn, calls }
}

describe('refreshPullRequests', () => {
  it('reads unknown and stale open PRs, keeps final ones, records an error without losing the state', async () => {
    const db = openDb(':memory:')
    let t = new Date('2026-10-27T10:00:00Z')
    const now = () => t
    const bb = answers({ 1: { status: 200, body: { state: 'MERGED', created_on: '2026-10-19T00:00:00Z', closed_on: '2026-10-20T00:00:00Z', draft: false, destination: { branch: { name: 'master' } } } }, 2: { status: 200, body: { state: 'OPEN', created_on: '2026-10-26T00:00:00Z' } }, 3: { status: 500 } })
    expect(await refreshPullRequests(db, [PR(1), PR(2), PR(3)], { token: 't' }, { fetch: bb.fetchFn, now })).toBe(2)
    expect(pullRequestStates(db).get(PR(1))).toMatchObject({ state: 'MERGED', createdOn: '2026-10-19T00:00:00Z', closedOn: '2026-10-20T00:00:00Z', destination: 'master', draft: false, changes: null, error: null })
    expect(pullRequestStates(db).get(PR(2))).toMatchObject({ state: 'OPEN', closedOn: null })
    expect(pullRequestStates(db).get(PR(3))).toMatchObject({ state: 'unknown', error: 'Bitbucket answered 500' })

    // Within MAX_AGE only the failed one is due again.
    t = new Date('2026-10-27T10:05:00Z')
    bb.calls.length = 0
    await refreshPullRequests(db, [PR(1), PR(2), PR(3)], { token: 't' }, { fetch: bb.fetchFn, now })
    expect(bb.calls.map((c) => c.match(/pullrequests\/(\d+)/)![1])).toEqual(['3'])

    // After it, the open one is read again; the merged one never.
    t = new Date('2026-10-27T10:20:00Z')
    bb.calls.length = 0
    await refreshPullRequests(db, [PR(1), PR(2)], { token: 't' }, { fetch: bb.fetchFn, now })
    expect(bb.calls.map((c) => c.match(/pullrequests\/(\d+)/)![1])).toEqual(['2'])
  })

  it('reads nothing without a token', async () => {
    const db = openDb(':memory:')
    const bb = answers({})
    expect(await refreshPullRequests(db, [PR(1)], null, { fetch: bb.fetchFn })).toBe(0)
    expect(bb.calls).toEqual([])
    expect(pullRequestStates(db).size).toBe(0)
  })

  it('reads a merged PR again once when it was read before its creation and destination were asked', async () => {
    const db = openDb(':memory:')
    pullRequestStates(db) // makes the table
    db.exec(`INSERT INTO pull_requests (url, state, closed_on, fetched_at, error) VALUES ('${PR(1)}', 'MERGED', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z', NULL)`)
    const bb = answers({ 1: { status: 200, body: { state: 'MERGED', created_on: '2026-10-19T00:00:00Z', closed_on: '2026-10-20T00:00:00Z', destination: { branch: { name: 'dev' } } } } })
    expect(await refreshPullRequests(db, [PR(1)], { token: 't' }, { fetch: bb.fetchFn })).toBe(1)
    expect(await refreshPullRequests(db, [PR(1)], { token: 't' }, { fetch: bb.fetchFn })).toBe(0)
    expect(pullRequestStates(db).get(PR(1))).toMatchObject({ destination: 'dev', createdOn: '2026-10-19T00:00:00Z' })
  })
})

describe('compareMerged', () => {
  // A PR opened at commit aaaaaaa on base 1111111, rebased onto 2222222 as bbbbbbb and merged.
  const bitbucket = (calls: string[]) => (async (url: string) => {
    calls.push(url)
    const body = url.includes('/activity') ? { values: [
      { update: { date: '2026-10-20T10:00:00Z', source: { commit: { hash: 'bbbbbbb' } }, destination: { commit: { hash: '2222222' } } } },
      { comment: {} },
      { update: { date: '2026-10-19T10:00:00Z', source: { commit: { hash: 'aaaaaaa' } }, destination: { commit: { hash: '1111111' } } } },
    ] }
      : url.includes('/commits') ? { values: [{ hash: 'bbbbbbb', parents: [{ hash: '2222222' }] }] }
      : { source: { commit: { hash: 'bbbbbbb' } } }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as unknown as typeof fetch
  const patch = (lines: string[]) => ['diff --git a/f.ts b/f.ts', 'index 1..2 100644', '--- a/f.ts', '+++ b/f.ts', '@@ -1,3 +1,3 @@', ' context', ...lines].join('\n')
  const fakeGit = (diffs: Record<string, string>, missing: string[] = []): Git & { calls: string[][] } => {
    const calls: string[][] = []
    const git = (async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'cat-file') {
        if (missing.some((h) => args[2]!.startsWith(h))) throw new Error('missing')
        return ''
      }
      if (args[0] === 'diff') return diffs[args.at(-1)!] ?? ''
      return ''
    }) as Git & { calls: string[][] }
    git.calls = calls
    return git
  }
  const merged = (db: ReturnType<typeof openDb>) => pullRequestStates(db) && db.exec(`INSERT INTO pull_requests (url, state, created_on, closed_on, destination, fetched_at) VALUES ('${PR(7)}', 'MERGED', '2026-10-19T10:00:00Z', '2026-10-20T11:00:00Z', 'master', '2026-10-20T12:00:00Z')`)

  it('finds a rebased PR merged as opened: the same lines added and removed, other context and hunks', async () => {
    const db = openDb(':memory:')
    merged(db)
    const git = fakeGit({ '1111111...aaaaaaa': patch(['-old', '+new']), '2222222...bbbbbbb': patch(['-old', '+new  ']).replace('@@ -1,3 +1,3 @@', '@@ -9,3 +9,3 @@') })
    expect(await compareMerged(db, { token: 't' }, git, { fetch: bitbucket([]) })).toBe(1)
    expect(pullRequestStates(db).get(PR(7))!.changes).toEqual({ changed: false, pushes: 2, opened: { files: 1, added: 1, removed: 1 }, merged: { files: 1, added: 1, removed: 1 } })
    // Compared once: never again.
    const calls: string[] = []
    expect(await compareMerged(db, { token: 't' }, git, { fetch: bitbucket(calls) })).toBe(0)
    expect(calls).toEqual([])
  })

  it('finds a PR merged with changes when the merged lines differ', async () => {
    const db = openDb(':memory:')
    merged(db)
    const git = fakeGit({ '1111111...aaaaaaa': patch(['-old', '+new']), '2222222...bbbbbbb': patch(['-old', '+new', '+more']) })
    await compareMerged(db, { token: 't' }, git, { fetch: bitbucket([]) })
    expect(pullRequestStates(db).get(PR(7))!.changes).toMatchObject({ changed: true, merged: { added: 2 } })
  })

  it('fetches the merged branch, objects only, for a missing commit; says which is missing and tries again an hour later', async () => {
    const db = openDb(':memory:')
    merged(db)
    let t = new Date('2026-10-21T10:00:00Z')
    const git = fakeGit({}, ['aaaaaaa'])
    expect(await compareMerged(db, { token: 't' }, git, { fetch: bitbucket([]), now: () => t })).toBe(0)
    expect(git.calls.filter((c) => c[0] === 'fetch')).toEqual([['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', 'origin', 'master']])
    expect(pullRequestStates(db).get(PR(7))!.changes).toEqual({ changed: null, why: 'commit aaaaaaa is not in the webui checkout' })
    const calls: string[] = []
    t = new Date('2026-10-21T10:30:00Z')
    await compareMerged(db, { token: 't' }, git, { fetch: bitbucket(calls), now: () => t })
    expect(calls).toEqual([])
    t = new Date('2026-10-21T11:30:00Z')
    await compareMerged(db, { token: 't' }, git, { fetch: bitbucket(calls), now: () => t })
    expect(calls.length).toBe(3)
  })
})
