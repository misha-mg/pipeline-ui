// A ticket's summary from Jira Cloud's REST API, with the same JIRA_EMAIL and JIRA_API_TOKEN the
// pipeline's MCP server uses. Never throws: a Jira that cannot be reached is `unavailable`.
import type { Lookup } from './queue.ts'

export type JiraConfig = { baseUrl: string; email: string; token: string }

const DEFAULT_BASE_URL = 'https://cgstowernetworks.atlassian.net'
const TIMEOUT_MS = 10_000

/** The Jira config from the environment; null when the credentials are not there. */
export function jiraConfig(env: Record<string, string | undefined>): JiraConfig | null {
  const email = env.JIRA_EMAIL
  const token = env.JIRA_API_TOKEN
  if (!email || !token) return null
  return { baseUrl: env.JIRA_BASE_URL ?? DEFAULT_BASE_URL, email, token }
}

export function jiraLookup(config: JiraConfig | null, fetchFn: typeof fetch = fetch): (key: string) => Promise<Lookup> {
  return async (key) => {
    if (!config) return { kind: 'unavailable', error: 'JIRA_EMAIL and JIRA_API_TOKEN are not set' }
    const url = `${config.baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`
    const auth = Buffer.from(`${config.email}:${config.token}`).toString('base64')
    try {
      const res = await fetchFn(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 404) return { kind: 'not-found' }
      if (!res.ok) return { kind: 'unavailable', error: `Jira answered ${res.status}` }
      const body = (await res.json()) as { fields?: { summary?: unknown } }
      const summary = body.fields?.summary
      return typeof summary === 'string' ? { kind: 'found', summary } : { kind: 'unavailable', error: 'no summary in the answer' }
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) }
    }
  }
}
