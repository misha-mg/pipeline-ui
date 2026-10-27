<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, fmtDuration, fmtTime, type RunFiles } from '../api.ts'

const props = defineProps<{ target: { key: string; number: number } }>()
const emit = defineEmits<{ close: [] }>()
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
}, { immediate: true })
</script>

<template>
  <div>
    <div class="row">
      <h2 style="margin: 0">{{ target.key }} run-{{ target.number }}</h2>
      <span style="flex: 1" />
      <button class="small" @click="emit('close')">close</button>
    </div>
    <div v-if="error" class="error">{{ error }}</div>
    <template v-else-if="run">
      <div class="row" style="margin: 8px 0">
        <span>{{ run.summary ?? '' }}</span>
        <span class="muted">started {{ fmtTime(run.startedAt) }}, {{ fmtDuration(run.seconds) }}</span>
        <span class="pill">{{ run.ending }}</span>
        <span v-if="run.verdict" class="pill">{{ run.verdict }}</span>
        <a v-if="run.prUrl" :href="run.prUrl" target="_blank" rel="noopener">pull request</a>
        <span v-if="run.reason" class="muted">reason: {{ run.reason }}</span>
      </div>
      <div class="stages" style="margin-bottom: 10px">
        <span v-for="(s, i) in run.stages" :key="i" class="pill" :title="s.agent ?? ''">{{ s.label }}<template v-if="s.seconds !== null"> {{ fmtDuration(s.seconds) }}</template><template v-if="s.result"> · {{ s.result }}</template></span>
      </div>
      <div v-if="run.path" class="muted" style="margin-bottom: 8px">{{ run.path }}</div>
      <details v-for="f in run.files" :key="f.name" :open="f.name === 'state.md'">
        <summary>{{ f.name }}</summary>
        <pre class="report">{{ f.text }}</pre>
      </details>
    </template>
    <div v-else class="muted">Loading…</div>
  </div>
</template>
