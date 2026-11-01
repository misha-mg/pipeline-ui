// Jira Cloud's REST API on the site JIRA_BASE_URL names, with the same JIRA_EMAIL and
// JIRA_API_TOKEN the pipeline's MCP server uses: a ticket's summary when it is queued, and the console's ticket search. The token is a
// scoped API token, which Jira accepts only through api.atlassian.com with the site's cloud id
// (the MCP server does the same); the id comes from the site's /_edge/tenant_info, or
// JIRA_CLOUD_ID. Read only: nothing is written to Jira. Never throws: a Jira that cannot be
// reached is `unavailable`.
import type { Lookup } from './queue.ts'

export type JiraConfig = { siteUrl: string; email: string; token: string; cloudId?: string }

/** A ticket as the search lists it. */
export type JiraIssue = {
  key: string
  summary: string
  status: string | null
  /** new, indeterminate or done: Jira's status category, for the pill's colour. */
  statusCategory: string | null
  type: string | null
  priority: string | null
  assignee: string | null
  updated: string | null
}

/** What was typed, as the search reads it: one ticket, or words, in one project or in all. */
export type SearchScope = { key: string } | { project: string | null; words: string | null }

export type JiraSearch =
  | {
      kind: 'found'
      scope: SearchScope | null
      issues: JiraIssue[]
      /** How many tickets match, as Jira counts them; null when it could not say. */
      total: number | null
      /** The token for the next page; null on the last one. */
      next: string | null
    }
  | { kind: 'unavailable'; error: string }

const TIMEOUT_MS = 10_000
const SEARCH_LIMIT = 20
const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated']
/** How long the list of project keys is kept before it is read again. */
const PROJECTS_MAX_AGE_MS = 60 * 60 * 1000
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/
/** What Jira's text search treats as syntax; a query is searched for as words. */
const TEXT_SYNTAX = /[+\-&|!(){}[\]^~*?\\:"/]/g

/** What jiraConfig needs from the environment, named for the messages that say it is missing. */
export const JIRA_SETTINGS = 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN'

/** The Jira site (JIRA_BASE_URL) without its trailing slash; null when it is not set, or is not
 *  an http(s) URL (a bare host would make every ticket link relative and every call fail). */
export function jiraSiteUrl(env: Record<string, string | undefined>): string | null {
  const site = env.JIRA_BASE_URL?.trim().replace(/\/+$/, '')
  if (!site) return null
  try {
    const { protocol } = new URL(site)
    return protocol === 'https:' || protocol === 'http:' ? site : null
  } catch {
    return null
  }
}

/** The Jira config from the environment; null when the site or the credentials are not there. */
export function jiraConfig(env: Record<string, string | undefined>): JiraConfig | null {
  const siteUrl = jiraSiteUrl(env)
  const email = env.JIRA_EMAIL
  const token = env.JIRA_API_TOKEN
  if (!siteUrl || !email || !token) return null
  return { siteUrl, email, token, cloudId: env.JIRA_CLOUD_ID || undefined }
}

type Call = (path: string, init?: { method?: string; body?: unknown }) => Promise<Response | string>

/** Calls Jira's REST API v3 by the site's cloud id; resolves with the response, or with why it could not. */
function jiraClient(config: JiraConfig | null, fetchFn: typeof fetch): Call {
  let cloudId: string | undefined = config?.cloudId
  const request = (url: string, authenticated: boolean, init: { method?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (authenticated && config) headers.Authorization = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    return fetchFn(url, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(TIMEOUT_MS) })
  }
  return async (apiPath, init) => {
    if (!config) return `${JIRA_SETTINGS} are not all set`
    try {
      if (!cloudId) {
        const res = await request(`${config.siteUrl}/_edge/tenant_info`, false)
        if (!res.ok) return `the site's tenant info answered ${res.status}`
        const info = (await res.json()) as { cloudId?: unknown }
        if (typeof info.cloudId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(info.cloudId)) return 'no cloud id in the tenant info; set JIRA_CLOUD_ID'
        cloudId = info.cloudId
      }
      return await request(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${apiPath}`, true, init)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

export function jiraLookup(config: JiraConfig | null, fetchFn: typeof fetch = fetch): (key: string) => Promise<Lookup> {
  const call = jiraClient(config, fetchFn)
  return async (key) => {
    const res = await call(`/issue/${encodeURIComponent(key)}?fields=summary`)
    if (typeof res === 'string') return { kind: 'unavailable', error: res }
    if (res.status === 404) return { kind: 'not-found' }
    if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
    try {
      const body = (await res.json()) as { fields?: { summary?: unknown } }
      const summary = body.fields?.summary
      return typeof summary === 'string' ? { kind: 'found', summary } : { kind: 'unavailable', error: 'no summary in the answer' }
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * What was typed, read against Jira's project keys: a ticket key is that ticket; a project key
 * first (`KAZ`, `kaz search pane`) keeps the search to that project, with the words after it if
 * any; anything else is words searched in every project. Null when there is nothing to search.
 */
export function searchScope(query: string, projects: ReadonlySet<string>): SearchScope | null {
  const q = query.trim()
  if (KEY.test(q)) return { key: q.toUpperCase() }
  const [first = '', ...rest] = q.split(/\s+/)
  const project = projects.has(first.toUpperCase()) ? first.toUpperCase() : null
  const text = (project ? rest.join(' ') : q).replace(TEXT_SYNTAX, ' ').replace(/\s+/g, ' ').trim()
  const words = text.length >= 2 ? text : null
  if (!project && !words) return null
  return { project, words }
}

/** The JQL for a scope: the most recently updated first. */
export function scopeJql(scope: SearchScope): string {
  if ('key' in scope) return `key = ${scope.key}`
  const where = [scope.project ? `project = ${scope.project}` : null, scope.words ? `text ~ "${scope.words}"` : null].filter(Boolean)
  return `${where.join(' AND ')} ORDER BY updated DESC`
}

export function jiraSearch(config: JiraConfig | null, fetchFn: typeof fetch = fetch): (query: string, next?: string) => Promise<JiraSearch> {
  const call = jiraClient(config, fetchFn)
  let projects: { keys: Set<string>; at: number } | null = null
  const projectKeys = async (): Promise<Set<string>> => {
    if (projects && Date.now() - projects.at < PROJECTS_MAX_AGE_MS) return projects.keys
    const res = await call('/project/search?maxResults=100&fields=key')
    if (typeof res === 'string' || !res.ok) return projects?.keys ?? new Set()
    try {
      const body = (await res.json()) as { values?: { key?: unknown }[] }
      const keys = new Set((body.values ?? []).map((v) => v.key).filter((k): k is string => typeof k === 'string'))
      projects = { keys, at: Date.now() }
      return keys
    } catch {
      return projects?.keys ?? new Set()
    }
  }
  const count = async (jql: string): Promise<number | null> => {
    const res = await call('/search/approximate-count', { method: 'POST', body: { jql: jql.replace(/ ORDER BY .*$/, '') } })
    if (typeof res === 'string' || !res.ok) return null
    try {
      const body = (await res.json()) as { count?: unknown }
      return typeof body.count === 'number' ? body.count : null
    } catch {
      return null
    }
  }
  return async (query, next) => {
    const scope = searchScope(query, await projectKeys())
    if (!scope) return { kind: 'found', scope: null, issues: [], total: 0, next: null }
    const jql = scopeJql(scope)
    const body: Record<string, unknown> = { jql, fields: SEARCH_FIELDS, maxResults: SEARCH_LIMIT }
    if (next) body.nextPageToken = next
    const [res, total] = await Promise.all([call('/search/jql', { method: 'POST', body }), 'key' in scope || next ? Promise.resolve(null) : count(jql)])
    if (typeof res === 'string') return { kind: 'unavailable', error: res }
    // A key Jira does not know is a 400 for `key = ...`: nothing found, not an outage.
    if (res.status === 400 && 'key' in scope) return { kind: 'found', scope, issues: [], total: 0, next: null }
    if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
    try {
      const page = (await res.json()) as { issues?: unknown; nextPageToken?: unknown; isLast?: unknown }
      const issues = Array.isArray(page.issues) ? page.issues.map(issueOf).filter((i): i is JiraIssue => i !== null) : []
      const token = typeof page.nextPageToken === 'string' && page.isLast !== true ? page.nextPageToken : null
      return { kind: 'found', scope, issues, total: 'key' in scope ? issues.length : total, next: token }
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function issueOf(raw: unknown): JiraIssue | null {
  const r = raw as { key?: unknown; fields?: Record<string, unknown> }
  if (typeof r?.key !== 'string') return null
  const f = r.fields ?? {}
  const name = (v: unknown, field = 'name'): string | null => {
    const n = (v as Record<string, unknown> | null | undefined)?.[field]
    return typeof n === 'string' ? n : null
  }
  const status = f.status as { name?: unknown; statusCategory?: { key?: unknown } } | undefined
  return {
    key: r.key,
    summary: typeof f.summary === 'string' ? f.summary : '',
    status: name(status),
    statusCategory: name(status?.statusCategory, 'key'),
    type: name(f.issuetype),
    priority: name(f.priority),
    assignee: name(f.assignee, 'displayName'),
    updated: typeof f.updated === 'string' ? f.updated : null,
  }
}
