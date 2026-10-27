import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../session/driver.ts'
import { openDb } from '../store/db.ts'
import { enqueue, listQueue } from '../store/queue.ts'
import { getRun, inFlight, listEvents, loopState, markRestart, requestCancel, startLoop, stopLoop } from '../store/runs.ts'
import { createLoop, endingOf, type RunExit, type Runner, type RunnerHandlers } from './loop.ts'

type Call = { key: string; handlers: RunnerHandlers; signal: AbortSignal; finish: (exit?: RunExit) => void }

function fakeRunner() {
  const calls: Call[] = []
  const runner: Runner = (key, handlers, signal) =>
    new Promise((resolve) => calls.push({ key, handlers, signal, finish: (exit = { code: 0, signal: null }) => resolve(exit) }))
  return { runner, calls, last: () => calls.at(-1)! }
}

const temps: string[] = []
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }) })

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-loop-'))
  temps.push(dir)
  const db = openDb(':memory:')
  const fake = fakeRunner()
  const runsDir = path.join(dir, 'runs')
  const loop = createLoop({ db, runner: fake.runner, runsDir, logDir: path.join(dir, 'logs') })
  const closeRun = (key: string, n: number, verdict: string) => {
    const runDir = path.join(runsDir, key, `run-${n}`)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(path.join(runDir, '00-assignment.md'), `# Assignment — ${key}\n\n- Ticket: ${key}\n- Summary: from the assignment\n`)
    fs.writeFileSync(path.join(runDir, 'state.md'), `investigate — ticket-investigator (-) — ok\n${verdict}\n`)
    return runDir
  }
  return { db, fake, loop, runsDir, closeRun }
}

const at = '2026-10-27T10:00:00.000Z'
type Bare = SessionEvent extends infer E ? (E extends SessionEvent ? Omit<E, 'at'> : never) : never
const ev = (e: Bare) => ({ ...e, at }) as SessionEvent
const completed = ev({ type: 'ended', ending: { kind: 'completed', text: 'done', costUsd: 0 } })

describe('loop', () => {
  it('starts nothing until started, then takes the queue head, records the stages, the ending and the verdict', async () => {
    const { db, fake, loop, closeRun } = setup()
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    loop.tick()
    expect(fake.calls).toHaveLength(0)

    startLoop(db)
    loop.tick()
    expect(fake.last().key).toBe('KAZ-1')
    expect(inFlight(db)).toMatchObject({ key: 'KAZ-1', ending: null, stage: null })
    expect(listQueue(db).map((i) => i.key)).toEqual(['KAZ-2'])
    loop.tick()
    expect(fake.calls).toHaveLength(1)

    const { handlers } = fake.last()
    handlers.onEvent(ev({ type: 'stage-start', agent: 'ticket-investigator', agentId: 'a1' }))
    expect(inFlight(db)).toMatchObject({ stage: 'ticket-investigator', stageSince: at })
    handlers.onEvent(ev({ type: 'stage-stop', agent: 'ticket-investigator', agentId: 'a1' }))
    expect(inFlight(db)?.stage).toBeNull()
    handlers.onOutput('some run.sh output\n')
    const runDir = closeRun('KAZ-1', 1, 'done:nothing-to-build')
    handlers.onEvent(completed)
    fake.last().finish()
    await loop.settled()

    const run = getRun(db, 1)!
    expect(run).toMatchObject({ ending: 'completed', verdict: 'done:nothing-to-build', runDir, summary: 'from the assignment', stage: null })
    expect(run.endedAt).not.toBeNull()
    expect(listEvents(db, 1).map((e) => e.type)).toEqual(['stage-start', 'stage-stop', 'ended'])
    expect(fs.readFileSync(run.logPath!, 'utf8')).toBe('some run.sh output\n')
    expect(inFlight(db)).toBeNull()

    loop.tick()
    expect(fake.last().key).toBe('KAZ-2')
  })

  it('finds the run directory among earlier ones of the same key', async () => {
    const { db, fake, loop, closeRun } = setup()
    closeRun('KAZ-1', 1, 'failed:old')
    await enqueue(db, 'KAZ-1')
    startLoop(db)
    loop.tick()
    const runDir = closeRun('KAZ-1', 2, 'blocked:tooling')
    fake.last().handlers.onEvent(completed)
    fake.last().finish()
    await loop.settled()
    expect(getRun(db, 1)).toMatchObject({ runDir, verdict: 'blocked:tooling' })
  })

  it('stopped while a run is in flight: the run finishes, the next waits for start', async () => {
    const { db, fake, loop } = setup()
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    startLoop(db)
    loop.tick()
    stopLoop(db, 'operator')
    loop.tick()
    expect(fake.calls).toHaveLength(1)
    fake.last().handlers.onEvent(completed)
    fake.last().finish()
    await loop.settled()
    loop.tick()
    expect(fake.calls).toHaveLength(1)
    expect(getRun(db, 1)?.ending).toBe('completed')
    expect(listQueue(db).map((i) => i.key)).toEqual(['KAZ-2'])
    startLoop(db)
    loop.tick()
    expect(fake.last().key).toBe('KAZ-2')
  })

  it('stops itself on the usage limit and leaves the queue untouched', async () => {
    const { db, fake, loop } = setup()
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    startLoop(db)
    loop.tick()
    fake.last().handlers.onEvent(ev({ type: 'ended', ending: { kind: 'usage-limit', resetsAt: 1700000000, text: 'limit' } }))
    fake.last().finish({ code: 1, signal: null })
    await loop.settled()
    expect(getRun(db, 1)).toMatchObject({ ending: 'usage-limit', endingDetail: 'limit' })
    expect(loopState(db)).toMatchObject({ wanted: 'stopped', stoppedReason: 'usage-limit', usageLimitResetsAt: 1700000000 })
    loop.tick()
    expect(fake.calls).toHaveLength(1)
    expect(listQueue(db).map((i) => i.key)).toEqual(['KAZ-2'])
    startLoop(db)
    loop.tick()
    expect(fake.last().key).toBe('KAZ-2')
  })

  it('goes on to the next ticket after an error, a timeout and an exit without an ending', async () => {
    const { db, fake, loop } = setup()
    for (const k of ['KAZ-1', 'KAZ-2', 'KAZ-3', 'KAZ-4']) await enqueue(db, k)
    startLoop(db)
    loop.tick()
    fake.last().handlers.onEvent(ev({ type: 'ended', ending: { kind: 'error', reason: 'API Error: 529' } }))
    fake.last().finish({ code: 1, signal: null })
    await loop.settled()
    loop.tick()
    fake.last().handlers.onEvent(ev({ type: 'ended', ending: { kind: 'aborted', reason: 'timeout' } }))
    fake.last().finish({ code: 1, signal: null })
    await loop.settled()
    loop.tick()
    fake.last().finish({ code: 2, signal: null })
    await loop.settled()
    loop.tick()
    expect(fake.last().key).toBe('KAZ-4')
    expect(getRun(db, 1)).toMatchObject({ ending: 'error', endingDetail: 'API Error: 529' })
    expect(getRun(db, 2)).toMatchObject({ ending: 'timeout' })
    expect(getRun(db, 3)).toMatchObject({ ending: 'exited', endingDetail: expect.stringContaining('code 2') })
  })

  it('cancel aborts the run in flight on the next tick, records it cancelled with its stage, and the next starts', async () => {
    const { db, fake, loop } = setup()
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    expect(requestCancel(db)).toMatchObject({ ok: false, reason: 'nothing-in-flight' })
    startLoop(db)
    loop.tick()
    fake.last().handlers.onEvent(ev({ type: 'stage-start', agent: 'ticket-implementer', agentId: 'a2' }))
    expect(requestCancel(db)).toMatchObject({ ok: true, run: { key: 'KAZ-1' } })
    expect(fake.last().signal.aborted).toBe(false)
    loop.tick()
    expect(fake.last().signal.aborted).toBe(true)
    expect(fake.last().signal.reason).toBe('cancelled')
    fake.last().handlers.onEvent(ev({ type: 'ended', ending: { kind: 'aborted', reason: 'cancelled' } }))
    fake.last().finish({ code: 1, signal: null })
    await loop.settled()
    expect(getRun(db, 1)).toMatchObject({ ending: 'cancelled', stage: null })
    expect(listEvents(db, 1)[0]?.event).toMatchObject({ type: 'stage-start', agent: 'ticket-implementer' })
    loop.tick()
    expect(fake.last().key).toBe('KAZ-2')
    expect(loopState(db).wanted).toBe('running')
  })

  it('shutdown ends the run in flight as restart; a starting service marks a run left in flight the same and stops the loop', async () => {
    const { db, fake, loop } = setup()
    await enqueue(db, 'KAZ-1')
    await enqueue(db, 'KAZ-2')
    startLoop(db)
    loop.tick()
    const shut = loop.shutdown()
    expect(fake.last().signal.reason).toBe('restart')
    fake.last().finish({ code: null, signal: 'SIGTERM' })
    await shut
    expect(getRun(db, 1)?.ending).toBe('restart')

    // A run the service had in flight when it died without a shutdown.
    startLoop(db)
    loop.tick()
    expect(inFlight(db)?.key).toBe('KAZ-2')
    const closed = markRestart(db)
    expect(closed.map((r) => r.key)).toEqual(['KAZ-2'])
    expect(getRun(db, 2)).toMatchObject({ ending: 'restart' })
    expect(loopState(db)).toMatchObject({ wanted: 'stopped', stoppedReason: 'restart' })
    expect(listQueue(db)).toEqual([])
  })
})

describe('endingOf', () => {
  const exit0 = { code: 0, signal: null }
  it('prefers the abort cause, then the session ending, then the exit', () => {
    expect(endingOf('cancelled', { kind: 'completed', text: '', costUsd: 0 }, exit0)).toMatchObject({ ending: 'cancelled' })
    expect(endingOf('restart', null, exit0)).toMatchObject({ ending: 'restart' })
    expect(endingOf(null, { kind: 'no-result' }, exit0)).toMatchObject({ ending: 'no-result' })
    expect(endingOf(null, { kind: 'aborted', reason: 'cancelled' }, exit0)).toMatchObject({ ending: 'cancelled' })
    expect(endingOf(null, null, { code: null, signal: 'SIGKILL' })).toMatchObject({ ending: 'exited', detail: expect.stringContaining('SIGKILL') })
  })
})
