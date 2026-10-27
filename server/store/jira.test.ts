import { describe, expect, it } from 'vitest'
import { jiraLookup, jiraSearch, searchJql, type JiraConfig } from './jira.ts'

const CONFIG: JiraConfig = { siteUrl: 'https://site.example', email: 'e@x', token: 't' }

/** A Jira whose tenant info gives a cloud id and whose API answers `api` for each call. */
function fakeJira(api: (path: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/_edge/tenant_info')) return Response.json({ cloudId: 'cloud-1' })
    return api(url.replace('https://api.atlassian.com/ex/jira/cloud-1/rest/api/3', ''), init)
  }) as typeof fetch
  return { fetchFn, calls }
}

const issue = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `summary of ${key}`, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, issuetype: { name: 'Bug' },
    priority: { name: 'High' }, assignee: { displayName: 'A Person' }, updated: '2026-10-27T10:00:00.000+0000', ...over,
  },
})

describe('searchJql', () => {
  it('finds a key as that ticket and anything else as words, without Jira\'s text syntax', () => {
    expect(searchJql(' kaz-7785 ')).toBe('key = KAZ-7785')
    expect(searchJql('search pane')).toBe('text ~ "search pane" ORDER BY updated DESC')
    expect(searchJql('can\'t "search" (ranges) a-b*')).toBe('text ~ "can\'t search ranges a b" ORDER BY updated DESC')
    expect(searchJql('')).toBeNull()
    expect(searchJql(' x ')).toBeNull()
    expect(searchJql('***')).toBeNull()
  })
})

describe('jiraSearch', () => {
  it('posts the JQL through the cloud id and lists the issues with their status, type and assignee', async () => {
    const jira = fakeJira((p) => (p === '/search/jql' ? Response.json({ issues: [issue('KAZ-1'), issue('KAZ-2', { assignee: null, status: null })] }) : new Response('', { status: 404 })))
    const found = await jiraSearch(CONFIG, jira.fetchFn)('search pane')
    expect(found).toEqual({
      kind: 'found',
      issues: [
        { key: 'KAZ-1', summary: 'summary of KAZ-1', status: 'In Progress', statusCategory: 'indeterminate', type: 'Bug', priority: 'High', assignee: 'A Person', updated: '2026-10-27T10:00:00.000+0000' },
        { key: 'KAZ-2', summary: 'summary of KAZ-2', status: null, statusCategory: null, type: 'Bug', priority: 'High', assignee: null, updated: '2026-10-27T10:00:00.000+0000' },
      ],
    })
    const post = jira.calls.find((c) => c.url.endsWith('/search/jql'))!
    expect(post.init.method).toBe('POST')
    expect(JSON.parse(String(post.init.body))).toMatchObject({ jql: 'text ~ "search pane" ORDER BY updated DESC', maxResults: 20 })
    expect((post.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('e@x:t').toString('base64')}`)
  })

  it('finds nothing for a key Jira does not know, and nothing without asking for a query too short', async () => {
    const jira = fakeJira(() => Response.json({ errorMessages: ['An issue with key \'KAZ-999999\' does not exist'] }, { status: 400 }))
    expect(await jiraSearch(CONFIG, jira.fetchFn)('KAZ-999999')).toEqual({ kind: 'found', issues: [] })
    const before = jira.calls.length
    expect(await jiraSearch(CONFIG, jira.fetchFn)('a')).toEqual({ kind: 'found', issues: [] })
    expect(jira.calls.length).toBe(before)
  })

  it('says Jira is unavailable when it fails, cannot be reached or has no credentials', async () => {
    expect(await jiraSearch(CONFIG, fakeJira(() => new Response('', { status: 500 })).fetchFn)('search pane')).toEqual({ kind: 'unavailable', error: 'Jira answered 500' })
    expect(await jiraSearch(CONFIG, fakeJira(() => { throw new Error('ECONNRESET') }).fetchFn)('search pane')).toEqual({ kind: 'unavailable', error: 'ECONNRESET' })
    expect(await jiraSearch(null)('search pane')).toEqual({ kind: 'unavailable', error: 'JIRA_EMAIL and JIRA_API_TOKEN are not set' })
  })
})

describe('jiraLookup', () => {
  it('reads the summary, refuses a key Jira does not know, and reports an outage', async () => {
    const jira = fakeJira((p) => (p.startsWith('/issue/KAZ-1?') ? Response.json({ fields: { summary: 'one' } }) : new Response('', { status: 404 })))
    const lookup = jiraLookup(CONFIG, jira.fetchFn)
    expect(await lookup('KAZ-1')).toEqual({ kind: 'found', summary: 'one' })
    expect(await lookup('KAZ-2')).toEqual({ kind: 'not-found' })
    expect(await jiraLookup(CONFIG, fakeJira(() => new Response('', { status: 503 })).fetchFn)('KAZ-1')).toEqual({ kind: 'unavailable', error: 'Jira answered 503' })
  })
})
