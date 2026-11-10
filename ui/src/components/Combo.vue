<script setup lang="ts">
// A select with a search, for a list too long to scroll (origin's branches): the sheet's combo.
// The field shows the chosen value; a click or a key opens a list under it with a search field
// on top, the options in their groups, cut to the ones that hold what is typed. The arrows move
// through them, Enter takes one, Escape closes the list and nothing else (not the dialog it may
// sit in); a click outside closes it too. The system's own select is not used: it has no
// search, and its list is the operating system's, not the sheet's.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export type ComboOption = { value: string; note?: string }
export type ComboGroup = { label: string; options: ComboOption[] }

const props = defineProps<{
  /** The field's id, for its label. */
  id: string
  groups: ComboGroup[]
  /** What the search field says while it is empty. */
  search: string
  disabled?: boolean
}>()
const value = defineModel<string>({ required: true })

const open = ref(false)
const typed = ref('')
/** The option the keyboard is at, by its place among the options shown. */
const at = ref(0)
const root = ref<HTMLElement | null>(null)
const field = ref<HTMLButtonElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)

const shown = computed(() => {
  const words = typed.value.toLowerCase().split(/\s+/).filter(Boolean)
  return props.groups
    .map((g) => ({ label: g.label, options: g.options.filter((o) => words.every((w) => o.value.toLowerCase().includes(w))) }))
    .filter((g) => g.options.length)
})
const options = computed(() => shown.value.flatMap((g) => g.options))
/** An option's place among the ones shown: the groups are drawn one after another. */
const placeOf = (group: number, option: number) => shown.value.slice(0, group).reduce((n, g) => n + g.options.length, 0) + option

function show() {
  if (props.disabled || open.value) return
  open.value = true
  typed.value = ''
  at.value = Math.max(
    0,
    options.value.findIndex((o) => o.value === value.value),
  )
  document.addEventListener('pointerdown', outside, true)
  void nextTick(() => {
    input.value?.focus()
    reveal()
  })
}
function hide(focus = true) {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
  if (focus) field.value?.focus()
}
function outside(event: Event) {
  if (!root.value?.contains(event.target as Node)) hide(false)
}
function take(option: ComboOption | undefined) {
  if (!option) return
  value.value = option.value
  hide()
}
function move(by: number) {
  if (!options.value.length) return
  at.value = (at.value + by + options.value.length) % options.value.length
  reveal()
}
/** Keeps the option the keyboard is at in sight. */
function reveal() {
  void nextTick(() => list.value?.querySelector('.at')?.scrollIntoView({ block: 'nearest' }))
}
// What is typed narrows the list: the keyboard starts again from its first option.
watch(typed, () => {
  at.value = 0
  reveal()
})
watch(
  () => props.disabled,
  (disabled) => disabled && hide(false),
)
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside, true))
</script>

<template>
  <div ref="root" class="combo" :class="{ open }">
    <button
      :id="id"
      ref="field"
      type="button"
      class="field"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :disabled="disabled"
      @click="open ? hide() : show()"
      @keydown.down.prevent="show()"
      @keydown.up.prevent="show()"
    >
      {{ value }}
    </button>
    <div v-if="open" class="combo-list">
      <input
        ref="input"
        v-model="typed"
        class="field"
        type="search"
        role="combobox"
        aria-expanded="true"
        :aria-controls="`${id}-options`"
        :aria-activedescendant="options.length ? `${id}-option-${at}` : undefined"
        :placeholder="search"
        :aria-label="search"
        autocomplete="off"
        spellcheck="false"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="take(options[at])"
        @keydown.esc.prevent.stop="hide()"
        @keydown.tab="hide(false)"
      />
      <ul :id="`${id}-options`" ref="list" role="listbox">
        <template v-for="(g, gi) in shown" :key="g.label">
          <li class="group" role="presentation">
            {{ g.label }} <b>{{ g.options.length }}</b>
          </li>
          <li
            v-for="(o, oi) in g.options"
            :id="`${id}-option-${placeOf(gi, oi)}`"
            :key="o.value"
            role="option"
            :aria-selected="o.value === value"
            :class="{ on: o.value === value, at: placeOf(gi, oi) === at }"
            @click="take(o)"
            @pointermove="at = placeOf(gi, oi)"
          >
            <span>{{ o.value }}</span
            ><small v-if="o.note">{{ o.note }}</small>
          </li>
        </template>
      </ul>
      <p v-if="!options.length" class="empty">Nothing holds “{{ typed }}”.</p>
    </div>
  </div>
</template>
