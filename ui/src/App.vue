<script setup lang="ts">
// The console: a masthead with the three pages (cockpit, runs, statistics) and the light/dark switch
// (public/theme.js handles it), and the sheet under it. The page comes from the hash, so a
// run's address can be shared.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Cockpit from './views/Cockpit.vue'
import RunsView from './views/RunsView.vue'
import RunView from './views/RunView.vue'
import Statistics from './views/Statistics.vue'
import Toasts from './components/Toasts.vue'
import { offline, startPolling, state, stopPolling } from './console.ts'

const hash = ref(location.hash)
const onHash = () => {
  hash.value = location.hash
}
onMounted(() => {
  startPolling()
  window.addEventListener('hashchange', onHash)
})
onBeforeUnmount(() => {
  stopPolling()
  window.removeEventListener('hashchange', onHash)
})

const route = computed(() => {
  if (hash.value === '#/stats') return { page: 'stats' as const }
  const m = /^#\/runs(?:\/([A-Z]+-\d+)\/(\d+))?$/.exec(hash.value)
  if (!m) return { page: 'cockpit' as const }
  if (m[1] && m[2]) return { page: 'run' as const, key: m[1], number: Number(m[2]) }
  return { page: 'runs' as const }
})
const where = computed(() => `console · ${location.host}`)
</script>

<template>
  <header class="masthead">
    <a class="brand" href="#/">Pipeline</a>
    <span class="divider" />
    <span class="where">{{ where }}</span>
    <span v-if="state && !state.service.alive" class="offline">service not running</span>
    <span v-if="offline" class="offline">console cannot reach the service</span>
    <span class="spacer" />
    <nav>
      <a class="btn" :class="{ active: route.page === 'cockpit' }" href="#/">Cockpit</a>
      <a class="btn" :class="{ active: route.page === 'runs' || route.page === 'run' }" href="#/runs">Runs</a>
      <a class="btn" :class="{ active: route.page === 'stats' }" href="#/stats">Statistics</a>
    </nav>
    <button class="btn theme" type="button" aria-label="Switch between light and dark">
      <svg class="sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg class="moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />
      </svg>
    </button>
  </header>
  <main class="sheet">
    <Cockpit v-if="route.page === 'cockpit'" />
    <RunsView v-else-if="route.page === 'runs'" />
    <Statistics v-else-if="route.page === 'stats'" />
    <RunView v-else :ticket="route.key" :number="route.number" />
  </main>
  <Toasts />
</template>
