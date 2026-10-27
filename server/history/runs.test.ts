import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRuns, readReport, stagesOf, summaryOf } from './runs.ts'

const temps: string[] = []
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }) })

function runsDir(runs: Record<string, Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-history-'))
  temps.push(dir)
  for (const [run, files] of Object.entries(runs)) {
    fs.mkdirSync(path.join(dir, run), { recursive: true })
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, run, name), text)
  }
  return dir
}

describe('loadRuns', () => {
  it('reads a closed run with timings: start, summary, verdict, PR, stages, duration', () => {
    const dir = runsDir({
      'KAZ-9016/run-1': {
        '00-assignment.md': '# Assignment — KAZ-9016\n\n- Ticket: KAZ-9016\n- Summary: Ports table sorting\n- Time: 2026-10-14T21:00:00+02:00\n',
        '01-investigate.md': '# Investigation\n',
        '02-implement.md': '',
        'state.md': 'investigate — ticket-investigator (-) — confidence high\nimplement — ticket-implementer (implement) — done\nreview — change-reviewer (-) — pass\npull-request — ticket-implementer (pull-request) — opened\npr: https://bitbucket.org/CGS/webui/pull-requests/622\ndone:pr-opened\n',
        'timings.tsv': 'label\tagent\tstarted\tseconds\ninvestigate\tticket-investigator\t2026-10-14T19:00:19Z\t506\nimplement\tticket-implementer\t2026-10-14T19:08:45Z\t332\nreview\tchange-reviewer\t2026-10-14T19:14:24Z\t66\npull request\tticket-implementer\t2026-10-14T19:21:05Z\t96\n',
        'diff-0.patch': '',
      },
    })
    const [run] = loadRuns(dir)
    expect(run).toMatchObject({
      key: 'KAZ-9016', number: 1, startedAt: '2026-10-14T19:00:00.000Z', summary: 'Ports table sorting', verdict: 'done:pr-opened',
      prUrl: 'https://bitbucket.org/CGS/webui/pull-requests/622', reason: null, reports: ['00-assignment.md', '01-investigate.md', '02-implement.md'],
    })
    expect(run!.finishedAt).not.toBeNull()
    // 19:21:05 + 96 s = 19:22:41, later than state.md's mtime would be in the past... the stages' end wins when later.
    expect(run!.seconds).toBeGreaterThanOrEqual(22 * 60 + 41)
    expect(run!.stages).toEqual([
      { label: 'investigate', agent: 'ticket-investigator', startedAt: '2026-10-14T19:00:19Z', seconds: 506, result: 'confidence high' },
      { label: 'implement', agent: 'ticket-implementer', startedAt: '2026-10-14T19:08:45Z', seconds: 332, result: 'done' },
      { label: 'review', agent: 'change-reviewer', startedAt: '2026-10-14T19:14:24Z', seconds: 66, result: 'pass' },
      { label: 'pull request', agent: 'ticket-implementer', startedAt: '2026-10-14T19:21:05Z', seconds: 96, result: 'opened' },
    ])
  })

  it('reads an old hand-written run: Started line, numbered stage lines, summary from the investigation, reason', () => {
    const dir = runsDir({
      'KAZ-8056/run-1': {
        '00-assignment.md': '# KAZ-8056 — run 1 assignment\n\n- Ticket: KAZ-8056\n- Started: 2026-10-05T23:50:14+02:00\n',
        '01-investigate.md': 'KAZ-8056 (Bug, 3 - Medium). Summary: "Quoted \\"summary\\" here".\n',
        'state.md': '03 review (change-reviewer): pass\n04 pull-request (ticket-implementer, pull-request): opened — https://bitbucket.org/CGS/webui/pull-requests/526\nreason: already-fixed\nblocked:tooling\n',
      },
    })
    const [run] = loadRuns(dir)
    expect(run).toMatchObject({
      startedAt: '2026-10-05T21:50:14.000Z', summary: 'Quoted "summary" here', verdict: 'blocked:tooling', reason: 'already-fixed',
      prUrl: 'https://bitbucket.org/CGS/webui/pull-requests/526',
    })
    expect(run!.stages).toEqual([
      { label: 'review', agent: null, startedAt: null, seconds: null, result: '(change-reviewer): pass' },
      { label: 'pull-request', agent: null, startedAt: null, seconds: null, result: '(ticket-implementer, pull-request): opened — https://bitbucket.org/CGS/webui/pull-requests/526' },
    ])
  })

  it('an open run has no verdict, no finish and no seconds; runs sort newest first; other directories are skipped', () => {
    const dir = runsDir({
      'KAZ-1/run-1': { '00-assignment.md': '- Time: 2026-10-01T10:00:00Z\n' },
      'KAZ-1/run-2': { '00-assignment.md': '- Time: 2026-10-03T10:00:00Z\n' },
      'KAZ-2/run-1': { '00-assignment.md': '- Time: 2026-10-02T10:00:00Z\n', 'state.md': 'done:nothing-to-build\n' },
      'batch-20261001-100000': { 'summary.tsv': '' },
      'KAZ-1/browser': {},
    })
    const runs = loadRuns(dir)
    expect(runs.map((r) => `${r.key}/${r.number}`)).toEqual(['KAZ-1/2', 'KAZ-2/1', 'KAZ-1/1'])
    expect(runs[0]).toMatchObject({ verdict: null, finishedAt: null, seconds: null, stages: [], summary: null })
    expect(runs[1]!.seconds).not.toBeNull()
  })

  it('reads a report by name and refuses other files', () => {
    const dir = runsDir({ 'KAZ-1/run-1': { '01-investigate.md': 'report', 'state.md': 'x', 'diff-0.patch': 'secret' } })
    expect(readReport(path.join(dir, 'KAZ-1/run-1'), '01-investigate.md')).toBe('report')
    expect(readReport(path.join(dir, 'KAZ-1/run-1'), 'state.md')).toBe('x')
    expect(readReport(path.join(dir, 'KAZ-1/run-1'), 'diff-0.patch')).toBeNull()
    expect(readReport(path.join(dir, 'KAZ-1/run-1'), '../../etc/passwd')).toBeNull()
    expect(readReport(path.join(dir, 'KAZ-1/run-1'), '09-none.md')).toBeNull()
  })

  it('loads nothing from a directory that is not there', () => {
    expect(loadRuns('/nonexistent/runs')).toEqual([])
  })
})

describe('summaryOf and stagesOf', () => {
  it('unquotes and strips a trailing period', () => {
    expect(summaryOf('- Summary: Plain one.')).toBe('Plain one')
    expect(summaryOf('**Summary:** "Bold"')).toBe('Bold')
    expect(summaryOf('nothing here')).toBeNull()
  })
  it('keeps rework rounds from timings and matches state results by label', () => {
    const stages = stagesOf('label\tagent\tstarted\tseconds\nreview\tchange-reviewer\t2026-10-14T19:14:24Z\t66\nrework 1\tticket-implementer\t2026-10-14T19:16:00Z\t30\n', 'review — change-reviewer (-) — fail\n')
    expect(stages.map((s) => [s.label, s.result])).toEqual([['review', 'fail'], ['rework 1', null]])
  })
})
