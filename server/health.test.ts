import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Config } from './config.ts'
import { checkHealth, type HealthDeps } from './health.ts'

function config(): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-health-'))
  fs.mkdirSync(path.join(dir, 'webui', 'tools', 'device-mock'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'webui', 'tools', 'device-mock', 'rpc.sh'), '')
  fs.mkdirSync(path.join(dir, 'webui', '.pipeline-runs', 'KAZ-1'), { recursive: true })
  return { repo: dir, webuiDir: path.join(dir, 'webui'), runsDir: path.join(dir, 'webui', '.pipeline-runs'), dataDir: dir, dbPath: '', logDir: '', envFile: '', sessionBin: '', sessionTimeoutMs: 0, host: '', port: 0, uiDir: '', baseBranch: 'master', entryDir: '', pullRequests: true }
}

const okFetch = (async (url: string) => {
  if (url.endsWith('/_edge/tenant_info')) return new Response(JSON.stringify({ cloudId: 'c' }), { status: 200 })
  return new Response(JSON.stringify({ fields: { summary: 's' } }), { status: 200 })
}) as unknown as typeof fetch

describe('checkHealth', () => {
  it('reports every dependency ok when all answer', async () => {
    const run: HealthDeps['run'] = async (file, args) =>
      file === 'tmux' ? { ok: false, output: 'no server running on /tmp/tmux-1000/default' } : { ok: true, output: `{"BOARD-TYPE":"NPB-IIe"} ${args.join(' ')}` }
    const h = await checkHealth(config(), { run, fetch: okFetch, env: { JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't', BITBUCKET_TOKEN: 'b', BITBUCKET_WORKSPACE: 'CGS' } })
    expect(Object.values(h).every((c) => c.ok)).toBe(true)
    expect(h.runsDir.detail).toContain('1 tickets')
    expect(h.mock.detail).toBe('board NPB-IIe')
    expect(h.tmux.detail).toContain('no tmux server')
  })

  it('reports what is missing: a batch running, no credentials, a silent mock', async () => {
    const run: HealthDeps['run'] = async (file) => (file === 'tmux' ? { ok: true, output: '' } : { ok: false, output: 'curl: (7) Failed to connect\n' })
    const c = config()
    fs.rmSync(c.runsDir, { recursive: true })
    const h = await checkHealth(c, { run, fetch: okFetch, env: {} })
    expect(h.runsDir).toMatchObject({ ok: false, detail: expect.stringContaining('ENOENT') })
    expect(h.tmux).toMatchObject({ ok: false, detail: expect.stringContaining('batch.sh session is running') })
    expect(h.jira).toMatchObject({ ok: false, detail: expect.stringContaining('JIRA_EMAIL') })
    expect(h.mock).toMatchObject({ ok: false, detail: 'the mock does not answer: curl: (7) Failed to connect' })
    expect(h.bitbucket).toMatchObject({ ok: false, detail: expect.stringContaining('BITBUCKET_TOKEN') })
  })
})
