// The state of what the console depends on: the runs directory, the tmux session batch.sh
// uses (the service and a batch never run at the same time), Jira, the device mock and
// Bitbucket. Each check says ok or not with a detail; what does not depend on a failed one
// keeps working. The service runs the checks in the background and serves the last result.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Config } from './config.ts'
import { bitbucketConfig } from './history/bitbucket.ts'
import { jiraConfig, jiraLookup } from './store/jira.ts'

export type Check = { ok: boolean; detail: string; checkedAt: string }
export type Health = Record<'runsDir' | 'tmux' | 'jira' | 'mock' | 'bitbucket', Check>

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
  const [runsDir, tmux, jira, mock, bitbucket] = await Promise.all([
    checkRunsDir(config.runsDir),
    checkTmux(run),
    checkJira(env, fetchFn),
    checkMock(config.webuiDir, run),
    checkBitbucket(env, fetchFn),
  ])
  const at = now()
  const stamp = (c: Omit<Check, 'checkedAt'>): Check => ({ ...c, checkedAt: at })
  return { runsDir: stamp(runsDir), tmux: stamp(tmux), jira: stamp(jira), mock: stamp(mock), bitbucket: stamp(bitbucket) }
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
  return { ok: true, detail: has.output.includes('no server') || has.output.includes('No such file') ? 'no tmux server, no batch running' : 'no batch.sh session' }
}

async function checkJira(env: Record<string, string | undefined>, fetchFn: typeof fetch): Promise<Omit<Check, 'checkedAt'>> {
  const config = jiraConfig(env)
  if (!config) return { ok: false, detail: 'JIRA_EMAIL and JIRA_API_TOKEN are not set: tickets are queued without a summary' }
  const probe = await jiraLookup(config, fetchFn)('KAZ-1')
  if (probe.kind === 'unavailable') return { ok: false, detail: probe.error }
  return { ok: true, detail: config.siteUrl }
}

async function checkMock(webuiDir: string, run: NonNullable<HealthDeps['run']>): Promise<Omit<Check, 'checkedAt'>> {
  const rpc = path.join(webuiDir, 'tools', 'device-mock', 'rpc.sh')
  if (!fs.existsSync(rpc)) return { ok: false, detail: `${rpc} is not there` }
  const board = await run(rpc, ['board'], webuiDir)
  const type = board.output.match(/BOARD-TYPE[^A-Za-z0-9]*([A-Za-z0-9-]+)/)?.[1]
  if (type) return { ok: true, detail: `board ${type}` }
  return { ok: false, detail: `the mock does not answer: ${board.output.trim().split('\n')[0] ?? ''}`.trim() }
}

async function checkBitbucket(env: Record<string, string | undefined>, fetchFn: typeof fetch): Promise<Omit<Check, 'checkedAt'>> {
  const config = bitbucketConfig(env)
  const workspace = env.BITBUCKET_WORKSPACE
  if (!config || !workspace) return { ok: false, detail: 'BITBUCKET_TOKEN or BITBUCKET_WORKSPACE is not set: pull-request states are unknown' }
  try {
    const res = await fetchFn(`https://api.bitbucket.org/2.0/repositories/${workspace}/webui?fields=full_name`, { headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    return res.ok ? { ok: true, detail: `${workspace}/webui` } : { ok: false, detail: `Bitbucket answered ${res.status}` }
  } catch (error) {
    return { ok: false, detail: message(error) }
  }
}

async function defaultRun(file: string, args: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await exec(file, args, { cwd, timeout: TIMEOUT_MS, env: { ...process.env, TMPDIR: process.env.TMPDIR ?? '/tmp' } })
    return { ok: true, output: stdout + stderr }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') + (e.message ?? '') }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
