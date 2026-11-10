<script setup lang="ts">
// The cockpit: a strip with the loop, what is in flight, what is next and where runs go; the
// controls; the queue, the latest runs and the state sources. One field queues a ticket by its
// key or searches Jira, within the operator's JQL when one is applied; the run in flight is cancelled from its own card. Explanations sit in
// tooltips, so the sheet says only what is happening. Cancelling the run in flight asks first:
// it cannot be taken back, and the session it ends cost a slot of the subscription.
import { computed, onMounted, ref, watch } from 'vue'
import Frame from '../components/Frame.vue'
import MigrationMark from '../components/MigrationMark.vue'
import { MIGRATION_LABEL } from '../../../server/history/outcome.ts'
import {
  endingLabel,
  endingTone,
  fmtAgo,
  fmtClock,
  fmtDate,
  fmtDuration,
  fmtTime,
  prNumber,
  stageOfAgent,
  toneClass,
  verdictClass,
} from '../api.ts'
import { api, type RunSettings } from '../api.ts'
import { actions, history, liveStage, PULL_REQUESTS_WORDS, runSeconds, saveSettings, state, ticketUrl } from '../console.ts'
import {
  applyJql,
  clearSearch,
  dropJql,
  jql,
  jqlDraft,
  jqlError,
  jqlOn,
  loadingMore,
  loadMore,
  next,
  query,
  restoreSearch,
  results,
  scope,
  searchError,
  searching,
  searchNow,
  switchJql,
  total as foundTotal,
  typed,
} from '../search.ts'

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
const failing = computed(() =>
  health.value
    ? Object.entries(health.value)
        .filter(([, c]) => !c.ok)
        .map(([n]) => names[n] ?? n)
    : [],
)
const SOURCES_OPEN = 'pipeline-ui.sources-open'
const sourcesOpen = ref(
  (() => {
    try {
      return localStorage.getItem(SOURCES_OPEN) === '1'
    } catch {
      return false
    }
  })(),
)
watch(sourcesOpen, (open) => {
  try {
    localStorage.setItem(SOURCES_OPEN, open ? '1' : '0')
  } catch {
    /* not kept */
  }
})

/** The clock alone for today, the date too otherwise. */
function when(iso: string | null): string {
  if (!iso) return '—'
  return fmtDate(iso) === fmtDate(new Date()) ? fmtClock(iso) : fmtTime(iso)
}
// One line under the loop's state: why it stopped, or what it does next.
const loopNote = computed(() => {
  const l = loop.value
  if (!l) return ''
  if (l.wanted === 'running')
    return inFlight.value ? 'next ticket when this run ends' : queue.value.length ? 'taking the next ticket' : 'waiting for a ticket'
  if (l.stoppedReason === 'usage-limit')
    return `usage limit at ${when(l.stoppedAt)}${l.usageLimitResetsAt ? `, resets ${when(new Date(l.usageLimitResetsAt * 1000).toISOString())}` : ''}`
  if (l.stoppedReason === 'entry-point') return `entry point refused at ${when(l.stoppedAt)}`
  if (l.stoppedReason === 'restart') return `by the service's restart, ${when(l.stoppedAt)}`
  if (l.stoppedReason === 'operator') return `by Stop, ${when(l.stoppedAt)}`
  return 'never started'
})
const loopProblem = computed(() =>
  loop.value?.wanted === 'stopped' && loop.value.stoppedReason === 'entry-point' ? loop.value.stoppedDetail : null,
)
const inFlightNote = computed(() => {
  const r = inFlight.value
  if (!r) return ''
  const parts = [`${fmtDuration(r.seconds)} so far`]
  if (r.stageSince) parts.push(`${stageOfAgent(r.stage)} ${fmtAgo(r.stageSince, state.value!.now)}`)
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
// A reorder moves the rows at once, before the service answers, so they glide on the click; the
// next poll brings the service's order back if it refused.
function reorderNow(keys: string[]) {
  if (state.value) {
    const byKey = new Map(state.value.queue.map((q) => [q.key, q]))
    const moved = keys.map((k) => byKey.get(k)!).filter(Boolean)
    state.value = { ...state.value, queue: [...moved, ...state.value.queue.filter((q) => !keys.includes(q.key))] }
  }
  void actions.reorder(keys)
}
function move(index: number, by: number) {
  const keys = queue.value.map((q) => q.key)
  const t = index + by
  if (t < 0 || t >= keys.length) return
  ;[keys[index], keys[t]] = [keys[t]!, keys[index]!]
  reorderNow(keys)
}
const runNumber = (dir: string | null) => dir?.match(/run-(\d+)$/)?.[1] ?? null

// The search's rows beside what the console knows of each ticket: its place in the queue, the
// run in flight, its latest run.
const found = computed(() =>
  (results.value ?? []).map((issue) => {
    const position = queue.value.findIndex((q) => q.key === issue.key)
    const lastRun = history.value?.runs.find((r) => r.key === issue.key) ?? null
    return { issue, position: position === -1 ? null : position + 1, inFlight: inFlight.value?.key === issue.key, lastRun }
  }),
)
// Where the search looked, for the note when nothing is found: "in KAZ", "in KAZ with “search pane”", "in every project
// with …"; within a JQL "found by the JQL", "in KAZ with … within the JQL".
const scopeText = computed(() => {
  const s = scope.value
  if (!s) return ''
  const within = s.jql !== undefined
  if ('key' in s) return within ? `${s.key} within the JQL` : s.key
  if (within && !s.project && !s.words) return 'found by the JQL'
  const where = [
    s.project ? `in ${s.project}` : within ? '' : 'in every project',
    s.words ? `with “${s.words}”` : '',
    within ? 'within the JQL' : '',
  ]
  return where.filter(Boolean).join(' ')
})
const shownCount = computed(() => {
  const shown = results.value?.length ?? 0
  return foundTotal.value !== null && foundTotal.value > shown
    ? `${shown} of ${foundTotal.value.toLocaleString('en-US')}`
    : `${shown} found`
})
// Under the field only what the results frame cannot say: searching, nothing found, an error.
const searchNote = computed(() => {
  if (searchError.value) return `Jira cannot be searched: ${searchError.value}`
  if (searching.value) return 'Searching Jira…'
  if (results.value && !results.value.length) {
    const s = scope.value
    if (s && 'key' in s) return s.jql !== undefined ? `No ${s.key} within the JQL.` : `Jira has no ${s.key}.`
    return `Nothing ${scopeText.value}.`
  }
  return ''
})
const fieldHelp =
  'A ticket key queues it at the top or the bottom of the queue. A project key (KAZ, RPG) lists the project, with words after it to search in it; other words search every project. With a JQL applied all of it is searched within what the JQL finds, and an empty field lists those. The summary is read from Jira as a ticket is queued; a key Jira does not know is refused.'
const jqlHelp =
  'Any JQL Jira takes, with or without ORDER BY. Enter or Apply searches within it; Shift+Enter is a new line. It stays in this browser, used while the switch is on.'
const switchHelp = computed(() =>
  jqlOn.value
    ? jql.value
      ? `On: searches are within ${jql.value}`
      : 'On: no JQL applied yet'
    : 'Off: searches every project. On: searches within a JQL query.',
)
const jqlUsed = computed(() => jqlOn.value && jql.value !== '')
const jqlChanged = computed(() => jqlDraft.value.trim() !== jql.value)
const statusClass = (category: string | null) => (category === 'done' ? 'ok' : category === 'indeterminate' ? 'slate' : '')
// A reload shows the search as it was: the field and the JQL come back from this browser, and
// their first page is asked for again.
onMounted(restoreSearch)
function queueFound(key: string, front: boolean) {
  void actions.enqueue(key, front)
}
// The confirmation of a cancel: a modal dialog of the sheet; removing a queued ticket does not
// ask, since the ticket can be queued again.
const cancelDialog = ref<HTMLDialogElement | null>(null)
function askCancel() {
  cancelDialog.value?.showModal()
}
function confirmCancel() {
  cancelDialog.value?.close()
  void actions.cancel()
}

// The run settings: the target branch, the pull requests and a session's time limit, changed
// in a dialog of the sheet. The service checks a new branch on origin before it keeps it, so
// Save may take a few seconds and may refuse; what it says stays in the dialog. A change is for
// the next run: the one in flight keeps what it started with.
const settingsDialog = ref<HTMLDialogElement | null>(null)
const draft = ref<RunSettings>({ baseBranch: '', pullRequests: 'on', timeoutHours: 4 })
const branches = ref<string[]>([])
const saving = ref(false)
const settingsError = ref<string | null>(null)
const PULL_REQUESTS_CHOICES: { value: RunSettings['pullRequests']; label: string; says: string }[] = [
  { value: 'on', label: 'On', says: 'A run opens the pull request it decides on, ready or draft.' },
  { value: 'draft', label: 'Drafts only', says: 'Every pull request opens as a draft; a ready one is refused.' },
  { value: 'off', label: 'Off', says: 'A run ends before its push: no branch on origin, no pull request.' },
]
const pullRequestsSays = computed(() => PULL_REQUESTS_CHOICES.find((c) => c.value === draft.value.pullRequests)?.says ?? '')
function openSettings() {
  const s = setup.value
  if (!s) return
  draft.value = { baseBranch: s.baseBranch, pullRequests: s.pullRequests, timeoutHours: s.timeoutHours }
  settingsError.value = null
  settingsDialog.value?.showModal()
  // The branches origin has, offered under the field; the field takes any name without them.
  api.branches().then(
    (b) => (branches.value = b.branches),
    () => (branches.value = []),
  )
}
function useDefaults() {
  if (setup.value) draft.value = { ...setup.value.defaults }
}
const atDefaults = computed(() => {
  const d = setup.value?.defaults
  return (
    !!d &&
    draft.value.baseBranch === d.baseBranch &&
    draft.value.pullRequests === d.pullRequests &&
    draft.value.timeoutHours === d.timeoutHours
  )
})
async function confirmSettings() {
  saving.value = true
  settingsError.value = await saveSettings({ ...draft.value, baseBranch: draft.value.baseBranch.trim() })
  saving.value = false
  if (settingsError.value === null) settingsDialog.value?.close()
}
</script>

<template>
  <div class="cards">
    <Frame class="card">
      <div class="label">Loop</div>
      <div class="value" :class="{ live: running }">
        <Transition name="tick" mode="out-in"
          ><span :key="loop?.wanted ?? '-'">{{ loop ? loop.wanted : '—' }}</span></Transition
        >
      </div>
      <div class="note one" :title="loopNote">{{ loopNote }}</div>
      <div v-if="loopProblem" class="note err" :title="loopProblem">{{ loopProblem }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">In flight</div>
      <div class="value">
        <Transition name="tick" mode="out-in"
          ><span :key="inFlight?.key ?? '-'">{{ inFlight?.key ?? '—' }}</span></Transition
        ><MigrationMark v-if="inFlight?.migration" />
        <Transition name="tick" mode="out-in"
          ><small v-if="inFlight" :key="inFlight.stage ?? '-'">{{ stageOfAgent(inFlight.stage) }}</small></Transition
        >
      </div>
      <template v-if="inFlight">
        <div class="note one" :title="inFlight.summary ?? ''">{{ inFlight.summary ?? 'no summary' }}</div>
        <div class="note one">
          {{ inFlightNote }}<template v-if="inFlight.cancelRequestedAt"> · <span class="err">cancelling</span></template>
        </div>
        <div class="acts">
          <a v-if="runNumber(inFlight.runDir)" class="btn tiny" :href="`#/runs/${inFlight.key}/${runNumber(inFlight.runDir)}`">Reports</a>
          <button
            class="btn tiny danger"
            :disabled="!!inFlight.cancelRequestedAt"
            title="Ends the session within 30 s. The run is recorded cancelled with the stage it was in; its worktree and reports stay."
            @click="askCancel()"
          >
            Cancel
          </button>
        </div>
      </template>
      <div v-else class="note">nothing running</div>
    </Frame>
    <Frame class="card">
      <div class="label">Next</div>
      <div class="value">
        <Transition name="tick" mode="out-in"
          ><span :key="queue[0]?.key ?? '-'">{{ queue[0]?.key ?? '—' }}</span></Transition
        ><MigrationMark v-if="queue[0]?.migration" />
        <small v-if="queue.length > 1">+{{ queue.length - 1 }} queued</small>
      </div>
      <div class="note one" :title="queue[0]?.summary ?? ''">{{ queue[0] ? (queue[0].summary ?? 'no summary') : 'queue empty' }}</div>
    </Frame>
    <Frame class="card">
      <div class="label">Target branch</div>
      <div class="value branch">{{ setup?.baseBranch ?? '—' }}</div>
      <div v-if="setup" class="note one" :title="`Each run: ${setup.entry}.`">
        pull requests
        <span :class="setup.pullRequests === 'off' ? 'warn' : 'ok'">{{
          setup.pullRequests === 'off' ? 'off' : `${PULL_REQUESTS_WORDS[setup.pullRequests]}, into ${setup.baseBranch}`
        }}</span>
      </div>
      <!-- A service started before the run settings could be changed sends no defaults: it has nothing to save them with. -->
      <div v-if="setup?.defaults" class="acts">
        <button
          class="btn tiny"
          title="The target branch, the pull requests and a session's time limit, from the next run."
          @click="openSettings()"
        >
          Settings
        </button>
      </div>
    </Frame>
  </div>

  <dialog ref="settingsDialog" class="frame confirm settings" aria-labelledby="settings-title">
    <div class="frame-head">
      <h2 id="settings-title">Run settings</h2>
      <span class="note">from the next run</span>
    </div>
    <div class="setting">
      <label class="label" for="setting-branch">Target branch</label>
      <input
        id="setting-branch"
        v-model="draft.baseBranch"
        class="field"
        form="settings-form"
        list="setting-branches"
        required
        autocomplete="off"
        spellcheck="false"
      />
      <datalist id="setting-branches"><option v-for="b in branches" :key="b" :value="b" /></datalist>
      <p class="hint">A run's worktree starts from it and its pull request goes to it. It must have the pipeline's entry point.</p>
    </div>
    <div class="setting">
      <div id="setting-prs" class="label">Pull requests</div>
      <div class="chips" role="group" aria-labelledby="setting-prs">
        <button
          v-for="c in PULL_REQUESTS_CHOICES"
          :key="c.value"
          type="button"
          class="chip"
          :class="{ on: draft.pullRequests === c.value }"
          :aria-pressed="draft.pullRequests === c.value"
          @click="draft.pullRequests = c.value"
        >
          {{ c.label }}
        </button>
      </div>
      <p class="hint">{{ pullRequestsSays }}</p>
    </div>
    <div class="setting">
      <label class="label" for="setting-hours">Session time limit, hours</label>
      <input
        id="setting-hours"
        v-model.number="draft.timeoutHours"
        class="field hours"
        form="settings-form"
        type="number"
        min="0.5"
        max="24"
        step="0.5"
        required
      />
      <p class="hint">A session that takes longer is ended and its run recorded as timed out.</p>
    </div>
    <p v-if="inFlight" class="hint">{{ inFlight.key }} is in flight and keeps the settings it started with.</p>
    <p v-if="settingsError" class="hint err" role="alert">{{ settingsError }}</p>
    <form id="settings-form" @submit.prevent="confirmSettings()">
      <button class="btn primary" :disabled="saving">{{ saving ? 'Checking the branch…' : 'Save' }}</button
      ><button type="button" class="btn" :disabled="saving" @click="settingsDialog?.close()">Close</button
      ><button
        v-if="setup && !atDefaults"
        type="button"
        class="btn"
        :disabled="saving"
        :title="`The service's own: ${setup.defaults.baseBranch}, pull requests ${PULL_REQUESTS_WORDS[setup.defaults.pullRequests]}, ${setup.defaults.timeoutHours} h.`"
        @click="useDefaults()"
      >
        Defaults
      </button>
    </form>
  </dialog>

  <dialog ref="cancelDialog" class="frame confirm" aria-labelledby="cancel-title">
    <div class="frame-head">
      <h2 id="cancel-title">Cancel {{ inFlight?.key ?? 'the run' }}?</h2>
      <span v-if="inFlight" class="note">{{ stageOfAgent(inFlight.stage) }} · {{ fmtDuration(inFlight.seconds) }} so far</span>
    </div>
    <p>
      The session ends within 30 s and the run is recorded cancelled with the stage it was in. Its worktree, its branch and the reports
      written so far stay; the next queued ticket starts if the loop is running. The ticket can be queued again for a new run.
    </p>
    <form method="dialog">
      <button type="button" class="btn primary" @click="confirmCancel()">Cancel the run</button
      ><button class="btn" autofocus>Keep it running</button>
    </form>
  </dialog>

  <div class="cockpit">
    <div class="stack">
      <Frame>
        <div class="label">Control</div>
        <button
          v-if="!running"
          class="btn primary big wide"
          :disabled="!loop || !state?.service.alive"
          title="The loop takes the queued tickets one at a time."
          @click="actions.start()"
        >
          Start
        </button>
        <button v-else class="btn big wide" title="No new run starts; the run in flight keeps going." @click="actions.stop()">Stop</button>
        <div class="block">
          <div class="block-head">
            <div class="label">Add a ticket</div>
            <button type="button" class="switch" role="switch" :aria-checked="jqlOn" :title="switchHelp" @click="switchJql(!jqlOn)">
              <span class="track"><span class="knob" /></span>Within JQL
            </button>
          </div>
          <div v-if="jqlOn" class="jql">
            <textarea
              v-model="jqlDraft"
              class="field"
              rows="3"
              spellcheck="false"
              placeholder='project = KAZ AND status = "To Do" ORDER BY priority DESC'
              :title="jqlHelp"
              @keydown.enter.exact.prevent="applyJql()"
            />
            <div class="ctl gap">
              <button class="btn" :disabled="!jqlDraft.trim() || (!jqlChanged && !jqlError)" @click="applyJql()">Apply</button>
              <button class="btn" :disabled="!jql && !jqlDraft" @click="dropJql()">Remove</button>
            </div>
            <p v-if="jqlError" class="hint err">Jira does not take this JQL: {{ jqlError }}</p>
            <p v-else-if="jql && jqlChanged" class="hint">Not applied yet: searches are still within the JQL before the edit.</p>
            <p v-else-if="jql" class="hint">Searches below are within this JQL; with the field empty, everything it finds is listed.</p>
            <p v-else class="hint">Type a JQL and press Enter; searches below are then made within it.</p>
          </div>
          <div class="ctl">
            <input
              id="jira-search"
              v-model="query"
              class="field"
              :placeholder="jqlUsed ? 'KAZ-1234, KAZ or words, within the JQL' : 'KAZ-1234, KAZ or words'"
              autocomplete="off"
              :title="fieldHelp"
              @input="typed()"
              @keyup.enter="searchNow()"
              @keyup.esc="clearSearch()"
            />
            <button v-if="query && !typedKey" class="btn" @click="clearSearch()">Clear</button>
          </div>
          <div v-if="typedKey" class="ctl gap">
            <button class="btn" title="Queue it first: the loop takes it next" @click="queueTyped(true)">Top</button>
            <button class="btn" title="Queue it last" @click="queueTyped(false)">Bottom</button>
          </div>
          <p v-if="searchNote" class="hint" :class="{ err: searchError }">{{ searchNote }}</p>
        </div>
      </Frame>

      <Frame class="sources" @click="sourcesOpen = !sourcesOpen">
        <button class="fold" type="button" :aria-expanded="sourcesOpen">
          <span class="label">State sources</span>
          <span class="lamp" :class="!health ? 'unknown' : failing.length ? 'bad' : 'ok'" />
          <span class="state" :class="{ err: failing.length }">{{
            !health ? 'not checked yet' : failing.length ? `${failing.join(', ')} not OK` : 'all OK'
          }}</span>
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
          <p class="hint">
            Checked at {{ fmtClock(health.runsDir.checkedAt) }}, once a minute. What does not depend on a failed source keeps working:
            without Jira a ticket is queued with its key alone.
          </p>
        </div>
      </Frame>
    </div>

    <div class="stack">
      <Frame
        v-if="results && results.length"
        title="Jira search"
        :count="shownCount"
        note="Queue a ticket from here; its summary is read from Jira again as it is added."
      >
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Summary</th>
              <th>Status</th>
              <th>Type</th>
              <th>Assignee</th>
              <th>Last run</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in found" :key="row.issue.key">
              <td class="key">
                <a v-if="ticketUrl(row.issue.key)" :href="ticketUrl(row.issue.key)!" target="_blank" rel="noopener">{{ row.issue.key }}</a
                ><span v-else>{{ row.issue.key }}</span
                ><MigrationMark v-if="row.issue.labels.includes(MIGRATION_LABEL)" />
              </td>
              <td class="summary">{{ row.issue.summary }}</td>
              <td>
                <span v-if="row.issue.status" class="pill" :class="statusClass(row.issue.statusCategory)">{{ row.issue.status }}</span>
              </td>
              <td class="dim">{{ row.issue.type ?? '' }}</td>
              <td class="dim">{{ row.issue.assignee ?? '' }}</td>
              <td>
                <template v-if="row.lastRun"
                  ><a
                    v-if="row.lastRun.path"
                    :href="`#/runs/${row.lastRun.key}/${row.lastRun.number}`"
                    class="pill"
                    :class="row.lastRun.verdict ? verdictClass(row.lastRun.verdict) : toneClass(endingTone(row.lastRun.ending))"
                    :title="row.lastRun.reason ?? ''"
                    style="text-decoration: none"
                    >{{ row.lastRun.verdict ?? endingLabel(row.lastRun.ending) }}</a
                  ><span v-else class="pill" :class="toneClass(endingTone(row.lastRun.ending))">{{
                    endingLabel(row.lastRun.ending)
                  }}</span></template
                ><span v-else class="dim">never run</span>
              </td>
              <td>
                <div class="actions">
                  <span v-if="row.inFlight" class="pill slate">in flight</span>
                  <span v-if="row.position !== null" class="pill">queued #{{ row.position }}</span>
                  <template v-else>
                    <button class="btn tiny" title="Queue it first: the loop takes it next" @click="queueFound(row.issue.key, true)">
                      Top
                    </button>
                    <button class="btn tiny" title="Queue it last" @click="queueFound(row.issue.key, false)">Bottom</button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="next" class="more">
          <button class="btn" :disabled="loadingMore" @click="loadMore()">{{ loadingMore ? 'Loading…' : 'Show 20 more' }}</button>
        </div>
      </Frame>

      <Frame
        title="Queue"
        :count="queue.length ? `${queue.length} queued` : 'empty'"
        note="In order; the loop takes the first one. A ticket already in flight or finished can be queued again and gets a new run."
      >
        <div v-if="queue.length" class="qhead"><span>#</span><span>Key</span><span>Summary</span><span /></div>
        <TransitionGroup tag="div" name="q" class="qlist">
          <div v-for="(item, i) in queue" :key="item.key" class="qrow">
            <span class="num dim">{{ i + 1 }}</span>
            <span class="key"
              ><a v-if="ticketUrl(item.key)" :href="ticketUrl(item.key)!" target="_blank" rel="noopener">{{ item.key }}</a
              ><span v-else>{{ item.key }}</span
              ><MigrationMark v-if="item.migration"
            /></span>
            <span class="summary one-line" :title="item.summary ?? ''">{{ item.summary ?? '' }}</span>
            <span class="actions">
              <button class="btn tiny" :disabled="i === 0" title="Move up" @click="move(i, -1)">↑</button>
              <button class="btn tiny" :disabled="i === queue.length - 1" title="Move down" @click="move(i, 1)">↓</button>
              <button class="btn tiny" :disabled="i === 0" @click="reorderNow([item.key])">First</button>
              <button class="btn tiny danger" @click="actions.remove(item.key)">Remove</button>
            </span>
          </div>
        </TransitionGroup>
        <Transition name="fade"><div v-if="!queue.length" class="empty">Nothing queued.</div></Transition>
      </Frame>

      <Frame title="Recent runs" note="From .pipeline-runs and the service's own records.">
        <template #right><a class="small-link" href="#/runs">All runs</a></template>
        <div v-if="recent.length" class="table-scroll">
          <table class="wide runs">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Jira</th>
                <th>Summary</th>
                <th>Verdict</th>
                <th>Ending</th>
                <th>PR</th>
                <th>Duration</th>
                <th>Started</th>
              </tr>
            </thead>
            <TransitionGroup tag="tbody" name="rows">
              <tr v-for="run in recent" :key="run.path || run.serviceRunId || run.key" :class="{ live: run.ending === 'in-flight' }">
                <td class="key">
                  <a v-if="run.path" :href="`#/runs/${run.key}/${run.number}`" title="The run's agents and reports">{{ run.key }}</a
                  ><span v-else>{{ run.key }}</span
                  ><span v-if="run.number > 1" class="dim"> · {{ run.number }}</span
                  ><MigrationMark v-if="run.migration" /><span v-if="run.ending === 'in-flight'" class="pulse" title="in flight" />
                </td>
                <td class="jira">
                  <a v-if="ticketUrl(run.key)" :href="ticketUrl(run.key)!" target="_blank" rel="noopener" :title="`${run.key} in Jira`"
                    >↗</a
                  >
                </td>
                <td class="summary one-line" :title="run.summary ?? ''">{{ run.summary ?? '' }}</td>
                <td>
                  <span class="pill" :class="verdictClass(run.verdict)" :title="run.reason ?? ''">{{ run.verdict ?? '—' }}</span>
                </td>
                <td>
                  <span class="pill" :class="toneClass(endingTone(run.ending))" :title="run.endingDetail ?? ''"
                    >{{ endingLabel(run.ending) }}<template v-if="liveStage(run)"> · {{ liveStage(run) }}</template></span
                  >
                </td>
                <td>
                  <a v-if="run.pr" :href="run.pr.url" target="_blank" rel="noopener" :title="run.pr.state.toLowerCase()"
                    >#{{ prNumber(run.pr.url) }}</a
                  >
                </td>
                <td class="num">{{ fmtDuration(runSeconds(run)) }}</td>
                <td class="num dim">{{ fmtTime(run.startedAt) }}</td>
              </tr>
            </TransitionGroup>
          </table>
        </div>
        <div v-else class="empty">No runs yet.</div>
      </Frame>
    </div>
  </div>
</template>
