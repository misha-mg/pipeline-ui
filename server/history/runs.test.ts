import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageKey, stagesAfter } from './outcome.ts'
import { loadRuns, readReport, reasonOf, stagesOf, stateStages, summaryOf, verdictOf } from './runs.ts'

const temps: string[] = []
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true })
})

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
        '00-assignment.md':
          '# Assignment — KAZ-9016\n\n- Ticket: KAZ-9016\n- Summary: Ports table sorting\n- Time: 2026-10-14T21:00:00+02:00\n',
        '01-investigate.md': '# Investigation\n',
        '02-implement.md': '',
        'state.md':
          'investigate — ticket-investigator (-) — confidence high\nimplement — ticket-implementer (implement) — done\nreview — change-reviewer (-) — pass\npull-request — ticket-implementer (pull-request) — opened\npr: https://bitbucket.org/example/webui/pull-requests/622\ndone:pr-opened\n',
        'timings.tsv':
          'label\tagent\tstarted\tseconds\ninvestigate\tticket-investigator\t2026-10-14T19:00:19Z\t506\nimplement\tticket-implementer\t2026-10-14T19:08:45Z\t332\nreview\tchange-reviewer\t2026-10-14T19:14:24Z\t66\npull request\tticket-implementer\t2026-10-14T19:21:05Z\t96\n',
        'diff-0.patch': '',
      },
    })
    const [run] = loadRuns(dir)
    expect(run).toMatchObject({
      key: 'KAZ-9016',
      number: 1,
      startedAt: '2026-10-14T19:00:00.000Z',
      summary: 'Ports table sorting',
      verdict: 'done:pr-opened',
      prUrl: 'https://bitbucket.org/example/webui/pull-requests/622',
      reason: null,
      reports: ['00-assignment.md', '01-investigate.md', '02-implement.md'],
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
        'state.md':
          '03 review (change-reviewer): pass\n04 pull-request (ticket-implementer, pull-request): opened — https://bitbucket.org/example/webui/pull-requests/526\nreason: already-fixed\nblocked:tooling\n',
      },
    })
    const [run] = loadRuns(dir)
    expect(run).toMatchObject({
      startedAt: '2026-10-05T21:50:14.000Z',
      summary: 'Quoted "summary" here',
      verdict: 'blocked:tooling',
      reason: 'already-fixed',
      prUrl: 'https://bitbucket.org/example/webui/pull-requests/526',
    })
    expect(run!.stages).toEqual([
      { label: 'review', agent: 'change-reviewer', startedAt: null, seconds: null, result: 'pass' },
      {
        label: 'pull request',
        agent: 'ticket-implementer',
        startedAt: null,
        seconds: null,
        result: 'opened — https://bitbucket.org/example/webui/pull-requests/526',
      },
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
    const stages = stagesOf(
      'label\tagent\tstarted\tseconds\nreview\tchange-reviewer\t2026-10-14T19:14:24Z\t66\nrework 1\tticket-implementer\t2026-10-14T19:16:00Z\t30\n',
      'review — change-reviewer (-) — fail\n',
    )
    expect(stages.map((s) => [s.label, s.result])).toEqual([
      ['review', 'fail'],
      ['rework 1', null],
    ])
  })
})

describe('stage lines, verdicts and reasons as the runs wrote them', () => {
  const TIMINGS = (rows: string[][]) =>
    ['label\tagent\tstarted\tseconds', ...rows.map((r) => [...r, '2026-10-14T19:00:00Z', '60'].join('\t'))].join('\n')

  it("gives each repeated stage its own round's result, in order (RPG-6183: reviews fail twice, the second app-test passes)", () => {
    const state = [
      'investigate — ticket-investigator (-) — confidence medium',
      'implement — ticket-implementer (implement) — done',
      'review — change-reviewer (-) — pass',
      'app-test — app-tester (-) — fail',
      'implement — ticket-implementer (rework) — done',
      'review — change-reviewer (-) — fail',
      'implement — ticket-implementer (rework) — done',
      'review — change-reviewer (-) — pass',
      'app-test — app-tester (-) — pass',
      'pull-request — ticket-implementer (pull-request) — opened',
      'app-test: passed on the mock; not observable there: live traffic',
      'done:pr-opened',
    ].join('\n')
    const timings = TIMINGS([
      ['investigate', 'ticket-investigator'],
      ['implement', 'ticket-implementer'],
      ['diff', 'diff-preparer'],
      ['review', 'change-reviewer'],
      ['app-test', 'app-tester'],
      ['rework 1', 'ticket-implementer'],
      ['diff', 'diff-preparer'],
      ['review', 'change-reviewer'],
      ['same cause?', 'cause-judge'],
      ['rework 2', 'ticket-implementer'],
      ['diff', 'diff-preparer'],
      ['review', 'change-reviewer'],
      ['app-test', 'app-tester'],
      ['pull request', 'ticket-implementer'],
    ])
    expect(stagesOf(timings, state).map((s) => [s.label, s.result])).toEqual([
      ['investigate', 'confidence medium'],
      ['implement', 'done'],
      ['diff', null],
      ['review', 'pass'],
      ['app-test', 'fail'],
      ['rework 1', 'done'],
      ['diff', null],
      ['review', 'fail'],
      ['same cause?', null],
      ['rework 2', 'done'],
      ['diff', null],
      ['review', 'pass'],
      ['app-test', 'pass'],
      ['pull request', 'opened'],
    ])
  })

  it("keeps every round of a run without timings, a rework named as one, and skips app-test's summary line", () => {
    const state =
      'implement — ticket-implementer (implement) — done\nreview — change-reviewer (-) — fail\nimplement — ticket-implementer (rework) — done\nreview — change-reviewer (-) — pass\napp-test: unverified:app-test — no mock\ndone:pr-opened\n'
    expect(stagesOf(null, state).map((s) => [s.label, s.agent, s.result])).toEqual([
      ['implement', 'ticket-implementer', 'done'],
      ['review', 'change-reviewer', 'fail'],
      ['rework 1', 'ticket-implementer', 'done'],
      ['review', 'change-reviewer', 'pass'],
    ])
  })

  it('reads every hand-written stage-line shape to an agent and a bare result', () => {
    const state = [
      '01 investigate (ticket-investigator): confidence high',
      'implement · ticket-implementer (implement) · done · 9c9b6a59a',
      'review: change-reviewer (-) — pass',
      '04-pull-request (ticket-implementer, pull-request): opened',
      'app-test · unverified:app-test — no test environment',
    ].join('\n')
    expect(stateStages(state).map((s) => [s.key, s.agent, s.mode, s.result])).toEqual([
      ['investigate', 'ticket-investigator', null, 'confidence high'],
      ['implement', 'ticket-implementer', 'implement', 'done · 9c9b6a59a'],
      ['review', 'change-reviewer', null, 'pass'],
      ['pull-request', 'ticket-implementer', 'pull-request', 'opened'],
    ])
  })

  it('takes the last verdict line, not a note after it, and refuses what is not a verdict', () => {
    expect(verdictOf('blocked:tooling\nnote: retried by hand\n')).toBe('blocked:tooling')
    expect(verdictOf('investigate — x\nnote: nothing closed this\n')).toBeNull()
    expect(verdictOf('done:pr-opened')).toBe('done:pr-opened')
    expect(verdictOf('maybe:later')).toBeNull()
  })

  it("reads a reason over several lines, and a stop's last free line when it has no reason line (KAZ-8839)", () => {
    expect(reasonOf('reason: the brief contradicts\nthe code in two places\nblocked:underspecified\n', 'blocked:underspecified')).toBe(
      'the brief contradicts the code in two places',
    )
    expect(
      reasonOf(
        'investigate — ticket-investigator (-) — blocked\nblocked:tooling\nThe HAR attachment was too large to read\nblocked:tooling\n',
        'blocked:tooling',
      ),
    ).toBe('The HAR attachment was too large to read')
    expect(reasonOf('pull-request — ticket-implementer (pull-request) — opened\ndone:pr-opened\n', 'done:pr-opened')).toBeNull()
  })

  it("finds a done run's pull request in its report when state.md has no URL (KAZ-8682 run-2)", () => {
    const dir = runsDir({
      'KAZ-8682/run-2': {
        '04-pull-request.md': 'Opened https://bitbucket.org/example/webui/pull-requests/547 as asked.',
        'state.md': 'pull-request — ticket-implementer (pull-request) — opened\ndone:pr-opened\n',
      },
    })
    expect(loadRuns(dir)[0]!.prUrl).toBe('https://bitbucket.org/example/webui/pull-requests/547')
  })
})

describe('screen-migration runs', () => {
  it('names the migration stages from state.md when timings.tsv lost the early ones, and flags the run (RPG-6316 run-1)', () => {
    const dir = runsDir({
      'RPG-6316/run-1': {
        '00-assignment.md':
          '# Assignment — RPG-6316\n\n- Ticket: RPG-6316\n- Summary: migrate the Alarms page\n- Workflow: screen-migration — the ticket is labelled `vue-migration`\n- Time: 2026-11-10T13:12:00+01:00\n',
        '01-spec.md': '# spec\n',
        '02-implement.md': '',
        '03-review.md': '',
        '04-implement.md': '',
        '05-review.md': '',
        '06-compare.md': '',
        '07-pull-request.md': '',
        'state.md':
          'spec — parity-investigator (-) — confidence medium, 43 rows\nimplement — ticket-implementer (implement) — done\nreview — change-reviewer (-) — fail\nimplement — ticket-implementer (rework) — done\nreview — change-reviewer (-) — pass\ncompare — parity-tester (-) — pass\ncompare — parity-tester (rework) — pass\npull-request — ticket-implementer (pull-request) — opened\nknown-defects: 2\nnot-compared: 10 need a real device, 1 not verified\ndone:draft-pr\n',
        // The run was resumed from a cache: only what ran again was timed.
        'timings.tsv':
          'label\tagent\tstarted\tseconds\ndiff\tdiff-preparer\t2026-11-10T13:09:03Z\t12\nreview\tchange-reviewer\t2026-11-10T13:09:15Z\t178\ncompare\tparity-tester\t2026-11-10T13:12:13Z\t2206\npull request\tticket-implementer\t2026-11-10T13:48:59Z\t233\n',
      },
    })
    const [run] = loadRuns(dir)
    expect(run).toMatchObject({ key: 'RPG-6316', migration: true, verdict: 'done:draft-pr', reason: null })
    expect(run!.stages.map((s) => [s.label, s.agent, s.result])).toEqual([
      ['spec', 'parity-investigator', 'confidence medium, 43 rows'],
      ['implement', 'ticket-implementer', 'done'],
      ['review', 'change-reviewer', 'fail'],
      ['rework 1', 'ticket-implementer', 'done'],
      ['review', 'change-reviewer', 'pass'],
      ['compare', 'parity-tester', 'pass'],
      ['re-compare 1', 'parity-tester', 'pass'],
      ['pull request', 'ticket-implementer', 'opened'],
    ])
  })

  it('reads a label the harness suffixed, and skips the parity line that starts with app-test', () => {
    expect(stageKey('implement (after usage limit)')).toBe('implement')
    expect(stageKey('diff (retry)')).toBeNull()
    expect(stagesAfter('implement (after usage limit)', true)).toEqual(['diff', 'review', 'compare', 'pull request'])
    expect(
      stateStages(
        'app-test: 34 rows same on arpeggio (ANPB, main): light, dark; 10 need a real device\ncompare — parity-tester (-) — pass\n',
      ),
    ).toEqual([{ key: 'compare', agent: 'parity-tester', mode: null, result: 'pass' }])
  })

  it('takes a migration from its agents when the assignment does not say, and keeps timings when they are whole', () => {
    const stages = stagesOf(
      'label\tagent\tstarted\tseconds\nspec\tparity-investigator\t2026-11-10T12:12:00Z\t1393\nimplement\tticket-implementer\t2026-11-10T12:36:00Z\t1545\ncompare\tparity-tester\t2026-11-10T13:03:01Z\t2293\n',
      'spec — parity-investigator (-) — confidence medium\nimplement — ticket-implementer (implement) — done\ncompare — parity-tester (-) — fail\n',
    )
    expect(stages.map((s) => [s.label, s.result])).toEqual([
      ['spec', 'confidence medium'],
      ['implement', 'done'],
      ['compare', 'fail'],
    ])
    const dir = runsDir({
      'RPG-6317/run-1': {
        '00-assignment.md': '# Assignment\n\n- Ticket: RPG-6317\n- Time: 2026-11-10T14:56:00+01:00\n',
        'state.md': 'spec — parity-investigator (-) — confidence medium\ndone:stopped\n',
      },
    })
    expect(loadRuns(dir)[0]!.migration).toBe(true)
  })
})
