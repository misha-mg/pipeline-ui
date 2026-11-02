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

/** `ok` for a good outcome, `bad` for a stop or a failure, `live` while it goes on, '' for neither. */
export type Tone = 'ok' | 'bad' | 'live' | ''

export function verdictTone(verdict: string | null): Tone {
  const family = verdictFamily(verdict)
  return family === 'done' ? 'ok' : family ? 'bad' : ''
}

/** A stage's result word as the agents write it (pass, fail, done, opened, confidence low, …). */
export function stageResultTone(result: string | null): Tone {
  const word = result?.trim().toLowerCase().replace(/^confidence\s+/, 'confidence-').split(/[\s·—,(]/)[0] ?? ''
  if (['pass', 'passed', 'done', 'opened', 'confidence-high', 'confidence-medium'].includes(word)) return 'ok'
  if (['fail', 'failed', 'blocked', 'not-opened', 'verify-unavailable', 'verify-failed', 'brief-unimplementable', 'confidence-low'].includes(word)) return 'bad'
  return ''
}

/**
 * How a run ended as the console shows it: the service's ending for a run it drove; for any other
 * run, `unwatched` when its files closed it, `died` when they did not and nothing runs it; and
 * `in-flight` while it runs.
 */
export const SHOWN_ENDINGS = ['completed', 'usage-limit', 'error', 'cancelled', 'timeout', 'restart', 'exited', 'no-result', 'in-flight', 'unwatched', 'died'] as const
export type ShownEnding = (typeof SHOWN_ENDINGS)[number]

export function endingLabel(ending: string | null): string {
  return ending ? ending.replace(/-/g, ' ') : '—'
}

export function endingTone(ending: string | null): Tone {
  if (ending === 'in-flight') return 'live'
  if (ending === null || ending === 'completed' || ending === 'unwatched' || ending === 'cancelled' || ending === 'restart') return ''
  return 'bad'
}

/** The stage each agent works in, named as timings.tsv names it. */
const AGENT_STAGE: Record<string, string> = {
  'ticket-investigator': 'investigate',
  'ticket-implementer': 'implement',
  'diff-preparer': 'diff',
  'change-reviewer': 'review',
  'app-tester': 'app-test',
  'cause-judge': 'same cause?',
}

/** The stage an agent works in; an agent the console does not know is named as it is. */
export function stageOfAgent(agent: string | null): string {
  return agent ? AGENT_STAGE[agent] ?? agent : 'between stages'
}

/** The stages a clean run goes through, in order. */
export const STAGE_ORDER = ['investigate', 'implement', 'diff', 'review', 'app-test', 'pull request'] as const

/** The stages still to come after `label`, for a run in flight; none after a stage the order does not have. */
export function stagesAfter(label: string): string[] {
  const at = /^rework/.test(label) ? STAGE_ORDER.indexOf('implement') : (STAGE_ORDER as readonly string[]).indexOf(label)
  return at === -1 ? [] : STAGE_ORDER.slice(at + 1)
}

/** The name a stage's report and state.md line go by: reworks are `implement`, `pull request` is `pull-request`. */
export function stageKey(label: string): string | null {
  if (/^rework\b/.test(label)) return 'implement'
  if (label === 'pull request') return 'pull-request'
  return ['investigate', 'implement', 'review', 'app-test', 'pull-request'].includes(label) ? label : null
}
