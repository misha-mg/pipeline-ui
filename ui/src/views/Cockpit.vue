<script setup lang="ts">
// The cockpit: a strip with the loop, what is in flight, what is next and where runs go; the
// controls; the queue, the latest runs and the state sources. One field queues a ticket by its
// key or searches Jira; the run in flight is cancelled from its own card. Explanations sit in
// tooltips, so the sheet says only what is happening.
import { computed, ref, watch } from 'vue'
import Frame from '../components/Frame.vue'
import { fmtAgo, fmtClock, fmtDuration, fmtTime, prNumber, stageName, verdictClass } from '../api.ts'
import { actions, history, state, ticketUrl } from '../console.ts'
import { clearSearch, loadingMore, loadMore, next, query, results, scope, searchError, searching, searchNow, total as foundTotal, typed } from '../search.ts'

const loop = computed(() => state.value?.loop ?? null)
const running = computed(() => loop.value?.wanted === 'running')
const inFlight = computed(() => state.value?.inFlight ?? null)
const queue = computed(() => state.value?.queue ?? [])
const recent = computed(() => history.value?.runs.slice(0, 8) ?? [])
const health = computed(() => state.value?.health ?? null)
const setup = computed(() => state.value?.setup ?? null)
const names: Record<string, string> = { runsDir: '.pipeline-runs', tmux: 'tmux — batch.sh', jira: 'Jira' }
// The state sources fold into one lamp: green when every source is ok, rust naming the ones that
// are not. A click anywhere on the frame opens or closes it (the button inside is there for the
// keyboard; its click reaches the frame). Whether it is open is remembered in this browser.
const failing = computed(() => (health.value ? Object.entries(health.value).filter(([, c]) => !c.ok).map(([n]) => names[n] ?? n) : []))
const SOURCES_OPEN = 'pipeline-ui.sources-open'
const sourcesOpen = ref((() => { try { return localStorage.getItem(SOURCES_OPEN) === '1' } catch { return false } })())
watch(sourcesOpen, (open) => { try { localStorage.setItem(SOURCES_OPEN, open ? '1' : '0') } catch { /* not kept */ } })

/** The clock alone for today, the date too otherwise. */
function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toDateString() === new Date().toDateString() ? fmtClock(iso) : fmtTime(iso)
}
// One line under the loop's state: why it stopped, or what it does next.
const loopNote = computed(() => {
  const l = loop.value
  if (!l) return ''
  if (l.wanted === 'running') return inFlight.value ? 'next ticket when this run ends' : queue.value.length ? 'taking the next ticket' : 'waiting for a ticket'
  if (l.stoppedReason === 'usage-limit') return `usage limit at ${when(l.stoppedAt)}${l.usageLimitResetsAt ? `, resets ${when(new Date(l.usageLimitResetsAt * 1000).toISOString())}` : ''}`
  if (l.stoppedReason === 'entry-point') return `entry point refused at ${when(l.stoppedAt)}`
  if (l.stoppedReason === 'restart') return `by the service's restart, ${when(l.stoppedAt)}`
  if (l.stoppedReason === 'operator') return `by Stop, ${when(l.stoppedAt)}`
  return 'never started'
})
const loopProblem = computed(() => (loop.value?.wanted === 'stopped' && loop.value.stoppedReason === 'entry-point' ? loop.value.stoppedDetail : null))
const inFlightNote = computed(() => {
  const r = inFlight.value
  if (!r) return ''
  const parts = [`${fmtDuration(r.seconds)} so far`]
  if (r.stageSince) parts.push(`${stageName(r.stage)} ${fmtAgo(r.stageSince, state.value!.now)}`)
  if (r.rework) parts.push(`rework ${r.rework}`)
  return parts.join(' · ')
})

// The one field: a ticket key queues at once, anything else is a Jira search (search.ts).
const typedKey = computed(() => (/^\s*[A-Za-z][A-Za-z0-9]*-\d+\s*$/.test(query.value) ? query.value.trim().toUpperCase() : null))
function queueTyped(front: boolean) {
  if (!typedKey.value) return
  void actions.enqueue(typedKey.value, front)
  clearSearch()
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
// Under the field only what the results frame cannot say: searching, nothing found, an error.
const searchNote = computed(() => {
  if (searchError.value) return `Jira cannot be searched: ${searchError.value}`
  if (searching.value) return 'Searching Jira…'
  if (results.value && !results.value.length) return scope.value && 'key' in scope.value ? `Jira has no ${scope.value.key}.` : `Nothing ${scopeText.value}.`
  return ''
})
const fieldHelp = 'A ticket key queues it (To end, To front). A project key (KAZ, RPG) lists the project, with words after it to search in it; other words search every project. The summary is read from Jira as a ticket is queued; a key Jira does not know is refused.'
const statusClass = (category: string | null) => (category === 'done' ? 'ok' : category === 'indeterminate' ? 'slate' : '')
function queueFound(key: string, front: boolean) {
  void actions.enqueue(key, front)
}
</script>

<template>
  <div class="cards">
    <Frame class="card">
      <div class="label">Loop</div>
      <div class="value" :class="{ live: running }">{{ loop ? loop.wanted : '—' }}</div>
      <div class="note one" :title="loopNote">{{ loopNote }}</div>
      <div v-if="loopProblem" class="note err" :title="loopProblem">{{ loopProblem }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">In flight</div>
      <div class="value">{{ inFlight?.key ?? '—' }} <small v-if="inFlight">{{ stageName(inFlight.stage) }}</small></div>
      <template v-if="inFlight">
        <div class="note one" :title="inFlight.summary ?? ''">{{ inFlight.summary ?? 'no summary' }}</div>
        <div class="note one">{{ inFlightNote }}<template v-if="inFlight.cancelRequestedAt"> · <span class="err">cancelling</span></template></div>
        <div class="acts">
          <a v-if="runNumber(inFlight.runDir)" class="btn tiny" :href="`#/runs/${inFlight.key}/${runNumber(inFlight.runDir)}`">Reports</a>
          <button class="btn tiny danger" :disabled="!!inFlight.cancelRequestedAt" title="Ends the session within 30 s. The run is recorded cancelled with the stage it was in; its worktree and reports stay." @click="actions.cancel()">Cancel</button>
        </div>
      </template>
      <div v-else class="note">nothing running</div>
    </Frame>
    <Frame class="card">
      <div class="label">Next</div>
      <div class="value">{{ queue[0]?.key ?? '—' }} <small v-if="queue.length > 1">+{{ queue.length - 1 }} queued</small></div>
      <div class="note one" :title="queue[0]?.summary ?? ''">{{ queue[0] ? queue[0].summary ?? 'no summary' : 'queue empty' }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">Target branch</div>
      <div class="value branch">{{ setup?.baseBranch ?? '—' }}</div>
      <div v-if="setup" class="note one" :title="`Each run: ${setup.entry}.`">
        pull requests <span :class="setup.pullRequests === 'off' ? 'warn' : 'ok'">{{ setup.pullRequests === 'off' ? 'off' : `${setup.pullRequests === 'draft' ? 'drafts only' : 'on'}, into ${setup.baseBranch}` }}</span>
      </div>
    </Frame>
  </div>

  <div class="cockpit">
    <div class="stack">
      <Frame>
        <div class="label">Control</div>
        <button v-if="!running" class="btn primary big wide" :disabled="!loop || !state?.service.alive" title="The loop takes the queued tickets one at a time." @click="actions.start()">Start</button>
        <button v-else class="btn big wide" title="No new run starts; the run in flight keeps going." @click="actions.stop()">Stop</button>
        <div class="block">
          <div class="label">Add a ticket</div>
          <div class="ctl">
            <input id="jira-search" v-model="query" class="field" placeholder="KAZ-1234, KAZ or words" autocomplete="off" :title="fieldHelp" @input="typed()" @keyup.enter="searchNow()" @keyup.esc="clearSearch()" />
            <button v-if="query && !typedKey" class="btn" @click="clearSearch()">Clear</button>
          </div>
          <div v-if="typedKey" class="ctl gap">
            <button class="btn" @click="queueTyped(false)">To end</button>
            <button class="btn" @click="queueTyped(true)">To front</button>
          </div>
          <p v-if="searchNote" class="hint" :class="{ err: searchError }">{{ searchNote }}</p>
        </div>
      </Frame>

      <Frame class="sources" @click="sourcesOpen = !sourcesOpen">
        <button class="fold" type="button" :aria-expanded="sourcesOpen">
          <span class="label">State sources</span>
          <span class="lamp" :class="!health ? 'unknown' : failing.length ? 'bad' : 'ok'" />
          <span class="state" :class="{ err: failing.length }">{{ !health ? 'not checked yet' : failing.length ? `${failing.join(', ')} not OK` : 'all OK' }}</span>
          <span class="chevron">{{ sourcesOpen ? '−' : '+' }}</span>
        </button>
        <div v-if="sourcesOpen && health" class="deps">
          <div v-for="(check, name) in health" :key="name" class="dep">
            <div class="text">
              <div class="name">{{ names[name] ?? name }}</div>
              <div class="detail" :title="check.detail">{{ check.detail }}</div>
            </div>
            <span class="pill" :class="check.ok ? 'ok' : 'bad'">{{ check.ok ? 'OK' : 'not OK' }}</span>
          </div>
          <p class="hint">Checked at {{ fmtClock(health.runsDir.checkedAt) }}, once a minute. What does not depend on a failed source keeps working: without Jira a ticket is queued with its key alone.</p>
        </div>
      </Frame>
    </div>

    <div class="stack">
      <Frame v-if="results && results.length" title="Jira search" :count="shownCount" :note="`${scopeText ? `${scopeText.charAt(0).toUpperCase()}${scopeText.slice(1)}, the latest updated first. ` : ''}Queue a ticket from here; its summary is read from Jira again as it is added.`">
        <template #right><button class="btn tiny" @click="clearSearch()">Clear</button></template>
        <table>
          <thead><tr><th>Key</th><th>Summary</th><th>Status</th><th>Type</th><th>Assignee</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            <tr v-for="row in found" :key="row.issue.key">
              <td class="key"><a v-if="ticketUrl(row.issue.key)" :href="ticketUrl(row.issue.key)!" target="_blank" rel="noopener">{{ row.issue.key }}</a><span v-else>{{ row.issue.key }}</span></td>
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
        <table v-if="queue.length">
          <thead><tr><th>#</th><th>Key</th><th>Summary</th><th></th></tr></thead>
          <tbody>
            <tr v-for="(item, i) in queue" :key="item.key">
              <td class="num dim">{{ i + 1 }}</td>
              <td class="key"><a v-if="ticketUrl(item.key)" :href="ticketUrl(item.key)!" target="_blank" rel="noopener">{{ item.key }}</a><span v-else>{{ item.key }}</span></td>
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
        <template #right><a class="small-link" href="#/runs">All runs</a></template>
        <table v-if="recent.length">
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
