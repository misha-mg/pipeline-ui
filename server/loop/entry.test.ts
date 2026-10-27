import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../session/driver.ts'
import { entryOf, prepareEntry } from './entry.ts'
import { createRunner } from './runner.ts'

const temps: string[] = []
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// A run.sh shaped like webui's: a worktree from origin/master, then the worktree's start.sh.
const RUN_SH = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'key="$1"',
  'main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"',
  'git -C "$main" fetch -q origin',
  'wt="$main/.claude/worktrees/$key"',
  'git -C "$main" worktree add -q --no-track -b "$key" "$wt" origin/master',
  'cd "$wt"',
  'exec tools/ticket-pipeline/start.sh "$@"',
  '',
].join('\n')
const OLD_START = '#!/usr/bin/env bash\necho "plain CLI on $(git rev-parse --abbrev-ref HEAD)"\n'
const NEW_START = '#!/usr/bin/env bash\nif [[ -n ${PIPELINE_SESSION:-} ]]; then "$PIPELINE_SESSION" "/ticket-pipeline $*" "{}" "{}" /runs; exit; fi\necho plain CLI\n'

/** An origin whose master has the old start.sh and whose `entry` branch has the new one, and a clone of it. */
function fakeWebui(runSh = RUN_SH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-entry-'))
  temps.push(dir)
  const origin = path.join(dir, 'origin')
  fs.mkdirSync(path.join(origin, 'tools', 'ticket-pipeline'), { recursive: true })
  git(origin, 'init', '-q', '-b', 'master')
  git(origin, 'config', 'user.email', 't@t')
  git(origin, 'config', 'user.name', 't')
  git(origin, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(origin, 'tools', 'ticket-pipeline', 'run.sh'), runSh, { mode: 0o755 })
  fs.writeFileSync(path.join(origin, 'tools', 'ticket-pipeline', 'start.sh'), OLD_START, { mode: 0o755 })
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'master')
  git(origin, 'checkout', '-q', '-b', 'entry')
  fs.writeFileSync(path.join(origin, 'tools', 'ticket-pipeline', 'start.sh'), NEW_START, { mode: 0o755 })
  git(origin, 'commit', '-q', '-am', 'entry point')
  git(origin, 'checkout', '-q', 'master')
  const webui = path.join(dir, 'webui')
  execFileSync('git', ['clone', '-q', origin, webui])
  git(webui, 'branch', '-q', 'entry', 'origin/entry')
  return { dir, origin, webui, entryDir: path.join(dir, 'data', 'entry') }
}

describe('prepareEntry', () => {
  it('refuses a run while origin/master\'s start.sh has no PIPELINE_SESSION', async () => {
    const w = fakeWebui()
    expect(await prepareEntry({ webuiDir: w.webui, startShRef: null, entryDir: w.entryDir })).toMatch(/origin\/master's start.sh has no PIPELINE_SESSION/)
  })

  it('lets a run start once origin/master has it, through webui\'s own run.sh', async () => {
    const w = fakeWebui()
    git(w.origin, 'merge', '-q', '--ff-only', 'entry')
    const config = { webuiDir: w.webui, startShRef: null, entryDir: w.entryDir }
    expect(await prepareEntry(config)).toBeNull()
    expect(entryOf(config)).toEqual({ runSh: 'tools/ticket-pipeline/run.sh', env: {} })
  })

  it('with a ref, copies origin/master\'s run.sh pointed at that ref\'s start.sh', async () => {
    const w = fakeWebui()
    const config = { webuiDir: w.webui, startShRef: 'entry', entryDir: w.entryDir }
    expect(await prepareEntry(config)).toBeNull()
    const entry = entryOf(config)
    expect(fs.readFileSync(entry.runSh, 'utf8')).toBe(RUN_SH.replace('exec tools/ticket-pipeline/start.sh "$@"', 'exec bash "$PIPELINE_START_SH" "$@"'))
    expect(fs.readFileSync(entry.env.PIPELINE_START_SH!, 'utf8')).toBe(NEW_START)
  })

  it('refuses a ref without the entry point, a missing ref, and a run.sh that no longer hands over the same way', async () => {
    const w = fakeWebui()
    expect(await prepareEntry({ webuiDir: w.webui, startShRef: 'master', entryDir: w.entryDir })).toMatch(/master's start.sh has no PIPELINE_SESSION/)
    expect(await prepareEntry({ webuiDir: w.webui, startShRef: 'nope', entryDir: w.entryDir })).toMatch(/nope has no tools\/ticket-pipeline\/start.sh/)
    const changed = fakeWebui(RUN_SH.replace('exec tools/ticket-pipeline/start.sh "$@"', 'exec tools/ticket-pipeline/start.sh "$key"'))
    expect(await prepareEntry({ webuiDir: changed.webui, startShRef: 'entry', entryDir: changed.entryDir })).toMatch(/no longer ends with/)
  })

  it('says so when origin cannot be fetched', async () => {
    const w = fakeWebui()
    git(w.webui, 'remote', 'set-url', 'origin', path.join(w.dir, 'gone'))
    expect(await prepareEntry({ webuiDir: w.webui, startShRef: 'entry', entryDir: w.entryDir })).toMatch(/git fetch origin failed/)
  })

  it('runs a ticket end to end: a worktree from origin/master, the ref\'s start.sh, the session with pull requests off', async () => {
    const w = fakeWebui()
    const config = { webuiDir: w.webui, startShRef: 'entry', entryDir: w.entryDir }
    expect(await prepareEntry(config)).toBeNull()
    const session = path.join(w.dir, 'session')
    fs.writeFileSync(session, [
      '#!/usr/bin/env bash',
      'echo "prompt=$1 branch=$(git rev-parse --abbrev-ref HEAD) prs=$PIPELINE_SESSION_PULL_REQUESTS"',
      'echo \'{"type":"ended","at":"t","ending":{"kind":"completed","text":"ok","costUsd":0}}\' >&3',
    ].join('\n'), { mode: 0o755 })
    const runner = createRunner({ webuiDir: w.webui, sessionBin: session, envFile: '/nonexistent', sessionTimeoutMs: 1000, entry: entryOf(config), pullRequests: false })
    const events: SessionEvent[] = []
    let output = ''
    const exit = await runner('KAZ-1', { onEvent: (e) => events.push(e), onOutput: (c) => { output += c }, tracePath: '/dev/null' }, new AbortController().signal)
    expect(exit).toEqual({ code: 0, signal: null })
    expect(output).toContain('prompt=/ticket-pipeline KAZ-1 branch=KAZ-1 prs=off')
    expect(events.map((e) => e.type)).toEqual(['ended'])
    // The worktree is origin/master's: the entry point came from outside it.
    expect(fs.readFileSync(path.join(w.webui, '.claude', 'worktrees', 'KAZ-1', 'tools', 'ticket-pipeline', 'start.sh'), 'utf8')).toBe(OLD_START)
  })
})
