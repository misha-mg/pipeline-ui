// The console's HTTP interface: a JSON API under /api and the built UI from ui/dist. Every
// action writes the database as the CLI does and then ticks the loop, so it takes effect at
// once in this process; another browser sees it on its next poll. No password: the network is
// the fence (PRD, Non-goals).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Loop } from '../loop/loop.ts'
import type { Lookup } from '../store/queue.ts'
import { enqueue, remove, reorder } from '../store/queue.ts'
import { requestCancel, startLoop, stopLoop } from '../store/runs.ts'
import { historyView, runView, stateView, type ViewSources } from './view.ts'

export type ApiDeps = ViewSources & {
  loop?: Pick<Loop, 'tick'>
  lookup?: (key: string) => Promise<Lookup>
  /** The directory with the built UI; nothing is served without it. */
  uiDir?: string
}

type Reply = { status: number; body: unknown }

const BODY_LIMIT = 64 * 1024
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json' }

export function createServer(deps: ApiDeps): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (url.pathname.startsWith('/api/')) {
        const reply = await handleApi(deps, req.method ?? 'GET', url, await readBody(req))
        send(res, reply.status, JSON.stringify(reply.body))
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(deps.uiDir, url.pathname, res)
      } else {
        send(res, 405, JSON.stringify({ message: 'method not allowed' }))
      }
    } catch (error) {
      send(res, 500, JSON.stringify({ message: error instanceof Error ? error.message : String(error) }))
    }
  })
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
  if (method === 'GET' && p === '/api/runs') {
    return ok(historyView(deps, { verdict: url.searchParams.get('verdict') ?? undefined, ending: url.searchParams.get('ending') ?? undefined }))
  }
  if (method === 'GET' && segs.length === 4 && segs[1] === 'runs') {
    const run = runView(deps, segs[2]!, Number(segs[3]))
    return run ? ok(run) : bad('no such run', 404)
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
  const file = wanted.startsWith(root + path.sep) && fs.existsSync(wanted) && fs.statSync(wanted).isFile() ? wanted : path.join(root, 'index.html')
  if (!fs.existsSync(file)) return send(res, 404, 'the UI is not built: npm run build')
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'max-age=31536000, immutable' })
  fs.createReadStream(file).pipe(res)
}

function send(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': text.startsWith('{') || text.startsWith('[') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (text.length > BODY_LIMIT) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!text) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', reject)
  })
}
