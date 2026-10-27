<script setup lang="ts">
// The cockpit: the loop's state, what is in flight and what is next, the controls, the queue,
// the latest runs and the dependencies, on one sheet.
import { computed, ref } from 'vue'
import Frame from '../components/Frame.vue'
import { fmtAgo, fmtClock, fmtDuration, fmtTime, prNumber, stageName, verdictClass, type Counts } from '../api.ts'
import { actions, history, state } from '../console.ts'

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
          <input class="field" placeholder="Jira search — coming" disabled />
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
