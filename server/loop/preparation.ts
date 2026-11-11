// The preparation's steps, read from the entry point's own trace: the runner starts
// prepare-worktree.sh under `bash -x` with the trace on its own descriptor (runner.ts), so every
// command the script runs arrives as a line the moment it starts, and a few of them begin a
// step: git fetch, the worktree, npm ci, the sandbox check, the mock, the hand-over to the
// launch script. Nothing in webui changes for it; a command the script no longer runs is a step
// the console does not show, never a wrong one. ADR preparation-steps.
import type { PreparationStepName } from '../history/outcome.ts'

/** What begins each step: a command as bash's trace prints it, without the `+ ` it starts with. */
const STEP_COMMANDS: [RegExp, PreparationStepName][] = [
  [/^git\b.*\sfetch(\s|$)/, 'git fetch'],
  [/^git\b.*\sworktree add(\s|$)/, 'worktree'],
  [/^npm (ci|install)(\s|$)/, 'npm ci'],
  [/^command -v (bwrap|socat)$/, 'sandbox check'],
  [/^\S*tools\/device-mock\/\S+\.sh(\s|$)/, 'mock reset'],
  [/^exec \S*tools\/ticket-pipeline\/\S+\.sh(\s|$)/, 'session start'],
]

/** The step a line of the trace begins; null for any other line, and for a line that is not the trace's. */
export function stepOfTrace(line: string): PreparationStepName | null {
  // bash prefixes each command with PS4 (`+ `), its first character repeated once per level of
  // command substitution: `++ tools/device-mock/rpc.sh board` is inside `$(...)`.
  const command = /^\++ (.*)$/.exec(line)?.[1]
  if (command === undefined) return null
  return STEP_COMMANDS.find(([pattern]) => pattern.test(command))?.[1] ?? null
}
