// The ticket search: what was typed, the operator's JQL it searches within, what Jira found for
// them, and whether it is still asking. Asked 350 ms after the last keystroke (at once on Enter);
// an answer to an older query is dropped. More pages are added below the first. The JQL is
// applied on Enter or Apply, not as it is typed (a JQL half typed is one Jira refuses); a switch
// turns it on and off without losing it. What is typed, the JQL and the switch are kept in this
// browser, and the search is made again when the page is reloaded. Kept apart from the console's
// polls, so a poll never touches the results.
import { ref, watch } from 'vue'
import { api, type JiraIssue, type SearchScope } from './api.ts'

export const results = ref<JiraIssue[] | null>(null)
export const scope = ref<SearchScope | null>(null)
export const total = ref<number | null>(null)
export const next = ref<string | null>(null)
export const searching = ref(false)
export const loadingMore = ref(false)
export const searchError = ref<string | null>(null)

const QUERY_KEPT = 'pipeline-ui.search'
const JQL_KEPT = 'pipeline-ui.jql'
const JQL_ON_KEPT = 'pipeline-ui.jql-on'
const kept = (name: string): string | null => {
  try {
    return localStorage.getItem(name)
  } catch {
    return null
  }
}
const keep = (name: string, value: string): void => {
  try {
    localStorage.setItem(name, value)
  } catch {
    /* not kept */
  }
}
export const query = ref(kept(QUERY_KEPT) ?? '')
/** The JQL applied; searches are made within it while the switch is on. Empty for none. */
export const jql = ref(kept(JQL_KEPT) ?? '')
/** Whether the switch is on: the JQL field shown and the applied JQL used. */
export const jqlOn = ref(kept(JQL_ON_KEPT) === '1')
/** The JQL as it stands in its field, applied or not. */
export const jqlDraft = ref(jql.value)
/** What Jira said when it refused the JQL. */
export const jqlError = ref<string | null>(null)
watch(query, (value) => keep(QUERY_KEPT, value))
watch(jql, (value) => keep(JQL_KEPT, value))
watch(jqlOn, (on) => keep(JQL_ON_KEPT, on ? '1' : '0'))
/** The JQL searches are made within now: the applied one while the switch is on. */
const within = (): string => (jqlOn.value ? jql.value : '')

const DEBOUNCE_MS = 350
let timer: ReturnType<typeof setTimeout> | undefined
let asked = 0
/** The query and JQL the shown results are for: a next page is asked for them, not for what is typed since. */
let shownFor: { q: string; jql: string } = { q: '', jql: '' }

/** Whether Jira would be asked for this text: a key, or at least two characters; anything at all within a JQL. */
function worthAsking(q: string): boolean {
  return within() !== '' || q.trim().replace(/[^\p{L}\p{N}]+/gu, '').length >= 2
}

function reset(): void {
  results.value = null
  scope.value = null
  total.value = null
  next.value = null
}

async function run(): Promise<void> {
  const asking = { q: query.value, jql: within() }
  const mine = ++asked
  loadingMore.value = false
  if (!worthAsking(asking.q)) {
    reset()
    searchError.value = null
    searching.value = false
    return
  }
  searching.value = true
  try {
    const found = await api.search(asking.q, { jql: asking.jql || undefined })
    if (mine !== asked) return
    if (found.kind === 'found') {
      results.value = found.issues
      scope.value = found.scope
      total.value = found.total
      next.value = found.next
      shownFor = asking
      searchError.value = null
      jqlError.value = null
    } else if (found.kind === 'invalid') {
      reset()
      searchError.value = null
      jqlError.value = found.error
    } else {
      reset()
      searchError.value = found.error
    }
  } catch (e) {
    if (mine !== asked) return
    reset()
    searchError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === asked) searching.value = false
  }
}

/** Makes the kept search again once the page is open, unless its results are already shown. */
export function restoreSearch(): void {
  if (results.value === null && !searching.value && worthAsking(query.value)) searchNow()
}

/** Called on every keystroke. */
export function typed(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void run(), DEBOUNCE_MS)
}

export function searchNow(): void {
  clearTimeout(timer)
  void run()
}

/** Makes the JQL in the field the one searches are made within, and searches at once. */
export function applyJql(): void {
  jql.value = jqlDraft.value.trim()
  jqlDraft.value = jql.value
  jqlError.value = null
  searchNow()
}

/** Turns the JQL on or off; what is shown is searched again for it. */
export function switchJql(on: boolean): void {
  jqlOn.value = on
  jqlError.value = null
  if (jql.value && (query.value.trim() || results.value || on)) searchNow()
}

/** Forgets the JQL: searches every project again, with what is typed if anything. */
export function dropJql(): void {
  jql.value = ''
  jqlDraft.value = ''
  jqlError.value = null
  searchNow()
}

/** Adds the next page below what is shown. */
export async function loadMore(): Promise<void> {
  const token = next.value
  if (!token || loadingMore.value) return
  const mine = asked
  loadingMore.value = true
  try {
    const found = await api.search(shownFor.q, { jql: shownFor.jql || undefined, next: token })
    if (mine !== asked) return
    if (found.kind === 'found') {
      const shown = new Set((results.value ?? []).map((i) => i.key))
      results.value = [...(results.value ?? []), ...found.issues.filter((i) => !shown.has(i.key))]
      next.value = found.next
    } else {
      searchError.value = found.error
    }
  } catch (e) {
    if (mine === asked) searchError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === asked) loadingMore.value = false
  }
}

/** Empties the field and the results; the JQL stays. */
export function clearSearch(): void {
  clearTimeout(timer)
  asked += 1
  query.value = ''
  reset()
  searchError.value = null
  searching.value = false
  loadingMore.value = false
}
