// Where things are, from the environment with defaults for the server the pipeline runs on.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  /** This repository. */
  repo: string
  /** The webui checkout a run starts in (its origin/<baseBranch>'s prepare-worktree.sh, entry.ts). */
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
  /** The webui branch a run's worktree starts from and its pull request goes to (entry.ts). */
  baseBranch: string
  /** Where the copy of the entry point's prepare script goes. */
  entryDir: string
  /** Whether a run may push and open its pull request, and whether that pull request is always a draft. */
  pullRequests: PullRequests
}

/**
 * PIPELINE_PULL_REQUESTS: `on` lets the run open the pull request it decides on, ready or draft;
 * `draft` lets it open drafts only; `off` refuses every push and pull request.
 */
export type PullRequests = 'on' | 'off' | 'draft'
const PULL_REQUESTS: readonly string[] = ['on', 'off', 'draft']

const DEFAULT_TIMEOUT_HOURS = 4

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const webuiDir = env.PIPELINE_WEBUI ?? path.resolve(repo, '..', 'webui')
  const dataDir = env.PIPELINE_DATA ?? path.join(repo, 'data')
  // The code freeze's workaround, replaced by the base branch: refused rather than ignored, since
  // it used to turn pull requests off.
  for (const gone of ['PIPELINE_LAUNCH_SESSION_REF', 'PIPELINE_START_SH_REF']) {
    if (env[gone]?.trim())
      throw new Error(
        `${gone} is no longer read: set PIPELINE_BASE_BRANCH (and PIPELINE_PULL_REQUESTS=off for a run that must not open a pull request)`,
      )
  }
  const baseBranch = env.PIPELINE_BASE_BRANCH?.trim() || 'master'
  const pr = env.PIPELINE_PULL_REQUESTS?.trim()
  if (pr && !PULL_REQUESTS.includes(pr)) throw new Error(`PIPELINE_PULL_REQUESTS is on, draft or off, not ${pr}`)
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
    baseBranch,
    entryDir: path.join(dataDir, 'entry'),
    pullRequests: (pr || 'on') as PullRequests,
  }
}
