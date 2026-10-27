<script setup lang="ts">
import { computed } from 'vue'
import { fmtDuration, fmtTime, type History, type ShownRun } from '../api.ts'

const props = defineProps<{ history: History | null; filter: { verdict: string; ending: string }; selected: { key: string; number: number } | null; now: string }>()
const emit = defineEmits<{ filter: [f: { verdict: string; ending: string }]; open: [target: { key: string; number: number }]; again: [key: string] }>()

const verdictOptions = computed(() => Object.entries(props.history?.verdicts ?? {}).sort())
const endingOptions = computed(() => Object.entries(props.history?.endings ?? {}).sort())

function verdictClass(v: string | null): string {
  if (!v) return 'verdict-other'
  return v.startsWith('done') ? 'verdict-done' : v.startsWith('blocked') ? 'verdict-blocked' : v.startsWith('failed') ? 'verdict-failed' : 'verdict-other'
}
function prLabel(run: ShownRun): string {
  if (!run.pr) return ''
  const n = run.pr.url.match(/(\d+)$/)?.[1] ?? ''
  return `#${n} ${run.pr.state === 'unknown' ? 'state unknown' : run.pr.state.toLowerCase()}`
}
function prTitle(run: ShownRun): string {
  if (!run.pr) return ''
  if (run.pr.state === 'unknown') return run.pr.error ?? 'not read from Bitbucket yet, or no token'
  return `read from Bitbucket ${fmtTime(run.pr.fetchedAt)}${run.pr.closedOn ? `, closed ${fmtTime(run.pr.closedOn)}` : ''}`
}
function isSelected(run: ShownRun): boolean {
  return props.selected?.key === run.key && props.selected?.number === run.number
}
</script>

<template>
  <div class="row" style="margin: 10px 0">
    <label>verdict
      <select :value="filter.verdict" @change="emit('filter', { ...filter, verdict: ($event.target as HTMLSelectElement).value })">
        <option value="">all ({{ history?.runs.length ?? 0 }})</option>
        <option v-for="[v, n] in verdictOptions" :key="v" :value="v">{{ v }} ({{ n }})</option>
      </select>
    </label>
    <label>ending
      <select :value="filter.ending" @change="emit('filter', { ...filter, ending: ($event.target as HTMLSelectElement).value })">
        <option value="">all</option>
        <option v-for="[e, n] in endingOptions" :key="e" :value="e">{{ e }} ({{ n }})</option>
      </select>
    </label>
    <span class="muted">{{ history?.runs.length ?? 0 }} runs shown</span>
  </div>
  <table v-if="history">
    <thead><tr><th>ticket</th><th>run</th><th>summary</th><th>started</th><th>duration</th><th>verdict</th><th>ending</th><th>pull request</th><th></th></tr></thead>
    <tbody>
      <tr v-for="run in history.runs" :key="run.path || run.serviceRunId || run.key" class="clickable" :class="{ selected: isSelected(run) }" @click="run.path && emit('open', { key: run.key, number: run.number })">
        <td><b>{{ run.key }}</b></td>
        <td>{{ run.number || '-' }}</td>
        <td class="muted">{{ run.summary ?? '' }}</td>
        <td>{{ fmtTime(run.startedAt) }}</td>
        <td>{{ fmtDuration(run.seconds) }}</td>
        <td :class="verdictClass(run.verdict)">{{ run.verdict ?? '-' }}</td>
        <td><span class="pill" :class="run.ending === 'in-flight' ? 'accent' : run.ending === 'completed' ? '' : 'warn'" :title="run.endingDetail ?? ''">{{ run.ending }}</span></td>
        <td><a v-if="run.pr" :href="run.pr.url" target="_blank" rel="noopener" :title="prTitle(run)" @click.stop>{{ prLabel(run) }}</a></td>
        <td><button class="small" title="Queue this ticket again" @click.stop="emit('again', run.key)">run again</button></td>
      </tr>
    </tbody>
  </table>
  <div v-else class="muted">Loading the runs…</div>
</template>
