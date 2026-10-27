// The console's view of the service: the API's shapes come from the server's own types, so
// a change there is a type error here.
import type { HistoryFilter, ShownRun, StateView } from '../../server/http/view.ts'

export type { Counts, ShownRun, StateView } from '../../server/http/view.ts'
export type RunFiles = ShownRun & { files: { name: string; text: string }[] }
export type History = { runs: ShownRun[]; verdicts: Record<string, number>; endings: Record<string, number> }

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

export function verdictClass(v: string | null): string {
  if (!v) return 'verdict-none'
  return v.startsWith('done') ? 'verdict-done' : v.startsWith('blocked') ? 'verdict-blocked' : v.startsWith('failed') ? 'verdict-failed' : 'verdict-none'
}

export function prNumber(url: string): string {
  return url.match(/(\d+)$/)?.[1] ?? ''
}

export function fmtAgo(iso: string | null, now: string): string {
  if (!iso) return ''
  return fmtDuration(Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 1000)))
}

/** The stage as the console names it, from the agent the hooks report. */
export function stageName(agent: string | null): string {
  const names: Record<string, string> = { 'ticket-investigator': 'investigate', 'ticket-implementer': 'implement', 'diff-preparer': 'diff', 'change-reviewer': 'review', 'app-tester': 'app-test' }
  return agent ? names[agent] ?? agent : 'between stages'
}
