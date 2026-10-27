// Where things are, from the environment with defaults for the server the pipeline runs on.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type Config = {
  /** This repository. */
  repo: string
  /** The webui checkout whose tools/ticket-pipeline/run.sh starts a run. */
  webuiDir: string
  runsDir: string
  dataDir: string
  dbPath: string
  logDir: string
  /** The secrets file run.sh's environment is read from (never printed). */
  envFile: string
  sessionBin: string
  /** How long one session may take before the driver ends it. */
  sessionTimeoutMs: number
  /** The console's address. */
  host: string
  port: number
  /** The built UI, served when it is there. */
  uiDir: string
}

const DEFAULT_TIMEOUT_HOURS = 4

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const webuiDir = env.PIPELINE_WEBUI ?? path.resolve(repo, '..', 'webui')
  const dataDir = env.PIPELINE_DATA ?? path.join(repo, 'data')
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
  }
}
