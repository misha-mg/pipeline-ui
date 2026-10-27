<script setup lang="ts">
import { fmtTime, type StateView } from '../api.ts'

defineProps<{ health: StateView['health'] }>()
const names: Record<string, string> = { runsDir: '.pipeline-runs', tmux: 'tmux (batch.sh)', jira: 'Jira', mock: 'device mock', bitbucket: 'Bitbucket' }
</script>

<template>
  <div>
    <h2>Dependencies <span v-if="health" class="muted">checked {{ fmtTime(Object.values(health)[0]?.checkedAt ?? null) }}</span></h2>
    <div v-if="health" class="health">
      <div v-for="(check, name) in health" :key="name" class="dep">
        <div class="row"><span class="name">{{ names[name] ?? name }}</span><span class="pill" :class="check.ok ? 'ok' : 'bad'">{{ check.ok ? 'OK' : 'not OK' }}</span></div>
        <div class="detail" :title="check.detail">{{ check.detail }}</div>
      </div>
    </div>
    <div v-else class="muted">Not checked yet.</div>
  </div>
</template>
