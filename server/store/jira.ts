// Jira Cloud's REST API on the site JIRA_BASE_URL names, with the same JIRA_EMAIL and
// JIRA_API_TOKEN the pipeline's MCP server uses: a ticket's summary when it is queued, and the
// console's ticket search, optionally within the operator's own JQL. The token is a
// scoped API token, which Jira accepts only through api.atlassian.com with the site's cloud id
// (the MCP server does the same); the id comes from the site's /_edge/tenant_info, or
// JIRA_CLOUD_ID. Read only: nothing is written to Jira. Never throws: a Jira that cannot be
// reached is `unavailable`.
import type { Lookup } from './queue.ts'

export type JiraConfig = { siteUrl: string; email: string; token: string; cloudId?: string | undefined }
/** The JIRA_* settings as the environment (or config.ts's parsed schema) gives them. */
export type JiraEnv = {
  JIRA_BASE_URL?: string | undefined
  JIRA_EMAIL?: string | undefined
  JIRA_API_TOKEN?: string | undefined
  JIRA_CLOUD_ID?: string | undefined
}

/** A ticket as the search lists it. */
export type JiraIssue = {
  key: string
  summary: string
  labels: string[]
  status: string | null
  /** new, indeterminate or done: Jira's status category, for the pill's colour. */
  statusCategory: string | null
  type: string | null
  priority: string | null
  assignee: string | null
  updated: string | null
}

/**
 * What was typed, as the search reads it: one ticket, or words, in one project or in all; with
 * `jql`, only among the tickets that JQL finds (its ORDER BY, if any, in `orderBy`).
 */
export type SearchScope = ({ key: string } | { project: string | null; words: string | null }) & { jql?: string; orderBy?: string }

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
  /** Jira refused the operator's JQL; `error` is what it said. */
  | { kind: 'invalid'; error: string }
  | { kind: 'unavailable'; error: string }

const TIMEOUT_MS = 10_000
const SEARCH_LIMIT = 20
const SEARCH_FIELDS = ['summary', 'labels', 'status', 'issuetype', 'priority', 'assignee', 'updated']
/** How long the list of project keys is kept before it is read again. */
const PROJECTS_MAX_AGE_MS = 60 * 60 * 1000
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/
/** What Jira's text search treats as syntax; a query is searched for as words. */
const TEXT_SYNTAX = /[+\-&|!(){}[\]^~*?\\:"/]/g

/** What jiraConfig needs from the environment, named for the messages that say it is missing. */
export const JIRA_SETTINGS = 'JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN'

/** The Jira site (JIRA_BASE_URL) without its trailing slash; null when it is not set, or is not
 *  an http(s) URL (a bare host would make every ticket link relative and every call fail). */
export function jiraSiteUrl(env: JiraEnv): string | null {
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
export function jiraConfig(env: JiraEnv): JiraConfig | null {
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
    return fetchFn(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }
  return async (apiPath, init) => {
    if (!config) return `${JIRA_SETTINGS} are not all set`
    try {
      if (!cloudId) {
        const res = await request(`${config.siteUrl}/_edge/tenant_info`, false)
        if (!res.ok) return `the site's tenant info answered ${res.status}`
        const info = (await res.json()) as { cloudId?: unknown }
        if (typeof info.cloudId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(info.cloudId))
          return 'no cloud id in the tenant info; set JIRA_CLOUD_ID'
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
    const res = await call(`/issue/${encodeURIComponent(key)}?fields=summary,labels`)
    if (typeof res === 'string') return { kind: 'unavailable', error: res }
    if (res.status === 404) return { kind: 'not-found' }
    if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
    try {
      const body = (await res.json()) as { fields?: { summary?: unknown; labels?: unknown } }
      const summary = body.fields?.summary
      return typeof summary === 'string'
        ? { kind: 'found', summary, labels: labelsOf(body.fields?.labels) }
        : { kind: 'unavailable', error: 'no summary in the answer' }
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * What was typed, read against Jira's project keys: a ticket key is that ticket; a project key
 * first (`KAZ`, `kaz search pane`) keeps the search to that project, with the words after it if
 * any; anything else is words searched in every project. With a JQL, all of it is searched
 * within what the JQL finds, and an empty query lists that. Null when there is nothing to search.
 */
export function searchScope(query: string, projects: ReadonlySet<string>, jql?: string): SearchScope | null {
  const q = query.trim()
  const own = jql ? splitJql(jql) : null
  const within = own ? { jql: own.where ?? '', ...(own.orderBy ? { orderBy: own.orderBy } : {}) } : {}
  if (KEY.test(q)) return { key: q.toUpperCase(), ...within }
  const [first = '', ...rest] = q.split(/\s+/)
  const project = projects.has(first.toUpperCase()) ? first.toUpperCase() : null
  const text = (project ? rest.join(' ') : q).replace(TEXT_SYNTAX, ' ').replace(/\s+/g, ' ').trim()
  const words = text.length >= 2 ? text : null
  if (!project && !words && !own) return null
  return { project, words, ...within }
}

/**
 * The operator's JQL as its condition and its ORDER BY, each null when it has none. ORDER BY is
 * found outside quoted strings only, so `summary ~ "order by"` stays a condition.
 */
export function splitJql(jql: string): { where: string | null; orderBy: string | null } {
  // Quoted text blanked out to the same length, so an index found here is the same in `jql`.
  const bare = jql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length))
  const at = bare.search(/(?:^|\s)order\s+by\s/i)
  const where = (at === -1 ? jql : jql.slice(0, at)).trim()
  const orderBy =
    at === -1
      ? ''
      : jql
          .slice(at)
          .trim()
          .replace(/^order\s+by\s+/i, '')
          .trim()
  return { where: where || null, orderBy: orderBy || null }
}

/** The JQL's condition for a scope, without its order; the operator's JQL bracketed, so its OR stays inside. */
export function scopeWhere(scope: SearchScope): string {
  const own = scope.jql ? `(${scope.jql})` : null
  const where =
    'key' in scope
      ? [own, `key = ${scope.key}`]
      : [own, scope.project ? `project = ${scope.project}` : null, scope.words ? `text ~ "${scope.words}"` : null]
  return where.filter(Boolean).join(' AND ')
}

/** The JQL for a scope: in the operator's JQL's order if it has one, the most recently updated first otherwise. */
export function scopeJql(scope: SearchScope): string {
  if ('key' in scope) return scopeWhere(scope)
  return `${scopeWhere(scope)} ORDER BY ${scope.orderBy ?? 'updated DESC'}`.trim()
}

/** What a search asks besides the typed query: the operator's JQL to search within, and the next page's token. */
export type SearchOptions = { jql?: string | undefined; next?: string | undefined }

export function jiraSearch(
  config: JiraConfig | null,
  fetchFn: typeof fetch = fetch,
): (query: string, options?: SearchOptions) => Promise<JiraSearch> {
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
  const count = async (where: string): Promise<number | null> => {
    const res = await call('/search/approximate-count', { method: 'POST', body: { jql: where } })
    if (typeof res === 'string' || !res.ok) return null
    try {
      const body = (await res.json()) as { count?: unknown }
      return typeof body.count === 'number' ? body.count : null
    } catch {
      return null
    }
  }
  // Jira's search takes a field or a value it does not know as a condition nothing meets; its
  // strict parse names them. Asked only when a JQL found nothing, so a typo is not "nothing found".
  const jqlProblems = async (jql: string): Promise<string[]> => {
    const res = await call('/jql/parse?validation=strict', { method: 'POST', body: { queries: [jql] } })
    if (typeof res === 'string' || !res.ok) return []
    try {
      const body = (await res.json()) as { queries?: { errors?: unknown }[] }
      const errors = body.queries?.[0]?.errors
      return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === 'string') : []
    } catch {
      return []
    }
  }
  return async (query, { jql, next } = {}) => {
    const scope = searchScope(query, await projectKeys(), jql?.trim() || undefined)
    if (!scope) return { kind: 'found', scope: null, issues: [], total: 0, next: null }
    const body: Record<string, unknown> = { jql: scopeJql(scope), fields: SEARCH_FIELDS, maxResults: SEARCH_LIMIT }
    if (next) body.nextPageToken = next
    const [res, total] = await Promise.all([
      call('/search/jql', { method: 'POST', body }),
      'key' in scope || next ? Promise.resolve(null) : count(scopeWhere(scope)),
    ])
    if (typeof res === 'string') return { kind: 'unavailable', error: res }
    if (res.status === 400) {
      const said = await errorsOf(res)
      // A key Jira does not know is a 400 for `key = ...`: nothing found, not an outage. With the
      // operator's JQL the 400 may be the JQL's: only a message naming the key is the key's.
      if ('key' in scope && (!scope.jql || said.some((m) => m.toUpperCase().includes(scope.key))))
        return { kind: 'found', scope, issues: [], total: 0, next: null }
      if (scope.jql !== undefined) return { kind: 'invalid', error: said.join(' ') || 'Jira refused the JQL' }
    }
    if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
    try {
      const page = (await res.json()) as { issues?: unknown; nextPageToken?: unknown; isLast?: unknown }
      const issues = Array.isArray(page.issues) ? page.issues.map(issueOf).filter((i): i is JiraIssue => i !== null) : []
      const token = typeof page.nextPageToken === 'string' && page.isLast !== true ? page.nextPageToken : null
      if (scope.jql && !next && !issues.length) {
        const problems = await jqlProblems(scope.jql)
        if (problems.length) return { kind: 'invalid', error: problems.join(' ') }
      }
      return { kind: 'found', scope, issues, total: 'key' in scope ? issues.length : total, next: token }
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** Jira's error messages in a refusal: `errorMessages`, then the per-field `errors`. */
async function errorsOf(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as { errorMessages?: unknown; errors?: unknown }
    const listed = Array.isArray(body.errorMessages) ? body.errorMessages : []
    const fields = body.errors && typeof body.errors === 'object' ? Object.values(body.errors) : []
    return [...listed, ...fields].filter((m): m is string => typeof m === 'string' && m.length > 0)
  } catch {
    return []
  }
}

/** The labels as Jira lists them; none when the field is missing or not a list. */
function labelsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : []
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
    labels: labelsOf(f.labels),
    status: name(status),
    statusCategory: name(status?.statusCategory, 'key'),
    type: name(f.issuetype),
    priority: name(f.priority),
    assignee: name(f.assignee, 'displayName'),
    updated: typeof f.updated === 'string' ? f.updated : null,
  }
}

/** A ticket's place in its workflow, for the statistics: its summary, its status, the status's category, and when it last entered Done. */
export type TicketStatus = {
  key: string
  summary: string | null
  status: string | null
  /** new, indeterminate or done: Jira's status category. */
  statusCategory: string | null
  /** When the ticket last moved into the done category; null while it is not there. */
  doneAt: string | null
  /** Every move into a status, oldest first, from the changelog: what the statistics read a
   *  ticket's path after the merge from (into Failed, back to Done). */
  moves: StatusMove[]
}

export type StatusMove = { at: string; to: string }

export type JiraStatuses = { kind: 'found'; tickets: TicketStatus[] } | { kind: 'unavailable'; error: string }

const BULK_LIMIT = 100

type History = { created?: unknown; items?: { field?: unknown; toString?: unknown }[] }

/** The status moves in a page of changelog histories. */
function movesOf(histories: History[]): StatusMove[] {
  return histories.flatMap((h) => {
    const at = typeof h.created === 'string' ? Date.parse(h.created) : NaN
    if (Number.isNaN(at)) return []
    return (h.items ?? []).flatMap((it) =>
      it.field === 'status' && typeof it.toString === 'string' ? [{ at: new Date(at).toISOString(), to: it.toString }] : [],
    )
  })
}

const byTime = (a: StatusMove, b: StatusMove) => a.at.localeCompare(b.at)

/**
 * The statuses of `keys`, 100 at a time through /issue/bulkfetch with the changelog expanded: a
 * key Jira does not know is left out, not an error (a JQL `key in (...)` would refuse the whole
 * query for it). Bulkfetch gives only the latest 40 or so histories; a ticket with more has its
 * whole changelog read by its own pages.
 */
export function jiraStatuses(config: JiraConfig | null, fetchFn: typeof fetch = fetch): (keys: string[]) => Promise<JiraStatuses> {
  const call = jiraClient(config, fetchFn)
  const fullChangelog = async (key: string): Promise<StatusMove[] | string> => {
    const moves: StatusMove[] = []
    for (let start = 0, page = 0; page < 20; page += 1) {
      const res = await call(`/issue/${encodeURIComponent(key)}/changelog?startAt=${start}&maxResults=100`)
      if (typeof res === 'string') return res
      if (!res.ok) return `Jira answered ${res.status} for ${key}'s changelog`
      const body = (await res.json()) as { values?: History[]; isLast?: unknown }
      const values = body.values ?? []
      moves.push(...movesOf(values))
      start += values.length
      if (body.isLast !== false || !values.length) break
    }
    return moves
  }
  return async (keys) => {
    const tickets: TicketStatus[] = []
    for (let i = 0; i < keys.length; i += BULK_LIMIT) {
      const res = await call('/issue/bulkfetch', {
        method: 'POST',
        body: {
          issueIdsOrKeys: keys.slice(i, i + BULK_LIMIT),
          fields: ['summary', 'status', 'statuscategorychangedate'],
          expand: ['changelog'],
        },
      })
      if (typeof res === 'string') return { kind: 'unavailable', error: res }
      if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
      try {
        const body = (await res.json()) as {
          issues?: {
            key?: unknown
            changelog?: { total?: unknown; histories?: History[] }
            fields?: {
              summary?: unknown
              status?: { name?: unknown; statusCategory?: { key?: unknown } }
              statuscategorychangedate?: unknown
            }
          }[]
        }
        for (const issue of body.issues ?? []) {
          if (typeof issue.key !== 'string') continue
          const status = issue.fields?.status
          const category = typeof status?.statusCategory?.key === 'string' ? status.statusCategory.key : null
          const changed = issue.fields?.statuscategorychangedate
          const at = typeof changed === 'string' ? Date.parse(changed) : NaN
          const histories = issue.changelog?.histories ?? []
          let moves = movesOf(histories)
          if (typeof issue.changelog?.total === 'number' && issue.changelog.total > histories.length) {
            const full = await fullChangelog(issue.key)
            if (typeof full === 'string') return { kind: 'unavailable', error: full }
            moves = full
          }
          tickets.push({
            key: issue.key,
            summary: typeof issue.fields?.summary === 'string' ? issue.fields.summary : null,
            status: typeof status?.name === 'string' ? status.name : null,
            statusCategory: category,
            doneAt: category === 'done' && !Number.isNaN(at) ? new Date(at).toISOString() : null,
            moves: moves.sort(byTime),
          })
        }
      } catch (error) {
        return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
      }
    }
    return { kind: 'found', tickets }
  }
}
