// The console's state: polled from the service, shared by every view. The state every 2 s,
// the history every 10 s and after each action, so a browser on another machine shows the
// same within 5 s. What changes between two polls, and what each action comes to, is told in a
// notification (toasts.ts): a run starting, its next stage, its end, the loop stopping by itself.
import { ref } from 'vue'
import {
  api,
  ApiError,
  endingLabel,
  prNumber,
  stageOfAgent,
  stageOfRun,
  verdictFamily,
  type History,
  type RunSettings,
  type ShownRun,
  type StateView,
} from './api.ts'
import { notify } from './toasts.ts'

export const state = ref<StateView | null>(null)
export const history = ref<History | null>(null)
export const filter = ref<{ verdict: string; ending: string }>({ verdict: '', ending: '' })
export const offline = ref(false)

let stateTimer: ReturnType<typeof setInterval> | undefined
let historyTimer: ReturnType<typeof setInterval> | undefined

async function refreshState(): Promise<void> {
  try {
    const next = await api.state()
    const prev = state.value
    state.value = next
    offline.value = false
    if (prev) announce(prev, next)
    // The first poll only learns where things stand: a page opened mid-run tells nothing old.
    else if (next.inFlight?.stage) toldStage = { runId: next.inFlight.id, stage: next.inFlight.stage }
  } catch {
    offline.value = true
  }
}

/** The stage last told of, so the gap between two stages (no stage at all) tells nothing. */
let toldStage: { runId: number; stage: string } | null = null

function announce(prev: StateView, next: StateView): void {
  const was = prev.inFlight
  const now = next.inFlight
  if (now && now.id !== was?.id) notify('info', `${now.key} started`, now.summary ?? undefined, { label: 'Open the run', href: '#/runs' })
  if (now?.stage && !(toldStage?.runId === now.id && toldStage.stage === now.stage)) {
    // "finished", not "done": the stage before may have failed, and this poll does not know.
    const before = toldStage?.runId === now.id ? stageOfAgent(toldStage.stage) : null
    const stage = stageOfAgent(now.stage)
    if (was?.id === now.id) notify('info', `${now.key} · ${stage}`, before ? `${before} finished, ${stage} started` : `${stage} started`)
    toldStage = { runId: now.id, stage: now.stage }
  }
  if (was && was.id !== now?.id) void announceEnd(was.id, was.key)
  const loop = next.loop
  if (prev.loop.wanted === 'running' && loop.wanted === 'stopped') {
    if (loop.stoppedReason === 'usage-limit') {
      const at = loop.usageLimitResetsAt
        ? new Date(loop.usageLimitResetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null
      notify(
        'error',
        'Usage limit: the loop stopped',
        at ? `The limit resets at ${at}; Start takes the next ticket.` : 'Start takes the next ticket once the limit resets.',
      )
    } else if (loop.stoppedReason === 'entry-point') notify('error', 'The entry point refused the run', loop.stoppedDetail ?? undefined)
  }
}

/** A run's end, told from its verdict: a pull request is a success, a stop an error. */
async function announceEnd(runId: number, key: string): Promise<void> {
  let run: ShownRun | undefined
  try {
    run = (await api.runs({})).runs.find((r) => r.serviceRunId === runId)
  } catch {
    /* the state poll reports the outage */
  }
  void refreshHistory()
  const href = run?.path ? `#/runs/${run.key}/${run.number}` : '#/runs'
  const verdict = run?.verdict ?? null
  const pr = run?.pr ?? null
  // The verdict's word after its family, as the title says it: `pr-opened` → "pr opened".
  const word = verdict ? verdict.slice(verdict.indexOf(':') + 1).replace(/-/g, ' ') : ''
  if (run?.ending === 'cancelled') notify('info', `${key} cancelled`, run.reason ?? undefined, { label: 'Open the run', href })
  else if (verdictFamily(verdict) === 'done' && pr)
    notify(
      'success',
      `${key}: ${verdict === 'done:draft-pr' ? 'draft ' : ''}pull request #${prNumber(pr.url)} opened`,
      run?.summary ?? undefined,
      { label: 'Open the pull request', href: pr.url },
    )
  else if (verdictFamily(verdict) === 'done')
    notify('success', `${key}: ${word}`, run?.reason ?? run?.summary ?? undefined, { label: 'Open the run', href })
  else if (verdict)
    notify('error', `${key} ${verdictFamily(verdict) ?? 'stopped'}: ${word}`, run?.reason ?? undefined, { label: 'Open the run', href })
  else
    notify('error', `${key} ended: ${endingLabel(run?.ending ?? null)}`, run?.endingDetail ?? 'It left no verdict.', {
      label: 'Open the run',
      href,
    })
}

async function refreshHistory(): Promise<void> {
  try {
    history.value = await api.runs({ verdict: filter.value.verdict || undefined, ending: filter.value.ending || undefined })
  } catch {
    /* the state poll reports the outage */
  }
}

export function startPolling(): void {
  void refreshState()
  void refreshHistory()
  stateTimer = setInterval(() => void refreshState(), 2000)
  historyTimer = setInterval(() => void refreshHistory(), 10000)
}

export function stopPolling(): void {
  clearInterval(stateTimer)
  clearInterval(historyTimer)
}

/** Runs an action, tells what it came to (done, done with a warning, refused), and refreshes what it changed. */
async function act(fn: () => Promise<unknown>, done?: { title: string; detail?: string }, refused = 'Not done'): Promise<void> {
  try {
    const result = (await fn()) as { warning?: string } | undefined
    if (result?.warning) notify('info', done?.title ?? 'Done', result.warning)
    else if (done) notify('success', done.title, done.detail)
  } catch (e) {
    notify('error', refused, e instanceof ApiError ? e.message : String(e))
  }
  await Promise.all([refreshState(), refreshHistory()])
}

/** A ticket's page on the Jira site the service is set up with; null when it has none. */
export function ticketUrl(key: string): string | null {
  const site = state.value?.jiraSite
  return site ? `${site}/browse/${encodeURIComponent(key)}` : null
}

/** The stage of a run in flight, as the state poll last saw it; null for any other run. */
export function liveStage(run: ShownRun): string | null {
  if (run.ending !== 'in-flight') return null
  const r = state.value?.inFlight
  return r && r.key === run.key ? stageOfRun(r) : null
}

/** A run's duration: for the run in flight, how long it has taken so far by the last state poll. */
export function runSeconds(run: ShownRun): number | null {
  const r = state.value?.inFlight
  return run.ending === 'in-flight' && r && r.key === run.key ? r.seconds : run.seconds
}

export function setFilter(next: { verdict: string; ending: string }): void {
  filter.value = next
  void refreshHistory()
}

/** Whether a run opens its pull request, in the console's words. */
export const PULL_REQUESTS_WORDS: Record<RunSettings['pullRequests'], string> = { on: 'on', draft: 'drafts only', off: 'off' }

/**
 * Keeps the run settings for the next run. Resolves with null once they are kept, or with why
 * they are not (origin has no such branch, the branch has no entry point), for the dialog to
 * say where the person is looking; the service checks the branch, which takes a fetch.
 */
export async function saveSettings(settings: RunSettings): Promise<string | null> {
  try {
    const { changed } = await api.settings(settings)
    if (changed.length)
      notify(
        'success',
        'Run settings saved',
        `From the next run: ${settings.baseBranch}, pull requests ${PULL_REQUESTS_WORDS[settings.pullRequests]}, a session at most ${settings.timeoutHours} h.`,
      )
    await refreshState()
    return null
  } catch (e) {
    return e instanceof ApiError ? e.message : String(e)
  }
}

export const actions = {
  start: () => act(api.start, { title: 'Loop started', detail: 'It takes the queued tickets one at a time.' }, 'The loop did not start'),
  stop: () => act(api.stop, { title: 'Loop stopped', detail: 'The run in flight finishes; nothing new starts.' }, 'The loop did not stop'),
  cancel: () => act(api.cancel, { title: 'Cancelling the run', detail: 'Its session ends within 30 s.' }, 'Not cancelled'),
  enqueue: (key: string, front: boolean) =>
    act(
      () => api.enqueue(key, front),
      { title: `${key} queued`, detail: front ? 'At the front: it starts next.' : 'At the end of the queue.' },
      `${key} cannot be queued`,
    ),
  remove: (key: string) => act(() => api.remove(key), { title: `${key} removed from the queue` }, `${key} was not removed`),
  reorder: (keys: string[]) => act(() => api.reorder(keys), undefined, 'The queue was not reordered'),
  again: (key: string) =>
    act(
      () => api.enqueue(key, false),
      { title: `${key} queued again`, detail: 'At the end of the queue; it gets a new run.' },
      `${key} cannot be queued`,
    ),
}
