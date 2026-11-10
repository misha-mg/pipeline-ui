<script setup lang="ts">
// The run settings, in the masthead beside the theme switch: a gear that opens a dialog of the
// sheet with the target branch (a combo over origin's branches, with a search), the pull requests and a
// session's time limit. The service checks a new branch on origin before it keeps it, so Save
// may take a few seconds and may refuse; what it says stays in the dialog. A change is for the
// next run: the one in flight keeps what it started with. A service started before the settings
// could be changed sends no defaults and has nothing to save them with: no gear then.
import { computed, ref } from 'vue'
import { api, type RunSettings } from '../api.ts'
import Combo, { type ComboGroup } from './Combo.vue'
import { PULL_REQUESTS_WORDS, saveSettings, state } from '../console.ts'

const setup = computed(() => state.value?.setup ?? null)
const inFlight = computed(() => state.value?.inFlight ?? null)
const settingsDialog = ref<HTMLDialogElement | null>(null)
const draft = ref<RunSettings>({ baseBranch: '', pullRequests: 'on', timeoutHours: 4 })
const branches = ref<string[]>([])
const branchesState = ref<'loading' | 'read' | 'none'>('loading')
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
  // The branches origin has, read when the dialog opens (the service fetches first, a few
  // seconds): until they come the select holds the branches in use.
  branchesState.value = 'loading'
  api.branches().then(
    (b) => {
      branches.value = b.branches
      branchesState.value = b.branches.length ? 'read' : 'none'
    },
    () => (branchesState.value = 'none'),
  )
}
// The combo's first group: the branch runs go to now and the service's default, at hand
// whatever origin's list says; then every other branch by name. The one being chosen stays in
// its place, ticked.
const branchesInUse = computed(() => [
  ...new Set([setup.value?.baseBranch, setup.value?.defaults?.baseBranch].filter((b): b is string => !!b)),
])
const otherBranches = computed(() => branches.value.filter((b) => !branchesInUse.value.includes(b)))
const branchGroups = computed<ComboGroup[]>(() => [
  {
    label: 'In use',
    options: branchesInUse.value.map((b) => ({ value: b, ...(b === setup.value?.defaults?.baseBranch ? { note: 'the default' } : {}) })),
  },
  { label: 'On origin', options: otherBranches.value.map((b) => ({ value: b })) },
])
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
  <button
    v-if="setup?.defaults"
    class="btn gear"
    type="button"
    aria-label="Run settings"
    title="Run settings: the target branch, the pull requests, a session's time limit"
    @click="openSettings()"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      />
    </svg>
  </button>
  <!-- In the body, not the masthead: the masthead restyles the buttons it holds. -->
  <Teleport to="body">
    <dialog ref="settingsDialog" class="frame confirm settings" aria-labelledby="settings-title">
      <div class="frame-head">
        <h2 id="settings-title">Run settings</h2>
        <span class="note">from the next run</span>
      </div>
      <div class="setting">
        <label class="label" for="setting-branch">Target branch</label>
        <Combo id="setting-branch" v-model="draft.baseBranch" :groups="branchGroups" search="Search origin's branches" :disabled="saving" />
        <p class="hint">
          A run's worktree starts from it and its pull request goes to it. It must have the pipeline's entry point.
          <template v-if="branchesState === 'loading'"> Reading origin's branches…</template>
          <span v-else-if="branchesState === 'none'" class="err"> Origin's branches could not be read.</span>
        </p>
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
          v-if="setup?.defaults && !atDefaults"
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
  </Teleport>
</template>
