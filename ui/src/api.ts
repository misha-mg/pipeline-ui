// The console's view of the service: the API's shapes come from the server's own types, so
// a change there is a type error here.
import type { HistoryFilter, RunDetail, ShownRun, StateView } from '../../server/http/view.ts'
import type { JiraSearch, SearchOptions } from '../../server/store/jira.ts'
import { verdictTone, type Tone } from '../../server/history/outcome.ts'

export type { AgentStage, Counts, ShownRun, StateView } from '../../server/http/view.ts'
export type { JiraIssue, JiraSearch, SearchScope } from '../../server/store/jira.ts'
export type RunFiles = RunDetail
export type History = { runs: ShownRun[]; total: number; verdicts: Record<string, number>; endings: Record<string, number> }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as T & { message?: string }
  if (!res.ok) throw new ApiError(data.message ?? `${method} ${path}: ${res.status}`, res.status)
  return data
}

export const api = {
  state: () => call<StateView>('GET', '/api/state'),
  runs: (filter: HistoryFilter) => {
    const q = new URLSearchParams()
    if (filter.verdict) q.set('verdict', filter.verdict)
    if (filter.ending) q.set('ending', filter.ending)
    return call<History>('GET', `/api/runs${q.size ? `?${q}` : ''}`)
  },
  run: (key: string, number: number) => call<RunFiles>('GET', `/api/runs/${key}/${number}`),
  search: (q: string, { jql, next }: SearchOptions = {}) => {
    const params = new URLSearchParams({ q })
    if (jql) params.set('jql', jql)
    if (next) params.set('next', next)
    return call<JiraSearch>('GET', `/api/jira/search?${params}`)
  },
  enqueue: (key: string, front: boolean) => call<{ ok: true; warning?: string }>('POST', '/api/queue', { key, front }),
  remove: (key: string) => call<{ ok: true }>('DELETE', `/api/queue/${key}`),
  reorder: (keys: string[]) => call<{ ok: true }>('PUT', '/api/queue/order', { keys }),
  start: () => call<{ ok: true }>('POST', '/api/loop/start'),
  stop: () => call<{ ok: true }>('POST', '/api/loop/stop'),
  cancel: () => call<{ ok: true }>('POST', '/api/cancel'),
}

export function fmtDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

/** Local time as `2026-10-14 21:00`. */
export function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fmtClock(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// The outcome's words and tones come from the server's own module, so the console and the API
// cannot name a verdict, an ending or a stage two ways.
export { endingLabel, endingTone, stageKey, stageOfAgent, stageResultTone, stagesAfter, verdictFamily, verdictTone, type Tone } from '../../server/history/outcome.ts'

/** A tone as a pill's class: `ok`, `bad`, `slate` while it goes on, none for neither. */
export function toneClass(tone: Tone): string {
  return tone === 'live' ? 'slate' : tone
}

/** A verdict's text colour in a table. */
export function verdictClass(v: string | null): string {
  const tone = verdictTone(v)
  return tone === 'ok' ? 'verdict-done' : tone === 'bad' ? 'verdict-blocked' : 'verdict-none'
}

/** A pull request's state as a pill's class: merged stands out, declined is a stop. */
export function prStateClass(state: string): string {
  return state === 'MERGED' ? 'strong' : state === 'DECLINED' ? 'bad' : ''
}

export function prNumber(url: string): string {
  return url.match(/(\d+)$/)?.[1] ?? ''
}

export function fmtAgo(iso: string | null, now: string): string {
  if (!iso) return ''
  return fmtDuration(Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 1000)))
}

