import { describe, expect, it } from 'vitest'
import { openDb } from '../store/db.ts'
import { pullRequestStates, refreshPullRequests } from './bitbucket.ts'

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
    const bb = answers({ 1: { status: 200, body: { state: 'MERGED', closed_on: '2026-10-20T00:00:00Z' } }, 2: { status: 200, body: { state: 'OPEN' } }, 3: { status: 500 } })
    expect(await refreshPullRequests(db, [PR(1), PR(2), PR(3)], { token: 't' }, { fetch: bb.fetchFn, now })).toBe(2)
    expect(pullRequestStates(db).get(PR(1))).toMatchObject({ state: 'MERGED', closedOn: '2026-10-20T00:00:00Z', error: null })
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
})
