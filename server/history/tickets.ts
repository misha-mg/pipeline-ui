// The Jira status of every ticket the pipeline ran, kept in the database for the statistics
// page: whether the ticket reached Done, and when, and its summary for a run whose files lack
// one. Read in the service's background round, every ticket at once (a few bulk calls), when the
// copy is older than MAX_AGE; never in a request. Without Jira the statuses stay as last read,
// or unknown.
import type { Db } from '../store/db.ts'
import type { JiraStatuses, TicketStatus } from '../store/jira.ts'

export type KnownTicket = TicketStatus & { fetchedAt: string }

const MAX_AGE_MS = 10 * 60 * 1000

function ensureTicketTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tickets (
    key TEXT PRIMARY KEY, summary TEXT, status TEXT, status_category TEXT, done_at TEXT, fetched_at TEXT NOT NULL
  )`)
}

export function ticketStatuses(db: Db): Map<string, KnownTicket> {
  ensureTicketTable(db)
  const rows = db.prepare('SELECT key, summary, status, status_category, done_at, fetched_at FROM tickets').all()
  return new Map(rows.map((r) => [r.key as string, { key: r.key as string, summary: (r.summary as string | null) ?? null, status: (r.status as string | null) ?? null, statusCategory: (r.status_category as string | null) ?? null, doneAt: (r.done_at as string | null) ?? null, fetchedAt: r.fetched_at as string }]))
}

/**
 * Reads the statuses of `keys` when any of them was never read or the oldest copy is stale.
 * Returns how many it read, or why it could not.
 */
export async function refreshTickets(db: Db, keys: Iterable<string>, statuses: (keys: string[]) => Promise<JiraStatuses>, now: () => Date = () => new Date()): Promise<number | string> {
  const known = ticketStatuses(db)
  const wanted = [...new Set(keys)].sort()
  const stale = wanted.some((k) => {
    const t = known.get(k)
    return !t || now().getTime() - Date.parse(t.fetchedAt) > MAX_AGE_MS
  })
  if (!stale) return 0
  const found = await statuses(wanted)
  if (found.kind === 'unavailable') return found.error
  const at = now().toISOString()
  const write = db.prepare(`INSERT INTO tickets (key, summary, status, status_category, done_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET summary = excluded.summary, status = excluded.status, status_category = excluded.status_category, done_at = excluded.done_at, fetched_at = excluded.fetched_at`)
  for (const t of found.tickets) write.run(t.key, t.summary, t.status, t.statusCategory, t.doneAt, at)
  // A key Jira does not know (moved, deleted) is kept as unknown, so it is not asked every round.
  const got = new Set(found.tickets.map((t) => t.key))
  for (const key of wanted.filter((k) => !got.has(k))) write.run(key, null, null, null, null, at)
  return found.tickets.length
}
