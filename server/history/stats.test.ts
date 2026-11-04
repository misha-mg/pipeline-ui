import { describe, expect, it } from 'vitest'
import type { StatsRun, StatsView } from '../http/view.ts'
import { unknownPullRequest, type PullRequestState } from './bitbucket.ts'
import { addDays, mondayOf, periodRuns, prOutcome, prRows, summarize, timeline } from './stats.ts'

const PR = (n: number) => `https://bitbucket.org/example/webui/pull-requests/${n}`
const run = (key: string, number: number, startedAt: string, verdict: string | null, over: Partial<StatsRun> = {}): StatsRun => ({
  key, number, startedAt, finishedAt: startedAt.replace('T10', 'T11'), seconds: 3600, summary: `${key} summary`, verdict: verdict as StatsRun['verdict'], ending: 'completed', prUrl: null, inLastBatch: false, ...over,
})
const pr = (n: number, over: Partial<PullRequestState>): PullRequestState => ({ ...unknownPullRequest(PR(n)), fetchedAt: '2026-10-27T00:00:00Z', destination: 'master', draft: false, ...over })
const same = { files: 1, added: 2, removed: 1 }

/**
 * KAZ-1: merged as opened, Done in Jira. KAZ-2: merged with changes, not Done. KAZ-3: declined.
 * KAZ-4: open. KAZ-5: blocked, then a second run that found nothing to build. KAZ-6: failed.
 * KAZ-7: one old run, merged without a comparison. KAZ-2 was sent to Failed once before its merge
 * (not counted) and twice after it.
 */
function view(): StatsView {
  return {
    now: '2026-10-27T12:00:00.000Z',
    runs: [
      run('KAZ-1', 1, '2026-10-20T10:00:00Z', 'done:pr-opened', { prUrl: PR(1), inLastBatch: true }),
      run('KAZ-2', 1, '2026-10-20T10:00:00Z', 'done:pr-opened', { prUrl: PR(2), inLastBatch: true }),
      run('KAZ-3', 1, '2026-10-21T10:00:00Z', 'done:draft-pr', { prUrl: PR(3) }),
      run('KAZ-4', 1, '2026-10-26T10:00:00Z', 'done:pr-opened', { prUrl: PR(4) }),
      run('KAZ-5', 1, '2026-10-26T10:00:00Z', 'blocked:tooling'),
      run('KAZ-5', 2, '2026-10-26T12:00:00Z', 'done:nothing-to-build'),
      run('KAZ-6', 1, '2026-10-27T10:00:00Z', 'failed:not-converging'),
      run('KAZ-7', 1, '2026-09-01T10:00:00Z', 'done:pr-opened', { prUrl: PR(7) }),
    ],
    pullRequests: {
      [PR(1)]: pr(1, { state: 'MERGED', createdOn: '2026-10-20T11:00:00Z', closedOn: '2026-10-22T11:00:00Z', changes: { changed: false, pushes: 1, opened: same, merged: same } }),
      [PR(2)]: pr(2, { state: 'MERGED', createdOn: '2026-10-20T11:00:00Z', closedOn: '2026-10-21T11:00:00Z', destination: 'dev', changes: { changed: true, pushes: 2, opened: same, merged: { files: 2, added: 9, removed: 1 } } }),
      [PR(3)]: pr(3, { state: 'DECLINED', createdOn: '2026-10-21T11:00:00Z', closedOn: '2026-10-21T15:00:00Z', draft: true }),
      [PR(4)]: pr(4, { state: 'OPEN', createdOn: '2026-10-26T11:00:00Z' }),
      [PR(7)]: pr(7, { state: 'MERGED', createdOn: '2026-09-01T11:00:00Z', closedOn: '2026-09-02T11:00:00Z' }),
    },
    tickets: {
      'KAZ-1': { key: 'KAZ-1', summary: null, status: 'Done', statusCategory: 'done', doneAt: '2026-10-23T09:00:00.000Z', moves: [{ at: '2026-10-22T12:00:00.000Z', to: 'Testing' }, { at: '2026-10-23T09:00:00.000Z', to: 'Done' }], fetchedAt: '2026-10-27T00:00:00Z' },
      'KAZ-2': { key: 'KAZ-2', summary: 'from Jira', status: 'Ready To Test', statusCategory: 'new', doneAt: null, moves: [{ at: '2026-10-20T12:00:00.000Z', to: 'Failed' }, { at: '2026-10-22T09:00:00.000Z', to: 'Failed' }, { at: '2026-10-24T09:00:00.000Z', to: 'Failed' }, { at: '2026-10-25T09:00:00.000Z', to: 'Ready To Test' }], fetchedAt: '2026-10-27T00:00:00Z' },
    },
    lastBatchLabel: 'batch-20261020-100000',
    readAt: { pullRequests: '2026-10-27T00:00:00Z', tickets: '2026-10-27T00:00:00Z' },
    readers: { bitbucket: true, jira: true },
    jiraSite: null,
  }
}

describe('the statistics', () => {
  it('takes the runs of a period by their start, or the last batch\'s', () => {
    const v = view()
    expect(periodRuns(v, 'batch').map((r) => r.key)).toEqual(['KAZ-1', 'KAZ-2'])
    // Seven days back from noon: the runs at ten on the 20th are out.
    expect(periodRuns(v, '7d').length).toBe(5)
    expect(periodRuns(v, '30d').length).toBe(7)
    expect(periodRuns(v, 'all').length).toBe(8)
  })

  it('names what became of a pull request', () => {
    const v = view()
    expect([1, 2, 3, 4, 7].map((n) => prOutcome(v.pullRequests[PR(n)]!))).toEqual(['merged-as-opened', 'merged-with-changes', 'declined', 'open', 'merged-not-compared'])
    expect(prOutcome(unknownPullRequest(PR(9)))).toBe('unknown')
  })

  it('lists each pull request once, by the run that opened it, the newest first, with its ticket\'s status', () => {
    const v = view()
    v.runs.push(run('KAZ-1', 2, '2026-10-25T10:00:00Z', 'done:pr-opened', { prUrl: PR(1) }))
    const rows = prRows(v, v.runs)
    expect(rows.map((r) => r.number)).toEqual(['4', '3', '2', '1', '7'])
    expect(rows.find((r) => r.number === '1')).toMatchObject({ run: 1, ticket: { status: 'Done' }, failed: [] })
    // Merged on the 21st: the Failed of the 20th was before it.
    expect(rows.find((r) => r.number === '2')!.failed).toEqual(['2026-10-22T09:00:00.000Z', '2026-10-24T09:00:00.000Z'])
    // A run whose files have no summary takes Jira's.
    v.runs.find((r) => r.key === 'KAZ-2')!.summary = null
    expect(prRows(v, v.runs).find((r) => r.key === 'KAZ-2')!.summary).toBe('from Jira')
  })

  it('sums a period up: runs by how they ended, why they stopped, the pull requests, the rates, the medians and the funnel', () => {
    const v = view()
    const s = summarize(v, periodRuns(v, '30d'))
    expect(s).toMatchObject({
      runs: 7, tickets: 6,
      kinds: { done: 4, nothing: 1, stopped: 2, none: 0 },
      stopReasons: [['blocked:tooling', 1], ['failed:not-converging', 1]],
      // KAZ-6 only: KAZ-5 found nothing to build in its second run.
      ticketsNotFinished: 1,
      mergeRate: 2 / 3,
      asOpenedRate: 0.5,
      // Two days and one day: their middle.
      medianToMerge: 1.5 * 24 * 3600,
      medianRun: 3600,
      funnel: { run: 6, pr: 4, merged: 2, done: 1, clean: 1 },
      failed: { tickets: 1, asOpened: 0, asOpenedOf: 1, withChanges: 1, withChangesOf: 1 },
      mergedTicketsUnknown: 0,
    })
    expect(s.prs).toMatchObject({ opened: 4, open: 1, merged: 2, 'merged-as-opened': 1, 'merged-with-changes': 1, declined: 1, drafts: 1, into: [['dev', 1], ['master', 1]] })
  })

  it('puts the events in days or weeks from the first to the last, an empty bucket for a day without any', () => {
    const v = view()
    const dayOf = (iso: string) => iso.slice(0, 10)
    const days = timeline(v, periodRuns(v, '30d'), { bucket: 'day', dayOf, to: '2026-10-27' })
    expect(days.map((d) => d.day)).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'])
    const on = (day: string) => days.find((d) => d.day === day)!
    expect(on('2026-10-20')).toMatchObject({ runs: { done: 2 }, opened: 2 })
    expect(on('2026-10-21')).toMatchObject({ opened: 1, closed: { withChanges: 1, declined: 1 } })
    expect(on('2026-10-22').closed).toMatchObject({ asOpened: 1 })
    expect(on('2026-10-23').done).toBe(1)
    expect(days.map((d) => d.failed)).toEqual([0, 0, 1, 0, 1, 0, 0, 0])
    expect(on('2026-10-24')).toMatchObject({ opened: 0, done: 0, runs: { done: 0, stopped: 0 } })
    expect(on('2026-10-26').runs).toMatchObject({ done: 1, nothing: 1, stopped: 1 })

    const weeks = timeline(v, periodRuns(v, '30d'), { bucket: 'week', dayOf, to: '2026-10-27' })
    expect(weeks.map((w) => [w.day, w.opened, w.runs.stopped])).toEqual([['2026-10-19', 3, 0], ['2026-10-26', 1, 2]])
  })

  it('counts calendar days without a time zone', () => {
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(mondayOf('2026-11-01')).toBe('2026-10-26')
    expect(mondayOf('2026-10-26')).toBe('2026-10-26')
  })
})
