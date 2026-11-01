<script setup lang="ts">
// The run history: every run, filtered by verdict and ending, with the pull request's state
// as Bitbucket last reported it.
import { computed } from 'vue'
import Frame from '../components/Frame.vue'
import { fmtClock, fmtDuration, fmtTime, prNumber, verdictClass, type ShownRun } from '../api.ts'
import { actions, filter, history, setFilter, ticketUrl } from '../console.ts'

const runs = computed(() => history.value?.runs ?? [])
const verdicts = computed(() => Object.entries(history.value?.verdicts ?? {}).sort())
const endings = computed(() => Object.entries(history.value?.endings ?? {}).sort())
const stats = computed(() => {
  const all = runs.value
  const closed = all.filter((r) => r.seconds !== null)
  const total = closed.reduce((s, r) => s + (r.seconds ?? 0), 0)
  const fetched = all.map((r) => r.pr?.fetchedAt ?? '').filter(Boolean).sort().at(-1) ?? null
  return `${all.length} runs · ${fmtDuration(total)} · avg ${fmtDuration(closed.length ? Math.round(total / closed.length) : null)}${fetched ? ` · PR state as of ${fmtClock(fetched)}` : ''}`
})
function prState(run: ShownRun): string {
  if (!run.pr) return ''
  return run.pr.state === 'unknown' ? 'unknown' : run.pr.state.toLowerCase()
}
</script>

<template>
  <div class="page-head">
    <h1>Run history</h1>
    <span class="stats">{{ stats }}</span>
  </div>
  <div class="chips runs-filters">
    <button class="chip" :class="{ on: !filter.verdict }" @click="setFilter({ ...filter, verdict: '' })">All</button>
    <button v-for="[v, n] in verdicts" :key="v" class="chip" :class="{ on: filter.verdict === v }" @click="setFilter({ ...filter, verdict: filter.verdict === v ? '' : v })">{{ v }} <b>{{ n }}</b></button>
    <span style="width: 12px" />
    <button v-for="[e, n] in endings" :key="e" class="chip" :class="{ on: filter.ending === e }" @click="setFilter({ ...filter, ending: filter.ending === e ? '' : e })">{{ e }} <b>{{ n }}</b></button>
  </div>
  <Frame>
    <table>
      <thead><tr><th>Ticket</th><th>Run</th><th>Summary</th><th>Verdict</th><th>Ending</th><th>PR · state</th><th>Started</th><th>Finished</th><th>Duration</th><th>Detail</th></tr></thead>
      <tbody>
        <tr v-for="run in runs" :key="run.path || run.serviceRunId || run.key">
          <td class="key"><a v-if="ticketUrl(run.key)" :href="ticketUrl(run.key)!" target="_blank" rel="noopener">{{ run.key }}</a><span v-else>{{ run.key }}</span></td>
          <td class="num dim">{{ run.number || '—' }}</td>
          <td class="summary">{{ run.summary ?? '' }}</td>
          <td><span class="pill" :class="verdictClass(run.verdict)">{{ run.verdict ?? '—' }}</span></td>
          <td><span class="pill" :class="run.ending === 'in-flight' ? 'slate' : run.ending === 'completed' ? '' : 'bad'" :title="run.endingDetail ?? ''">{{ run.ending }}</span></td>
          <td class="num"><template v-if="run.pr"><a :href="run.pr.url" target="_blank" rel="noopener" class="small-link">PR #{{ prNumber(run.pr.url) }}</a> <span class="pill" :class="run.pr.state === 'MERGED' ? 'strong' : ''" :title="run.pr.fetchedAt ? `read ${fmtTime(run.pr.fetchedAt)}` : run.pr.error ?? 'not read yet'">{{ prState(run) }}</span></template></td>
          <td class="num dim">{{ fmtTime(run.startedAt) }}</td>
          <td class="num dim">{{ fmtTime(run.finishedAt) }}</td>
          <td class="num">{{ fmtDuration(run.seconds) }}</td>
          <td><div class="actions" style="justify-content: flex-start"><a v-if="run.path" class="small-link" :href="`#/runs/${run.key}/${run.number}`">Reports</a><a class="small-link" href="#" @click.prevent="actions.again(run.key)">Again</a></div></td>
        </tr>
      </tbody>
    </table>
    <div v-if="history && !runs.length" class="empty">No runs match.</div>
  </Frame>
</template>
