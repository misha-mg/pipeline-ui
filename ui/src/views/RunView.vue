<script setup lang="ts">
// One run as a diagram of its steps: the ticket's assignment, each agent as a block in the order
// it worked, the stages still to come while the run is in flight, and the verdict, joined by
// links that fill as the run moves on. Choosing a block opens what it left in the panel under it:
// its report as the file reads, or, while the run is in flight (the pipeline writes its reports
// only at the end), the agent's last message as its session reported it. Reloaded every 3 s while
// the run is in flight; the panel shows the first block until another one is chosen.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import Frame from '../components/Frame.vue'
import { api, fmtDuration, fmtTime, prNumber, stageName, type AgentStage, type RunFiles } from '../api.ts'
import { actions, runSeconds, state, ticketUrl } from '../console.ts'

const props = defineProps<{ ticket: string; number: number }>()
const run = ref<RunFiles | null>(null)
const error = ref<string | null>(null)
/** The step chosen by a click; null shows the first one. */
const chosen = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function load(ticket: string, number: number): Promise<void> {
  try {
    const loaded = await api.run(ticket, number)
    // Another run may have been opened while this one loaded.
    if (props.ticket === ticket && props.number === number) {
      run.value = loaded
      error.value = null
    }
  } catch (e) {
    if (!run.value) error.value = String(e)
  }
}

watch(() => [props.ticket, props.number] as const, async ([ticket, number]) => {
  clearInterval(timer)
  run.value = null
  error.value = null
  chosen.value = null
  await load(ticket, number)
  timer = setInterval(() => {
    if (run.value?.ending === 'in-flight') void load(ticket, number)
  }, 3000)
}, { immediate: true })
onUnmounted(() => clearInterval(timer))

type Step = {
  id: string
  label: string
  agent: string | null
  status: 'done' | 'working' | 'next' | 'stopped'
  startedAt: string | null
  seconds: number | null
  result: string | null
  /** What the step left: a report file's name and text, or the agent's last message. */
  left: { source: string; text: string } | null
}

const ORDER = ['investigate', 'implement', 'diff', 'review', 'app-test', 'pull request']
const live = computed(() => run.value?.ending === 'in-flight')
const nowMs = computed(() => Date.parse(state.value?.now ?? new Date().toISOString()))

/** The report a stage wrote: reworks write `implement` reports, `pull request` a `pull-request` one. */
function reportLabel(label: string): string {
  return /^rework/.test(label) ? 'implement' : label.replace(' ', '-')
}

/** Stage labels for the agents the session reported, named the way timings.tsv names them. */
function liveLabels(agents: AgentStage[], ended: boolean): string[] {
  let reworks = 0
  return agents.map((a, i) => {
    if (a.agent !== 'ticket-implementer' || !agents.slice(0, i).some((p) => p.agent === 'ticket-implementer')) return stageName(a.agent)
    // An implementer after the first is a rework when a diff follows it, else the pull request.
    if (agents.slice(i + 1).some((n) => n.agent === 'diff-preparer')) return `rework ${++reworks}`
    return ended || i < agents.length - 1 ? 'pull request' : 'rework or pull request'
  })
}

const steps = computed<Step[]>(() => {
  const r = run.value
  if (!r) return []
  const files = new Map(r.files.map((f) => [f.name, f.text]))
  const used = new Set<string>()
  const takeReport = (label: string) => {
    const name = r.files.map((f) => f.name).find((n) => !used.has(n) && n.replace(/^\d\d-/, '').replace(/\.md$/, '') === reportLabel(label))
    if (!name) return null
    used.add(name)
    return { source: name, text: files.get(name) ?? '' }
  }
  const agents = r.agents ?? []
  const out: Step[] = []
  const assignment = files.get('00-assignment.md')
  if (assignment !== undefined) {
    used.add('00-assignment.md')
    out.push({ id: 'assignment', label: 'assignment', agent: null, status: 'done', startedAt: r.startedAt, seconds: null, result: null, left: { source: '00-assignment.md', text: assignment } })
  }
  if (r.stages.length) {
    // The pipeline's own record, written at the end; an agent's message fills a stage with no report.
    const seen = new Map<string, number>()
    r.stages.forEach((s, i) => {
      const n = seen.get(s.agent ?? '') ?? 0
      seen.set(s.agent ?? '', n + 1)
      const message = agents.filter((a) => a.agent === s.agent)[n]?.text
      out.push({
        id: `stage-${i}`, label: s.label, agent: s.agent, status: 'done', startedAt: s.startedAt, seconds: s.seconds, result: s.result,
        left: takeReport(s.label) ?? (message ? { source: 'the agent\'s last message', text: message } : null),
      })
    })
  } else {
    const labels = liveLabels(agents, !live.value)
    agents.forEach((a, i) => {
      const working = a.endedAt === null && live.value
      const end = a.endedAt ? Date.parse(a.endedAt) : working ? nowMs.value : null
      out.push({
        id: `agent-${a.agentId}-${i}`, label: labels[i]!, agent: a.agent, status: a.endedAt ? 'done' : working ? 'working' : 'stopped',
        startedAt: a.startedAt, seconds: end === null ? null : Math.max(0, Math.round((end - Date.parse(a.startedAt)) / 1000)), result: null,
        left: takeReport(labels[i]!) ?? (a.text ? { source: 'the agent\'s last message', text: a.text } : null),
      })
    })
    // A service from before the agents were sent still names the working one in its state.
    const flying = state.value?.inFlight
    if (!agents.length && live.value && flying?.key === r.key && flying.stage && flying.stageSince) {
      out.push({
        id: 'working', label: stageName(flying.stage), agent: flying.stage, status: 'working', startedAt: flying.stageSince,
        seconds: Math.max(0, Math.round((nowMs.value - Date.parse(flying.stageSince)) / 1000)), result: null, left: null,
      })
    }
  }
  if (live.value) {
    const last = out.at(-1)?.label ?? ''
    const from = /^rework/.test(last) ? ORDER.indexOf('implement') : ORDER.indexOf(last)
    for (const label of ORDER.slice(from + 1)) out.push({ id: `next-${label}`, label, agent: null, status: 'next', startedAt: null, seconds: null, result: null, left: null })
  }
  const stateText = files.get('state.md')
  if (stateText !== undefined) {
    used.add('state.md')
    out.push({ id: 'verdict', label: 'verdict', agent: null, status: 'done', startedAt: r.finishedAt, seconds: null, result: r.verdict, left: { source: 'state.md', text: stateText } })
  }
  // Reports no step claimed, so nothing the run wrote is out of reach.
  for (const f of r.files) {
    if (!used.has(f.name)) out.push({ id: `file-${f.name}`, label: f.name.replace(/\.md$/, '').replace(/^\d\d-/, ''), agent: null, status: 'done', startedAt: null, seconds: null, result: null, left: { source: f.name, text: f.text } })
  }
  return out
})

const shown = computed<Step | null>(() => {
  const all = steps.value
  return all.find((s) => s.id === chosen.value) ?? all[0] ?? null
})

function choose(step: Step): void {
  if (step.status !== 'next') chosen.value = step.id
}

type Kind = 'start' | 'stage' | 'end' | 'file'
function kindOf(step: Step): Kind {
  return step.id === 'assignment' ? 'start' : step.id === 'verdict' ? 'end' : step.id.startsWith('file-') ? 'file' : 'stage'
}
/** Each stage's number in the run, 01 for the first agent. */
const numbers = computed(() => {
  let n = 0
  return steps.value.map((s) => (kindOf(s) === 'stage' ? String(++n).padStart(2, '0') : ''))
})
/** The link into a block: filled once the block has started, flowing while it works. */
function linkClass(step: Step): string {
  return step.status === 'working' ? 'flowing' : step.status === 'next' ? 'empty' : step.status === 'stopped' ? 'cut' : 'filled'
}
function verdictTone(v: string | null): string {
  return !v ? '' : v.startsWith('done') ? 'ok' : 'bad'
}

// The panel's pointer sits under the block it shows, followed as the diagram scrolls or resizes.
const flowEl = ref<HTMLElement | null>(null)
const detailEl = ref<HTMLElement | null>(null)
const caretX = ref<number | null>(null)
function placeCaret(): void {
  const flow = flowEl.value
  const detail = detailEl.value
  const node = flow?.querySelector<HTMLElement>('.node.on')
  if (!flow || !detail || !node) {
    caretX.value = null
    return
  }
  const n = node.getBoundingClientRect()
  const d = detail.getBoundingClientRect()
  const f = flow.getBoundingClientRect()
  const x = n.left + n.width / 2
  caretX.value = x < f.left || x > f.right ? null : Math.round(x - d.left)
}
watch(() => [shown.value?.id, steps.value.length] as const, async () => {
  await nextTick()
  // Keep the working or chosen block in view when the diagram is wider than the page.
  flowEl.value?.querySelector<HTMLElement>('.node.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  placeCaret()
  setTimeout(placeCaret, 400)
})
onMounted(() => window.addEventListener('resize', placeCaret))
onUnmounted(() => window.removeEventListener('resize', placeCaret))
</script>

<template>
  <div class="page-head">
    <h1>{{ ticket }} · run {{ number }}</h1>
    <span v-if="run" class="stats">started {{ fmtTime(run.startedAt) }}<template v-if="run.finishedAt"> · finished {{ fmtTime(run.finishedAt) }}</template> · {{ fmtDuration(runSeconds(run)) }}<template v-if="live"> so far</template></span>
    <a v-if="ticketUrl(ticket)" class="action" :href="ticketUrl(ticket)!" target="_blank" rel="noopener">Jira ↗</a>
    <button class="btn tiny" :disabled="live" :title="live ? 'The run is in flight' : 'Queue this ticket at the end for a new run'" @click="actions.again(ticket)">Run again</button>
    <a class="action" href="#/runs">All runs</a>
  </div>
  <p v-if="run?.summary" class="run-summary">{{ run.summary }}</p>
  <div v-if="error" class="notice">{{ error }}</div>
  <template v-else-if="run">
    <div class="stages">
      <span class="pill" :class="live ? 'slate' : 'strong'"><span v-if="live" class="pulse" />{{ run.ending }}</span>
      <span v-if="run.verdict" class="pill strong">{{ run.verdict }}</span>
      <a v-if="run.pr" class="pill slate" :href="run.pr.url" target="_blank" rel="noopener" style="text-decoration: none">PR #{{ prNumber(run.pr.url) }} · {{ run.pr.state.toLowerCase() }}</a>
      <span v-if="run.reason" class="pill" :title="run.reason">reason: {{ run.reason.length > 80 ? run.reason.slice(0, 80) + '…' : run.reason }}</span>
    </div>

    <Frame class="flow-frame">
      <div ref="flowEl" class="flow" @scroll.passive="placeCaret">
        <template v-for="(step, i) in steps" :key="i">
          <div v-if="i > 0" class="link" :class="linkClass(step)" aria-hidden="true"><span class="track"><span class="fill" /></span><span class="head" /></div>
          <button
            type="button" class="node" :class="[kindOf(step), step.status, { on: shown?.id === step.id }]"
            :disabled="step.status === 'next'" :aria-pressed="shown?.id === step.id" :title="step.agent ?? ''" @click="choose(step)"
          >
            <template v-if="kindOf(step) === 'stage'">
              <span class="top"><span class="no">{{ numbers[i] }}</span><span class="lamp-dot" /></span>
              <span class="name">{{ step.label }}</span>
              <span class="agent">{{ step.agent ?? 'to come' }}</span>
              <span class="meta">
                <template v-if="step.status === 'working'">working · {{ fmtDuration(step.seconds) }}</template>
                <template v-else-if="step.status === 'stopped'">stopped</template>
                <template v-else-if="step.status === 'next'">&nbsp;</template>
                <template v-else>{{ fmtDuration(step.seconds) }}<template v-if="step.result"> · {{ step.result }}</template></template>
              </span>
              <span class="bar" />
            </template>
            <template v-else-if="kindOf(step) === 'start'">
              <span class="name">{{ ticket }}</span>
              <span class="agent">assignment</span>
            </template>
            <template v-else-if="kindOf(step) === 'end'">
              <span class="name">verdict</span>
              <span class="agent" :class="verdictTone(step.result)">{{ step.result ?? '—' }}</span>
            </template>
            <template v-else>
              <span class="name">{{ step.label }}</span>
              <span class="agent">file</span>
            </template>
          </button>
        </template>
      </div>
      <p v-if="!steps.length" class="empty">No steps recorded yet.</p>
    </Frame>

    <div v-if="shown" ref="detailEl" class="detail" :class="{ pointed: caretX !== null }" :style="caretX !== null ? { '--caret-x': `${caretX}px` } : undefined">
      <Transition name="swap" mode="out-in">
        <Frame :key="shown.id" class="detail-frame" :title="kindOf(shown) === 'start' ? 'assignment' : shown.label" :note="[shown.agent, shown.startedAt ? `started ${fmtTime(shown.startedAt)}` : null, shown.left?.source].filter(Boolean).join(' · ')">
          <pre v-if="shown.left" class="report">{{ shown.left.text }}</pre>
          <p v-else-if="shown.status === 'working'" class="empty">Working. What it hands back shows here when it stops; the pipeline writes the reports when the run ends.</p>
          <p v-else-if="shown.status === 'stopped'" class="empty">The session ended while this agent worked; it left nothing.</p>
          <p v-else class="empty">Nothing recorded for this step yet: the pipeline writes its reports when the run ends.</p>
        </Frame>
      </Transition>
    </div>
    <p class="hint" style="margin-top: 20px">{{ run.path }}</p>
  </template>
  <div v-else class="empty">Loading…</div>
</template>
