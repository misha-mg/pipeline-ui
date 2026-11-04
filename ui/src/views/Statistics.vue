<script setup lang="ts">
// The statistics: what the pipeline's runs came to over a period (the last batch, 7, 30 or 90
// days, or all time), counted by the runs started in it. A strip of numbers; the tickets'
// funnel from a run to Done in Jira, the merged fixes testing sent to Failed, and why runs
// stopped; four charts by day or week (runs, pull requests opened, closed, tickets Done or
// Failed); then every pull request with what became of it.
// The sums are server/history/stats.ts's, over /api/stats, read once a minute.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Frame from '../components/Frame.vue'
import Columns from '../components/Columns.vue'
import type { Column, Series } from '../components/columns.ts'
import { api, fmtDuration, fmtTime, type StatsView } from '../api.ts'
import { PR_OUTCOME_LABEL, periodRuns, prRows, summarize, timeline, type Bucket, type Period, type PrOutcome } from '../../../server/history/stats.ts'

const view = ref<StatsView | null>(null)
const failed = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function load(): Promise<void> {
  try {
    view.value = await api.stats()
    failed.value = null
  } catch (e) {
    failed.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(() => { void load(); timer = setInterval(() => void load(), 60_000) })
onBeforeUnmount(() => clearInterval(timer))

// The period and the bucket are this browser's choice, kept across a reload.
const PERIOD_LABEL: Record<Period, string> = { batch: 'Last batch', '7d': '7 days', '30d': '30 days', '90d': '90 days', all: 'All time' }
const remembered = <T extends string>(name: string, allowed: readonly T[], fallback: T) => {
  let value = fallback
  try {
    const stored = localStorage.getItem(`pipeline.stats.${name}`)
    if (stored && (allowed as readonly string[]).includes(stored)) value = stored as T
  } catch { /* no storage: the default */ }
  const r = ref(value)
  watch(r, (v) => { try { localStorage.setItem(`pipeline.stats.${name}`, v) } catch { /* not kept */ } })
  return r
}
const period = remembered<Period>('period', Object.keys(PERIOD_LABEL) as Period[], '30d')
const bucket = remembered<'day' | 'week'>('bucket', ['day', 'week'], 'day')

const runs = computed(() => (view.value ? periodRuns(view.value, period.value) : []))
const sum = computed(() => (view.value ? summarize(view.value, runs.value) : null))
const prs = computed(() => (view.value ? prRows(view.value, runs.value) : []))

const pad = (n: number) => String(n).padStart(2, '0')
/** The calendar day where this browser is. */
const dayOf = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const localDate = (day: string) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
const shortDay = (day: string) => localDate(day).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

const DAYS: Partial<Record<Period, number>> = { '7d': 7, '30d': 30, '90d': 90 }
const buckets = computed<Bucket[]>(() => {
  const v = view.value
  if (!v) return []
  const days = DAYS[period.value]
  // The day the period starts on, so the first runs it covers have their column.
  const from = days ? dayOf(new Date(Date.parse(v.now) - days * 24 * 3600 * 1000).toISOString()) : undefined
  return timeline(v, runs.value, { bucket: bucket.value, dayOf, from, to: dayOf(v.now) })
})
const columns = (values: (b: Bucket) => number[]): Column[] => buckets.value.map((b) => ({
  day: b.day,
  short: shortDay(b.day),
  long: bucket.value === 'week' ? `Week of ${shortDay(b.day)}` : localDate(b.day).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
  values: values(b),
}))

// Colour says how a thing ended: moss done, its lighter step done another way, rust stopped,
// slate for a count that is neither, faint for not known.
const OK = 'var(--chart-ok)'
const OK_SOFT = 'var(--chart-ok-soft)'
const BAD = 'var(--chart-bad)'
const NONE = 'var(--chart-none)'
const runSeries: Series[] = [
  { key: 'done', label: 'done', color: OK },
  { key: 'nothing', label: 'nothing to build', color: OK_SOFT },
  { key: 'stopped', label: 'blocked or failed', color: BAD },
  { key: 'none', label: 'no verdict', color: NONE },
]
const closedSeries: Series[] = [
  { key: 'asOpened', label: 'merged as opened', color: OK },
  { key: 'withChanges', label: 'merged with changes', color: OK_SOFT },
  { key: 'merged', label: 'merged, not compared', color: NONE },
  { key: 'declined', label: 'declined', color: BAD },
]
const jiraSeries: Series[] = [
  { key: 'done', label: 'Done', color: OK },
  { key: 'failed', label: 'sent to Failed', color: BAD },
]
const charts = computed(() => [
  { title: 'Runs started', note: '', series: runSeries, columns: columns((b) => [b.runs.done, b.runs.nothing, b.runs.stopped, b.runs.none]) },
  { title: 'Pull requests opened', note: '', series: [{ key: 'opened', label: 'opened', color: 'var(--chart-count)' }], columns: columns((b) => [b.opened]) },
  { title: 'Pull requests closed', note: sum.value?.medianToMerge != null ? `Median ${span(sum.value.medianToMerge)} from opened to merged.` : '', series: closedSeries.filter((s) => s.key !== 'merged' || buckets.value.some((b) => b.closed.merged)), columns: columns((b) => [b.closed.asOpened, b.closed.withChanges, ...(buckets.value.some((x) => x.closed.merged) ? [b.closed.merged] : []), b.closed.declined]) },
  { title: 'Tickets in Jira after the merge', note: 'A ticket sent to Failed twice counts on both days.', series: jiraSeries, columns: columns((b) => [b.done, b.failed]) },
])

/** A span of a day or more in days and hours (`6d 13h`), shorter ones as the console says them. */
const span = (seconds: number | null) => (seconds !== null && seconds >= 86400 ? `${Math.floor(seconds / 86400)}d ${String(Math.floor((seconds % 86400) / 3600)).padStart(2, '0')}h` : fmtDuration(seconds))
const pct = (part: number, whole: number | null | undefined) => (whole ? `${Math.round((part / whole) * 100)}%` : '—')
const word = (verdict: string) => verdict.slice(verdict.indexOf(':') + 1).replace(/-/g, ' ')

/** The strip: one number each, a note under it. */
const strip = computed(() => {
  const s = sum.value
  if (!s) return []
  const closed = s.prs.merged + s.prs.declined
  // One branch names the cell (`Merged into master`); several are counted in its note.
  const only = s.prs.into.length === 1 ? s.prs.into[0]![0] : null
  const into = only ? '' : s.prs.into.map(([b, n]) => `${n} ${b}`).join(' · ')
  const compared = s.prs['merged-as-opened'] + s.prs['merged-with-changes']
  return [
    { label: 'Tickets', value: String(s.tickets), tone: '', note: `${s.runs} runs · median ${fmtDuration(s.medianRun)}` },
    { label: 'Pull requests', value: String(s.prs.opened), tone: '', note: `${s.prs.open} open${s.prs.drafts ? ` · ${s.prs.drafts} drafts` : ''}${s.prs.unknown ? ` · ${s.prs.unknown} unknown` : ''}` },
    { label: only && only !== 'unknown' ? `Merged into ${only}` : 'Merged', value: String(s.prs.merged), tone: s.prs.merged ? 'ok' : '', note: `${pct(s.prs.merged, closed)} of closed${into ? ` · ${into}` : ''}` },
    { label: 'Merged as opened', value: String(s.prs['merged-as-opened']), tone: '', note: compared ? `${pct(s.prs['merged-as-opened'], compared)} · ${s.prs['merged-with-changes']} with changes` : s.prs.merged ? 'not compared yet' : 'none merged' },
    { label: 'Declined', value: String(s.prs.declined), tone: s.prs.declined ? 'bad' : '', note: closed ? `${pct(s.prs.declined, closed)} of closed` : 'none closed' },
    { label: 'Done in Jira', value: String(s.funnel.done), tone: s.funnel.done ? 'ok' : '', note: `of ${s.funnel.merged} tickets merged${s.mergedTicketsUnknown ? ` · ${s.mergedTicketsUnknown} not read` : ''}` },
    { label: 'Failed after merge', value: String(s.failed.tickets), tone: s.failed.tickets ? 'bad' : '', note: s.funnel.merged ? `${pct(s.failed.tickets, s.funnel.merged)} of ${s.funnel.merged} merged` : 'none merged' },
    { label: 'Not finished', value: String(s.ticketsNotFinished), tone: s.ticketsNotFinished ? 'bad' : '', note: `${s.kinds.stopped} runs blocked or failed` },
  ]
})

const funnel = computed(() => {
  const f = sum.value?.funnel
  if (!f) return []
  return [
    { label: 'Tickets run', n: f.run },
    { label: 'With a pull request', n: f.pr },
    { label: 'Merged', n: f.merged },
    { label: 'Done in Jira', n: f.done },
    { label: 'Done, never Failed', n: f.clean },
  ].map((row) => ({ ...row, share: f.run ? row.n / f.run : 0 }))
})
/** The merged fixes testing sent to Failed, out of the merged: all of them, then by whether they were merged as opened. */
const fails = computed(() => {
  const s = sum.value
  if (!s) return []
  return [
    { label: 'All merged', title: 'tickets', n: s.failed.tickets, of: s.funnel.merged },
    { label: 'Merged as opened', title: 'pull requests', n: s.failed.asOpened, of: s.failed.asOpenedOf },
    { label: 'Merged with changes', title: 'pull requests', n: s.failed.withChanges, of: s.failed.withChangesOf },
  ].map((row) => ({ ...row, share: row.of ? row.n / row.of : 0 }))
})
const stops = computed(() => {
  const s = sum.value
  if (!s) return []
  const most = Math.max(1, s.kinds.nothing, ...s.stopReasons.map(([, n]) => n))
  return [
    ...s.stopReasons.map(([v, n]) => ({ label: word(v), title: v, n, share: n / most, tone: 'bad' })),
    ...(s.kinds.none ? [{ label: 'no verdict', title: 'runs that left none', n: s.kinds.none, share: s.kinds.none / most, tone: 'none' }] : []),
    ...(s.kinds.nothing ? [{ label: 'nothing to build', title: 'done:nothing-to-build: the fix was already there; not a stop', n: s.kinds.nothing, share: s.kinds.nothing / most, tone: 'soft' }] : []),
  ]
})

// The pull requests, filtered by what became of them.
const ORDER: PrOutcome[] = ['open', 'merged-as-opened', 'merged-with-changes', 'merged-not-compared', 'declined', 'unknown']
const outcome = ref<PrOutcome | ''>('')
const outcomes = computed(() => ORDER.map((o) => ({ o, n: prs.value.filter((p) => p.outcome === o).length })).filter((x) => x.n))
const shownPrs = computed(() => prs.value.filter((p) => !outcome.value || p.outcome === outcome.value))
const OUTCOME_TONE: Record<PrOutcome, string> = { open: 'slate', 'merged-as-opened': 'ok', 'merged-with-changes': 'ok', 'merged-not-compared': 'ok', declined: 'bad', unknown: '' }
const lines = (s: { added: number; removed: number }) => `+${s.added} −${s.removed}`
const ticketUrl = (key: string) => (view.value?.jiraSite ? `${view.value.jiraSite}/browse/${encodeURIComponent(key)}` : null)
const open = (from: string | null, to: string | null) => (from ? span(Math.max(0, Math.round((Date.parse(to ?? view.value?.now ?? from) - Date.parse(from)) / 1000))) : '—')

/** The last batch as the service names it, its time in local time: `loop started 2026-11-02 16:56`. */
const batchLabel = (label: string) => label.replace(/^loop since (\S+)$/, (_, at: string) => `loop started ${fmtTime(at)}`)

const read = computed(() => {
  const v = view.value
  if (!v) return ''
  const at = (iso: string | null) => (iso ? fmtTime(iso).slice(11) : 'never')
  return [v.readers.bitbucket ? `Bitbucket read ${at(v.readAt.pullRequests)}` : null, v.readers.jira ? `Jira read ${at(v.readAt.tickets)}` : null].filter(Boolean).join(' · ')
})
</script>

<template>
  <div class="page-head">
    <h1>Statistics</h1>
    <span class="stats">{{ period === 'batch' && view ? batchLabel(view.lastBatchLabel) : PERIOD_LABEL[period] }} · runs started in it, and what became of them<template v-if="read"> · {{ read }}</template></span>
  </div>

  <div v-if="failed" class="notice">The statistics cannot be read: {{ failed }}</div>
  <div v-if="view && !view.readers.bitbucket" class="notice calm">BITBUCKET_TOKEN is not set: what became of the pull requests is unknown.</div>
  <div v-if="view && !view.readers.jira" class="notice calm">Jira is not set up: whether the tickets are Done is unknown.</div>

  <div class="filters stats-filters">
    <div class="row">
      <span class="label">Period</span>
      <div class="opts">
        <button v-for="(label, p) in PERIOD_LABEL" :key="p" class="chip" :class="{ on: period === p }" @click="period = p">{{ label }}</button>
      </div>
      <div class="opts by">
        <button class="chip" :class="{ on: bucket === 'day' }" @click="bucket = 'day'">By day</button>
        <button class="chip" :class="{ on: bucket === 'week' }" @click="bucket = 'week'">By week</button>
      </div>
    </div>
  </div>

  <Frame class="strip eight">
    <div v-for="cell in strip" :key="cell.label" class="cell">
      <div class="label">{{ cell.label }}</div>
      <div class="value" :class="cell.tone">{{ cell.value }}</div>
      <div class="note" :title="cell.note">{{ cell.note }}</div>
    </div>
  </Frame>

  <div class="stats-pair">
    <Frame title="From a run to Done" note="Tickets, each counted once, however many runs it took.">
      <div class="bars">
        <div v-for="row in funnel" :key="row.label" class="bar-row">
          <span class="name">{{ row.label }}</span>
          <span class="track"><i class="count" :style="{ width: `${row.share * 100}%` }" /></span>
          <b class="num">{{ row.n }}</b>
          <span class="share num">{{ Math.round(row.share * 100) }}%</span>
        </div>
      </div>
    </Frame>
    <Frame title="Failed after merge" :count="sum ? `${sum.failed.tickets} of ${sum.funnel.merged}` : ''" note="Merged fixes testing sent to Jira's Failed: the share that did not hold.">
      <div v-if="sum?.funnel.merged" class="bars">
        <div v-for="row in fails" :key="row.label" class="bar-row" :title="`${row.n} of ${row.of} ${row.title}`">
          <span class="name">{{ row.label }} <span class="dim">· {{ row.of }}</span></span>
          <span class="track"><i class="bad" :style="{ width: `${row.share * 100}%` }" /></span>
          <b class="num">{{ row.n }}</b>
          <span class="share num">{{ pct(row.n, row.of) }}</span>
        </div>
      </div>
      <p v-else class="empty">No pull request merged.</p>
    </Frame>
    <Frame title="Why runs stopped" :count="sum ? `${sum.kinds.stopped} of ${sum.runs} runs` : ''" note="Blocked or failed by verdict; nothing to build apart, it is not a stop.">
      <div v-if="stops.length" class="bars">
        <div v-for="row in stops" :key="row.title" class="bar-row" :title="row.title">
          <span class="name">{{ row.label }}</span>
          <span class="track"><i :class="row.tone" :style="{ width: `${row.share * 100}%` }" /></span>
          <b class="num">{{ row.n }}</b>
          <span class="share" />
        </div>
      </div>
      <p v-else class="empty">No run stopped.</p>
    </Frame>
  </div>

  <div class="charts">
    <Frame v-for="c in charts" :key="c.title" :title="c.title" :note="c.note" :count="String(c.columns.reduce((s, col) => s + col.values.reduce((a, v) => a + v, 0), 0))">
      <Columns :series="c.series" :columns="c.columns" :label="c.title" />
    </Frame>
  </div>

  <Frame title="Pull requests" :count="String(prs.length)" note="Opened by the runs of the period. Lines: what the pipeline pushed, and what was merged when it differs.">
    <div class="chips pr-chips">
      <button class="chip" :class="{ on: !outcome }" @click="outcome = ''">All <b>{{ prs.length }}</b></button>
      <button v-for="x in outcomes" :key="x.o" class="chip" :class="{ on: outcome === x.o }" @click="outcome = outcome === x.o ? '' : x.o">{{ PR_OUTCOME_LABEL[x.o] }} <b>{{ x.n }}</b></button>
    </div>
    <table class="wide prs">
      <thead><tr><th>PR</th><th>Ticket</th><th>Summary</th><th>Opened</th><th>Open for</th><th>Became</th><th>Lines</th><th>Into</th><th>Jira</th></tr></thead>
      <tbody>
        <tr v-for="p in shownPrs" :key="p.url">
          <td class="num"><a :href="p.url" target="_blank" rel="noopener" class="small-link">#{{ p.number }}</a></td>
          <td class="key"><a :href="`#/runs/${p.key}/${p.run}`" title="The run that opened it">{{ p.key }}</a><a v-if="ticketUrl(p.key)" class="jira-arrow" :href="ticketUrl(p.key)!" target="_blank" rel="noopener" :title="`${p.key} in Jira`">↗</a></td>
          <td class="summary one-line" :title="p.summary ?? ''">{{ p.summary ?? '' }}</td>
          <td class="num dim">{{ fmtTime(p.openedAt).slice(0, 10) }}</td>
          <td class="num">{{ p.outcome === 'unknown' ? '—' : open(p.openedAt, p.pr.closedOn) }}</td>
          <td><span class="pill" :class="OUTCOME_TONE[p.outcome]" :title="p.pr.changes?.changed === null ? p.pr.changes.why : p.pr.error ?? ''">{{ PR_OUTCOME_LABEL[p.outcome] }}</span></td>
          <td class="num lines"><template v-if="p.pr.changes && p.pr.changes.changed !== null">{{ lines(p.pr.changes.opened) }}<template v-if="p.pr.changes.changed"><span class="arrow">→</span>{{ lines(p.pr.changes.merged) }}</template></template><span v-else class="dim">—</span></td>
          <td class="dim">{{ p.pr.destination ?? '—' }}</td>
          <td class="jira"><span v-if="p.ticket?.status" class="pill" :class="{ ok: p.ticket.statusCategory === 'done' }">{{ p.ticket.status }}</span><span v-else class="dim">—</span><span v-if="p.failed.length" class="pill bad" :title="`Sent to Failed after the merge: ${p.failed.map((at) => fmtTime(at)).join(', ')}`">failed{{ p.failed.length > 1 ? ` ${p.failed.length}×` : '' }}</span></td>
        </tr>
      </tbody>
    </table>
    <div v-if="view && !shownPrs.length" class="empty">No pull request in this period.</div>
  </Frame>
</template>
