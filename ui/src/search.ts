// The ticket search: what was typed, what Jira found for it, and whether it is still asking.
// Asked 350 ms after the last keystroke (at once on Enter); an answer to an older query is
// dropped. More pages are added below the first. Kept apart from the console's polls, so a
// poll never touches the results.
import { ref } from 'vue'
import { api, type JiraIssue, type SearchScope } from './api.ts'

export const query = ref('')
export const results = ref<JiraIssue[] | null>(null)
export const scope = ref<SearchScope | null>(null)
export const total = ref<number | null>(null)
export const next = ref<string | null>(null)
export const searching = ref(false)
export const loadingMore = ref(false)
export const searchError = ref<string | null>(null)

const DEBOUNCE_MS = 350
let timer: ReturnType<typeof setTimeout> | undefined
let asked = 0

/** Whether Jira would be asked for this text: a key, or at least two characters. */
function worthAsking(q: string): boolean {
  return q.trim().replace(/[^\p{L}\p{N}]+/gu, '').length >= 2
}

function reset(): void {
  results.value = null
  scope.value = null
  total.value = null
  next.value = null
}

async function run(): Promise<void> {
  const q = query.value
  const mine = ++asked
  loadingMore.value = false
  if (!worthAsking(q)) {
    reset()
    searchError.value = null
    searching.value = false
    return
  }
  searching.value = true
  try {
    const found = await api.search(q)
    if (mine !== asked) return
    if (found.kind === 'found') {
      results.value = found.issues
      scope.value = found.scope
      total.value = found.total
      next.value = found.next
      searchError.value = null
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

/** Called on every keystroke. */
export function typed(): void {
  clearTimeout(timer)
  timer = setTimeout(() => void run(), DEBOUNCE_MS)
}

export function searchNow(): void {
  clearTimeout(timer)
  void run()
}

/** Adds the next page below what is shown. */
export async function loadMore(): Promise<void> {
  const token = next.value
  if (!token || loadingMore.value) return
  const mine = asked
  loadingMore.value = true
  try {
    const found = await api.search(query.value, token)
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

export function clearSearch(): void {
  clearTimeout(timer)
  asked += 1
  query.value = ''
  reset()
  searchError.value = null
  searching.value = false
  loadingMore.value = false
}
