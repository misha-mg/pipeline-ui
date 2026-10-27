<script setup lang="ts">
import { fmtAgo, fmtDuration, fmtTime, stageName, type StateView } from '../api.ts'

const props = defineProps<{ run: StateView['inFlight']; now: string; loopRunning: boolean }>()
const emit = defineEmits<{ cancel: []; open: [target: { key: string; number: number }] }>()

function runNumber(): number | null {
  const m = props.run?.runDir?.match(/run-(\d+)$/)
  return m ? Number(m[1]) : null
}
</script>

<template>
  <div class="panel inflight">
    <h2>In flight</h2>
    <template v-if="run">
      <div class="row">
        <span class="big">{{ run.key }}</span>
        <span class="pill accent">{{ stageName(run.stage) }}</span>
        <span v-if="run.cancelRequestedAt" class="pill warn">cancelling</span>
        <span class="spacer" style="flex: 1" />
        <button class="danger" :disabled="!!run.cancelRequestedAt" @click="emit('cancel')">Cancel</button>
      </div>
      <div class="muted">{{ run.summary ?? 'no summary' }}</div>
      <dl>
        <dt>stage</dt><dd>{{ stageName(run.stage) }}<span v-if="run.stageSince" class="muted"> since {{ fmtTime(run.stageSince) }} ({{ fmtAgo(run.stageSince, now) }})</span></dd>
        <dt>rework round</dt><dd>{{ run.rework || 'none' }}</dd>
        <dt>started</dt><dd>{{ fmtTime(run.startedAt) }}, {{ fmtDuration(run.seconds) }} so far</dd>
        <dt>run</dt><dd><a v-if="runNumber()" href="#" @click.prevent="emit('open', { key: run.key, number: runNumber()! })">run-{{ runNumber() }}</a><span v-else class="muted">directory not there yet</span></dd>
      </dl>
    </template>
    <div v-else class="muted">Nothing in flight. {{ loopRunning ? 'The loop takes the next queued ticket.' : 'The loop is stopped: Start to take the next ticket.' }}</div>
  </div>
</template>
