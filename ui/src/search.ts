// The ticket search: what was typed, what Jira found for it, and whether it is still asking.
// Asked 350 ms after the last keystroke (at once on Enter); an answer to an older query is
// dropped. Kept apart from the console's polls, so a poll never touches the results.
import { ref } from 'vue'
import { api, type JiraIssue } from './api.ts'

export const query = ref('')
export const results = ref<JiraIssue[] | null>(null)
export const searching = ref(false)
export const searchError = ref<string | null>(null)

const DEBOUNCE_MS = 350
let timer: ReturnType<typeof setTimeout> | undefined
let asked = 0

/** Whether Jira would be asked for this text: a key, or at least two characters. */
function worthAsking(q: string): boolean {
  return q.trim().replace(/[^\p{L}\p{N}]+/gu, '').length >= 2
}

async function run(): Promise<void> {
  const q = query.value
  const mine = ++asked
  if (!worthAsking(q)) {
    results.value = null
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
      searchError.value = null
    } else {
      results.value = null
      searchError.value = found.error
    }
  } catch (e) {
    if (mine !== asked) return
    results.value = null
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

export function clearSearch(): void {
  clearTimeout(timer)
  asked += 1
  query.value = ''
  results.value = null
  searchError.value = null
  searching.value = false
}
