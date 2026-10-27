<script setup lang="ts">
// A framed block of the sheet: a hairline border with a cross at each corner, an optional
// title line (the name, a count, a note, something on the right).
defineProps<{ title?: string; count?: string; note?: string }>()
</script>

<template>
  <section class="frame">
    <i class="corner tl" /><i class="corner tr" /><i class="corner bl" /><i class="corner br" />
    <div v-if="title" class="frame-head">
      <h2>{{ title }}</h2>
      <span v-if="count" class="count">{{ count }}</span>
      <span v-if="note" class="note">{{ note }}</span>
      <span v-if="$slots.right" class="right"><slot name="right" /></span>
    </div>
    <slot />
  </section>
</template>
