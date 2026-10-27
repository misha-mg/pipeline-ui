<script setup lang="ts">
import { ref } from 'vue'
import type { StateView } from '../api.ts'

const props = defineProps<{ queue: StateView['queue']; inFlight: StateView['inFlight'] }>()
const emit = defineEmits<{ enqueue: [key: string, front: boolean]; remove: [key: string]; reorder: [keys: string[]] }>()
const key = ref('')

function add(front: boolean) {
  const k = key.value.trim()
  if (!k) return
  emit('enqueue', k, front)
  key.value = ''
}
function move(index: number, by: number) {
  const keys = props.queue.map((q) => q.key)
  const target = index + by
  if (target < 0 || target >= keys.length) return
  ;[keys[index], keys[target]] = [keys[target]!, keys[index]!]
  emit('reorder', keys)
}
</script>

<template>
  <div class="panel">
    <h2>Queue <span class="muted">({{ queue.length }})</span></h2>
    <form class="row" @submit.prevent="add(false)">
      <input v-model="key" placeholder="KAZ-1234" pattern="[A-Z]+-\d+" title="A ticket key, like KAZ-1234" style="width: 9em" />
      <button type="submit" class="primary" :disabled="!key.trim()">Add to end</button>
      <button type="button" :disabled="!key.trim()" @click="add(true)">Add to front</button>
    </form>
    <ol class="queue" v-if="queue.length">
      <li v-for="(item, i) in queue" :key="item.key">
        <span class="pos">{{ i + 1 }}</span>
        <span class="key">{{ item.key }}</span>
        <span class="summary" :title="item.summary ?? ''">{{ item.summary ?? '' }}</span>
        <button class="small" :disabled="i === 0" title="Move up" @click="move(i, -1)">↑</button>
        <button class="small" :disabled="i === queue.length - 1" title="Move down" @click="move(i, 1)">↓</button>
        <button class="small" :disabled="i === 0" title="Move to the front" @click="emit('reorder', [item.key])">first</button>
        <button class="small danger" @click="emit('remove', item.key)">remove</button>
      </li>
    </ol>
    <div v-else class="muted" style="margin-top: 8px">The queue is empty.</div>
  </div>
</template>
