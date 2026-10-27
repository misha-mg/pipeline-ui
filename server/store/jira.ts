// A ticket's summary from Jira Cloud's REST API, with the same JIRA_EMAIL and JIRA_API_TOKEN the
// pipeline's MCP server uses. The token is a scoped API token, which Jira accepts only through
// api.atlassian.com with the site's cloud id (the MCP server does the same); the id comes from
// the site's /_edge/tenant_info, or JIRA_CLOUD_ID. Never throws: a Jira that cannot be reached
// is `unavailable`.
import type { Lookup } from './queue.ts'

export type JiraConfig = { siteUrl: string; email: string; token: string; cloudId?: string }

const DEFAULT_SITE_URL = 'https://cgstowernetworks.atlassian.net'
const TIMEOUT_MS = 10_000

/** The Jira config from the environment; null when the credentials are not there. */
export function jiraConfig(env: Record<string, string | undefined>): JiraConfig | null {
  const email = env.JIRA_EMAIL
  const token = env.JIRA_API_TOKEN
  if (!email || !token) return null
  return { siteUrl: (env.JIRA_BASE_URL ?? DEFAULT_SITE_URL).replace(/\/$/, ''), email, token, cloudId: env.JIRA_CLOUD_ID || undefined }
}

export function jiraLookup(config: JiraConfig | null, fetchFn: typeof fetch = fetch): (key: string) => Promise<Lookup> {
  let cloudId: string | undefined = config?.cloudId
  const get = (url: string, authenticated: boolean) => {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (authenticated && config) headers.Authorization = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`
    return fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
  }
  const unavailable = (error: string): Lookup => ({ kind: 'unavailable', error })
  return async (key) => {
    if (!config) return unavailable('JIRA_EMAIL and JIRA_API_TOKEN are not set')
    try {
      if (!cloudId) {
        const res = await get(`${config.siteUrl}/_edge/tenant_info`, false)
        if (!res.ok) return unavailable(`the site's tenant info answered ${res.status}`)
        const info = (await res.json()) as { cloudId?: unknown }
        if (typeof info.cloudId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(info.cloudId)) return unavailable('no cloud id in the tenant info; set JIRA_CLOUD_ID')
        cloudId = info.cloudId
      }
      const res = await get(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`, true)
      if (res.status === 404) return { kind: 'not-found' }
      if (!res.ok) return unavailable(`Jira answered ${res.status}`)
      const body = (await res.json()) as { fields?: { summary?: unknown } }
      const summary = body.fields?.summary
      return typeof summary === 'string' ? { kind: 'found', summary } : unavailable('no summary in the answer')
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error))
    }
  }
}
