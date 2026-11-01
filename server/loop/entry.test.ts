import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../session/driver.ts'
import { entryLabel, entryOf, prepareEntry } from './entry.ts'
import { createRunner } from './runner.ts'

const temps: string[] = []
afterEach(() => { for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true }) })

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * A prepare script shaped like webui's: a worktree from origin/<base>, then the worktree's launch
 * script. `fromBase` false is the script from before PIPELINE_BASE_BRANCH, always from master.
 */
const prepare = ({ fromBase = true, launch = 'launch-session.sh' } = {}) => [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'key="$1"',
  ...(fromBase ? ['export PIPELINE_BASE_BRANCH="${PIPELINE_BASE_BRANCH:-master}"', 'base="$PIPELINE_BASE_BRANCH"'] : ['base=master']),
  'main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"',
  'git -C "$main" fetch -q origin',
  'wt="$main/.claude/worktrees/$key"',
  'git -C "$main" worktree add -q --no-track -b "$key" "$wt" "origin/$base"',
  'cd "$wt"',
  `exec tools/ticket-pipeline/${launch} "$@"`,
  '',
].join('\n')
const OLD_PREPARE = prepare({ fromBase: false })
const PREPARE = prepare()
const PLAIN = '#!/usr/bin/env bash\necho "plain CLI on $(git rev-parse --abbrev-ref HEAD)"\n'
const WITH_SESSION = '#!/usr/bin/env bash\nif [[ -n ${PIPELINE_SESSION:-} ]]; then "$PIPELINE_SESSION" "/ticket-pipeline $*" "{}" "{}" /runs; exit; fi\necho plain CLI\n'

type Files = Record<string, string | null>

/**
 * webui with a master whose prepare script predates the base branch and whose launch script has
 * no entry point, and a dev with both (webui PR #666); a file `base` on each names the branch.
 * `commit` adds a branch or changes one on origin. And a clone of it, the service's checkout.
 */
function fakeWebui() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-entry-'))
  temps.push(dir)
  const origin = path.join(dir, 'origin')
  fs.mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'master')
  git(origin, 'config', 'user.email', 't@t')
  git(origin, 'config', 'user.name', 't')
  git(origin, 'config', 'commit.gpgsign', 'false')
  const commit = (branch: string, files: Files, from = 'master') => {
    const exists = git(origin, 'branch', '--list', branch).trim() !== ''
    git(origin, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch, from]))
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(origin, name)
      if (text === null) fs.rmSync(file, { force: true })
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, text, { mode: 0o755 })
      }
    }
    git(origin, 'add', '-A')
    git(origin, 'commit', '-q', '-m', branch)
    git(origin, 'checkout', '-q', 'master')
  }
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'root')
  commit('master', { base: 'master\n', 'tools/ticket-pipeline/prepare-worktree.sh': OLD_PREPARE, 'tools/ticket-pipeline/launch-session.sh': PLAIN })
  commit('dev', { base: 'dev\n', 'tools/ticket-pipeline/prepare-worktree.sh': PREPARE, 'tools/ticket-pipeline/launch-session.sh': WITH_SESSION })
  const webui = path.join(dir, 'webui')
  execFileSync('git', ['clone', '-q', origin, webui])
  return { dir, origin, webui, entryDir: path.join(dir, 'data', 'entry'), commit }
}

const config = (w: ReturnType<typeof fakeWebui>, baseBranch = 'master') => ({ webuiDir: w.webui, baseBranch, entryDir: w.entryDir })

describe('prepareEntry', () => {
  it('reads a base branch other than master from that branch, and copies its prepare-worktree.sh', async () => {
    const w = fakeWebui()
    const c = config(w, 'dev')
    expect(await prepareEntry(c)).toBeNull()
    expect(entryOf(c)).toEqual({ prepareWorktree: path.join(w.entryDir, 'prepare-worktree.sh') })
    expect(fs.readFileSync(entryOf(c).prepareWorktree, 'utf8')).toBe(PREPARE)
    expect(entryLabel(c)).toBe('worktree and session launch from origin/dev')
  })

  it('refuses master while its launch script has no PIPELINE_SESSION, and takes it once it has', async () => {
    const w = fakeWebui()
    expect(await prepareEntry(config(w))).toBe('origin/master\'s tools/ticket-pipeline/launch-session.sh has no PIPELINE_SESSION: a run would go unwatched to a pull request')
    // On master a prepare script from before PIPELINE_BASE_BRANCH does what it is asked.
    w.commit('master', { 'tools/ticket-pipeline/launch-session.sh': WITH_SESSION })
    expect(await prepareEntry(config(w))).toBeNull()
    expect(fs.readFileSync(entryOf(config(w)).prepareWorktree, 'utf8')).toBe(OLD_PREPARE)
  })

  it('refuses a base other than master whose prepare script has no PIPELINE_BASE_BRANCH', async () => {
    const w = fakeWebui()
    w.commit('old', { 'tools/ticket-pipeline/launch-session.sh': WITH_SESSION })
    expect(await prepareEntry(config(w, 'old'))).toBe('origin/old\'s tools/ticket-pipeline/prepare-worktree.sh has no PIPELINE_BASE_BRANCH: it would build the worktree from master and open the pull request there')
  })

  it('refuses a base without the prepare script or the launch script, and one that does not exist', async () => {
    const w = fakeWebui()
    // The names from before webui's rename are not looked for.
    w.commit('renamed', { 'tools/ticket-pipeline/prepare-worktree.sh': null, 'tools/ticket-pipeline/run.sh': PREPARE }, 'dev')
    expect(await prepareEntry(config(w, 'renamed'))).toBe('origin/renamed has no tools/ticket-pipeline/prepare-worktree.sh')
    w.commit('dangling', { 'tools/ticket-pipeline/prepare-worktree.sh': prepare({ launch: 'gone.sh' }) }, 'dev')
    expect(await prepareEntry(config(w, 'dangling'))).toBe('origin/dangling\'s tools/ticket-pipeline/prepare-worktree.sh hands over to tools/ticket-pipeline/gone.sh, which origin/dangling does not have')
    w.commit('changed', { 'tools/ticket-pipeline/prepare-worktree.sh': PREPARE.replace('"$@"', '"$key"') }, 'dev')
    expect(await prepareEntry(config(w, 'changed'))).toMatch(/^origin\/changed's tools\/ticket-pipeline\/prepare-worktree.sh no longer ends with/)
    expect(await prepareEntry(config(w, 'nope'))).toBe('origin has no branch nope (PIPELINE_BASE_BRANCH)')
    expect(fs.existsSync(w.entryDir)).toBe(false)
  })

  it('says so when origin cannot be fetched', async () => {
    const w = fakeWebui()
    git(w.webui, 'remote', 'set-url', 'origin', path.join(w.dir, 'gone'))
    expect(await prepareEntry(config(w, 'dev'))).toMatch(/git fetch origin failed/)
  })
})

describe('a run through the entry point', () => {
  const session = (dir: string) => {
    const file = path.join(dir, 'session')
    fs.writeFileSync(file, [
      '#!/usr/bin/env bash',
      'echo "prompt=$1 branch=$(git rev-parse --abbrev-ref HEAD) from=$(cat base) base=$PIPELINE_BASE_BRANCH prs=$PIPELINE_SESSION_PULL_REQUESTS"',
      'echo \'{"type":"ended","at":"t","ending":{"kind":"completed","text":"ok","costUsd":0}}\' >&3',
    ].join('\n'), { mode: 0o755 })
    return file
  }
  const runKaz1 = async (w: ReturnType<typeof fakeWebui>, baseBranch: string, pullRequests: boolean) => {
    const c = config(w, baseBranch)
    expect(await prepareEntry(c)).toBeNull()
    const runner = createRunner({ webuiDir: w.webui, sessionBin: session(w.dir), envFile: '/nonexistent', sessionTimeoutMs: 1000, baseBranch, entry: entryOf(c), pullRequests })
    const events: SessionEvent[] = []
    let output = ''
    const exit = await runner('KAZ-1', { onEvent: (e) => events.push(e), onOutput: (o) => { output += o }, tracePath: '/dev/null' }, new AbortController().signal)
    return { exit, events, output }
  }

  it('from dev: the worktree and launch-session.sh are dev\'s while the checkout is on master', async () => {
    const w = fakeWebui()
    const r = await runKaz1(w, 'dev', false)
    expect(r.exit).toEqual({ code: 0, signal: null })
    expect(r.output).toContain('prompt=/ticket-pipeline KAZ-1 branch=KAZ-1 from=dev base=dev prs=off')
    expect(r.events.map((e) => e.type)).toEqual(['ended'])
  })

  it('from master once it has the entry point, pull requests on', async () => {
    const w = fakeWebui()
    w.commit('master', { 'tools/ticket-pipeline/launch-session.sh': WITH_SESSION })
    const r = await runKaz1(w, 'master', true)
    expect(r.exit).toEqual({ code: 0, signal: null })
    expect(r.output).toContain('prompt=/ticket-pipeline KAZ-1 branch=KAZ-1 from=master base=master prs=on')
  })
})
