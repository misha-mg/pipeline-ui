import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { enqueue, listQueue, queueHead, remove, reorder, takeHead, type Lookup } from './queue.ts'
import { jiraConfig, jiraLookup } from './jira.ts'

const keys = (db: ReturnType<typeof openDb>) => listQueue(db).map((i) => i.key)
const found = (summary: string) => async (): Promise<Lookup> => ({ kind: 'found', summary })

describe('queue', () => {
  it('adds at the end and at the front, keeps the order and the summary', async () => {
    const db = openDb(':memory:')
    expect(await enqueue(db, 'KAZ-1', { lookup: found('one') })).toMatchObject({ ok: true, item: { key: 'KAZ-1', summary: 'one' } })
    await enqueue(db, 'KAZ-2')
    await enqueue(db, 'KAZ-3', { front: true })
    expect(keys(db)).toEqual(['KAZ-3', 'KAZ-1', 'KAZ-2'])
    expect(queueHead(db)?.key).toBe('KAZ-3')
  })

  it('refuses a key that is not a ticket key', async () => {
    const db = openDb(':memory:')
    for (const bad of ['kaz-1', 'KAZ', 'foo', 'KAZ-1 ', '']) {
      expect(await enqueue(db, bad)).toMatchObject({ ok: false, reason: 'invalid-key' })
    }
    expect(keys(db)).toEqual([])
  })

  it('refuses a duplicate and holds the ticket once', async () => {
    const db = openDb(':memory:')
    await enqueue(db, 'KAZ-1')
    expect(await enqueue(db, 'KAZ-1', { front: true })).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(keys(db)).toEqual(['KAZ-1'])
  })

  it('refuses a ticket Jira does not know, and queues without a summary when Jira is unreachable', async () => {
    const db = openDb(':memory:')
    expect(await enqueue(db, 'KAZ-9', { lookup: async () => ({ kind: 'not-found' }) })).toMatchObject({ ok: false, reason: 'unknown-ticket' })
    const added = await enqueue(db, 'KAZ-1', { lookup: async () => ({ kind: 'unavailable', error: 'ECONNREFUSED' }) })
    expect(added).toMatchObject({ ok: true, item: { key: 'KAZ-1', summary: null }, warning: expect.stringContaining('ECONNREFUSED') })
    expect(keys(db)).toEqual(['KAZ-1'])
  })

  it('removes a queued ticket and refuses one that is not queued', async () => {
    const db = openDb(':memory:')
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    expect(remove(db, 'KAZ-1')).toEqual({ ok: true })
    expect(remove(db, 'KAZ-1')).toMatchObject({ ok: false, reason: 'not-queued' })
    expect(keys(db)).toEqual(['KAZ-2'])
  })

  it('reorders: the named tickets first, the rest after in their order; refuses an unknown key', async () => {
    const db = openDb(':memory:')
    for (const k of ['KAZ-1', 'KAZ-2', 'KAZ-3', 'KAZ-4']) await enqueue(db, k)
    expect(reorder(db, ['KAZ-3', 'KAZ-2'])).toMatchObject({ ok: true })
    expect(keys(db)).toEqual(['KAZ-3', 'KAZ-2', 'KAZ-1', 'KAZ-4'])
    expect(reorder(db, ['KAZ-4', 'KAZ-7'])).toMatchObject({ ok: false, reason: 'not-queued' })
    expect(keys(db)).toEqual(['KAZ-3', 'KAZ-2', 'KAZ-1', 'KAZ-4'])
    await enqueue(db, 'KAZ-5', { front: true })
    expect(keys(db)).toEqual(['KAZ-5', 'KAZ-3', 'KAZ-2', 'KAZ-1', 'KAZ-4'])
  })

  it('takes the head out, and a taken ticket can be queued again', async () => {
    const db = openDb(':memory:')
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    expect(takeHead(db)?.key).toBe('KAZ-1')
    expect(keys(db)).toEqual(['KAZ-2'])
    expect(await enqueue(db, 'KAZ-1')).toMatchObject({ ok: true })
    expect(takeHead(db)?.key).toBe('KAZ-2')
    expect(takeHead(db)?.key).toBe('KAZ-1')
    expect(takeHead(db)).toBeNull()
  })
})

describe('jiraLookup', () => {
  const config = { siteUrl: 'https://jira.test', email: 'me@test', token: 'tok' }
  const ISSUE = 'https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/KAZ-1?fields=summary'
  /** A Jira whose tenant info names cloud-1 and whose issue endpoint answers `status`/`body`. */
  function fakeJira(status: number, body: unknown = {}) {
    const seen: { url: string; auth: string | undefined }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization })
      if (url.endsWith('/_edge/tenant_info')) return new Response(JSON.stringify({ cloudId: 'cloud-1' }), { status: 200 })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { fetchFn, seen }
  }

  it('finds the cloud id once, then asks api.atlassian.com for the summary with basic auth', async () => {
    const jira = fakeJira(200, { fields: { summary: 'Range search' } })
    const lookup = jiraLookup(config, jira.fetchFn)
    expect(await lookup('KAZ-1')).toEqual({ kind: 'found', summary: 'Range search' })
    expect(await lookup('KAZ-1')).toEqual({ kind: 'found', summary: 'Range search' })
    expect(jira.seen).toEqual([
      { url: 'https://jira.test/_edge/tenant_info', auth: undefined },
      { url: ISSUE, auth: `Basic ${Buffer.from('me@test:tok').toString('base64')}` },
      { url: ISSUE, auth: `Basic ${Buffer.from('me@test:tok').toString('base64')}` },
    ])
  })

  it('uses JIRA_CLOUD_ID when set', async () => {
    const jira = fakeJira(200, { fields: { summary: 's' } })
    await jiraLookup({ ...config, cloudId: 'given' }, jira.fetchFn)('KAZ-1')
    expect(jira.seen.map((s) => s.url)).toEqual(['https://api.atlassian.com/ex/jira/given/rest/api/3/issue/KAZ-1?fields=summary'])
  })

  it('maps 404 to not-found, other statuses, a thrown fetch and no config to unavailable', async () => {
    expect(await jiraLookup(config, fakeJira(404).fetchFn)('KAZ-1')).toEqual({ kind: 'not-found' })
    expect(await jiraLookup(config, fakeJira(401).fetchFn)('KAZ-1')).toEqual({ kind: 'unavailable', error: 'Jira answered 401' })
    const thrower = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await jiraLookup(config, thrower)('KAZ-1')).toEqual({ kind: 'unavailable', error: 'ECONNREFUSED' })
    expect(await jiraLookup(null)('KAZ-1')).toMatchObject({ kind: 'unavailable' })
  })

  it('reads the config from the environment', () => {
    expect(jiraConfig({})).toBeNull()
    expect(jiraConfig({ JIRA_EMAIL: 'e', JIRA_API_TOKEN: 't', JIRA_BASE_URL: 'https://x.test/' })).toEqual({ siteUrl: 'https://x.test', email: 'e', token: 't', cloudId: undefined })
  })
})
