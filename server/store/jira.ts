// Jira Cloud's REST API, with the same JIRA_EMAIL and JIRA_API_TOKEN the pipeline's MCP server
// uses: a ticket's summary when it is queued, and the console's ticket search. The token is a
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

export type JiraSearch = { kind: 'found'; issues: JiraIssue[] } | { kind: 'unavailable'; error: string }

const DEFAULT_SITE_URL = 'https://cgstowernetworks.atlassian.net'
const TIMEOUT_MS = 10_000
const SEARCH_LIMIT = 20
const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'priority', 'assignee', 'updated']
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/
/** What Jira's text search treats as syntax; a query is searched for as words. */
const TEXT_SYNTAX = /[+\-&|!(){}[\]^~*?\\:"/]/g

/** The Jira config from the environment; null when the credentials are not there. */
export function jiraConfig(env: Record<string, string | undefined>): JiraConfig | null {
  const email = env.JIRA_EMAIL
  const token = env.JIRA_API_TOKEN
  if (!email || !token) return null
  return { siteUrl: (env.JIRA_BASE_URL ?? DEFAULT_SITE_URL).replace(/\/$/, ''), email, token, cloudId: env.JIRA_CLOUD_ID || undefined }
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
    if (!config) return 'JIRA_EMAIL and JIRA_API_TOKEN are not set'
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
 * The JQL for what was typed: a ticket key finds that ticket, anything else is searched for as
 * words in the summary, description and comments; the most recently updated first. Null when
 * there is nothing to search for.
 */
export function searchJql(query: string): string | null {
  const q = query.trim()
  if (KEY.test(q)) return `key = ${q.toUpperCase()}`
  const words = q.replace(TEXT_SYNTAX, ' ').replace(/\s+/g, ' ').trim()
  if (words.length < 2) return null
  return `text ~ "${words}" ORDER BY updated DESC`
}

export function jiraSearch(config: JiraConfig | null, fetchFn: typeof fetch = fetch): (query: string) => Promise<JiraSearch> {
  const call = jiraClient(config, fetchFn)
  return async (query) => {
    const jql = searchJql(query)
    if (!jql) return { kind: 'found', issues: [] }
    const res = await call('/search/jql', { method: 'POST', body: { jql, fields: SEARCH_FIELDS, maxResults: SEARCH_LIMIT } })
    if (typeof res === 'string') return { kind: 'unavailable', error: res }
    // A key Jira does not know is a 400 for `key = ...`: nothing found, not an outage.
    if (res.status === 400 && jql.startsWith('key = ')) return { kind: 'found', issues: [] }
    if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
    try {
      const body = (await res.json()) as { issues?: unknown }
      return { kind: 'found', issues: Array.isArray(body.issues) ? body.issues.map(issueOf).filter((i): i is JiraIssue => i !== null) : [] }
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
