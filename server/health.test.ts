import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Config } from './config.ts'
import { checkHealth, type HealthDeps } from './health.ts'

function config(jira: Config['jira'] = null): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-health-'))
  fs.mkdirSync(path.join(dir, 'webui', '.pipeline-runs', 'KAZ-1'), { recursive: true })
  return {
    repo: dir,
    webuiDir: path.join(dir, 'webui'),
    runsDir: path.join(dir, 'webui', '.pipeline-runs'),
    dataDir: dir,
    dbPath: '',
    logDir: '',
    envFile: '',
    sessionBin: '',
    sessionTimeoutMs: 0,
    host: '',
    port: 0,
    uiDir: '',
    baseBranch: 'master',
    entryDir: '',
    pullRequests: 'on',
    jira,
    jiraSite: jira?.siteUrl ?? null,
    bitbucket: null,
    guard: { hostnames: [], login: null, realm: 'test' },
    backupDir: '',
    logFile: '',
  }
}

const okFetch = (async (url: string) => {
  if (url.endsWith('/_edge/tenant_info')) return new Response(JSON.stringify({ cloudId: 'c' }), { status: 200 })
  return new Response(JSON.stringify({ fields: { summary: 's' } }), { status: 200 })
}) as unknown as typeof fetch

describe('checkHealth', () => {
  it('reports every dependency ok when all answer', async () => {
    const run: HealthDeps['run'] = async () => ({ ok: false, output: 'no server running on /tmp/tmux-1000/default' })
    const h = await checkHealth(config({ siteUrl: 'https://site.example', email: 'e', token: 't' }), { run, fetch: okFetch })
    expect(Object.keys(h).sort()).toEqual(['jira', 'runsDir', 'tmux'])
    expect(Object.values(h).every((c) => c.ok)).toBe(true)
    expect(h.runsDir.detail).toContain('1 tickets')
    expect(h.tmux.detail).toContain('no tmux server')
  })

  it('reports what is missing: a batch running, no credentials', async () => {
    const run: HealthDeps['run'] = async () => ({ ok: true, output: '' })
    const c = config()
    fs.rmSync(c.runsDir, { recursive: true })
    const h = await checkHealth(c, { run, fetch: okFetch })
    expect(h.runsDir).toMatchObject({ ok: false, detail: expect.stringContaining('ENOENT') })
    expect(h.tmux).toMatchObject({ ok: false, detail: expect.stringContaining('batch.sh session is running') })
    expect(h.jira).toMatchObject({
      ok: false,
      detail: expect.stringContaining('JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set'),
    })
  })
})
