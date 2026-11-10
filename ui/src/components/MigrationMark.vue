<script setup lang="ts">
// The mark beside the key of a screen migration: a ticket labelled for webui's screen-migration
// workflow, or a run that went through it. The pointer over it, or the keyboard's focus, says
// what it means at once, in the sheet's tip (a title showed only the help cursor, late or never).
</script>

<template>
  <span class="mark" tabindex="0" role="img" data-tip="Screen migration: the legacy screen rebuilt in Vue" aria-label="screen migration"
    >⤳</span
  >
</template>
