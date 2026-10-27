<script setup lang="ts">
// The cockpit: the loop's state, what is in flight and what is next, the controls, the queue,
// the latest runs and the dependencies, on one sheet.
import { computed, ref } from 'vue'
import Frame from '../components/Frame.vue'
import { fmtAgo, fmtClock, fmtDuration, fmtTime, prNumber, stageName, verdictClass, type Counts } from '../api.ts'
import { actions, history, state } from '../console.ts'
import { clearSearch, loadingMore, loadMore, next, query, results, scope, searchError, searching, searchNow, total as foundTotal, typed } from '../search.ts'

const key = ref('')
const loop = computed(() => state.value?.loop ?? null)
const inFlight = computed(() => state.value?.inFlight ?? null)
const queue = computed(() => state.value?.queue ?? [])
const recent = computed(() => history.value?.runs.slice(0, 8) ?? [])
const health = computed(() => state.value?.health ?? null)
const names: Record<string, string> = { runsDir: '.pipeline-runs', tmux: 'tmux — batch.sh', jira: 'Jira', mock: 'Device mock', bitbucket: 'Bitbucket — PR state' }

const loopNote = computed(() => {
  const l = loop.value
  if (!l) return ''
  if (l.wanted === 'running') return inFlight.value ? 'Takes the next ticket when this run ends.' : 'Takes the next queued ticket.'
  if (l.stoppedReason === 'usage-limit') return `The subscription's usage limit was hit at ${fmtTime(l.stoppedAt)}${l.usageLimitResetsAt ? `, resets ${fmtTime(new Date(l.usageLimitResetsAt * 1000).toISOString())}` : ''}. The queue is untouched.`
  if (l.stoppedReason === 'entry-point') return `Stopped at ${fmtTime(l.stoppedAt)} before a run: ${l.stoppedDetail ?? 'the entry point was refused'}. The queue is untouched.`
  if (l.stoppedReason === 'restart') return `Stopped by the service's restart at ${fmtTime(l.stoppedAt)}. Nothing starts until Start.`
  if (l.stoppedReason === 'operator') return `Stopped at ${fmtTime(l.stoppedAt)}. The run in flight, if any, finishes.`
  return 'Never started.'
})
const allTime = computed(() => {
  const runs = history.value?.runs ?? []
  const closed = runs.filter((r) => r.seconds !== null)
  const total = closed.reduce((s, r) => s + (r.seconds ?? 0), 0)
  return { n: runs.length, total, avg: closed.length ? Math.round(total / closed.length) : null }
})
function breakdown(c: Counts): string {
  const entries = Object.entries(c).sort((a, b) => b[1] - a[1])
  return entries.length ? entries.map(([v, n]) => `${n} ${v}`).join(' · ') : 'no runs'
}
function total(c: Counts): number {
  return Object.values(c).reduce((a, b) => a + b, 0)
}
function add(front: boolean) {
  const k = key.value.trim().toUpperCase()
  if (!k) return
  void actions.enqueue(k, front)
  key.value = ''
}
function move(index: number, by: number) {
  const keys = queue.value.map((q) => q.key)
  const t = index + by
  if (t < 0 || t >= keys.length) return
  ;[keys[index], keys[t]] = [keys[t]!, keys[index]!]
  void actions.reorder(keys)
}
const runNumber = (dir: string | null) => dir?.match(/run-(\d+)$/)?.[1] ?? null

// The search's rows beside what the console knows of each ticket: its place in the queue, the
// run in flight, its latest run.
const found = computed(() => (results.value ?? []).map((issue) => {
  const position = queue.value.findIndex((q) => q.key === issue.key)
  const lastRun = history.value?.runs.find((r) => r.key === issue.key) ?? null
  return { issue, position: position === -1 ? null : position + 1, inFlight: inFlight.value?.key === issue.key, lastRun }
}))
// Where the search looked, as a phrase: "in KAZ", "in KAZ with “search pane”", "in every project with …".
const scopeText = computed(() => {
  const s = scope.value
  if (!s) return ''
  if ('key' in s) return s.key
  const where = s.project ? `in ${s.project}` : 'in every project'
  return s.words ? `${where} with “${s.words}”` : where
})
const shownCount = computed(() => {
  const shown = results.value?.length ?? 0
  return foundTotal.value !== null && foundTotal.value > shown ? `${shown} of ${foundTotal.value.toLocaleString('en-US')}` : `${shown} found`
})
const searchNote = computed(() => {
  if (searchError.value) return `Jira cannot be searched: ${searchError.value}`
  if (searching.value) return 'Searching Jira…'
  if (results.value) {
    if (!results.value.length) return scope.value && 'key' in scope.value ? `Jira has no ${scope.value.key}.` : `Nothing ${scopeText.value}.`
    if (scope.value && 'key' in scope.value) return `${scope.value.key} found.`
    const shown = results.value.length
    const many = foundTotal.value === null ? `${shown} shown ${scopeText.value}` : foundTotal.value > shown ? `${foundTotal.value.toLocaleString('en-US')} ${scopeText.value}, ${shown} shown` : `${foundTotal.value.toLocaleString('en-US')} ${scopeText.value}`
    return `${many}, the latest updated first.`
  }
  return 'A ticket key; a project key (KAZ, RPG) to list the project, with words after it to search in it; or words to search every project.'
})
const statusClass = (category: string | null) => (category === 'done' ? 'ok' : category === 'indeterminate' ? 'slate' : '')
function queueFound(key: string, front: boolean) {
  void actions.enqueue(key, front)
}
</script>

<template>
  <div class="cards">
    <Frame class="card">
      <div class="label">Loop state</div>
      <div class="value">{{ loop ? loop.wanted : '—' }} <small v-if="loop?.wanted === 'stopped'">no new runs</small></div>
      <div class="note">{{ loopNote }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">In flight</div>
      <div class="value">{{ inFlight?.key ?? '—' }} <small v-if="inFlight">{{ stageName(inFlight.stage) }}</small></div>
      <div v-if="inFlight" class="note">{{ inFlight.summary ?? 'no summary' }}<br />{{ fmtDuration(inFlight.seconds) }} so far<template v-if="inFlight.stageSince">, {{ stageName(inFlight.stage) }} for {{ fmtAgo(inFlight.stageSince, state!.now) }}</template><template v-if="inFlight.rework">, rework round {{ inFlight.rework }}</template><template v-if="inFlight.cancelRequestedAt">, cancelling</template></div>
      <div v-else class="note">Nothing in flight.</div>
    </Frame>
    <Frame class="card">
      <div class="label">Queued next</div>
      <div class="value">{{ queue[0]?.key ?? '—' }} <small v-if="queue.length">{{ queue.length }} queued</small></div>
      <div class="note">{{ queue[0] ? queue[0].summary ?? 'no summary' : 'The queue is empty: add a ticket below.' }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">Last batch</div>
      <div class="value">{{ state ? total(state.counts.lastBatch) : '—' }} <small v-if="state">{{ state.counts.lastBatchLabel.replace('batch-', '').replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/, '$1-$2-$3 $4:$5') }}</small></div>
      <div class="note">{{ state ? breakdown(state.counts.lastBatch) : '' }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">Last 7 days</div>
      <div class="value">{{ state ? total(state.counts.last7Days) : '—' }}</div>
      <div class="note">{{ state ? breakdown(state.counts.last7Days) : '' }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">Runs to date</div>
      <div class="value">{{ allTime.n }}</div>
      <div class="note">{{ fmtDuration(allTime.total) }} in all · avg {{ fmtDuration(allTime.avg) }}<br />Every run under .pipeline-runs, verdict as state.md says.</div>
    </Frame>
  </div>

  <div class="cockpit">
    <div class="stack">
      <Frame>
        <div class="label">Control</div>
        <div class="ctl">
          <button class="btn primary big" :disabled="!loop || loop.wanted === 'running' || !state?.service.alive" @click="actions.start()">Start</button>
          <button class="btn" style="height: 48px" :disabled="!loop || loop.wanted !== 'running'" @click="actions.stop()">Stop</button>
        </div>
        <p class="hint">Stop only prevents the next run. A run already in flight keeps going.</p>
        <p v-if="state?.setup" class="hint">Each run: {{ state.setup.entry }}; pull requests {{ state.setup.pullRequests ? 'on' : 'off — the run ends before its push' }}.</p>
        <div class="block">
          <div class="label">Queue a ticket</div>
          <div class="ctl">
            <input v-model="key" class="field" placeholder="KAZ-1234" @keyup.enter="add(false)" />
            <button class="btn" :disabled="!key.trim()" @click="add(false)">To end</button>
            <button class="btn" :disabled="!key.trim()" @click="add(true)">To front</button>
          </div>
          <p class="hint">The summary is read from Jira; a key Jira does not know is refused, a ticket already queued is refused.</p>
        </div>
        <div class="block">
          <div class="label">Run in flight</div>
          <div class="ctl">
            <button class="btn danger" :disabled="!inFlight || !!inFlight.cancelRequestedAt" @click="actions.cancel()">Cancel {{ inFlight?.key ?? '' }}</button>
            <a v-if="inFlight && runNumber(inFlight.runDir)" class="btn" :href="`#/runs/${inFlight.key}/${runNumber(inFlight.runDir)}`">Reports</a>
          </div>
          <p class="hint">Ends the session within 30 s. The run is recorded cancelled with the stage it was in; its worktree and reports stay. The next queued ticket starts if the loop is running.</p>
        </div>
        <div class="block">
          <div class="label">Search tickets</div>
          <div class="ctl">
            <input id="jira-search" v-model="query" class="field" placeholder="KAZ-7785 or search pane" autocomplete="off" @input="typed()" @keyup.enter="searchNow()" @keyup.esc="clearSearch()" />
            <button v-if="query" class="btn" @click="clearSearch()">Clear</button>
          </div>
          <p class="hint" :class="{ 'hint-bad': searchError }">{{ searchNote }}</p>
        </div>
      </Frame>

      <Frame>
        <div class="label">State sources</div>
        <div v-if="health" class="deps">
          <div v-for="(check, name) in health" :key="name" class="dep">
            <div class="text">
              <div class="name">{{ names[name] ?? name }}</div>
              <div class="detail" :title="check.detail">{{ check.detail }}</div>
            </div>
            <span class="pill" :class="check.ok ? 'ok' : 'bad'">{{ check.ok ? 'OK' : 'not OK' }}</span>
          </div>
          <p class="hint">Checked at {{ fmtClock(health.runsDir.checkedAt) }}, once a minute. What does not depend on a failed source keeps working: without Jira a ticket is queued with its key alone, without Bitbucket a pull request's state is unknown.</p>
        </div>
        <p v-else class="hint">Not checked yet.</p>
      </Frame>
    </div>

    <div class="stack">
      <Frame v-if="results && results.length" title="Jira search" :count="shownCount" :note="`${scopeText ? `${scopeText.charAt(0).toUpperCase()}${scopeText.slice(1)}, the latest updated first. ` : ''}Queue a ticket from here; its summary is read from Jira again as it is added.`">
        <template #right><button class="btn tiny" @click="clearSearch()">Clear</button></template>
        <table class="sheet-table">
          <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Type</th><th>Assignee</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            <tr v-for="row in found" :key="row.issue.key">
              <td class="key"><a :href="`https://cgstowernetworks.atlassian.net/browse/${row.issue.key}`" target="_blank" rel="noopener">{{ row.issue.key }}</a></td>
              <td class="summary">{{ row.issue.summary }}</td>
              <td><span v-if="row.issue.status" class="pill" :class="statusClass(row.issue.statusCategory)">{{ row.issue.status }}</span></td>
              <td class="dim">{{ row.issue.type ?? '' }}</td>
              <td class="dim">{{ row.issue.assignee ?? '' }}</td>
              <td><template v-if="row.lastRun"><a v-if="row.lastRun.path" :href="`#/runs/${row.lastRun.key}/${row.lastRun.number}`" class="pill" :class="verdictClass(row.lastRun.verdict)" style="text-decoration: none">{{ row.lastRun.verdict ?? row.lastRun.ending }}</a><span v-else class="pill">{{ row.lastRun.ending }}</span></template><span v-else class="dim">never run</span></td>
              <td><div class="actions">
                <span v-if="row.inFlight" class="pill slate">in flight</span>
                <span v-if="row.position !== null" class="pill">queued #{{ row.position }}</span>
                <template v-else>
                  <button class="btn tiny" @click="queueFound(row.issue.key, false)">To end</button>
                  <button class="btn tiny" @click="queueFound(row.issue.key, true)">To front</button>
                </template>
              </div></td>
            </tr>
          </tbody>
        </table>
        <div v-if="next" class="more"><button class="btn" :disabled="loadingMore" @click="loadMore()">{{ loadingMore ? 'Loading…' : 'Show 20 more' }}</button></div>
      </Frame>

      <Frame title="Queue" :count="queue.length ? `${queue.length} queued` : 'empty'" note="In order; the loop takes the first one. A ticket already in flight or finished can be queued again and gets a new run.">
        <table v-if="queue.length" class="sheet-table">
          <thead><tr><th>#</th><th>Key</th><th>Summary</th><th></th></tr></thead>
          <tbody>
            <tr v-for="(item, i) in queue" :key="item.key">
              <td class="num dim">{{ i + 1 }}</td>
              <td class="key"><a :href="`https://cgstowernetworks.atlassian.net/browse/${item.key}`" target="_blank" rel="noopener">{{ item.key }}</a></td>
              <td class="summary">{{ item.summary ?? '' }}</td>
              <td><div class="actions">
                <button class="btn tiny" :disabled="i === 0" title="Move up" @click="move(i, -1)">↑</button>
                <button class="btn tiny" :disabled="i === queue.length - 1" title="Move down" @click="move(i, 1)">↓</button>
                <button class="btn tiny" :disabled="i === 0" @click="actions.reorder([item.key])">First</button>
                <button class="btn tiny danger" @click="actions.remove(item.key)">Remove</button>
              </div></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">Nothing queued.</div>
      </Frame>

      <Frame title="Recent runs" note="From .pipeline-runs and the service's own records.">
        <template #right><a class="small-link" href="#/runs" style="font: 600 11px/1 var(--cond); letter-spacing: 0.16em; text-transform: uppercase">All runs</a></template>
        <table v-if="recent.length" class="sheet-table">
          <thead><tr><th>Ticket</th><th>Summary</th><th>Verdict</th><th>Ending</th><th>PR</th><th>Duration</th><th>Started</th></tr></thead>
          <tbody>
            <tr v-for="run in recent" :key="run.path || run.serviceRunId || run.key">
              <td class="key"><a v-if="run.path" :href="`#/runs/${run.key}/${run.number}`">{{ run.key }}</a><span v-else>{{ run.key }}</span><span v-if="run.number > 1" class="dim"> · {{ run.number }}</span></td>
              <td class="summary">{{ run.summary ?? '' }}</td>
              <td><span class="pill" :class="verdictClass(run.verdict)">{{ run.verdict ?? run.ending }}</span></td>
              <td class="dim">{{ run.ending }}</td>
              <td><a v-if="run.pr" :href="run.pr.url" target="_blank" rel="noopener" :title="run.pr.state">#{{ prNumber(run.pr.url) }}</a></td>
              <td class="num">{{ fmtDuration(run.seconds) }}</td>
              <td class="num dim">{{ fmtTime(run.startedAt) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">No runs yet.</div>
      </Frame>
    </div>
  </div>
</template>
