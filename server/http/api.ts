// The console's HTTP interface: a JSON API under /api, /healthz for a monitor, and the built UI
// from ui/dist. Every action writes the database as the CLI does and then ticks the loop, so it
// takes effect at once in this process; another browser sees it on its next poll. Before
// anything is served, the guard (guard.ts) runs: the security headers go on every answer, a
// Host the console does not know is refused (421), an action asked for by another site's page
// is refused (403), a login is asked for when one is set (401; /healthz needs none), and a
// body over 64 KB is refused (413). The network is still the fence (PRD, Non-goals): the login
// is for a console reachable beyond it.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Check } from '../health.ts'
import type { Loop } from '../loop/loop.ts'
import type { JiraSearch, SearchOptions } from '../store/jira.ts'
import type { Lookup } from '../store/queue.ts'
import { enqueue, remove, reorder } from '../store/queue.ts'
import { inFlight, loopState, requestCancel, serviceAlive, startLoop, stopLoop } from '../store/runs.ts'
import { knownHost, loggedIn, loginChallenge, readBody, sameOrigin, SECURITY_HEADERS, TooLarge, type Guard } from './guard.ts'
import { filterProblem, historyView, runView, stateView, statsView, type ViewSources } from './view.ts'

export type ApiDeps = ViewSources & {
  loop?: Pick<Loop, 'tick'>
  /** The host names and the login the console is guarded by; without it, addresses and this machine's name, no login. */
  guard?: Guard | undefined
  lookup?: ((key: string) => Promise<Lookup>) | undefined
  /** The ticket search; without it the search answers that Jira is not configured. */
  search?: ((query: string, options?: SearchOptions) => Promise<JiraSearch>) | undefined
  /** The directory with the built UI; nothing is served without it. */
  uiDir?: string | undefined
}

type Reply = { status: number; body: unknown }

const BODY_LIMIT = 64 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

const NO_GUARD: Guard = { hostnames: [], login: null, realm: 'Pipeline console' }

export function createServer(deps: ApiDeps): http.Server {
  const guard = deps.guard ?? NO_GUARD
  return http.createServer(async (req, res) => {
    if (!knownHost(req.headers.host, guard)) return send(res, 421, 'Unknown host name: open the console by its address.')
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    if (url.pathname === '/healthz') {
      const h = healthz(deps)
      return send(res, h.ok ? 200 : 503, JSON.stringify(h))
    }
    if (guard.login && !loggedIn(req.headers.authorization, guard.login)) return send(res, 401, 'Login required.', loginChallenge(guard))
    try {
      if (url.pathname.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req))
          return send(res, 403, JSON.stringify({ message: "An action can be asked for from the console's own pages only." }))
        const reply = await handleApi(deps, method, url, parseBody(await readBody(req, BODY_LIMIT)))
        send(res, reply.status, JSON.stringify(reply.body))
      } else if (method === 'GET' || method === 'HEAD') {
        serveStatic(deps.uiDir, url.pathname, res)
      } else {
        send(res, 405, JSON.stringify({ message: 'method not allowed' }))
      }
    } catch (error) {
      if (error instanceof TooLarge) return send(res, 413, JSON.stringify({ message: error.message }))
      send(res, 500, JSON.stringify({ message: error instanceof Error ? error.message : String(error) }))
    }
  })
}

export type Healthz = {
  ok: boolean
  /** Whether the service's heartbeat is fresh. */
  state: 'running' | 'stopped'
  loop: 'running' | 'stopped'
  inFlight: string | null
  /** Each dependency checked so far and whether it is ok. */
  health: Record<string, boolean>
}

/** For a monitor: ok when the service runs and every dependency it has checked is ok. */
export function healthz(deps: ApiDeps): Healthz {
  const now = (deps.now ?? (() => new Date()))()
  const alive = serviceAlive(deps.db, 5000, () => now.getTime())
  const checks: Record<string, Check> = deps.health() ?? {}
  const health = Object.fromEntries(Object.entries(checks).map(([name, c]) => [name, c.ok]))
  return {
    ok: alive && Object.values(health).every(Boolean),
    state: alive ? 'running' : 'stopped',
    loop: loopState(deps.db).wanted,
    inFlight: inFlight(deps.db)?.key ?? null,
    health,
  }
}

async function handleApi(deps: ApiDeps, method: string, url: URL, body: unknown): Promise<Reply> {
  const p = url.pathname
  const ok = (body: unknown): Reply => ({ status: 200, body })
  const bad = (message: string, status = 400): Reply => ({ status, body: { message } })
  const ticked = (body: unknown): Reply => {
    deps.loop?.tick()
    return ok(body)
  }
  const segs = p.split('/').filter(Boolean) // ['api', ...]
  const asObject = (b: unknown): Record<string, unknown> => (typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {})

  if (method === 'GET' && p === '/api/state') return ok(stateView(deps))
  if (method === 'GET' && p === '/api/stats') return ok(statsView(deps))
  if (method === 'GET' && p === '/api/runs') {
    const filter = { verdict: url.searchParams.get('verdict') ?? undefined, ending: url.searchParams.get('ending') ?? undefined }
    const problem = filterProblem(filter)
    return problem ? bad(problem) : ok(historyView(deps, filter))
  }
  if (method === 'GET' && segs.length === 4 && segs[1] === 'runs') {
    const run = runView(deps, segs[2]!, Number(segs[3]))
    return run ? ok(run) : bad('no such run', 404)
  }
  if (method === 'GET' && p === '/api/jira/search') {
    const q = url.searchParams.get('q') ?? ''
    if (q.length > 200) return bad('the query is longer than 200 characters')
    if (!deps.search) return ok({ kind: 'unavailable', error: 'the ticket search is not set up' } satisfies JiraSearch)
    const next = url.searchParams.get('next') ?? undefined
    if (next !== undefined && next.length > 2000) return bad('the page token is too long')
    const jql = url.searchParams.get('jql') ?? undefined
    if (jql !== undefined && jql.length > 2000) return bad('the JQL is longer than 2000 characters')
    return ok(await deps.search(q, { jql, next }))
  }
  if (method === 'POST' && p === '/api/queue') {
    const { key, front } = asObject(body)
    if (typeof key !== 'string') return bad('key is required')
    const added = await enqueue(deps.db, key.trim(), { front: front === true, lookup: deps.lookup })
    return added.ok ? ticked(added) : bad(added.message)
  }
  if (method === 'DELETE' && segs.length === 3 && segs[1] === 'queue') {
    const removed = remove(deps.db, segs[2]!)
    return removed.ok ? ok(removed) : bad(removed.message, 404)
  }
  if (method === 'PUT' && p === '/api/queue/order') {
    const { keys } = asObject(body)
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string')) return bad('keys is required')
    const done = reorder(deps.db, keys as string[])
    return done.ok ? ok(done) : bad(done.message)
  }
  if (method === 'POST' && p === '/api/loop/start') {
    startLoop(deps.db)
    return ticked({ ok: true })
  }
  if (method === 'POST' && p === '/api/loop/stop') {
    stopLoop(deps.db, 'operator')
    return ticked({ ok: true })
  }
  if (method === 'POST' && p === '/api/cancel') {
    const asked = requestCancel(deps.db)
    return asked.ok ? ticked(asked) : bad(asked.message, 409)
  }
  return bad('not found', 404)
}

function serveStatic(uiDir: string | undefined, pathname: string, res: http.ServerResponse): void {
  if (!uiDir) return send(res, 404, 'the UI is not built: npm run build')
  const root = path.resolve(uiDir)
  const wanted = path.resolve(root, '.' + decodeURIComponent(pathname))
  const found = wanted.startsWith(root + path.sep) && fs.existsSync(wanted) && fs.statSync(wanted).isFile()
  // A file the build does not have (an asset of an older build) is not the page.
  if (!found && path.extname(pathname)) return send(res, 404, 'not found')
  const file = found ? wanted : path.join(root, 'index.html')
  if (!fs.existsSync(file)) return send(res, 404, 'the UI is not built: npm run build')
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000, immutable',
  })
  fs.createReadStream(file).pipe(res)
}

function send(res: http.ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'content-type': text.startsWith('{') || text.startsWith('[') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** The body as JSON; undefined when there is none or it is not JSON (the handler then says what is missing). */
function parseBody(text: string): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
