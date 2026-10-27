<script setup lang="ts">
// The console: a masthead with the two pages (cockpit, runs) and the sheet under it. The
// page comes from the hash, so a run's address can be shared.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Cockpit from './views/Cockpit.vue'
import RunsView from './views/RunsView.vue'
import RunView from './views/RunView.vue'
import { error, offline, startPolling, state, stopPolling } from './console.ts'

const hash = ref(location.hash)
const onHash = () => { hash.value = location.hash }
onMounted(() => { startPolling(); window.addEventListener('hashchange', onHash) })
onBeforeUnmount(() => { stopPolling(); window.removeEventListener('hashchange', onHash) })

const route = computed(() => {
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
    <span v-if="state && !state.service.alive" class="offline" style="margin-left: 18px">service not running</span>
    <span v-if="offline" class="offline" style="margin-left: 18px">console cannot reach the service</span>
    <span class="spacer" />
    <nav>
      <a class="btn" :class="{ active: route.page === 'cockpit' }" href="#/">Cockpit</a>
      <a class="btn" :class="{ active: route.page !== 'cockpit' }" href="#/runs">Runs</a>
    </nav>
  </header>
  <main class="sheet">
    <div v-if="error" class="notice">{{ error }} <button class="btn tiny" @click="error = null">dismiss</button></div>
    <Cockpit v-if="route.page === 'cockpit'" />
    <RunsView v-else-if="route.page === 'runs'" />
    <RunView v-else :target="{ key: route.key, number: route.number }" />
  </main>
</template>
