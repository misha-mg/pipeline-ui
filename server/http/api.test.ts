import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../store/db.ts'
import { addEvent, insertRun, loopState, serviceHeartbeat, startLoop, updateRun } from '../store/runs.ts'
import type { Health } from '../health.ts'
import { createServer, type ApiDeps } from './api.ts'
import type { SearchOptions } from '../store/jira.ts'
import { agentStages, runView, shownRuns, stateView, type StatsView } from './view.ts'
import { refreshTickets } from '../history/tickets.ts'
import { readRunSettings, type RunSettings } from '../store/settings.ts'

const temps: string[] = []
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true })
})

function sources() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-api-'))
  temps.push(dir)
  const runsDir = path.join(dir, 'runs')
  const write = (run: string, files: Record<string, string>) => {
    fs.mkdirSync(path.join(runsDir, run), { recursive: true })
    for (const [n, t] of Object.entries(files)) fs.writeFileSync(path.join(runsDir, run, n), t)
  }
  write('KAZ-1/run-1', {
    '00-assignment.md': '- Summary: one\n- Time: 2026-10-20T10:00:00Z\n',
    '01-investigate.md': 'inv',
    'state.md': 'pr: https://bitbucket.org/example/webui/pull-requests/1\ndone:pr-opened\n',
  })
  write('KAZ-2/run-1', { '00-assignment.md': '- Time: 2026-10-21T10:00:00Z\n' })
  write('KAZ-3/run-1', { '00-assignment.md': '- Time: 2026-10-22T10:00:00Z\n', 'state.md': 'blocked:tooling\n' })
  fs.mkdirSync(path.join(runsDir, 'batch-20261021-000000'))
  fs.writeFileSync(
    path.join(runsDir, 'batch-20261021-000000', 'summary.tsv'),
    `KAZ-3\tblocked:tooling\t-\t${path.join(runsDir, 'KAZ-3/run-1')}\n`,
  )
  const db = openDb(':memory:')
  const ticks: number[] = []
  const deps: ApiDeps = {
    db,
    runsDir,
    health: () => null,
    loop: { tick: () => ticks.push(1) },
    now: () => new Date('2026-10-27T12:00:00Z'),
  }
  return { db, runsDir, deps, ticks, write }
}

/** KAZ-1 is Done in Jira. */
function refreshTicketsFrom(db: ApiDeps['db']): Promise<number | string> {
  return refreshTickets(db, ['KAZ-1'], async () => ({
    kind: 'found',
    tickets: [{ key: 'KAZ-1', summary: 'one', status: 'Done', statusCategory: 'done', doneAt: '2026-10-21T00:00:00.000Z', moves: [] }],
  }))
}

async function serve(deps: ApiDeps) {
  const server = createServer(deps)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) }
}

describe('views', () => {
  it('shows every run with its ending: unwatched when only its files closed it, died without state.md, the service record when it has one', () => {
    const { db, deps, runsDir } = sources()
    const id = insertRun(db, { key: 'KAZ-3', summary: null, startedAt: '2026-10-22T10:00:00Z', logPath: null })
    updateRun(db, id, { runDir: path.join(runsDir, 'KAZ-3/run-1'), ending: 'cancelled', endedAt: '2026-10-22T10:30:00Z' })
    const runs = shownRuns(deps)
    expect(runs.map((r) => [r.key, r.ending, r.verdict])).toEqual([
      ['KAZ-3', 'cancelled', 'blocked:tooling'],
      ['KAZ-2', 'died', null],
      ['KAZ-1', 'unwatched', 'done:pr-opened'],
    ])
    expect(runs[2]!.pr).toMatchObject({ state: 'unknown' })
    expect(runs[0]!.serviceRunId).toBe(id)
    // A run just started is listed before its directory exists, in flight, with no number.
    const started = insertRun(db, { key: 'KAZ-4', summary: 'four', startedAt: '2026-10-22T11:00:00Z', logPath: null })
    const fresh = shownRuns(deps)
    expect(fresh.map((r) => [r.key, r.ending, r.number])).toEqual([
      ['KAZ-4', 'in-flight', 0],
      ['KAZ-3', 'cancelled', 1],
      ['KAZ-2', 'died', 1],
      ['KAZ-1', 'unwatched', 1],
    ])
    expect(fresh[0]!.serviceRunId).toBe(started)
    // Once its directory is on disk the files list it; the record without run_dir is not listed twice.
    fs.mkdirSync(path.join(runsDir, 'KAZ-4/run-1'), { recursive: true })
    fs.writeFileSync(path.join(runsDir, 'KAZ-4/run-1/00-assignment.md'), '- Summary: four\n- Time: 2026-10-22T11:01:00Z\n')
    const appeared = shownRuns(deps).filter((r) => r.key === 'KAZ-4')
    expect(appeared.map((r) => [r.ending, r.number])).toEqual([['in-flight', 1]])
  })

  it('counts verdicts all time, for 7 days and for the last batch, by the loop start when it is later', () => {
    const { db, deps } = sources()
    let s = stateView(deps)
    // Verdicts only: the run without one counts as none, not as its ending.
    expect(s.counts.allTime).toEqual({ 'done:pr-opened': 1, none: 1, 'blocked:tooling': 1 })
    expect(s.counts.last7Days).toEqual({ none: 1, 'blocked:tooling': 1 })
    expect(s.counts).toMatchObject({ lastBatchLabel: 'batch-20261021-000000', lastBatch: { 'blocked:tooling': 1 } })
    startLoop(db, () => '2026-10-25T00:00:00Z')
    s = stateView(deps)
    expect(s.counts.lastBatch).toEqual({})
    expect(s.counts.lastBatchLabel).toContain('loop since')
    expect(s.service.alive).toBe(false)
    expect(s.inFlight).toBeNull()
  })

  it('gives a run the service drove its agents from the session events, the working one open', () => {
    const { db, deps, runsDir } = sources()
    const id = insertRun(db, { key: 'KAZ-2', summary: null, startedAt: '2026-10-21T10:00:00Z', logPath: null })
    updateRun(db, id, { runDir: path.join(runsDir, 'KAZ-2/run-1') })
    addEvent(db, id, { type: 'stage-start', at: '2026-10-21T10:01:00Z', agent: 'ticket-investigator', agentId: 'a1' })
    addEvent(db, id, { type: 'rate-limit', at: '2026-10-21T10:02:00Z', status: 'allowed' })
    addEvent(db, id, { type: 'stage-stop', at: '2026-10-21T10:05:00Z', agent: 'ticket-investigator', agentId: 'a1', text: '## Brief' })
    addEvent(db, id, { type: 'stage-start', at: '2026-10-21T10:05:01Z', agent: 'ticket-implementer', agentId: 'a2' })
    expect(agentStages(db, id)).toEqual([
      {
        agent: 'ticket-investigator',
        agentId: 'a1',
        label: 'investigate',
        startedAt: '2026-10-21T10:01:00Z',
        endedAt: '2026-10-21T10:05:00Z',
        text: '## Brief',
        result: null,
      },
      {
        agent: 'ticket-implementer',
        agentId: 'a2',
        label: 'implement',
        startedAt: '2026-10-21T10:05:01Z',
        endedAt: null,
        text: null,
        result: null,
      },
    ])
    expect(runView(deps, 'KAZ-2', 1)?.agents).toHaveLength(2)
    // An agent whose call was not on disk as it stopped: read from its transcript now.
    const transcript = path.join(runsDir, 'agent.jsonl')
    fs.writeFileSync(
      transcript,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { report: 'late report' } }] },
      }),
    )
    addEvent(db, id, { type: 'stage-stop', at: '2026-10-21T10:09:00Z', agent: 'ticket-implementer', agentId: 'a2', transcript })
    expect(agentStages(db, id)[1]).toMatchObject({ endedAt: '2026-10-21T10:09:00Z', text: 'late report' })
    expect(runView(deps, 'KAZ-1', 1)?.agents).toEqual([])
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
      // Each filter's counts follow the other filter: the endings among the done runs.
      expect(runs.body.verdicts).toEqual({ 'done:pr-opened': 1, none: 1, 'blocked:tooling': 1 })
      expect(runs.body.endings).toEqual({ unwatched: 1 })
      const none = await call('GET', '/api/runs?verdict=none')
      expect((none.body.runs as { key: string }[]).map((r) => r.key)).toEqual(['KAZ-2'])
      expect((await call('GET', '/api/runs?ending=finished')).status).toBe(400)
      expect((await call('GET', '/api/runs?verdict=DONE')).status).toBe(400)
      const died = await call('GET', '/api/runs?ending=died')
      expect((died.body.runs as { key: string }[]).map((r) => r.key)).toEqual(['KAZ-2'])
      const one = await call('GET', '/api/runs/KAZ-1/1')
      expect(one.body.files).toEqual([
        { name: '00-assignment.md', text: '- Summary: one\n- Time: 2026-10-20T10:00:00Z\n' },
        { name: '01-investigate.md', text: 'inv' },
        { name: 'state.md', text: 'pr: https://bitbucket.org/example/webui/pull-requests/1\ndone:pr-opened\n' },
      ])
      expect((await call('GET', '/api/runs/KAZ-9/1')).status).toBe(404)
    } finally {
      await close()
    }
  })

  it("serves the statistics: every run marked by the last batch, its pull request and its ticket's status", async () => {
    const { deps, db } = sources()
    await refreshTicketsFrom(db)
    const { call, close } = await serve({ ...deps, readers: { bitbucket: false, jira: true } })
    try {
      const stats = await call('GET', '/api/stats')
      expect(stats.status).toBe(200)
      const body = stats.body as unknown as StatsView
      expect(body.runs.map((r) => [r.key, r.verdict, r.inLastBatch])).toEqual([
        ['KAZ-3', 'blocked:tooling', true],
        ['KAZ-2', null, false],
        ['KAZ-1', 'done:pr-opened', false],
      ])
      expect(body.pullRequests['https://bitbucket.org/example/webui/pull-requests/1']).toMatchObject({ state: 'unknown' })
      expect(body.tickets['KAZ-1']).toMatchObject({ statusCategory: 'done' })
      expect(body).toMatchObject({
        lastBatchLabel: 'batch-20261021-000000',
        readers: { bitbucket: false, jira: true },
        readAt: { pullRequests: null },
      })
    } finally {
      await close()
    }
  })

  it('queues, refuses, reorders, removes, starts and stops the loop, cancels, and ticks the loop after each action', async () => {
    const { deps, ticks, db } = sources()
    deps.lookup = async (key) => (key === 'KAZ-404' ? { kind: 'not-found' } : { kind: 'found', summary: `sum ${key}`, labels: [] })
    const { call, close } = await serve(deps)
    try {
      expect((await call('POST', '/api/queue', { key: 'KAZ-10' })).body).toMatchObject({
        ok: true,
        item: { key: 'KAZ-10', summary: 'sum KAZ-10' },
      })
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
    fs.writeFileSync(path.join(ui, 'theme.js'), 'js')
    fs.mkdirSync(path.join(ui, 'fonts'))
    fs.writeFileSync(path.join(ui, 'fonts', 'a.woff2'), 'font')
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
      // A hashed file and a face are kept by the browser; the page and theme.js, which keep their names, are not.
      expect(js.headers.get('cache-control')).toContain('immutable')
      expect((await get('/fonts/a.woff2')).headers.get('cache-control')).toContain('immutable')
      expect((await get('/theme.js')).headers.get('cache-control')).toBe('no-cache')
      expect((await get('/')).headers.get('cache-control')).toBe('no-cache')
      expect(await (await get('/../../etc/passwd')).text()).toBe('<html>ui</html>')
      expect((await get('/assets/an-older-build.js')).status).toBe(404)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('the frame the tools share', () => {
  it('tells the console the start page its mark leads to and the code the service runs, or neither', async () => {
    const { deps } = sources()
    expect(stateView(deps)).toMatchObject({ portal: null, build: null })
    const build = { version: '0.38.1', commit: 'abc1234', dirty: false, commitUrl: null }
    expect(stateView({ ...deps, portal: 'http://tools.example.net/', build })).toMatchObject({ portal: 'http://tools.example.net/', build })
  })
})

describe('the run settings', () => {
  const defaults: RunSettings = { baseBranch: 'master', pullRequests: 'on', timeoutHours: 4 }
  function withSettings() {
    const { deps, db, ticks } = sources()
    const changes: Partial<RunSettings>[] = []
    const checked: string[] = []
    deps.settings = {
      defaults,
      checkBranch: async (branch) => {
        checked.push(branch)
        return branch === 'gone' ? 'origin has no branch gone' : null
      },
      branches: async () => ['dev', 'master'],
      onChange: (c) => changes.push(c),
    }
    deps.setup = () => ({ ...readRunSettings(db, defaults), entry: 'entry', defaults })
    return { deps, db, ticks, changes, checked }
  }

  it('are changed from the console for the next run: the state shows them at once, the branch is checked first', async () => {
    const { deps, changes, checked } = withSettings()
    const { call, close } = await serve(deps)
    try {
      expect((await call('GET', '/api/state')).body.setup).toMatchObject({
        baseBranch: 'master',
        pullRequests: 'on',
        timeoutHours: 4,
        defaults,
      })
      expect((await call('GET', '/api/branches')).body).toEqual({ branches: ['dev', 'master'] })

      const saved = await call('PUT', '/api/settings', { baseBranch: 'dev', pullRequests: 'draft' })
      expect(saved).toEqual({
        status: 200,
        body: {
          ok: true,
          settings: { baseBranch: 'dev', pullRequests: 'draft', timeoutHours: 4 },
          changed: ['baseBranch', 'pullRequests'],
        },
      })
      expect(checked).toEqual(['dev'])
      expect(changes).toEqual([{ baseBranch: 'dev', pullRequests: 'draft' }])
      expect((await call('GET', '/api/state')).body.setup).toMatchObject({ baseBranch: 'dev', pullRequests: 'draft', defaults })

      // The branch is not asked about again when it is not the one that changes; nothing changed is not told.
      expect((await call('PUT', '/api/settings', { timeoutHours: 6 })).body.changed).toEqual(['timeoutHours'])
      expect((await call('PUT', '/api/settings', { timeoutHours: 6 })).body.changed).toEqual([])
      expect(checked).toEqual(['dev'])
      expect(changes).toHaveLength(2)
    } finally {
      await close()
    }
  })

  it('keeps nothing when origin refuses the branch or a value is wrong', async () => {
    const { deps, db, changes } = withSettings()
    const { call, close } = await serve(deps)
    try {
      expect(await call('PUT', '/api/settings', { baseBranch: 'gone', pullRequests: 'off' })).toEqual({
        status: 400,
        body: { message: 'origin has no branch gone' },
      })
      expect((await call('PUT', '/api/settings', { pullRequests: 'sometimes' })).status).toBe(400)
      expect((await call('PUT', '/api/settings', { baseBranch: '--upload-pack=x' })).status).toBe(400)
      expect(readRunSettings(db, defaults)).toEqual(defaults)
      expect(changes).toEqual([])
    } finally {
      await close()
    }
  })

  it('cannot be changed on a console that was given none', async () => {
    const { deps } = sources()
    const { call, close } = await serve(deps)
    try {
      expect((await call('PUT', '/api/settings', { pullRequests: 'off' })).status).toBe(404)
      expect((await call('GET', '/api/branches')).body).toEqual({ branches: [] })
    } finally {
      await close()
    }
  })
})

describe('the guard', () => {
  /** A raw request, for headers fetch will not send (Host). */
  const raw = (port: number, options: http.RequestOptions, body?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  const listen = async (deps: ApiDeps) => {
    const server = createServer(deps)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return { port: (server.address() as { port: number }).port, close: () => new Promise<void>((r) => server.close(() => r())) }
  }

  it('puts the security headers on every answer and refuses a Host it does not know', async () => {
    const { deps } = sources()
    const { port, close } = await listen({ ...deps, guard: { hostnames: ['console.example'], login: null, realm: 'test' } })
    try {
      const state = await raw(port, { path: '/api/state', headers: { host: `127.0.0.1:${port}` } })
      expect(state.status).toBe(200)
      expect(state.headers['content-security-policy']).toContain("default-src 'self'")
      expect(state.headers['x-content-type-options']).toBe('nosniff')
      expect((await raw(port, { path: '/api/state', headers: { host: 'localhost' } })).status).toBe(200)
      expect((await raw(port, { path: '/api/state', headers: { host: 'Console.example:8787' } })).status).toBe(200)
      const foreign = await raw(port, { path: '/api/state', headers: { host: 'evil.example' } })
      expect(foreign.status).toBe(421)
      expect(foreign.headers['content-security-policy']).toContain("default-src 'self'")
    } finally {
      await close()
    }
  })

  it("takes an action from the console's own pages only; a GET is always answered", async () => {
    const { deps, db } = sources()
    const { port, close } = await listen(deps)
    try {
      const post = (headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}/api/queue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ key: 'KAZ-9' }),
        })
      const foreign = await post({ origin: 'https://evil.example' })
      expect(foreign.status).toBe(403)
      expect(((await foreign.json()) as { message: string }).message).toContain("console's own pages")
      expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { origin: 'https://evil.example' } })).status).toBe(200)
      expect((await post({ origin: `http://127.0.0.1:${port}` })).status).toBe(200)
      expect(db.prepare('SELECT key FROM queue').all()).toEqual([{ key: 'KAZ-9' }])
    } finally {
      await close()
    }
  })

  it('asks for the login when one is set, /healthz apart; without one nothing changes', async () => {
    const { deps } = sources()
    const open = await listen(deps)
    const guarded = await listen({ ...deps, guard: { hostnames: [], login: { user: 'op', password: 'pw' }, realm: 'Pipeline console' } })
    try {
      expect((await fetch(`http://127.0.0.1:${open.port}/api/state`)).status).toBe(200)
      const asked = await fetch(`http://127.0.0.1:${guarded.port}/api/state`)
      expect(asked.status).toBe(401)
      expect(asked.headers.get('www-authenticate')).toBe('Basic realm="Pipeline console", charset="UTF-8"')
      const auth = (login: string) => ({ authorization: `Basic ${Buffer.from(login).toString('base64')}` })
      expect((await fetch(`http://127.0.0.1:${guarded.port}/api/state`, { headers: auth('op:wrong') })).status).toBe(401)
      expect((await fetch(`http://127.0.0.1:${guarded.port}/api/state`, { headers: auth('op:pw') })).status).toBe(200)
      expect((await fetch(`http://127.0.0.1:${guarded.port}/healthz`)).status).toBe(503)
    } finally {
      await open.close()
      await guarded.close()
    }
  })

  it('refuses a body over 64 KB', async () => {
    const { deps } = sources()
    const { port, close } = await listen(deps)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/queue`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'x'.repeat(70 * 1024) }),
      })
      expect(res.status).toBe(413)
    } finally {
      await close()
    }
  })
})

describe('/healthz', () => {
  it('is ok when the heartbeat is fresh and every dependency checked is ok, 503 otherwise, and says what is in flight', async () => {
    const { deps, db } = sources()
    const now = () => new Date('2026-10-27T12:00:00Z')
    let health: Health | null = null
    const server = createServer({ ...deps, now, health: () => health })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const get = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    try {
      expect(await get()).toEqual({ status: 503, body: { ok: false, state: 'stopped', loop: 'stopped', inFlight: null, health: {} } })
      serviceHeartbeat(db, 1, '2026-10-27T11:00:00Z', () => '2026-10-27T11:59:58Z')
      expect(await get()).toMatchObject({ status: 200, body: { ok: true, state: 'running' } })
      const check = (ok: boolean) => ({ ok, detail: '', checkedAt: '2026-10-27T11:59:00Z' })
      health = { runsDir: check(true), tmux: check(true), jira: check(false) }
      expect(await get()).toMatchObject({
        status: 503,
        body: { ok: false, state: 'running', health: { runsDir: true, tmux: true, jira: false } },
      })
      health = { runsDir: check(true), tmux: check(true), jira: check(true) }
      startLoop(db, () => '2026-10-27T11:30:00Z')
      insertRun(db, { key: 'KAZ-5', summary: null, startedAt: '2026-10-27T11:31:00Z', logPath: null })
      expect(await get()).toEqual({
        status: 200,
        body: { ok: true, state: 'running', loop: 'running', inFlight: 'KAZ-5', health: { runsDir: true, tmux: true, jira: true } },
      })
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('the ticket search', () => {
  it('answers what the search found, refuses a long query, and says when it is not set up', async () => {
    const { deps } = sources()
    const asked: [string, SearchOptions | undefined][] = []
    const search = async (q: string, options?: SearchOptions) => {
      asked.push([q, options])
      return {
        kind: 'found' as const,
        scope: { project: null, words: q },
        total: 1,
        next: null,
        issues: [
          {
            key: 'KAZ-1',
            summary: 'one',
            labels: [],
            status: 'Open',
            statusCategory: 'new',
            type: 'Bug',
            priority: null,
            assignee: null,
            updated: null,
          },
        ],
      }
    }
    const api = await serve({ ...deps, search })
    try {
      const found = await api.call('GET', `/api/jira/search?q=${encodeURIComponent('search pane')}`)
      expect(found).toMatchObject({ status: 200, body: { kind: 'found', issues: [{ key: 'KAZ-1' }] } })
      await api.call('GET', '/api/jira/search?q=KAZ&next=p2')
      await api.call('GET', `/api/jira/search?q=&jql=${encodeURIComponent('status = Open')}`)
      expect(asked).toEqual([
        ['search pane', { jql: undefined, next: undefined }],
        ['KAZ', { jql: undefined, next: 'p2' }],
        ['', { jql: 'status = Open', next: undefined }],
      ])
      expect((await api.call('GET', `/api/jira/search?q=${'x'.repeat(201)}`)).status).toBe(400)
      expect((await api.call('GET', `/api/jira/search?q=&jql=${'x'.repeat(2001)}`)).status).toBe(400)
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

describe("the implementer's three stages", () => {
  it('names a later implementer a rework when a diff follows it or a fail came before it, else the pull request; the card counts reworks only', () => {
    const { db } = sources()
    const id = insertRun(db, { key: 'KAZ-5', summary: null, startedAt: '2026-10-21T10:00:00Z', logPath: null })
    let n = 0
    const agent = (name: string, text?: string) => {
      const agentId = `a${++n}`
      addEvent(db, id, { type: 'stage-start', at: `2026-10-21T10:${String(n).padStart(2, '0')}:00Z`, agent: name, agentId })
      if (text !== undefined)
        addEvent(db, id, { type: 'stage-stop', at: `2026-10-21T10:${String(n).padStart(2, '0')}:30Z`, agent: name, agentId, text })
    }
    agent('ticket-investigator', 'confidence: high\n\n## Brief')
    agent('ticket-implementer', 'outcome: done')
    agent('diff-preparer', '')
    agent('change-reviewer', 'verdict: fail')
    agent('ticket-implementer', 'outcome: done')
    expect(agentStages(db, id).map((s) => [s.label, s.result])).toEqual([
      ['investigate', 'confidence high'],
      ['implement', 'done'],
      ['diff', null],
      ['review', 'fail'],
      ['rework 1', 'done'],
    ])
    agent('diff-preparer', '')
    agent('change-reviewer', 'verdict: pass')
    agent('ticket-implementer')
    expect(
      agentStages(db, id)
        .map((s) => s.label)
        .slice(4),
    ).toEqual(['rework 1', 'diff', 'review', 'pull request'])
    expect(stateView({ db, runsDir: '/nonexistent', health: () => null }).inFlight?.rework).toBe(1)
    // In a run that is over, the implementer it ended on was the pull request, whatever came before.
    const { db: db2 } = sources()
    const id2 = insertRun(db2, { key: 'KAZ-6', summary: null, startedAt: '2026-10-21T10:00:00Z', logPath: null })
    addEvent(db2, id2, { type: 'stage-start', at: '2026-10-21T10:00:00Z', agent: 'ticket-implementer', agentId: 'b1' })
    addEvent(db2, id2, { type: 'stage-start', at: '2026-10-21T10:01:00Z', agent: 'ticket-implementer', agentId: 'b2' })
    addEvent(db2, id2, { type: 'stage-stop', at: '2026-10-21T10:02:00Z', agent: 'ticket-implementer', agentId: 'b2' })
    expect(agentStages(db2, id2).map((s) => s.label)).toEqual(['implement', 'rework or pull request'])
    expect(agentStages(db2, id2, true).map((s) => s.label)).toEqual(['implement', 'pull request'])
  })
})
