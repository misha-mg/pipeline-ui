// The console's state: polled from the service, shared by every view. The state every 2 s,
// the history every 10 s and after each action, so a browser on another machine shows the
// same within 5 s.
import { ref } from 'vue'
import { api, ApiError, type History, type StateView } from './api.ts'

export const state = ref<StateView | null>(null)
export const history = ref<History | null>(null)
export const filter = ref<{ verdict: string; ending: string }>({ verdict: '', ending: '' })
export const error = ref<string | null>(null)
export const offline = ref(false)

let stateTimer: ReturnType<typeof setInterval> | undefined
let historyTimer: ReturnType<typeof setInterval> | undefined

export async function refreshState(): Promise<void> {
  try {
    state.value = await api.state()
    offline.value = false
  } catch {
    offline.value = true
  }
}

export async function refreshHistory(): Promise<void> {
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

/** Runs an action, shows its refusal or warning, and refreshes what it changed. */
export async function act(fn: () => Promise<unknown>): Promise<void> {
  error.value = null
  try {
    const result = (await fn()) as { warning?: string } | undefined
    if (result?.warning) error.value = result.warning
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  }
  await Promise.all([refreshState(), refreshHistory()])
}

export function setFilter(next: { verdict: string; ending: string }): void {
  filter.value = next
  void refreshHistory()
}

export const actions = {
  start: () => act(api.start),
  stop: () => act(api.stop),
  cancel: () => act(api.cancel),
  enqueue: (key: string, front: boolean) => act(() => api.enqueue(key, front)),
  remove: (key: string) => act(() => api.remove(key)),
  reorder: (keys: string[]) => act(() => api.reorder(keys)),
  again: (key: string) => act(() => api.enqueue(key, false)),
}
