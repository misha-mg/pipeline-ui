// The state of what the console depends on: the runs directory, the tmux session batch.sh
// uses (the service and a batch never run at the same time) and Jira. Each check says ok or not
// with a detail; what does not depend on a failed one keeps working. The service runs the checks
// in the background and serves the last result. The device mock is not checked (the agents switch
// its board while they work, so its state says nothing about the console), nor Bitbucket (a
// pull request's state shows as unknown in the runs without it).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import type { Config } from './config.ts'
import { JIRA_SETTINGS, jiraConfig, jiraLookup } from './store/jira.ts'

export type Check = { ok: boolean; detail: string; checkedAt: string }
export type Health = Record<'runsDir' | 'tmux' | 'jira', Check>

const exec = promisify(execFile)
const TIMEOUT_MS = 15_000

export type HealthDeps = {
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  /** Runs a command and resolves with its stdout+stderr and whether it exited 0. */
  run?: (file: string, args: string[], cwd?: string) => Promise<{ ok: boolean; output: string }>
  now?: () => string
}

export async function checkHealth(config: Config, deps: HealthDeps = {}): Promise<Health> {
  const env = deps.env ?? process.env
  const fetchFn = deps.fetch ?? fetch
  const run = deps.run ?? defaultRun
  const now = deps.now ?? (() => new Date().toISOString())
  const [runsDir, tmux, jira] = await Promise.all([checkRunsDir(config.runsDir), checkTmux(run), checkJira(env, fetchFn)])
  const at = now()
  const stamp = (c: Omit<Check, 'checkedAt'>): Check => ({ ...c, checkedAt: at })
  return { runsDir: stamp(runsDir), tmux: stamp(tmux), jira: stamp(jira) }
}

async function checkRunsDir(runsDir: string): Promise<Omit<Check, 'checkedAt'>> {
  try {
    fs.accessSync(runsDir, fs.constants.R_OK)
    const runs = fs.readdirSync(runsDir).filter((n) => /^[A-Z]+-\d+$/.test(n)).length
    return { ok: true, detail: `${runsDir}: ${runs} tickets` }
  } catch (error) {
    return { ok: false, detail: `${runsDir}: ${message(error)}` }
  }
}

async function checkTmux(run: NonNullable<HealthDeps['run']>): Promise<Omit<Check, 'checkedAt'>> {
  const has = await run('tmux', ['has-session', '-t', 'pipeline'])
  if (has.ok) return { ok: false, detail: 'a batch.sh session is running (tmux pipeline): do not start the loop' }
  return {
    ok: true,
    detail:
      has.output.includes('no server') || has.output.includes('No such file') ? 'no tmux server, no batch running' : 'no batch.sh session',
  }
}

async function checkJira(env: Record<string, string | undefined>, fetchFn: typeof fetch): Promise<Omit<Check, 'checkedAt'>> {
  const config = jiraConfig(env)
  if (!config) return { ok: false, detail: `${JIRA_SETTINGS} are not all set: tickets are queued without a summary` }
  const probe = await jiraLookup(config, fetchFn)('KAZ-1')
  if (probe.kind === 'unavailable') return { ok: false, detail: probe.error }
  return { ok: true, detail: config.siteUrl }
}

async function defaultRun(file: string, args: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      cwd,
      timeout: TIMEOUT_MS,
      env: { ...process.env, TMPDIR: process.env.TMPDIR ?? '/tmp' },
    })
    return { ok: true, output: stdout + stderr }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '') }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
