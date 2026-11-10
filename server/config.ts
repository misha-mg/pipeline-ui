// Every setting the service and its commands read, from the environment through one schema
// into one typed Config: where things are (with defaults for the server the pipeline runs on),
// Jira and Bitbucket, the console's address, its known host names and its optional login. Read
// once, at start; a bad value stops the process at once with every problem named. No other
// module reads process.env for its settings (the run's own environment, runner.ts, is the one
// exception: the pipeline's secrets file is passed to the run as it is).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { bitbucketConfig, type BitbucketConfig } from './history/bitbucket.ts'
import { guardFromEnv, type Guard } from './http/guard.ts'
import { jiraConfig, jiraSiteUrl, type JiraConfig } from './store/jira.ts'
import type { RunSettings } from './store/settings.ts'

/**
 * PIPELINE_PULL_REQUESTS: `on` lets the run open the pull request it decides on, ready or draft;
 * `draft` lets it open drafts only; `off` refuses every push and pull request.
 */
export type PullRequests = 'on' | 'off' | 'draft'

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
  /** How long one session may take before the driver ends it: the default, until the console sets another. */
  sessionTimeoutMs: number
  /** The console's address. */
  host: string
  port: number
  /** The built UI, served when it is there. */
  uiDir: string
  /** The webui branch a run's worktree starts from and its pull request goes to (entry.ts): the default, until the console sets another (store/settings.ts). */
  baseBranch: string
  /** Where the copy of the entry point's prepare script goes. */
  entryDir: string
  /** Whether a run may push and open its pull request, and whether that pull request is always a draft: the default, as the base branch is. */
  pullRequests: PullRequests
  /** Jira, for a queued ticket's summary, the search and the tickets' statuses; null without the site or the credentials. */
  jira: JiraConfig | null
  /** The Jira site a ticket key links to; null when it is not set. */
  jiraSite: string | null
  /** Bitbucket, for the pull requests' states; null without the token. */
  bitbucket: BitbucketConfig | null
  /** The console's guard: the host names it answers to and its login (guard.ts). */
  guard: Guard
  /** Where `maintain` puts the database's backups. */
  backupDir: string
  /** The service's log file, as the unit appends it; `maintain` cuts it down. */
  logFile: string
}

const DEFAULT_TIMEOUT_HOURS = 4
const GONE = 'is no longer read: set PIPELINE_BASE_BRANCH (and PIPELINE_PULL_REQUESTS=off for a run that must not open a pull request)'
const optionalPath = z.string().trim().min(1).optional()
const httpUrl = (v: string) => {
  try {
    const { protocol } = new URL(v)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** The environment as the service reads it; `.env.example` documents each name. */
export const Env = z
  .object({
    PIPELINE_WEBUI: optionalPath,
    PIPELINE_DATA: optionalPath,
    PIPELINE_ENV: optionalPath,
    PIPELINE_TIMEOUT_HOURS: z.coerce.number().positive().default(DEFAULT_TIMEOUT_HOURS),
    PIPELINE_HOST: z.string().trim().min(1).default('0.0.0.0'),
    PIPELINE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    PIPELINE_BASE_BRANCH: z.string().trim().default(''),
    PIPELINE_PULL_REQUESTS: z.preprocess(
      (v) => (typeof v === 'string' ? v.trim() || undefined : v),
      z.enum(['on', 'off', 'draft'], { error: (issue) => `is on, draft or off, not ${String(issue.input)}` }).default('on'),
    ),
    // The code freeze's workaround, replaced by the base branch: refused rather than ignored,
    // since it used to turn pull requests off.
    PIPELINE_LAUNCH_SESSION_REF: z
      .string()
      .optional()
      .refine((v) => !v?.trim(), GONE),
    PIPELINE_START_SH_REF: z
      .string()
      .optional()
      .refine((v) => !v?.trim(), GONE),
    // The console: the host names it answers to besides addresses and this machine's, and a login.
    PIPELINE_HOSTNAMES: z.string().default(''),
    PIPELINE_USER: z.string().optional(),
    PIPELINE_PASSWORD: z.string().optional(),
    PIPELINE_BACKUP_DIR: optionalPath,
    PIPELINE_LOG_FILE: optionalPath,
    JIRA_BASE_URL: z
      .string()
      .trim()
      .optional()
      .refine((v) => !v || httpUrl(v), 'is the Jira site with its scheme, such as https://your-site.atlassian.net'),
    JIRA_EMAIL: z.string().optional(),
    JIRA_API_TOKEN: z.string().optional(),
    JIRA_CLOUD_ID: z.string().optional(),
    BITBUCKET_TOKEN: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (Boolean(e.PIPELINE_USER) !== Boolean(e.PIPELINE_PASSWORD))
      ctx.addIssue({
        code: 'custom',
        path: ['PIPELINE_USER'],
        message: 'and PIPELINE_PASSWORD go together: set both for a login, neither for none',
      })
  })

/**
 * The environment through a schema. For the process's own environment, the repository's `.env`
 * is loaded first (a variable already set wins, so bin/pipeline's sourcing of it changes
 * nothing). Fails fast with every problem named.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined>,
  envFile = path.join(REPO, '.env'),
): z.infer<T> {
  if (env === process.env && fs.existsSync(envFile)) process.loadEnvFile(envFile)
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`)
    throw new Error(`Bad configuration: ${problems.join('; ')}`)
  }
  return parsed.data
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The environment's value of each run setting: what a run starts with until the console sets another. */
export function runDefaults(config: Pick<Config, 'baseBranch' | 'pullRequests' | 'sessionTimeoutMs'>): RunSettings {
  return { baseBranch: config.baseBranch, pullRequests: config.pullRequests, timeoutHours: config.sessionTimeoutMs / 3600 / 1000 }
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const e = parseEnv(Env, env)
  const repo = REPO
  const webuiDir = e.PIPELINE_WEBUI ?? path.resolve(repo, '..', 'webui')
  const dataDir = e.PIPELINE_DATA ?? path.join(repo, 'data')
  return {
    repo,
    webuiDir,
    runsDir: path.join(webuiDir, '.pipeline-runs'),
    dataDir,
    dbPath: path.join(dataDir, 'pipeline.db'),
    logDir: path.join(dataDir, 'logs'),
    envFile: e.PIPELINE_ENV ?? path.join(os.homedir(), '.config', 'webui-pipeline.env'),
    sessionBin: path.join(repo, 'bin', 'session'),
    sessionTimeoutMs: e.PIPELINE_TIMEOUT_HOURS * 3600 * 1000,
    host: e.PIPELINE_HOST,
    port: e.PIPELINE_PORT,
    uiDir: path.join(repo, 'ui', 'dist'),
    baseBranch: e.PIPELINE_BASE_BRANCH || 'master',
    entryDir: path.join(dataDir, 'entry'),
    pullRequests: e.PIPELINE_PULL_REQUESTS,
    jira: jiraConfig(e),
    jiraSite: jiraSiteUrl(e),
    bitbucket: bitbucketConfig(e),
    guard: guardFromEnv(e.PIPELINE_HOSTNAMES, e.PIPELINE_USER, e.PIPELINE_PASSWORD, 'Pipeline console'),
    backupDir: e.PIPELINE_BACKUP_DIR ?? path.join(dataDir, 'backups'),
    logFile: e.PIPELINE_LOG_FILE ?? path.join(dataDir, 'serve.log'),
  }
}
