import { describe, expect, it } from 'vitest'
import { jiraLookup, jiraSearch, scopeJql, searchScope, type JiraConfig } from './jira.ts'

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

const PROJECTS = new Set(['KAZ', 'RPG'])

describe('searchScope', () => {
  it('reads a key as that ticket, a project key first as that project, and the rest as words without Jira\'s text syntax', () => {
    expect(searchScope(' kaz-7785 ', PROJECTS)).toEqual({ key: 'KAZ-7785' })
    expect(searchScope('KAZ', PROJECTS)).toEqual({ project: 'KAZ', words: null })
    expect(searchScope('rpg search pane', PROJECTS)).toEqual({ project: 'RPG', words: 'search pane' })
    expect(searchScope('search pane', PROJECTS)).toEqual({ project: null, words: 'search pane' })
    expect(searchScope('DM', PROJECTS)).toEqual({ project: null, words: 'DM' })
    expect(searchScope('can\'t "search" (ranges) a-b*', PROJECTS)).toEqual({ project: null, words: 'can\'t search ranges a b' })
    expect(searchScope('', PROJECTS)).toBeNull()
    expect(searchScope(' x ', PROJECTS)).toBeNull()
    expect(searchScope('***', PROJECTS)).toBeNull()
  })

  it('makes the JQL, the latest updated first', () => {
    expect(scopeJql({ key: 'KAZ-1' })).toBe('key = KAZ-1')
    expect(scopeJql({ project: 'KAZ', words: null })).toBe('project = KAZ ORDER BY updated DESC')
    expect(scopeJql({ project: 'KAZ', words: 'search pane' })).toBe('project = KAZ AND text ~ "search pane" ORDER BY updated DESC')
    expect(scopeJql({ project: null, words: 'search pane' })).toBe('text ~ "search pane" ORDER BY updated DESC')
  })
})

/** A Jira with the projects KAZ and RPG, a count of 201, and `search` answering /search/jql. */
const searchingJira = (search: (body: Record<string, unknown>) => Response, count: () => Response = () => Response.json({ count: 201 })) =>
  fakeJira((p, init) => {
    if (p.startsWith('/project/search')) return Response.json({ values: [{ key: 'KAZ' }, { key: 'RPG' }] })
    if (p === '/search/approximate-count') return count()
    if (p === '/search/jql') return search(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response('', { status: 404 })
  })

describe('jiraSearch', () => {
  it('posts the JQL through the cloud id and lists the issues with their status, type and assignee, the count and the next page', async () => {
    const jira = searchingJira(() => Response.json({ issues: [issue('KAZ-1'), issue('KAZ-2', { assignee: null, status: null })], nextPageToken: 'p2', isLast: false }))
    const found = await jiraSearch(CONFIG, jira.fetchFn)('search pane')
    expect(found).toEqual({
      kind: 'found',
      scope: { project: null, words: 'search pane' },
      total: 201,
      next: 'p2',
      issues: [
        { key: 'KAZ-1', summary: 'summary of KAZ-1', status: 'In Progress', statusCategory: 'indeterminate', type: 'Bug', priority: 'High', assignee: 'A Person', updated: '2026-10-27T10:00:00.000+0000' },
        { key: 'KAZ-2', summary: 'summary of KAZ-2', status: null, statusCategory: null, type: 'Bug', priority: 'High', assignee: null, updated: '2026-10-27T10:00:00.000+0000' },
      ],
    })
    const post = jira.calls.find((c) => c.url.endsWith('/search/jql'))!
    expect(post.init.method).toBe('POST')
    expect(JSON.parse(String(post.init.body))).toMatchObject({ jql: 'text ~ "search pane" ORDER BY updated DESC', maxResults: 20 })
    expect(JSON.parse(String(jira.calls.find((c) => c.url.endsWith('/approximate-count'))!.init.body))).toEqual({ jql: 'text ~ "search pane"' })
    expect((post.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('e@x:t').toString('base64')}`)
  })

  it('keeps a project key to its project, asks for the next page by its token, and reads the projects once', async () => {
    const bodies: Record<string, unknown>[] = []
    const jira = searchingJira((b) => { bodies.push(b); return Response.json({ issues: [issue('KAZ-3')], isLast: true }) })
    const search = jiraSearch(CONFIG, jira.fetchFn)
    expect(await search('kaz')).toMatchObject({ scope: { project: 'KAZ', words: null }, total: 201, next: null })
    expect(await search('KAZ search pane', 'p2')).toMatchObject({ scope: { project: 'KAZ', words: 'search pane' }, total: null })
    expect(bodies).toEqual([
      expect.objectContaining({ jql: 'project = KAZ ORDER BY updated DESC' }),
      expect.objectContaining({ jql: 'project = KAZ AND text ~ "search pane" ORDER BY updated DESC', nextPageToken: 'p2' }),
    ])
    expect(jira.calls.filter((c) => c.url.includes('/project/search'))).toHaveLength(1)
    expect(jira.calls.filter((c) => c.url.endsWith('/approximate-count'))).toHaveLength(1) // not for a next page
  })

  it('finds nothing for a key Jira does not know, nothing without asking for a query too short, and no count when Jira cannot say', async () => {
    const jira = searchingJira(() => Response.json({ errorMessages: ['An issue with key \'KAZ-999999\' does not exist'] }, { status: 400 }))
    expect(await jiraSearch(CONFIG, jira.fetchFn)('KAZ-999999')).toEqual({ kind: 'found', scope: { key: 'KAZ-999999' }, issues: [], total: 0, next: null })
    const before = jira.calls.filter((c) => c.url.endsWith('/search/jql')).length
    expect(await jiraSearch(CONFIG, jira.fetchFn)('a')).toMatchObject({ kind: 'found', issues: [] })
    expect(jira.calls.filter((c) => c.url.endsWith('/search/jql')).length).toBe(before)
    const uncounted = searchingJira(() => Response.json({ issues: [issue('KAZ-1')] }), () => new Response('', { status: 403 }))
    expect(await jiraSearch(CONFIG, uncounted.fetchFn)('search pane')).toMatchObject({ kind: 'found', total: null })
  })

  it('says Jira is unavailable when it fails, cannot be reached or has no credentials', async () => {
    expect(await jiraSearch(CONFIG, searchingJira(() => new Response('', { status: 500 })).fetchFn)('search pane')).toEqual({ kind: 'unavailable', error: 'Jira answered 500' })
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
