import { describe, expect, it } from 'vitest'
import { openDb } from '../store/db.ts'
import type { JiraStatuses } from '../store/jira.ts'
import { refreshTickets, ticketStatuses } from './tickets.ts'

describe('refreshTickets', () => {
  it('reads every ticket when one is new or the copy is stale, keeps an unknown key as unknown, and keeps the last copy when Jira is down', async () => {
    const db = openDb(':memory:')
    let t = new Date('2026-10-27T10:00:00Z')
    const asked: string[][] = []
    let answer: JiraStatuses = {
      kind: 'found',
      tickets: [
        {
          key: 'KAZ-1',
          summary: 'one',
          status: 'Done',
          statusCategory: 'done',
          doneAt: '2026-10-26T10:00:00.000Z',
          moves: [
            { at: '2026-10-25T10:00:00.000Z', to: 'Failed' },
            { at: '2026-10-26T10:00:00.000Z', to: 'Done' },
          ],
        },
      ],
    }
    const statuses = async (keys: string[]) => (asked.push(keys), answer)
    expect(await refreshTickets(db, ['KAZ-1', 'KAZ-2', 'KAZ-1'], statuses, () => t)).toBe(1)
    expect(asked).toEqual([['KAZ-1', 'KAZ-2']])
    expect(ticketStatuses(db).get('KAZ-1')).toMatchObject({
      statusCategory: 'done',
      doneAt: '2026-10-26T10:00:00.000Z',
      moves: [{ to: 'Failed' }, { to: 'Done' }],
    })
    expect(ticketStatuses(db).get('KAZ-2')).toMatchObject({ status: null, statusCategory: null })

    // Fresh: not asked again.
    t = new Date('2026-10-27T10:05:00Z')
    expect(await refreshTickets(db, ['KAZ-1', 'KAZ-2'], statuses, () => t)).toBe(0)
    expect(asked.length).toBe(1)

    // Stale, and Jira is down: the copy stays.
    t = new Date('2026-10-27T10:30:00Z')
    answer = { kind: 'unavailable', error: 'Jira answered 503' }
    expect(await refreshTickets(db, ['KAZ-1', 'KAZ-2'], statuses, () => t)).toBe('Jira answered 503')
    expect(ticketStatuses(db).get('KAZ-1')).toMatchObject({ status: 'Done' })
  })

  it('reads a fresh copy again when it was kept before the moves were', async () => {
    const db = openDb(':memory:')
    const t = new Date('2026-10-27T10:00:00Z')
    const statuses = async () =>
      ({
        kind: 'found',
        tickets: [{ key: 'KAZ-1', summary: null, status: 'To Do', statusCategory: 'new', doneAt: null, moves: [] }],
      }) as JiraStatuses
    expect(await refreshTickets(db, ['KAZ-1'], statuses, () => t)).toBe(1)
    // Never moved: an empty list, not asked again.
    expect(await refreshTickets(db, ['KAZ-1'], statuses, () => t)).toBe(0)
    db.exec('UPDATE tickets SET moves = NULL')
    expect(await refreshTickets(db, ['KAZ-1'], statuses, () => t)).toBe(1)
  })
})
