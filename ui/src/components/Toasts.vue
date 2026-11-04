<script setup lang="ts">
// The notifications' stack at the bottom right: each rises in, its bar runs down while it stays,
// the pointer over it holds it, and it slides out when its time is up or it is closed.
import { dismiss, hold, release, toasts } from '../toasts.ts'

const icons = { info: 'i', success: '✓', error: '!' } as const
</script>

<template>
  <div class="toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="t.kind"
        :role="t.kind === 'error' ? 'alert' : 'status'"
        :style="{ '--life': `${t.ms}ms` }"
        @mouseenter="hold(t.id)"
        @mouseleave="release(t.id)"
      >
        <span class="icon" aria-hidden="true">{{ icons[t.kind] }}</span>
        <div class="body">
          <div class="title">{{ t.title }}</div>
          <div v-if="t.detail" class="detail">{{ t.detail }}</div>
          <a
            v-if="t.link"
            class="small-link"
            :href="t.link.href"
            :target="t.link.href.startsWith('#') ? undefined : '_blank'"
            rel="noopener"
            >{{ t.link.label }}</a
          >
        </div>
        <button class="close" type="button" aria-label="Close" @click="dismiss(t.id)">×</button>
        <span class="life" />
      </div>
    </TransitionGroup>
  </div>
</template>
