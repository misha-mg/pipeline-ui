<script setup lang="ts">
// One run: its stages and every report as the files read, state.md included.
import { ref, watch } from 'vue'
import Frame from '../components/Frame.vue'
import { api, fmtDuration, fmtTime, prNumber, type RunFiles } from '../api.ts'

const props = defineProps<{ target: { key: string; number: number } }>()
const run = ref<RunFiles | null>(null)
const error = ref<string | null>(null)

watch(() => props.target, async (t) => {
  run.value = null
  error.value = null
  try {
    run.value = await api.run(t.key, t.number)
  } catch (e) {
    error.value = String(e)
  }
}, { immediate: true, deep: true })
</script>

<template>
  <div class="page-head">
    <h1>{{ target.key }} · run {{ target.number }}</h1>
    <span v-if="run" class="stats">{{ run.summary ?? '' }} · started {{ fmtTime(run.startedAt) }} · {{ fmtDuration(run.seconds) }}</span>
    <a class="action" href="#/runs">All runs</a>
  </div>
  <div v-if="error" class="notice">{{ error }}</div>
  <template v-else-if="run">
    <div class="stages" style="margin-bottom: 26px">
      <span class="pill strong">{{ run.ending }}</span>
      <span v-if="run.verdict" class="pill strong">{{ run.verdict }}</span>
      <a v-if="run.pr" class="pill slate" :href="run.pr.url" target="_blank" rel="noopener" style="text-decoration: none">PR #{{ prNumber(run.pr.url) }} · {{ run.pr.state.toLowerCase() }}</a>
      <span v-if="run.reason" class="pill" :title="run.reason">reason: {{ run.reason.length > 80 ? run.reason.slice(0, 80) + '…' : run.reason }}</span>
      <span style="width: 12px" />
      <span v-for="(s, i) in run.stages" :key="i" class="pill" :title="s.agent ?? ''">{{ s.label }}<template v-if="s.seconds !== null"> · {{ fmtDuration(s.seconds) }}</template><template v-if="s.result"> · {{ s.result }}</template></span>
    </div>
    <Frame v-for="f in run.files" :key="f.name" class="report-frame" :title="f.name.replace(/\.md$/, '').replace(/^\d\d-/, '')" :note="f.name">
      <pre class="report">{{ f.text }}</pre>
    </Frame>
    <p class="hint" style="margin-top: 20px">{{ run.path }}</p>
  </template>
  <div v-else class="empty">Loading…</div>
</template>
