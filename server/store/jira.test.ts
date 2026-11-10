import { describe, expect, it } from 'vitest'
import {
  jiraConfig,
  jiraLookup,
  jiraSearch,
  jiraSiteUrl,
  jiraStatuses,
  scopeJql,
  scopeWhere,
  searchScope,
  splitJql,
  type JiraConfig,
} from './jira.ts'

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
    summary: `summary of ${key}`,
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    assignee: { displayName: 'A Person' },
    updated: '2026-10-27T10:00:00.000+0000',
    ...over,
  },
})

const PROJECTS = new Set(['KAZ', 'RPG'])

describe('searchScope', () => {
  it("reads a key as that ticket, a project key first as that project, and the rest as words without Jira's text syntax", () => {
    expect(searchScope(' kaz-7785 ', PROJECTS)).toEqual({ key: 'KAZ-7785' })
    expect(searchScope('KAZ', PROJECTS)).toEqual({ project: 'KAZ', words: null })
    expect(searchScope('rpg search pane', PROJECTS)).toEqual({ project: 'RPG', words: 'search pane' })
    expect(searchScope('search pane', PROJECTS)).toEqual({ project: null, words: 'search pane' })
    expect(searchScope('DM', PROJECTS)).toEqual({ project: null, words: 'DM' })
    expect(searchScope('can\'t "search" (ranges) a-b*', PROJECTS)).toEqual({ project: null, words: "can't search ranges a b" })
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

describe("the operator's JQL", () => {
  it('splits off its ORDER BY, but not one inside a quoted string', () => {
    expect(splitJql('project = KAZ AND status = "To Do" order by created ASC')).toEqual({
      where: 'project = KAZ AND status = "To Do"',
      orderBy: 'created ASC',
    })
    expect(splitJql('summary ~ "sort order by date"')).toEqual({ where: 'summary ~ "sort order by date"', orderBy: null })
    expect(splitJql("summary ~ 'a \\' order by b'")).toEqual({ where: "summary ~ 'a \\' order by b'", orderBy: null })
    expect(splitJql('ORDER BY priority DESC')).toEqual({ where: null, orderBy: 'priority DESC' })
  })

  it('searches what was typed within it, bracketed, in its own order when it has one', () => {
    const jql = 'labels = pipeline OR assignee = currentUser() ORDER BY priority DESC'
    expect(searchScope('', PROJECTS, jql)).toEqual({
      project: null,
      words: null,
      jql: 'labels = pipeline OR assignee = currentUser()',
      orderBy: 'priority DESC',
    })
    expect(searchScope('kaz-7', PROJECTS, 'status = Open')).toEqual({ key: 'KAZ-7', jql: 'status = Open' })
    const words = searchScope('KAZ search pane', PROJECTS, jql)!
    expect(scopeJql(words)).toBe(
      '(labels = pipeline OR assignee = currentUser()) AND project = KAZ AND text ~ "search pane" ORDER BY priority DESC',
    )
    expect(scopeWhere(words)).toBe('(labels = pipeline OR assignee = currentUser()) AND project = KAZ AND text ~ "search pane"')
    expect(scopeJql(searchScope('', PROJECTS, 'status = Open')!)).toBe('(status = Open) ORDER BY updated DESC')
    expect(scopeJql(searchScope('KAZ-7', PROJECTS, 'status = Open')!)).toBe('(status = Open) AND key = KAZ-7')
  })
})

/** A Jira with the projects KAZ and RPG, a count of 201, `search` answering /search/jql, and a strict parse finding `problems` in any JQL. */
const searchingJira = (
  search: (body: Record<string, unknown>) => Response,
  count: () => Response = () => Response.json({ count: 201 }),
  problems: string[] = [],
) =>
  fakeJira((p, init) => {
    if (p.startsWith('/project/search')) return Response.json({ values: [{ key: 'KAZ' }, { key: 'RPG' }] })
    if (p === '/search/approximate-count') return count()
    if (p === '/jql/parse?validation=strict')
      return Response.json({
        queries: (JSON.parse(String(init.body)) as { queries: string[] }).queries.map((query) => ({ query, errors: problems })),
      })
    if (p === '/search/jql') return search(JSON.parse(String(init.body)) as Record<string, unknown>)
    return new Response('', { status: 404 })
  })

describe('jiraSearch', () => {
  it('posts the JQL through the cloud id and lists the issues with their status, type and assignee, the count and the next page', async () => {
    const jira = searchingJira(() =>
      Response.json({ issues: [issue('KAZ-1'), issue('KAZ-2', { assignee: null, status: null })], nextPageToken: 'p2', isLast: false }),
    )
    const found = await jiraSearch(CONFIG, jira.fetchFn)('search pane')
    expect(found).toEqual({
      kind: 'found',
      scope: { project: null, words: 'search pane' },
      total: 201,
      next: 'p2',
      issues: [
        {
          key: 'KAZ-1',
          summary: 'summary of KAZ-1',
          labels: [],
          status: 'In Progress',
          statusCategory: 'indeterminate',
          type: 'Bug',
          priority: 'High',
          assignee: 'A Person',
          updated: '2026-10-27T10:00:00.000+0000',
        },
        {
          key: 'KAZ-2',
          summary: 'summary of KAZ-2',
          labels: [],
          status: null,
          statusCategory: null,
          type: 'Bug',
          priority: 'High',
          assignee: null,
          updated: '2026-10-27T10:00:00.000+0000',
        },
      ],
    })
    const post = jira.calls.find((c) => c.url.endsWith('/search/jql'))!
    expect(post.init.method).toBe('POST')
    expect(JSON.parse(String(post.init.body))).toMatchObject({ jql: 'text ~ "search pane" ORDER BY updated DESC', maxResults: 20 })
    expect(JSON.parse(String(jira.calls.find((c) => c.url.endsWith('/approximate-count'))!.init.body))).toEqual({
      jql: 'text ~ "search pane"',
    })
    expect((post.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('e@x:t').toString('base64')}`)
  })

  it('keeps a project key to its project, asks for the next page by its token, and reads the projects once', async () => {
    const bodies: Record<string, unknown>[] = []
    const jira = searchingJira((b) => {
      bodies.push(b)
      return Response.json({ issues: [issue('KAZ-3')], isLast: true })
    })
    const search = jiraSearch(CONFIG, jira.fetchFn)
    expect(await search('kaz')).toMatchObject({ scope: { project: 'KAZ', words: null }, total: 201, next: null })
    expect(await search('KAZ search pane', { next: 'p2' })).toMatchObject({ scope: { project: 'KAZ', words: 'search pane' }, total: null })
    expect(bodies).toEqual([
      expect.objectContaining({ jql: 'project = KAZ ORDER BY updated DESC' }),
      expect.objectContaining({ jql: 'project = KAZ AND text ~ "search pane" ORDER BY updated DESC', nextPageToken: 'p2' }),
    ])
    expect(jira.calls.filter((c) => c.url.includes('/project/search'))).toHaveLength(1)
    expect(jira.calls.filter((c) => c.url.endsWith('/approximate-count'))).toHaveLength(1) // not for a next page
  })

  it('finds nothing for a key Jira does not know, nothing without asking for a query too short, and no count when Jira cannot say', async () => {
    const jira = searchingJira(() => Response.json({ errorMessages: ["An issue with key 'KAZ-999999' does not exist"] }, { status: 400 }))
    expect(await jiraSearch(CONFIG, jira.fetchFn)('KAZ-999999')).toEqual({
      kind: 'found',
      scope: { key: 'KAZ-999999' },
      issues: [],
      total: 0,
      next: null,
    })
    const before = jira.calls.filter((c) => c.url.endsWith('/search/jql')).length
    expect(await jiraSearch(CONFIG, jira.fetchFn)('a')).toMatchObject({ kind: 'found', issues: [] })
    expect(jira.calls.filter((c) => c.url.endsWith('/search/jql')).length).toBe(before)
    const uncounted = searchingJira(
      () => Response.json({ issues: [issue('KAZ-1')] }),
      () => new Response('', { status: 403 }),
    )
    expect(await jiraSearch(CONFIG, uncounted.fetchFn)('search pane')).toMatchObject({ kind: 'found', total: null })
  })

  it('lists everything the JQL finds for an empty query, and searches the typed words within it', async () => {
    const bodies: Record<string, unknown>[] = []
    const counted: unknown[] = []
    const jira = searchingJira(
      (b) => {
        bodies.push(b)
        return Response.json({ issues: [issue('KAZ-5')], isLast: true })
      },
      () => Response.json({ count: 42 }),
    )
    jira.calls.length = 0
    const search = jiraSearch(CONFIG, jira.fetchFn)
    expect(await search('', { jql: ' status = Open ' })).toMatchObject({
      kind: 'found',
      scope: { project: null, words: null, jql: 'status = Open' },
      total: 42,
    })
    await search('search pane', { jql: 'status = Open ORDER BY created' })
    expect(bodies.map((b) => b.jql)).toEqual([
      '(status = Open) ORDER BY updated DESC',
      '(status = Open) AND text ~ "search pane" ORDER BY created',
    ])
    for (const c of jira.calls.filter((c) => c.url.endsWith('/approximate-count'))) counted.push(JSON.parse(String(c.init.body)).jql)
    expect(counted).toEqual(['(status = Open)', '(status = Open) AND text ~ "search pane"'])
    expect(await search('', { jql: '   ' })).toEqual({ kind: 'found', scope: null, issues: [], total: 0, next: null })
  })

  it("says the JQL is invalid with Jira's own words, and tells a key outside the JQL from a JQL Jira refuses", async () => {
    const refusing = searchingJira(() =>
      Response.json({ errorMessages: ["Field 'stauts' does not exist or you do not have permission to view it."] }, { status: 400 }),
    )
    expect(await jiraSearch(CONFIG, refusing.fetchFn)('', { jql: 'stauts = Open' })).toEqual({
      kind: 'invalid',
      error: "Field 'stauts' does not exist or you do not have permission to view it.",
    })
    expect(await jiraSearch(CONFIG, refusing.fetchFn)('KAZ-1', { jql: 'stauts = Open' })).toMatchObject({ kind: 'invalid' })
    const unknownKey = searchingJira(() =>
      Response.json({ errorMessages: ["An issue with key 'KAZ-999999' does not exist for field 'key'."] }, { status: 400 }),
    )
    expect(await jiraSearch(CONFIG, unknownKey.fetchFn)('kaz-999999', { jql: 'status = Open' })).toMatchObject({
      kind: 'found',
      issues: [],
      total: 0,
    })
    const bare = searchingJira(() => new Response('', { status: 400 }))
    expect(await jiraSearch(CONFIG, bare.fetchFn)('', { jql: 'ORDER BY created' })).toEqual({
      kind: 'invalid',
      error: 'Jira refused the JQL',
    })
  })

  it("names a field or a value Jira does not know when a JQL finds nothing, as Jira's strict parse says", async () => {
    const empty = () => Response.json({ issues: [], isLast: true })
    const typo = searchingJira(empty, undefined, ["Field 'stauts' does not exist or you do not have permission to view it."])
    expect(await jiraSearch(CONFIG, typo.fetchFn)('', { jql: 'stauts = Open ORDER BY created' })).toEqual({
      kind: 'invalid',
      error: "Field 'stauts' does not exist or you do not have permission to view it.",
    })
    expect(JSON.parse(String(typo.calls.find((c) => c.url.endsWith('/jql/parse?validation=strict'))!.init.body))).toEqual({
      queries: ['stauts = Open'],
    })
    const sound = searchingJira(empty)
    expect(await jiraSearch(CONFIG, sound.fetchFn)('search pane', { jql: 'status = Open' })).toMatchObject({
      kind: 'found',
      issues: [],
      total: 201,
    })
    const found = searchingJira(() => Response.json({ issues: [issue('KAZ-1')], isLast: true }))
    await jiraSearch(CONFIG, found.fetchFn)('', { jql: 'status = Open' })
    await jiraSearch(CONFIG, found.fetchFn)('search pane')
    expect(found.calls.filter((c) => c.url.includes('/jql/parse'))).toHaveLength(0)
  })

  it('says Jira is unavailable when it fails, cannot be reached or has no credentials', async () => {
    expect(await jiraSearch(CONFIG, searchingJira(() => new Response('', { status: 500 })).fetchFn)('search pane')).toEqual({
      kind: 'unavailable',
      error: 'Jira answered 500',
    })
    expect(
      await jiraSearch(
        CONFIG,
        fakeJira(() => {
          throw new Error('ECONNRESET')
        }).fetchFn,
      )('search pane'),
    ).toEqual({ kind: 'unavailable', error: 'ECONNRESET' })
    expect(await jiraSearch(null)('search pane')).toEqual({
      kind: 'unavailable',
      error: 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not all set',
    })
  })
})

describe('jiraLookup', () => {
  it('reads the summary, refuses a key Jira does not know, and reports an outage', async () => {
    const jira = fakeJira((p) =>
      p.startsWith('/issue/KAZ-1?') ? Response.json({ fields: { summary: 'one' } }) : new Response('', { status: 404 }),
    )
    const lookup = jiraLookup(CONFIG, jira.fetchFn)
    expect(await lookup('KAZ-1')).toEqual({ kind: 'found', summary: 'one', labels: [] })
    expect(await lookup('KAZ-2')).toEqual({ kind: 'not-found' })
    expect(await jiraLookup(CONFIG, fakeJira(() => new Response('', { status: 503 })).fetchFn)('KAZ-1')).toEqual({
      kind: 'unavailable',
      error: 'Jira answered 503',
    })
  })
})

describe('jiraConfig', () => {
  const creds = { JIRA_EMAIL: 'e@x', JIRA_API_TOKEN: 't' }

  it('takes the site from JIRA_BASE_URL, without a trailing slash, and has no default', () => {
    expect(jiraSiteUrl({ JIRA_BASE_URL: ' https://site.example/ ' })).toBe('https://site.example')
    expect(jiraSiteUrl({})).toBeNull()
    expect(jiraSiteUrl({ JIRA_BASE_URL: 'site.atlassian.net' })).toBeNull()
    expect(jiraSiteUrl({ JIRA_BASE_URL: 'ftp://site.example' })).toBeNull()
    expect(jiraConfig({ ...creds, JIRA_BASE_URL: 'https://site.example/' })).toEqual({
      siteUrl: 'https://site.example',
      email: 'e@x',
      token: 't',
      cloudId: undefined,
    })
  })

  it('is off without the site or without the credentials', () => {
    expect(jiraConfig(creds)).toBeNull()
    expect(jiraConfig({ JIRA_BASE_URL: 'https://site.example', JIRA_EMAIL: 'e@x' })).toBeNull()
  })
})

describe('jiraStatuses', () => {
  it('reads the statuses in bulk, 100 keys a call, leaves out a key Jira does not know, and dates Done only in the done category', async () => {
    const keys = Array.from({ length: 101 }, (_, i) => `KAZ-${i + 1}`)
    const jira = fakeJira((p, init) => {
      const asked = JSON.parse(String(init.body)) as { issueIdsOrKeys: string[] }
      expect(p).toBe('/issue/bulkfetch')
      return Response.json({
        issues: asked.issueIdsOrKeys
          .filter((k) => k !== 'KAZ-2')
          .map((k) => ({
            key: k,
            fields: {
              status:
                k === 'KAZ-1'
                  ? { name: 'Done', statusCategory: { key: 'done' } }
                  : { name: 'Ready To Test', statusCategory: { key: 'new' } },
              statuscategorychangedate: '2026-10-22T14:22:11.559+0300',
            },
          })),
        issueErrors: [],
      })
    })
    const found = await jiraStatuses(CONFIG, jira.fetchFn)(keys)
    expect(jira.calls.filter((c) => c.url.includes('bulkfetch')).length).toBe(2)
    expect(found.kind === 'found' && found.tickets.length).toBe(100)
    expect(found.kind === 'found' && found.tickets.slice(0, 2)).toEqual([
      { key: 'KAZ-1', summary: null, status: 'Done', statusCategory: 'done', doneAt: '2026-10-22T11:22:11.559Z', moves: [] },
      { key: 'KAZ-3', summary: null, status: 'Ready To Test', statusCategory: 'new', doneAt: null, moves: [] },
    ])
  })

  it('reads the status moves from the expanded changelog, oldest first, and a long changelog by its own pages', async () => {
    const move = (created: string, to: string) => ({
      created,
      items: [
        { field: 'assignee', toString: 'Someone' },
        { field: 'status', toString: to },
      ],
    })
    const jira = fakeJira((p, init) => {
      if (p === '/issue/bulkfetch') {
        expect(JSON.parse(String(init.body)).expand).toEqual(['changelog'])
        return Response.json({
          issues: [
            // Newest first, as bulkfetch gives them.
            {
              key: 'KAZ-1',
              fields: { status: { name: 'Done', statusCategory: { key: 'done' } } },
              changelog: {
                total: 2,
                histories: [move('2026-10-23T10:00:00.000+0300', 'Done'), move('2026-10-22T10:00:00.000+0300', 'Failed')],
              },
            },
            {
              key: 'KAZ-2',
              fields: { status: { name: 'Testing', statusCategory: { key: 'indeterminate' } } },
              changelog: { total: 3, histories: [move('2026-10-23T10:00:00.000Z', 'Testing')] },
            },
          ],
        })
      }
      expect(p.startsWith('/issue/KAZ-2/changelog?startAt=')).toBe(true)
      return p.includes('startAt=0')
        ? Response.json({
            values: [move('2026-10-20T10:00:00.000Z', 'In Progress'), move('2026-10-21T10:00:00.000Z', 'Failed')],
            isLast: false,
          })
        : Response.json({ values: [move('2026-10-23T10:00:00.000Z', 'Testing')], isLast: true })
    })
    const found = await jiraStatuses(CONFIG, jira.fetchFn)(['KAZ-1', 'KAZ-2'])
    expect(found.kind === 'found' && found.tickets.map((t) => [t.key, t.moves])).toEqual([
      [
        'KAZ-1',
        [
          { at: '2026-10-22T07:00:00.000Z', to: 'Failed' },
          { at: '2026-10-23T07:00:00.000Z', to: 'Done' },
        ],
      ],
      [
        'KAZ-2',
        [
          { at: '2026-10-20T10:00:00.000Z', to: 'In Progress' },
          { at: '2026-10-21T10:00:00.000Z', to: 'Failed' },
          { at: '2026-10-23T10:00:00.000Z', to: 'Testing' },
        ],
      ],
    ])
  })

  it('says Jira is unavailable when it answers an error or is not set up', async () => {
    expect(await jiraStatuses(CONFIG, fakeJira(() => new Response('', { status: 403 })).fetchFn)(['KAZ-1'])).toEqual({
      kind: 'unavailable',
      error: 'Jira answered 403',
    })
    expect((await jiraStatuses(null)(['KAZ-1'])).kind).toBe('unavailable')
  })
})
