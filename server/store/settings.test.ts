// The run settings: the environment's defaults until one is set, what is kept and forgotten,
// and what a value asked for must be.
import { describe, expect, it } from 'vitest'
import { openDb } from './db.ts'
import { changedSettings, parseRunSettings, readRunSettings, writeRunSettings, type RunSettings } from './settings.ts'

const defaults: RunSettings = { baseBranch: 'master', pullRequests: 'on', timeoutHours: 4 }

describe('the run settings', () => {
  it('are the defaults until one is set; a set one wins, and one set back to the default is forgotten', () => {
    const db = openDb(':memory:')
    expect(readRunSettings(db, defaults)).toEqual(defaults)

    writeRunSettings(db, { baseBranch: 'dev', pullRequests: 'draft', timeoutHours: 4 }, defaults, () => '2026-11-10T10:00:00.000Z')
    expect(readRunSettings(db, defaults)).toEqual({ baseBranch: 'dev', pullRequests: 'draft', timeoutHours: 4 })
    // Only what differs from the defaults is kept, so the environment's hours still show when they change.
    expect(db.prepare('SELECT name FROM settings ORDER BY name').all()).toEqual([{ name: 'baseBranch' }, { name: 'pullRequests' }])
    expect(readRunSettings(db, { ...defaults, timeoutHours: 6 }).timeoutHours).toBe(6)

    writeRunSettings(db, { baseBranch: 'master', pullRequests: 'draft', timeoutHours: 4 }, defaults)
    expect(db.prepare('SELECT name FROM settings').all()).toEqual([{ name: 'pullRequests' }])
    expect(readRunSettings(db, { ...defaults, baseBranch: 'main' }).baseBranch).toBe('main')
  })

  it('falls back to the default for a kept value it cannot read', () => {
    const db = openDb(':memory:')
    for (const [name, value] of [
      ['pullRequests', 'maybe'],
      ['timeoutHours', 'long'],
    ])
      db.prepare('INSERT INTO settings (name, value, set_at) VALUES (?, ?, ?)').run(name!, value!, 't')
    expect(readRunSettings(db, defaults)).toEqual(defaults)
  })

  it('takes the names asked for over the current ones and says what is wrong with a value', () => {
    expect(parseRunSettings({ pullRequests: 'off' }, defaults)).toEqual({ ok: true, settings: { ...defaults, pullRequests: 'off' } })
    expect(parseRunSettings({ baseBranch: ' origin/release/5.9 ', timeoutHours: '6.5' }, defaults)).toEqual({
      ok: true,
      settings: { baseBranch: 'release/5.9', pullRequests: 'on', timeoutHours: 6.5 },
    })
    expect(parseRunSettings(undefined, defaults)).toEqual({ ok: true, settings: defaults })
    for (const branch of ['', '-x', 'a..b', 'a b', 'dev;rm', 'dev/', 'x.lock', 7])
      expect(parseRunSettings({ baseBranch: branch }, defaults)).toMatchObject({ ok: false, message: expect.stringContaining('branch') })
    expect(parseRunSettings({ pullRequests: 'ready' }, defaults)).toMatchObject({ ok: false })
    for (const hours of [0, -1, 25, 'soon', null]) expect(parseRunSettings({ timeoutHours: hours }, defaults)).toMatchObject({ ok: false })
  })

  it('names what changed', () => {
    expect(changedSettings(defaults, { ...defaults, baseBranch: 'dev' })).toEqual({ baseBranch: 'dev' })
    expect(changedSettings(defaults, defaults)).toEqual({})
  })
})
