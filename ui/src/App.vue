<script setup lang="ts">
// The console: one page, polled every 2 s for the state and every 10 s (and after each
// action) for the history, so a browser on another machine shows the same within 5 s.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { api, ApiError, fmtAgo, fmtTime, type History, type StateView } from './api.ts'
import HealthPanel from './components/HealthPanel.vue'
import HistoryTable from './components/HistoryTable.vue'
import InFlight from './components/InFlight.vue'
import QueuePanel from './components/QueuePanel.vue'
import RunDetail from './components/RunDetail.vue'

const state = ref<StateView | null>(null)
const history = ref<History | null>(null)
const filter = ref<{ verdict: string; ending: string }>({ verdict: '', ending: '' })
const selected = ref<{ key: string; number: number } | null>(null)
const error = ref<string | null>(null)
const offline = ref(false)
let stateTimer: ReturnType<typeof setInterval> | undefined
let historyTimer: ReturnType<typeof setInterval> | undefined

async function refreshState() {
  try {
    state.value = await api.state()
    offline.value = false
  } catch {
    offline.value = true
  }
}
async function refreshHistory() {
  try {
    history.value = await api.runs({ verdict: filter.value.verdict || undefined, ending: filter.value.ending || undefined })
  } catch {
    /* the state poll reports the outage */
  }
}
async function act(fn: () => Promise<unknown>) {
  error.value = null
  try {
    const result = (await fn()) as { warning?: string } | undefined
    if (result?.warning) error.value = result.warning
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  }
  await Promise.all([refreshState(), refreshHistory()])
}
const enqueue = (key: string, front: boolean) => act(() => api.enqueue(key, front))
const removeKey = (key: string) => act(() => api.remove(key))
const reorder = (keys: string[]) => act(() => api.reorder(keys))
const again = (key: string) => act(() => api.enqueue(key, false))
function setFilter(next: { verdict: string; ending: string }) {
  filter.value = next
  void refreshHistory()
}

onMounted(() => {
  void refreshState()
  void refreshHistory()
  stateTimer = setInterval(() => void refreshState(), 2000)
  historyTimer = setInterval(() => void refreshHistory(), 10000)
})
onBeforeUnmount(() => {
  clearInterval(stateTimer)
  clearInterval(historyTimer)
})

const loop = computed(() => state.value?.loop ?? null)
const loopLabel = computed(() => {
  const l = loop.value
  if (!l) return ''
  if (l.wanted === 'running') return 'running'
  const reason = l.stoppedReason === 'usage-limit' ? 'stopped on the usage limit' : l.stoppedReason === 'restart' ? 'stopped by the restart' : 'stopped'
  return reason
})
const usageLimit = computed(() => {
  const l = loop.value
  if (!l || l.stoppedReason !== 'usage-limit') return null
  const resets = l.usageLimitResetsAt ? `, resets ${fmtTime(new Date(l.usageLimitResetsAt * 1000).toISOString())}` : ''
  return `The subscription's usage limit was hit ${fmtTime(l.stoppedAt)}${resets}. The queue is untouched; Start takes the next ticket.`
})
</script>

<template>
  <header class="top">
    <h1>Ticket pipeline</h1>
    <span v-if="state" class="pill" :class="state.service.alive ? 'ok' : 'bad'">service {{ state.service.alive ? 'running' : 'not running' }}</span>
    <span v-if="loop" class="pill" :class="loop.wanted === 'running' ? 'accent' : loop.stoppedReason === 'usage-limit' ? 'bad' : ''">loop {{ loopLabel }}</span>
    <span v-if="offline" class="pill bad">console cannot reach the service</span>
    <span class="spacer" />
    <input type="search" placeholder="Search tickets (coming)" disabled title="The Jira search will go here" />
    <button class="primary" :disabled="!loop || loop.wanted === 'running' || !state?.service.alive" @click="act(api.start)">Start</button>
    <button :disabled="!loop || loop.wanted !== 'running'" @click="act(api.stop)">Stop</button>
  </header>

  <div v-if="error" class="notice">{{ error }} <button class="small" @click="error = null">dismiss</button></div>
  <div v-if="usageLimit" class="notice">{{ usageLimit }}</div>
  <div v-if="state && !state.service.alive" class="notice">The service is not running: nothing starts until it is (<code>bin/pipeline serve</code>). Last seen {{ state.service.seenAt ? fmtAgo(state.service.seenAt, state.now) + ' ago' : 'never' }}.</div>

  <div class="grid">
    <InFlight :run="state?.inFlight ?? null" :now="state?.now ?? ''" :loop-running="loop?.wanted === 'running'" @cancel="act(api.cancel)" @open="selected = $event" />
    <QueuePanel :queue="state?.queue ?? []" :in-flight="state?.inFlight ?? null" @enqueue="enqueue" @remove="removeKey" @reorder="reorder" />
    <div class="panel full">
      <h2>Runs</h2>
      <div v-if="state" class="counts">
        <div v-for="(c, label) in { [state.counts.lastBatchLabel]: state.counts.lastBatch, 'last 7 days': state.counts.last7Days, 'all time': state.counts.allTime }" :key="label" class="box">
          <div class="label">{{ label }}</div>
          <div class="row"><span v-for="(n, v) in c" :key="v" class="pill" :class="'verdict-' + (String(v).split(':')[0] === 'done' ? 'done' : String(v).startsWith('blocked') ? 'blocked' : String(v).startsWith('failed') ? 'failed' : 'other')">{{ v }} <b>{{ n }}</b></span><span v-if="!Object.keys(c).length" class="muted">no runs</span></div>
        </div>
      </div>
      <HistoryTable :history="history" :filter="filter" :selected="selected" :now="state?.now ?? ''" @filter="setFilter" @open="selected = $event" @again="again" />
    </div>
    <RunDetail v-if="selected" class="panel full" :target="selected" @close="selected = null" />
    <HealthPanel class="panel full" :health="state?.health ?? null" />
  </div>
</template>
