// The words a run's outcome is told in, in one place for the service and the console: the
// verdict (the pipeline's, `family:word`), a stage's result, the ending (the service's), the
// stage an agent works in, and the tone each is shown in. No Node imports: the console's bundle
// loads this file too. See .about/glossary.md.

/** The verdict families the pipeline writes (webui's SKILL.md, its verdict table). */
export const VERDICT_FAMILIES = ['done', 'blocked', 'failed'] as const
export type VerdictFamily = (typeof VERDICT_FAMILIES)[number]
/** A verdict as the pipeline writes it: `done:pr-opened`, `blocked:tooling`, `failed:not-converging`. */
export type Verdict = `${VerdictFamily}:${string}`

const VERDICT = /^(done|blocked|failed):[a-z0-9][a-z0-9-]*$/

/** The line as a verdict, or null when it is not one (a note, a reason, a stage line). */
export function parseVerdict(line: string): Verdict | null {
  const text = line.trim()
  return VERDICT.test(text) ? (text as Verdict) : null
}

export function verdictFamily(verdict: string | null): VerdictFamily | null {
  const family = verdict?.split(':')[0]
  return (VERDICT_FAMILIES as readonly string[]).includes(family ?? '') ? (family as VerdictFamily) : null
}

/**
 * How a state is shown, as both consoles name it: `ok` for a good outcome, `bad` for a stop or a
 * failure, `live` while it goes on, `strong` for one that stands out, '' for neither.
 */
export type Tone = 'ok' | 'bad' | 'live' | 'strong' | ''

export function verdictTone(verdict: string | null): Tone {
  const family = verdictFamily(verdict)
  return family === 'done' ? 'ok' : family ? 'bad' : ''
}

/** A stage's result word as the agents write it (pass, fail, done, opened, confidence low, …). */
export function stageResultTone(result: string | null): Tone {
  const word =
    result
      ?.trim()
      .toLowerCase()
      .replace(/^confidence\s+/, 'confidence-')
      .split(/[\s·—,(]/)[0] ?? ''
  if (['pass', 'passed', 'done', 'opened', 'confidence-high', 'confidence-medium'].includes(word)) return 'ok'
  if (
    ['fail', 'failed', 'blocked', 'not-opened', 'verify-unavailable', 'verify-failed', 'brief-unimplementable', 'confidence-low'].includes(
      word,
    )
  )
    return 'bad'
  return ''
}

/**
 * How a run ended as the console shows it: the service's ending for a run it drove; for any other
 * run, `unwatched` when its files closed it, `died` when they did not and nothing runs it; and
 * `in-flight` while it runs.
 */
export const SHOWN_ENDINGS = [
  'completed',
  'usage-limit',
  'error',
  'cancelled',
  'timeout',
  'restart',
  'exited',
  'no-result',
  'in-flight',
  'unwatched',
  'died',
] as const
export type ShownEnding = (typeof SHOWN_ENDINGS)[number]

export function endingLabel(ending: string | null): string {
  return ending ? ending.replace(/-/g, ' ') : '—'
}

export function endingTone(ending: string | null): Tone {
  if (ending === 'in-flight') return 'live'
  if (ending === null || ending === 'completed' || ending === 'unwatched' || ending === 'cancelled' || ending === 'restart') return ''
  return 'bad'
}

/** The stage each agent works in, named as timings.tsv names it; a screen migration's two agents included. */
const AGENT_STAGE: Record<string, string> = {
  'ticket-investigator': 'investigate',
  'parity-investigator': 'spec',
  'ticket-implementer': 'implement',
  'diff-preparer': 'diff',
  'change-reviewer': 'review',
  'app-tester': 'app-test',
  'parity-tester': 'compare',
  'cause-judge': 'same cause?',
}

/** The agents of a screen-migration run only: a run that had one is a migration. */
export const MIGRATION_AGENTS = ['parity-investigator', 'parity-tester'] as const
/** The Jira label that sends a ticket through the screen-migration workflow (webui's CLAUDE.md). */
export const MIGRATION_LABEL = 'vue-migration'

/** The stage an agent works in; an agent the console does not know is named as it is. */
export function stageOfAgent(agent: string | null): string {
  return agent ? (AGENT_STAGE[agent] ?? agent) : 'between stages'
}

/**
 * The preparation's steps, in the order prepare-worktree.sh takes them: what the entry point
 * does before the session starts, which the session's hooks do not report. The service reads
 * them from the script's trace (loop/preparation.ts, ADR preparation-steps).
 */
export const PREPARATION_STEPS = ['git fetch', 'worktree', 'npm ci', 'sandbox check', 'mock reset', 'session start'] as const
export type PreparationStepName = (typeof PREPARATION_STEPS)[number]

/** One step of a run's preparation; `endedAt` is null while it goes on. A run that ended in it closed it as it ended. */
export type PreparationStep = { step: PreparationStepName; startedAt: string; endedAt: string | null }

/** The step the preparation is at; null before the first one and once the session has started. */
export function preparingStep(steps: readonly PreparationStep[]): PreparationStep | null {
  return steps.find((s) => s.endedAt === null) ?? null
}

/**
 * The stage of a run the service drives: until the session starts, the preparation's step it is
 * at (`preparing: npm ci`), or "preparing the worktree" before the first step is known; then
 * the agent's stage, or between two.
 */
export function stageOfRun(run: { stage: string | null; runDir: string | null; steps?: readonly PreparationStep[] }): string {
  if (run.stage) return stageOfAgent(run.stage)
  const steps = run.steps ?? []
  const step = preparingStep(steps)
  if (step) return `preparing: ${step.step}`
  return run.runDir || steps.length ? stageOfAgent(null) : 'preparing the worktree'
}

/** The stages a clean run goes through, in order: a bug's, and a screen migration's (webui's screen-migration.js). */
export const STAGE_ORDER = ['investigate', 'implement', 'diff', 'review', 'app-test', 'pull request'] as const
export const MIGRATION_STAGE_ORDER = ['spec', 'implement', 'diff', 'review', 'compare', 'pull request'] as const

/** The stages still to come after `label`, for a run in flight; none after a stage the order does not have. */
export function stagesAfter(rawLabel: string, migration = false): string[] {
  const label = rawLabel.replace(/\s*\(.*\)\s*$/, '')
  const order: readonly string[] = migration ? MIGRATION_STAGE_ORDER : STAGE_ORDER
  const at = /^rework/.test(label)
    ? order.indexOf('implement')
    : /^re-compare/.test(label)
      ? order.indexOf('compare')
      : order.indexOf(label)
  return at === -1 ? [] : order.slice(at + 1)
}

/**
 * The name a stage's report and state.md line go by: reworks are `implement`, re-comparisons
 * `compare`, `pull request` is `pull-request`; null for a stage that writes no report (diff,
 * same cause?).
 */
export function stageKey(rawLabel: string): string | null {
  // The harness suffixes a label it ran again: `implement (after usage limit)`, `diff (retry)`.
  const label = rawLabel.replace(/\s*\(.*\)\s*$/, '')
  if (/^rework\b/.test(label)) return 'implement'
  if (/^re-compare\b/.test(label)) return 'compare'
  if (label === 'pull request') return 'pull-request'
  return ['investigate', 'spec', 'implement', 'review', 'app-test', 'compare', 'pull-request'].includes(label) ? label : null
}

/** Why a stage that ran has nothing to show: the agents that leave no report by design. */
export function noReportReason(agent: string | null): string | null {
  if (agent === 'diff-preparer') return 'The diff preparer writes the patch the review reads, not a report.'
  if (agent === 'cause-judge') return 'The cause judge leaves no report: its one-word answer decided whether the rework went on.'
  return null
}
