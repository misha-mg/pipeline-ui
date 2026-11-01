import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../store/db.ts'
import { insertRun, loopState, startLoop, updateRun } from '../store/runs.ts'
import { createServer, type ApiDeps } from './api.ts'
import { shownRuns, stateView } from './view.ts'

const temps: string[] = []
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }) })

function sources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-api-'))
  temps.push(dir)
  const runsDir = path.join(dir, 'runs')
  const write = (run: string, files: Record<string, string>) => {
    fs.mkdirSync(path.join(runsDir, run), { recursive: true })
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(runsDir, run, n), t)
  }
  write('KAZ-1/run-1', { '00-assignment.md': '- Summary: one\n- Time: 2026-10-20T10:00:00Z\n', '01-investigate.md': 'inv', 'state.md': 'pr: https://bitbucket.org/CGS/webui/pull-requests/1\ndone:pr-opened\n' })
  write('KAZ-2/run-1', { '00-assignment.md': '- Time: 2026-10-21T10:00:00Z\n' })
  write('KAZ-3/run-1', { '00-assignment.md': '- Time: 2026-10-22T10:00:00Z\n', 'state.md': 'blocked:tooling\n' })
  fs.mkdirSync(path.join(runsDir, 'batch-20261021-000000'))
  fs.writeFileSync(path.join(runsDir, 'batch-20261021-000000', 'summary.tsv'), `KAZ-3\tblocked:tooling\t-\t${path.join(runsDir, 'KAZ-3/run-1')}\n`)
  const db = openDb(':memory:')
  const ticks: number[] = []
  const deps: ApiDeps = { db, runsDir, health: () => null, loop: { tick: () => ticks.push(1) }, now: () => new Date('2026-10-27T12:00:00Z') }
  return { db, runsDir, deps, ticks, write }
}

async function serve(deps: ApiDeps) {
  const server = createServer(deps)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('views', () => {
  it('shows every run with its ending: completed from the files, died without state.md, the service record when it has one', () => {
    const { db, deps, runsDir } = sources()
    const id = insertRun(db, { key: 'KAZ-3', summary: null, startedAt: '2026-10-22T10:00:00Z', logPath: null })
    updateRun(db, id, { runDir: path.join(runsDir, 'KAZ-3/run-1'), ending: 'cancelled', endedAt: '2026-10-22T10:30:00Z' })
    const runs = shownRuns(deps)
    expect(runs.map((r) => [r.key, r.ending, r.verdict])).toEqual([['KAZ-3', 'cancelled', 'blocked:tooling'], ['KAZ-2', 'died', null], ['KAZ-1', 'completed', 'done:pr-opened']])
    expect(runs[2]!.pr).toMatchObject({ state: 'unknown' })
    expect(runs[0]!.serviceRunId).toBe(id)
  })

  it('counts verdicts all time, for 7 days and for the last batch, by the loop start when it is later', () => {
    const { db, deps } = sources()
    let s = stateView(deps)
    expect(s.counts.allTime).toEqual({ 'done:pr-opened': 1, died: 1, 'blocked:tooling': 1 })
    expect(s.counts.last7Days).toEqual({ died: 1, 'blocked:tooling': 1 })
    expect(s.counts).toMatchObject({ lastBatchLabel: 'batch-20261021-000000', lastBatch: { 'blocked:tooling': 1 } })
    startLoop(db, () => '2026-10-25T00:00:00Z')
    s = stateView(deps)
    expect(s.counts.lastBatch).toEqual({})
    expect(s.counts.lastBatchLabel).toContain('loop since')
    expect(s.service.alive).toBe(false)
    expect(s.inFlight).toBeNull()
  })

  it('carries the Jira site a ticket key links to, or null when there is none', () => {
    const { deps } = sources()
    expect(stateView(deps).jiraSite).toBeNull()
    expect(stateView({ ...deps, jiraSite: 'https://site.example' }).jiraSite).toBe('https://site.example')
  })
})

describe('api', () => {
  it('serves state, runs with filters and counts, and one run with its files', async () => {
    const { deps } = sources()
    const { call, close } = await serve(deps)
    try {
      const state = await call('GET', '/api/state')
      expect(state.status).toBe(200)
      expect(state.body).toMatchObject({ loop: { wanted: 'stopped' }, queue: [], health: null })
      const runs = await call('GET', '/api/runs?verdict=done')
      expect((runs.body.runs as unknown[]).length).toBe(1)
      expect(runs.body.verdicts).toEqual({ 'done:pr-opened': 1, '-': 1, 'blocked:tooling': 1 })
      expect(runs.body.endings).toEqual({ completed: 2, died: 1 })
      const died = await call('GET', '/api/runs?ending=died')
      expect((died.body.runs as { key: string }[]).map((r) => r.key)).toEqual(['KAZ-2'])
      const one = await call('GET', '/api/runs/KAZ-1/1')
      expect(one.body.files).toEqual([{ name: '00-assignment.md', text: '- Summary: one\n- Time: 2026-10-20T10:00:00Z\n' }, { name: '01-investigate.md', text: 'inv' }, { name: 'state.md', text: 'pr: https://bitbucket.org/CGS/webui/pull-requests/1\ndone:pr-opened\n' }])
      expect((await call('GET', '/api/runs/KAZ-9/1')).status).toBe(404)
    } finally {
      await close()
    }
  })

  it('queues, refuses, reorders, removes, starts and stops the loop, cancels, and ticks the loop after each action', async () => {
    const { deps, ticks, db } = sources()
    deps.lookup = async (key) => (key === 'KAZ-404' ? { kind: 'not-found' } : { kind: 'found', summary: `sum ${key}` })
    const { call, close } = await serve(deps)
    try {
      expect((await call('POST', '/api/queue', { key: 'KAZ-10' })).body).toMatchObject({ ok: true, item: { key: 'KAZ-10', summary: 'sum KAZ-10' } })
      expect((await call('POST', '/api/queue', { key: 'kaz-10' })).status).toBe(400)
      expect((await call('POST', '/api/queue', { key: 'KAZ-10' })).body).toMatchObject({ message: 'KAZ-10 is already queued' })
      expect((await call('POST', '/api/queue', { key: 'KAZ-404' })).body).toMatchObject({ message: 'Jira does not know KAZ-404' })
      await call('POST', '/api/queue', { key: 'KAZ-11' })
      await call('POST', '/api/queue', { key: 'KAZ-12', front: true })
      expect(((await call('GET', '/api/state')).body.queue as { key: string }[]).map((q) => q.key)).toEqual(['KAZ-12', 'KAZ-10', 'KAZ-11'])
      expect((await call('PUT', '/api/queue/order', { keys: ['KAZ-11', 'KAZ-12'] })).body).toMatchObject({ ok: true })
      expect(((await call('GET', '/api/state')).body.queue as { key: string }[]).map((q) => q.key)).toEqual(['KAZ-11', 'KAZ-12', 'KAZ-10'])
      expect((await call('DELETE', '/api/queue/KAZ-12')).status).toBe(200)
      expect((await call('DELETE', '/api/queue/KAZ-12')).status).toBe(404)
      expect((await call('POST', '/api/cancel')).status).toBe(409)
      expect((await call('POST', '/api/loop/start')).status).toBe(200)
      expect(loopState(db).wanted).toBe('running')
      expect((await call('POST', '/api/loop/stop')).status).toBe(200)
      expect(loopState(db)).toMatchObject({ wanted: 'stopped', stoppedReason: 'operator' })
      expect(ticks.length).toBe(5)
      expect((await call('GET', '/api/nothing')).status).toBe(404)
    } finally {
      await close()
    }
  })

  it('serves the built UI with an index fallback, refuses paths outside it and answers 404 for a file it does not have', async () => {
    const { deps } = sources()
    const ui = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-ui-dist-'))
    temps.push(ui)
    fs.writeFileSync(path.join(ui, 'index.html'), '<html>ui</html>')
    fs.mkdirSync(path.join(ui, 'assets'))
    fs.writeFileSync(path.join(ui, 'assets', 'a.js'), 'js')
    deps.uiDir = ui
    const server = createServer(deps)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`)
      expect(await (await get('/')).text()).toBe('<html>ui</html>')
      expect(await (await get('/runs/KAZ-1/1')).text()).toBe('<html>ui</html>')
      const js = await get('/assets/a.js')
      expect(js.headers.get('content-type')).toContain('javascript')
      expect(await (await get('/../../etc/passwd')).text()).toBe('<html>ui</html>')
      expect((await get('/assets/an-older-build.js')).status).toBe(404)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('the ticket search', () => {
  it('answers what the search found, refuses a long query, and says when it is not set up', async () => {
    const { deps } = sources()
    const asked: [string, string | undefined][] = []
    const search = async (q: string, next?: string) => {
      asked.push([q, next])
      return { kind: 'found' as const, scope: { project: null, words: q }, total: 1, next: null, issues: [{ key: 'KAZ-1', summary: 'one', status: 'Open', statusCategory: 'new', type: 'Bug', priority: null, assignee: null, updated: null }] }
    }
    const api = await serve({ ...deps, search })
    try {
      const found = await api.call('GET', `/api/jira/search?q=${encodeURIComponent('search pane')}`)
      expect(found).toMatchObject({ status: 200, body: { kind: 'found', issues: [{ key: 'KAZ-1' }] } })
      await api.call('GET', '/api/jira/search?q=KAZ&next=p2')
      expect(asked).toEqual([['search pane', undefined], ['KAZ', 'p2']])
      expect((await api.call('GET', `/api/jira/search?q=${'x'.repeat(201)}`)).status).toBe(400)
    } finally {
      await api.close()
    }
    const bare = await serve(deps)
    try {
      expect(await bare.call('GET', '/api/jira/search?q=abc')).toMatchObject({ status: 200, body: { kind: 'unavailable' } })
    } finally {
      await bare.close()
    }
  })
})
