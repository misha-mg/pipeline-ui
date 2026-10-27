// Where things are, from the environment with defaults for the server the pipeline runs on.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  /** This repository. */
  repo: string
  /** The webui checkout a run starts in (its origin/master's prepare-worktree.sh, entry.ts). */
  webuiDir: string
  runsDir: string
  dataDir: string
  dbPath: string
  logDir: string
  /** The secrets file the run's environment is read from (never printed). */
  envFile: string
  sessionBin: string
  /** How long one session may take before the driver ends it. */
  sessionTimeoutMs: number
  /** The console's address. */
  host: string
  port: number
  /** The built UI, served when it is there. */
  uiDir: string
  /** The ref whose launch-session.sh launches the session instead of origin/master's (entry.ts). */
  launchSessionRef: string | null
  /** Where the copies of the entry point's scripts go. */
  entryDir: string
  /** Whether a run may push and open its pull request; off by default with a launch ref. */
  pullRequests: boolean
}

const DEFAULT_TIMEOUT_HOURS = 4

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const webuiDir = env.PIPELINE_WEBUI ?? path.resolve(repo, '..', 'webui')
  const dataDir = env.PIPELINE_DATA ?? path.join(repo, 'data')
  // PIPELINE_START_SH_REF is the name from before webui renamed start.sh; still read.
  const launchSessionRef = env.PIPELINE_LAUNCH_SESSION_REF?.trim() || env.PIPELINE_START_SH_REF?.trim() || null
  const pr = env.PIPELINE_PULL_REQUESTS?.trim()
  if (pr && pr !== 'on' && pr !== 'off') throw new Error(`PIPELINE_PULL_REQUESTS is on or off, not ${pr}`)
  return {
    repo,
    webuiDir,
    runsDir: path.join(webuiDir, '.pipeline-runs'),
    dataDir,
    dbPath: path.join(dataDir, 'pipeline.db'),
    logDir: path.join(dataDir, 'logs'),
    envFile: env.PIPELINE_ENV ?? path.join(os.homedir(), '.config', 'webui-pipeline.env'),
    sessionBin: path.join(repo, 'bin', 'session'),
    sessionTimeoutMs: Number(env.PIPELINE_TIMEOUT_HOURS ?? DEFAULT_TIMEOUT_HOURS) * 3600 * 1000,
    host: env.PIPELINE_HOST ?? '0.0.0.0',
    port: Number(env.PIPELINE_PORT ?? 8787),
    uiDir: path.join(repo, 'ui', 'dist'),
    launchSessionRef,
    entryDir: path.join(dataDir, 'entry'),
    // A launch script from a branch is a workaround while origin/master lacks it: a test run, no PR.
    pullRequests: pr ? pr === 'on' : launchSessionRef === null,
  }
}
