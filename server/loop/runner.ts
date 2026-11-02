// The real runner: starts the entry point's prepare-worktree.sh (entry.ts) for a ticket the way
// batch.sh does (the secrets sourced inside the child, the API key unset), with bin/session as
// the session program, the base branch the worktree starts from, the events pipe on file
// descriptor 3, and the session told whether it may open a pull request, or only a draft. Cancelling sends
// SIGTERM to the whole process group (prepare-worktree.sh, launch-session.sh, the session and its
// CLI), then SIGKILL if it lingers.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import type { PullRequests } from '../config.ts'
import type { SessionEvent } from '../session/driver.ts'
import type { Entry } from './entry.ts'
import type { Runner, RunExit } from './loop.ts'

export type RunnerConfig = {
  webuiDir: string
  sessionBin: string
  envFile: string
  sessionTimeoutMs: number
  /** The branch the worktree starts from and the pull request goes to (PIPELINE_BASE_BRANCH). */
  baseBranch: string
  /** The prepare-worktree.sh to start; the checkout's own when absent. */
  entry?: Entry
  /** `off`: the session refuses every push and pull request; `draft`: every ready one. `on` when absent. */
  pullRequests?: PullRequests
  /** After SIGTERM, how long before SIGKILL. */
  killAfterMs?: number
  /** After the child exited, how long to wait for its pipes to drain. */
  drainMs?: number
}

const EVENT_TYPES = new Set<SessionEvent['type']>(['init', 'stage-start', 'stage-stop', 'rate-limit', 'api-retry', 'refused', 'turn', 'ended'])

// The secrets never appear on a command line: the file is sourced by the child itself.
const SCRIPT = [
  'set -a',
  'if [[ -f $PIPELINE_ENV ]]; then . "$PIPELINE_ENV"; fi',
  'set +a',
  'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN',
  'exec bash "$PIPELINE_PREPARE_WORKTREE" "$1"',
].join('; ')

export function createRunner(config: RunnerConfig): Runner {
  const killAfterMs = config.killAfterMs ?? 30_000
  const drainMs = config.drainMs ?? 5_000
  return (key, handlers, signal) =>
    new Promise<RunExit>((resolve) => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN') env[k] = v
      }
      Object.assign(env, {
        PIPELINE_PREPARE_WORKTREE: config.entry?.prepareWorktree ?? 'tools/ticket-pipeline/prepare-worktree.sh',
        PIPELINE_SESSION_PULL_REQUESTS: config.pullRequests ?? 'on',
        PIPELINE_ENV: config.envFile,
        PIPELINE_SESSION: config.sessionBin,
        PIPELINE_BASE_BRANCH: config.baseBranch,
        PIPELINE_EVENTS_FD: '3',
        PIPELINE_SESSION_TRACE: handlers.tracePath,
        PIPELINE_SESSION_TIMEOUT_MS: String(config.sessionTimeoutMs),
      })
      const child = spawn('bash', ['-c', SCRIPT, 'run', key], {
        cwd: config.webuiDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        detached: true,
      })
      let exit: RunExit | null = null
      let finished = false
      let killTimer: NodeJS.Timeout | undefined
      let drainTimer: NodeJS.Timeout | undefined
      const finish = (result: RunExit) => {
        if (finished) return
        finished = true
        clearTimeout(killTimer)
        clearTimeout(drainTimer)
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      const kill = (sig: NodeJS.Signals) => {
        if (child.pid === undefined || exit) return
        try {
          process.kill(-child.pid, sig)
        } catch {
          try { child.kill(sig) } catch { /* already gone */ }
        }
      }
      const onAbort = () => {
        handlers.onOutput(`[service] cancelling the run (${String(signal.reason)})\n`)
        kill('SIGTERM')
        killTimer = setTimeout(() => kill('SIGKILL'), killAfterMs)
      }

      child.stdout?.on('data', (d: Buffer) => handlers.onOutput(d.toString()))
      child.stderr?.on('data', (d: Buffer) => handlers.onOutput(d.toString()))
      const events = readline.createInterface({ input: child.stdio[3] as Readable })
      events.on('line', (line) => {
        const event = parseEvent(line)
        if (event) handlers.onEvent(event)
        else if (line.trim()) handlers.onOutput(`[events] ${line}\n`)
      })
      child.on('error', (error) => {
        handlers.onOutput(`[service] prepare-worktree.sh could not be started: ${error.message}\n`)
        finish({ code: null, signal: null })
      })
      child.on('exit', (code, sig) => {
        exit = { code, signal: sig }
        drainTimer = setTimeout(() => finish(exit!), drainMs)
      })
      child.on('close', () => finish(exit ?? { code: null, signal: null }))

      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
}

export function parseEvent(line: string): SessionEvent | null {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed && 'at' in parsed && EVENT_TYPES.has((parsed as SessionEvent).type)) {
      return parsed as SessionEvent
    }
  } catch {
    /* not an event */
  }
  return null
}
