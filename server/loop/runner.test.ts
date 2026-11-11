import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../session/driver.ts'
import { createRunner, parseEvent } from './runner.ts'

const temps: string[] = []
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true })
})

/** A fake webui checkout whose prepare-worktree.sh runs `body` with the key in $1. */
function fakeWebui(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-runner-'))
  temps.push(dir)
  fs.mkdirSync(path.join(dir, 'tools', 'ticket-pipeline'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tools', 'ticket-pipeline', 'prepare-worktree.sh'), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
  return dir
}

function collect() {
  const events: SessionEvent[] = []
  const trace: string[] = []
  let output = ''
  return {
    events,
    trace,
    output: () => output,
    handlers: {
      onEvent: (e: SessionEvent) => events.push(e),
      onOutput: (c: string) => {
        output += c
      },
      onTrace: (line: string) => trace.push(line),
      tracePath: '/dev/null',
    },
  }
}

describe('createRunner', () => {
  it('asks for its settings when a run starts, so the next run takes a changed base branch', async () => {
    const webui = fakeWebui('echo "base=$PIPELINE_BASE_BRANCH prs=$PIPELINE_SESSION_PULL_REQUESTS ms=$PIPELINE_SESSION_TIMEOUT_MS"')
    const settings = { baseBranch: 'master', pullRequests: 'on' as 'on' | 'draft', sessionTimeoutMs: 1000 }
    const runner = createRunner(() => ({ webuiDir: webui, sessionBin: '/bin/true', envFile: '/nonexistent', drainMs: 50, ...settings }))
    const first = collect()
    await runner('KAZ-1', first.handlers, new AbortController().signal)
    expect(first.output()).toContain('base=master prs=on ms=1000')
    Object.assign(settings, { baseBranch: 'dev', pullRequests: 'draft', sessionTimeoutMs: 2000 })
    const second = collect()
    await runner('KAZ-2', second.handlers, new AbortController().signal)
    expect(second.output()).toContain('base=dev prs=draft ms=2000')
  })

  it('runs prepare-worktree.sh with the key, the session env and the events pipe on fd 3, and reports the exit', async () => {
    const webui = fakeWebui(
      [
        'echo "key=$1 session=$PIPELINE_SESSION base=$PIPELINE_BASE_BRANCH fd=$PIPELINE_EVENTS_FD api=${ANTHROPIC_API_KEY:-unset} secret=${FROM_ENV_FILE:-unset}"',
        'echo err >&2',
        '{ echo \'{"type":"init","at":"t","version":"1","model":"m","mcp":{}}\'; echo not-json; echo \'{"type":"ended","at":"t","ending":{"kind":"completed","text":"ok","costUsd":0}}\'; } >&3',
        'exit 3',
      ].join('\n'),
    )
    const envFile = path.join(webui, 'secrets.env')
    fs.writeFileSync(envFile, 'FROM_ENV_FILE=yes\n')
    process.env.ANTHROPIC_API_KEY = 'must-not-leak'
    // The service's own environment does not decide the base branch: its config does.
    process.env.PIPELINE_BASE_BRANCH = 'from-the-environment'
    const runner = createRunner({ webuiDir: webui, sessionBin: '/x/session', envFile, sessionTimeoutMs: 1000, baseBranch: 'dev' })
    const c = collect()
    const exit = await runner('KAZ-1', c.handlers, new AbortController().signal)
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.PIPELINE_BASE_BRANCH
    expect(exit).toEqual({ code: 3, signal: null })
    expect(c.output()).toContain('key=KAZ-1 session=/x/session base=dev fd=3 api=unset secret=yes')
    expect(c.output()).toContain('err')
    expect(c.output()).toContain('[events] not-json')
    expect(c.events.map((e) => e.type)).toEqual(['init', 'ended'])
  })

  it("passes prepare-worktree.sh's own trace line by line, out of the log; the launch script it hands over to is not traced", async () => {
    const webui = fakeWebui(['echo prepared', "printf 'echo launched\\n' > launch.sh", 'exec bash launch.sh "$1"'].join('\n'))
    const runner = createRunner({
      webuiDir: webui,
      sessionBin: '/x',
      envFile: '/nonexistent',
      sessionTimeoutMs: 1000,
      baseBranch: 'master',
      drainMs: 50,
    })
    const c = collect()
    await runner('KAZ-1', c.handlers, new AbortController().signal)
    expect(c.trace).toEqual(['+ echo prepared', "+ printf 'echo launched\\n'", '+ exec bash launch.sh KAZ-1'])
    expect(c.output()).toBe('prepared\nlaunched\n')
  })

  it('cancels by signalling the process group', async () => {
    const webui = fakeWebui("trap 'echo got-term; exit 0' TERM\nsleep 30 & wait $!\necho after")
    const runner = createRunner({
      webuiDir: webui,
      sessionBin: '/x',
      envFile: '/nonexistent',
      sessionTimeoutMs: 1000,
      baseBranch: 'master',
      killAfterMs: 2000,
    })
    const c = collect()
    const controller = new AbortController()
    const run = runner('KAZ-1', c.handlers, controller.signal)
    await new Promise((r) => setTimeout(r, 300))
    controller.abort('cancelled')
    const exit = await run
    expect(c.output()).toContain('cancelling the run (cancelled)')
    expect(c.output()).toContain('got-term')
    expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true)
  })

  it('reports a prepare-worktree.sh that cannot start', async () => {
    const runner = createRunner({
      webuiDir: '/nonexistent-webui',
      sessionBin: '/x',
      envFile: '/none',
      sessionTimeoutMs: 1000,
      baseBranch: 'master',
    })
    const c = collect()
    const exit = await runner('KAZ-1', c.handlers, new AbortController().signal)
    expect(exit.code).not.toBe(0)
    expect(c.output()).toMatch(/could not be started|No such file/)
  })
})

describe('parseEvent', () => {
  it('accepts only the session events', () => {
    expect(parseEvent('{"type":"turn","at":"t","subtype":"success","isError":false,"turns":1,"costUsd":0,"text":""}')).toMatchObject({
      type: 'turn',
    })
    expect(parseEvent('{"type":"other","at":"t"}')).toBeNull()
    expect(parseEvent('{"type":"init"}')).toBeNull()
    expect(parseEvent('plain text')).toBeNull()
  })
})
