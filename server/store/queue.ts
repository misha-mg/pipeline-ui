// The queue of tickets: in order, one row per ticket, a ticket at most once. Adding looks the
// ticket up in Jira for its summary; a key Jira does not know is refused, a Jira that cannot be
// reached leaves the summary empty. The lookup also brings the labels: a ticket labelled for the
// screen-migration workflow is marked so, and the mark follows it into its run. See
// .about/prd/pipeline-web-ui.md, Queue and loop.
import { MIGRATION_LABEL } from '../history/outcome.ts'
import { nowIso, transaction, type Db } from './db.ts'

export type QueueItem = { key: string; summary: string | null; migration: boolean; position: number; addedAt: string }

export type QueueRefusal =
  | { ok: false; reason: 'invalid-key'; message: string }
  | { ok: false; reason: 'duplicate'; message: string }
  | { ok: false; reason: 'not-queued'; message: string }
  | { ok: false; reason: 'unknown-ticket'; message: string }

export type Lookup = { kind: 'found'; summary: string; labels: string[] } | { kind: 'not-found' } | { kind: 'unavailable'; error: string }

const TICKET_KEY = /^[A-Z]+-\d+$/

function isTicketKey(key: string): boolean {
  return TICKET_KEY.test(key)
}

export function listQueue(db: Db): QueueItem[] {
  return db.prepare('SELECT key, summary, migration, position, added_at FROM queue ORDER BY position').all().map(itemOf)
}

export function queueHead(db: Db): QueueItem | null {
  const row = db.prepare('SELECT key, summary, migration, position, added_at FROM queue ORDER BY position LIMIT 1').get()
  return row ? itemOf(row) : null
}

function isQueued(db: Db, key: string): boolean {
  return db.prepare('SELECT 1 FROM queue WHERE key = ?').get(key) !== undefined
}

/**
 * Adds a ticket at the end, or at the front with `front`. `lookup` asks Jira for the summary;
 * without it, or when Jira cannot be reached, the ticket is queued with its key alone.
 */
export async function enqueue(
  db: Db,
  key: string,
  opts: { front?: boolean; lookup?: ((key: string) => Promise<Lookup>) | undefined; now?: () => string } = {},
): Promise<{ ok: true; item: QueueItem; warning?: string } | QueueRefusal> {
  if (!isTicketKey(key)) return { ok: false, reason: 'invalid-key', message: `not a ticket key: ${key}` }
  if (isQueued(db, key)) return { ok: false, reason: 'duplicate', message: `${key} is already queued` }
  let summary: string | null = null
  let migration = false
  let warning: string | undefined
  if (opts.lookup) {
    const found = await opts.lookup(key)
    if (found.kind === 'not-found') return { ok: false, reason: 'unknown-ticket', message: `Jira does not know ${key}` }
    if (found.kind === 'found') [summary, migration] = [found.summary, found.labels.includes(MIGRATION_LABEL)]
    else warning = `Jira could not be reached (${found.error}); ${key} is queued without a summary`
  }
  const item = transaction(db, () => {
    // The lookup took time: the ticket may have been queued meanwhile.
    if (isQueued(db, key)) return null
    const edge = db.prepare('SELECT MIN(position) AS lo, MAX(position) AS hi FROM queue').get() as { lo: number | null; hi: number | null }
    const position = opts.front ? (edge.lo ?? 1) - 1 : (edge.hi ?? 0) + 1
    const addedAt = (opts.now ?? nowIso)()
    db.prepare('INSERT INTO queue (key, summary, migration, position, added_at) VALUES (?, ?, ?, ?, ?)').run(
      key,
      summary,
      migration ? 1 : 0,
      position,
      addedAt,
    )
    return { key, summary, migration, position, addedAt }
  })
  if (!item) return { ok: false, reason: 'duplicate', message: `${key} is already queued` }
  return warning ? { ok: true, item, warning } : { ok: true, item }
}

export function remove(db: Db, key: string): { ok: true } | QueueRefusal {
  const changed = db.prepare('DELETE FROM queue WHERE key = ?').run(key).changes
  return changed ? { ok: true } : { ok: false, reason: 'not-queued', message: `${key} is not queued` }
}

/** Takes the first ticket out of the queue; null when it is empty. */
export function takeHead(db: Db): QueueItem | null {
  return transaction(db, () => {
    const head = queueHead(db)
    if (head) db.prepare('DELETE FROM queue WHERE key = ?').run(head.key)
    return head
  })
}

/**
 * Puts `keys` first, in that order; the tickets not named keep their order after them. Refuses
 * a key that is not queued and changes nothing then.
 */
export function reorder(db: Db, keys: string[]): { ok: true; queue: QueueItem[] } | QueueRefusal {
  return transaction(db, () => {
    const current = listQueue(db)
    const missing = keys.find((k) => !current.some((i) => i.key === k))
    if (missing) return { ok: false, reason: 'not-queued', message: `${missing} is not queued` }
    const named = new Set(keys)
    const order = [...keys, ...current.filter((i) => !named.has(i.key)).map((i) => i.key)]
    const set = db.prepare('UPDATE queue SET position = ? WHERE key = ?')
    order.forEach((key, i) => set.run(i + 1, key))
    return { ok: true, queue: listQueue(db) }
  })
}

function itemOf(row: Record<string, unknown>): QueueItem {
  return {
    key: row.key as string,
    summary: (row.summary as string | null) ?? null,
    migration: row.migration === 1,
    position: row.position as number,
    addedAt: row.added_at as string,
  }
}
