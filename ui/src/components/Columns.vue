<script setup lang="ts">
// Stacked columns over time, one per day or week, drawn as SVG on the sheet: thin columns with a
// 2px gap between stacked parts and a rounded top, hairline grid lines at round counts, and a
// date under every column there is room for. Hovering a column (or focusing the chart and moving
// with the arrow keys) shows its date and each part's count. A single series needs no legend:
// the frame's title names it; two or more get one, each colour beside its name.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Column, Series } from './columns.ts'

const props = defineProps<{ series: Series[]; columns: Column[]; label: string }>()

const box = ref<HTMLElement | null>(null)
const width = ref(600)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry) width.value = Math.max(200, entry.contentRect.width)
  })
  if (box.value) observer.observe(box.value)
})
onBeforeUnmount(() => observer?.disconnect())

const HEIGHT = 180
const AXIS = 30
const BOTTOM = 22
const TOP = 8
const GAP = 2

/** Round grid steps: at most four lines above zero. */
const scale = computed(() => {
  const max = Math.max(1, ...props.columns.map((c) => c.values.reduce((s, v) => s + v, 0)))
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((s) => max / s <= 4) ?? Math.ceil(max / 4)
  const top = Math.ceil(max / step) * step
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) }
})

const plotH = computed(() => HEIGHT - BOTTOM - TOP)
const slot = computed(() => (width.value - AXIS) / Math.max(1, props.columns.length))
const barW = computed(() => Math.max(2, Math.min(24, slot.value * 0.62)))
const y = (v: number) => TOP + plotH.value - (v / scale.value.top) * plotH.value

/** A date under every column there is room for. */
const labelEvery = computed(() => Math.max(1, Math.ceil(48 / slot.value)))

/** Each column's parts, bottom up; a part under 2px is drawn at 2px so a 1 is seen. */
const bars = computed(() =>
  props.columns.map((c, i) => {
    const x = AXIS + i * slot.value + (slot.value - barW.value) / 2
    let base = TOP + plotH.value
    const parts: { d: string; color: string }[] = []
    const shown = c.values.map((v, s) => ({ v, s })).filter((p) => p.v > 0)
    shown.forEach(({ v, s }, n) => {
      const h = Math.max(2, (v / scale.value.top) * plotH.value - (n > 0 ? GAP : 0))
      const top = base - (n > 0 ? GAP : 0) - h
      const last = n === shown.length - 1
      const r = last ? Math.min(4, h, barW.value / 2) : 0
      const w = barW.value
      // The top part's upper corners are rounded; every other edge is square.
      const d = `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z`
      parts.push({ d, color: props.series[s]?.color ?? 'var(--faint)' })
      base = top
    })
    return { x, parts, total: c.values.reduce((s, v) => s + v, 0) }
  }),
)

const hover = ref<number | null>(null)
const tip = computed(() => {
  if (hover.value === null) return null
  const c = props.columns[hover.value]
  if (!c) return null
  const x = AXIS + hover.value * slot.value + slot.value / 2
  return { c, left: Math.min(Math.max(x, 90), width.value - 90), total: c.values.reduce((s, v) => s + v, 0) }
})

function key(e: KeyboardEvent): void {
  const n = props.columns.length
  if (!n) return
  if (e.key === 'ArrowRight') hover.value = Math.min(n - 1, (hover.value ?? -1) + 1)
  else if (e.key === 'ArrowLeft') hover.value = Math.max(0, (hover.value ?? n) - 1)
  else return
  e.preventDefault()
}

const summary = computed(
  () => `${props.label}: ${props.columns.reduce((s, c) => s + c.values.reduce((a, v) => a + v, 0), 0)} in ${props.columns.length} columns`,
)
</script>

<template>
  <div class="columns">
    <ul v-if="series.length > 1" class="legend">
      <li v-for="s in series" :key="s.key"><i :style="{ background: s.color }" />{{ s.label }}</li>
    </ul>
    <div ref="box" class="plot" tabindex="0" :aria-label="summary" @keydown="key" @blur="hover = null" @mouseleave="hover = null">
      <svg :width="width" :height="HEIGHT" role="img" :aria-label="summary">
        <g class="grid">
          <template v-for="t in scale.ticks" :key="t">
            <line :x1="AXIS" :x2="width" :y1="y(t)" :y2="y(t)" />
            <text :x="AXIS - 8" :y="y(t) + 4" text-anchor="end">{{ t }}</text>
          </template>
        </g>
        <rect v-if="hover !== null" class="band" :x="AXIS + hover * slot" :y="TOP" :width="slot" :height="plotH" />
        <g v-for="(b, i) in bars" :key="columns[i]!.day">
          <path v-for="(p, n) in b.parts" :key="n" :d="p.d" :fill="p.color" />
        </g>
        <g class="dates">
          <template v-for="(c, i) in columns" :key="c.day">
            <text v-if="i % labelEvery === 0" :x="AXIS + i * slot + slot / 2" :y="HEIGHT - 6" text-anchor="middle">{{ c.short }}</text>
          </template>
        </g>
        <rect
          v-for="(c, i) in columns"
          :key="`hit-${c.day}`"
          class="hit"
          :x="AXIS + i * slot"
          :y="0"
          :width="slot"
          :height="HEIGHT"
          @mouseenter="hover = i"
        />
      </svg>
      <div v-if="tip" class="tip" :style="{ left: `${tip.left}px` }">
        <div class="when">
          {{ tip.c.long }}<span v-if="series.length > 1"> · {{ tip.total }}</span>
        </div>
        <div v-for="(s, i) in series" :key="s.key" class="row">
          <i :style="{ background: s.color }" /><span>{{ s.label }}</span
          ><b>{{ tip.c.values[i] ?? 0 }}</b>
        </div>
      </div>
    </div>
  </div>
</template>
