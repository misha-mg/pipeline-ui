<script setup lang="ts">
// A frame of the sheet (sheet.css draws its border and corner crosses), with an optional
// title line (the name, a count, a note, something on the right).
defineProps<{ title?: string; count?: string; note?: string }>()
</script>

<template>
  <section class="frame">
    <div v-if="title" class="frame-head">
      <h2>{{ title }}</h2>
      <span v-if="count" class="count">{{ count }}</span>
      <span v-if="note" class="note">{{ note }}</span>
      <span v-if="$slots.right" class="right"><slot name="right" /></span>
    </div>
    <slot />
  </section>
</template>
