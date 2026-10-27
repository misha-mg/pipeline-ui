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

/** A prepare script shaped like webui's: a worktree from origin/master, then the worktree's launch script. */
const prepare = (launch: string) => [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'key="$1"',
  'main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"',
  'git -C "$main" fetch -q origin',
  'wt="$main/.claude/worktrees/$key"',
  'git -C "$main" worktree add -q --no-track -b "$key" "$wt" origin/master',
  'cd "$wt"',
  `exec tools/ticket-pipeline/${launch} "$@"`,
  '',
].join('\n')
const RUN_SH = prepare('start.sh')
const PREPARE_WORKTREE = prepare('launch-session.sh')
const PLAIN = '#!/usr/bin/env bash\necho "plain CLI on $(git rev-parse --abbrev-ref HEAD)"\n'
const WITH_SESSION = '#!/usr/bin/env bash\nif [[ -n ${PIPELINE_SESSION:-} ]]; then "$PIPELINE_SESSION" "/ticket-pipeline $*" "{}" "{}" /runs; exit; fi\necho plain CLI\n'

/**
 * webui as it stands during the freeze: master with run.sh and a start.sh without the entry
 * point; `legacy` with the entry point in start.sh (10a2022ee); `entry` with the scripts renamed
 * on top of it (214abfefb). And a clone of it, the service's webui checkout.
 */
function fakeWebui(masterRunSh = RUN_SH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-entry-'))
  temps.push(dir)
  const origin = path.join(dir, 'origin')
  const tools = path.join(origin, 'tools', 'ticket-pipeline')
  const put = (name: string, text: string) => fs.writeFileSync(path.join(tools, name), text, { mode: 0o755 })
  fs.mkdirSync(tools, { recursive: true })
  git(origin, 'init', '-q', '-b', 'master')
  git(origin, 'config', 'user.email', 't@t')
  git(origin, 'config', 'user.name', 't')
  git(origin, 'config', 'commit.gpgsign', 'false')
  put('run.sh', masterRunSh)
  put('start.sh', PLAIN)
  git(origin, 'add', '.')
  git(origin, 'commit', '-q', '-m', 'master')
  git(origin, 'checkout', '-q', '-b', 'legacy')
  put('start.sh', WITH_SESSION)
  git(origin, 'commit', '-q', '-am', 'entry point')
  git(origin, 'checkout', '-q', '-b', 'entry')
  git(origin, 'mv', 'tools/ticket-pipeline/run.sh', 'tools/ticket-pipeline/prepare-worktree.sh')
  git(origin, 'mv', 'tools/ticket-pipeline/start.sh', 'tools/ticket-pipeline/launch-session.sh')
  put('prepare-worktree.sh', PREPARE_WORKTREE)
  git(origin, 'commit', '-q', '-am', 'rename')
  git(origin, 'checkout', '-q', 'master')
  const webui = path.join(dir, 'webui')
  execFileSync('git', ['clone', '-q', origin, webui])
  for (const b of ['legacy', 'entry']) git(webui, 'branch', '-q', b, `origin/${b}`)
  return { dir, origin, webui, entryDir: path.join(dir, 'data', 'entry') }
}

const config = (w: ReturnType<typeof fakeWebui>, launchSessionRef: string | null) => ({ webuiDir: w.webui, launchSessionRef, entryDir: w.entryDir })

describe('prepareEntry', () => {
  it('refuses a run while origin/master\'s launch script has no PIPELINE_SESSION', async () => {
    const w = fakeWebui()
    expect(await prepareEntry(config(w, null))).toMatch(/origin\/master's tools\/ticket-pipeline\/start.sh has no PIPELINE_SESSION/)
  })

  it('lets a run start once origin/master has the renamed scripts, through a copy of its prepare-worktree.sh', async () => {
    const w = fakeWebui()
    git(w.origin, 'merge', '-q', '--ff-only', 'entry')
    const c = config(w, null)
    expect(await prepareEntry(c)).toBeNull()
    const entry = entryOf(c)
    expect(entry).toEqual({ prepareWorktree: path.join(w.entryDir, 'prepare-worktree.sh'), env: {} })
    expect(fs.readFileSync(entry.prepareWorktree, 'utf8')).toBe(PREPARE_WORKTREE)
  })

  it('with a ref, copies origin/master\'s run.sh pointed at that ref\'s launch-session.sh', async () => {
    const w = fakeWebui()
    const c = config(w, 'entry')
    expect(await prepareEntry(c)).toBeNull()
    const entry = entryOf(c)
    expect(fs.readFileSync(entry.prepareWorktree, 'utf8')).toBe(RUN_SH.replace('exec tools/ticket-pipeline/start.sh "$@"', 'exec bash "$PIPELINE_LAUNCH_SESSION" "$@"'))
    expect(fs.readFileSync(entry.env.PIPELINE_LAUNCH_SESSION!, 'utf8')).toBe(WITH_SESSION)
  })

  it('with a ref from before the rename, takes its start.sh', async () => {
    const w = fakeWebui()
    const c = config(w, 'legacy')
    expect(await prepareEntry(c)).toBeNull()
    expect(fs.readFileSync(entryOf(c).env.PIPELINE_LAUNCH_SESSION!, 'utf8')).toBe(WITH_SESSION)
  })

  it('refuses a ref without the entry point, a missing ref, and a prepare script that hands over another way or to nothing', async () => {
    const w = fakeWebui()
    expect(await prepareEntry(config(w, 'master'))).toMatch(/master's tools\/ticket-pipeline\/start.sh has no PIPELINE_SESSION \(PIPELINE_LAUNCH_SESSION_REF\)/)
    expect(await prepareEntry(config(w, 'nope'))).toMatch(/nope has neither tools\/ticket-pipeline\/launch-session.sh nor tools\/ticket-pipeline\/start.sh/)
    const changed = fakeWebui(RUN_SH.replace('exec tools/ticket-pipeline/start.sh "$@"', 'exec tools/ticket-pipeline/start.sh "$key"'))
    expect(await prepareEntry(config(changed, 'entry'))).toMatch(/run.sh no longer ends with/)
    const dangling = fakeWebui(prepare('gone.sh'))
    expect(await prepareEntry(config(dangling, null))).toMatch(/hands over to tools\/ticket-pipeline\/gone.sh, which origin\/master does not have/)
  })

  it('says so when origin cannot be fetched', async () => {
    const w = fakeWebui()
    git(w.webui, 'remote', 'set-url', 'origin', path.join(w.dir, 'gone'))
    expect(await prepareEntry(config(w, 'entry'))).toMatch(/git fetch origin failed/)
  })
})

describe('a run through the entry point', () => {
  const session = (dir: string) => {
    const file = path.join(dir, 'session')
    fs.writeFileSync(file, [
      '#!/usr/bin/env bash',
      'echo "prompt=$1 branch=$(git rev-parse --abbrev-ref HEAD) prs=$PIPELINE_SESSION_PULL_REQUESTS"',
      'echo \'{"type":"ended","at":"t","ending":{"kind":"completed","text":"ok","costUsd":0}}\' >&3',
    ].join('\n'), { mode: 0o755 })
    return file
  }
  const runKaz1 = async (w: ReturnType<typeof fakeWebui>, ref: string | null, pullRequests: boolean) => {
    const c = config(w, ref)
    expect(await prepareEntry(c)).toBeNull()
    // The checkout is on another branch: the run does not depend on it.
    git(w.webui, 'checkout', '-q', 'legacy')
    const runner = createRunner({ webuiDir: w.webui, sessionBin: session(w.dir), envFile: '/nonexistent', sessionTimeoutMs: 1000, entry: entryOf(c), pullRequests })
    const events: SessionEvent[] = []
    let output = ''
    const exit = await runner('KAZ-1', { onEvent: (e) => events.push(e), onOutput: (o) => { output += o }, tracePath: '/dev/null' }, new AbortController().signal)
    return { exit, events, output, tools: path.join(w.webui, '.claude', 'worktrees', 'KAZ-1', 'tools', 'ticket-pipeline') }
  }

  it('during the freeze: a worktree from origin/master, the ref\'s launch-session.sh, pull requests off', async () => {
    const r = await runKaz1(fakeWebui(), 'entry', false)
    expect(r.exit).toEqual({ code: 0, signal: null })
    expect(r.output).toContain('prompt=/ticket-pipeline KAZ-1 branch=KAZ-1 prs=off')
    expect(r.events.map((e) => e.type)).toEqual(['ended'])
    // The worktree is origin/master's: the entry point came from outside it.
    expect(fs.readFileSync(path.join(r.tools, 'start.sh'), 'utf8')).toBe(PLAIN)
  })

  it('after the freeze: origin/master\'s own prepare-worktree.sh and launch-session.sh, pull requests on', async () => {
    const w = fakeWebui()
    git(w.origin, 'merge', '-q', '--ff-only', 'entry')
    const r = await runKaz1(w, null, true)
    expect(r.exit).toEqual({ code: 0, signal: null })
    expect(r.output).toContain('prompt=/ticket-pipeline KAZ-1 branch=KAZ-1 prs=on')
    expect(r.events.map((e) => e.type)).toEqual(['ended'])
    expect(fs.existsSync(path.join(r.tools, 'launch-session.sh'))).toBe(true)
  })
})
