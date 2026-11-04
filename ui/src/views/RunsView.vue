<script setup lang="ts">
// The run history: a strip of what the runs shown add up to, the filters by verdict and ending,
// then every run with the pull request's state as Bitbucket last reported it. The ticket key opens
// the run's page, the arrow its Jira ticket; the run in flight stands out with its stage. The
// summary is cut to one line: the run's page has it whole, with the start, the end and running the
// ticket again.
import { computed } from 'vue'
import Frame from '../components/Frame.vue'
import {
  endingLabel,
  endingTone,
  fmtClock,
  fmtDuration,
  fmtTime,
  prNumber,
  prStateClass,
  toneClass,
  verdictClass,
  verdictFamily,
  type ShownRun,
} from '../api.ts'
import { filter, history, liveStage, runSeconds, setFilter, ticketUrl } from '../console.ts'

const runs = computed(() => history.value?.runs ?? [])
const filtered = computed(() => !!(filter.value.verdict || filter.value.ending))

/** The verdicts by family (done, blocked, failed), each with its own verdicts; `none`, for runs without one, apart. */
const families = computed(() => {
  const groups = new Map<string, { family: string; total: number; members: { verdict: string; label: string; count: number }[] }>()
  for (const [verdict, count] of Object.entries(history.value?.verdicts ?? {})) {
    if (verdict === 'none') continue
    const [family, rest] = verdict.includes(':')
      ? [verdict.slice(0, verdict.indexOf(':')), verdict.slice(verdict.indexOf(':') + 1)]
      : [verdict, '']
    const g = groups.get(family) ?? { family, total: 0, members: [] }
    g.total += count
    g.members.push({ verdict, label: rest || verdict, count })
    groups.set(family, g)
  }
  const rank = (f: string) => (['done', 'blocked', 'failed'].indexOf(f) === -1 ? 3 : ['done', 'blocked', 'failed'].indexOf(f))
  return [...groups.values()]
    .sort((x, y) => rank(x.family) - rank(y.family) || x.family.localeCompare(y.family))
    .map((g) => ({ ...g, members: g.members.sort((x, y) => y.count - x.count) }))
})
const noVerdict = computed(() => history.value?.verdicts['none'] ?? 0)
const endings = computed(() => Object.entries(history.value?.endings ?? {}).sort((x, y) => y[1] - x[1]))
// The All chip counts what the other filter lets through; the heading counts every run.
const allCount = computed(() => Object.values(history.value?.verdicts ?? {}).reduce((s, n) => s + n, 0))
const total = computed(() => history.value?.total ?? 0)

function pickVerdict(v: string): void {
  setFilter({ ...filter.value, verdict: filter.value.verdict === v ? '' : v })
}
function pickEnding(e: string): void {
  setFilter({ ...filter.value, ending: filter.value.ending === e ? '' : e })
}

/** `62 pr-opened · 9 nothing-to-build`: the most common first, at most `n`. */
function breakdown(counts: Map<string, number>, n = 3): string {
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .slice(0, n)
    .map(([k, c]) => `${c} ${k}`)
    .join(' · ')
}

/** What the runs shown add up to, one cell each. */
const strip = computed(() => {
  const all = runs.value
  const family = (r: ShownRun) => verdictFamily(r.verdict)
  const tail = (r: ShownRun) => r.verdict?.split(':').slice(1).join(':') || r.verdict || ''
  const tally = (list: ShownRun[], key: (r: ShownRun) => string) =>
    list.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map<string, number>())

  const done = all.filter((r) => family(r) === 'done')
  const stuck = all.filter((r) => family(r) === 'blocked' || family(r) === 'failed')
  const withVerdict = all.filter((r) => r.verdict).length
  const prs = all.filter((r) => r.pr)
  const prStates = tally(prs, (r) => (r.pr!.state === 'unknown' ? 'unknown' : r.pr!.state.toLowerCase()))
  const fetched =
    prs
      .map((r) => r.pr?.fetchedAt ?? '')
      .filter(Boolean)
      .sort()
      .at(-1) ?? null
  const otherEndings = tally(
    all.filter((r) => r.ending !== 'completed' && r.ending !== 'unwatched'),
    (r) => endingLabel(r.ending),
  )

  const secs = all
    .map((r) => runSeconds(r))
    .filter((s): s is number => s !== null)
    .sort((x, y) => x - y)
  const total = secs.reduce((s, n) => s + n, 0)
  const median = secs.length ? secs[Math.floor(secs.length / 2)]! : null
  const first = all.map((r) => r.startedAt).sort()[0] ?? null

  return [
    { label: 'Runs', value: String(all.length), tone: '', note: otherEndings.size ? breakdown(otherEndings) : 'none stopped early' },
    {
      label: 'Done',
      value: String(done.length),
      tone: done.length ? 'ok' : '',
      note: `${withVerdict ? Math.round((done.length / withVerdict) * 100) : 0}% of verdicts${done.length ? ` · ${breakdown(tally(done, tail), 2)}` : ''}`,
    },
    {
      label: 'Blocked or failed',
      value: String(stuck.length),
      tone: stuck.length ? 'bad' : '',
      note: stuck.length ? breakdown(tally(stuck, tail), 2) : 'none',
    },
    {
      label: 'Pull requests',
      value: String(prs.length),
      tone: '',
      note: `${prs.length ? breakdown(prStates) : 'none'}${fetched ? ` · read ${fmtClock(fetched)}` : ''}`,
    },
    { label: 'Time', value: fmtDuration(total), tone: '', note: first ? `since ${fmtTime(first).slice(0, 10)}` : '—' },
    {
      label: 'Per run',
      value: fmtDuration(secs.length ? Math.round(total / secs.length) : null),
      tone: '',
      note: `median ${fmtDuration(median)} · longest ${fmtDuration(secs.at(-1) ?? null)}`,
    },
  ]
})

function prState(run: ShownRun): string {
  if (!run.pr) return ''
  return run.pr.state === 'unknown' ? 'unknown' : run.pr.state.toLowerCase()
}
</script>

<template>
  <div class="page-head">
    <h1>Run history</h1>
    <span v-if="filtered" class="stats">{{ runs.length }} of {{ total }} runs shown</span>
  </div>

  <Frame class="strip">
    <div v-for="cell in strip" :key="cell.label" class="cell">
      <div class="label">{{ cell.label }}</div>
      <div class="value" :class="cell.tone">{{ cell.value }}</div>
      <div class="note" :title="cell.note">{{ cell.note }}</div>
    </div>
  </Frame>

  <div class="filters">
    <div class="row">
      <span class="label">Verdict</span>
      <div class="opts">
        <button class="chip" :class="{ on: !filter.verdict }" @click="setFilter({ ...filter, verdict: '' })">
          All <b>{{ allCount }}</b>
        </button>
        <div
          v-for="g in families"
          :key="g.family"
          class="group"
          :class="g.family === 'done' ? 'ok' : g.family === 'blocked' || g.family === 'failed' ? 'bad' : ''"
        >
          <button class="chip fam" :class="{ on: filter.verdict === g.family }" @click="pickVerdict(g.family)">
            {{ g.family }} <b>{{ g.total }}</b>
          </button>
          <button
            v-for="m in g.members"
            :key="m.verdict"
            class="chip sub"
            :class="{ on: filter.verdict === m.verdict }"
            @click="pickVerdict(m.verdict)"
          >
            {{ m.label }} <b>{{ m.count }}</b>
          </button>
        </div>
        <button
          v-if="noVerdict"
          class="chip"
          :class="{ on: filter.verdict === 'none' }"
          title="Runs that left no verdict"
          @click="pickVerdict('none')"
        >
          no verdict <b>{{ noVerdict }}</b>
        </button>
      </div>
    </div>
    <div class="row">
      <span class="label">Ending</span>
      <div class="opts">
        <button class="chip" :class="{ on: !filter.ending }" @click="setFilter({ ...filter, ending: '' })">All</button>
        <button v-for="[e, n] in endings" :key="e" class="chip" :class="{ on: filter.ending === e }" @click="pickEnding(e)">
          {{ endingLabel(e) }} <b>{{ n }}</b>
        </button>
      </div>
      <button v-if="filtered" class="btn tiny clear" @click="setFilter({ verdict: '', ending: '' })">Clear</button>
    </div>
  </div>

  <Frame>
    <table class="wide runs">
      <thead>
        <tr>
          <th>Ticket</th>
          <th>Jira</th>
          <th>Run</th>
          <th>Summary</th>
          <th>Verdict</th>
          <th>Ending</th>
          <th>PR · state</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="run in runs" :key="run.path || run.serviceRunId || run.key" :class="{ live: run.ending === 'in-flight' }">
          <td class="key">
            <span v-if="run.ending === 'in-flight'" class="pulse" title="in flight" /><a
              v-if="run.path"
              :href="`#/runs/${run.key}/${run.number}`"
              title="The run's agents and reports"
              >{{ run.key }}</a
            ><span v-else>{{ run.key }}</span>
          </td>
          <td class="jira">
            <a v-if="ticketUrl(run.key)" :href="ticketUrl(run.key)!" target="_blank" rel="noopener" :title="`${run.key} in Jira`">↗</a>
          </td>
          <td class="num dim">{{ run.number || '—' }}</td>
          <td class="summary one-line" :title="run.summary ?? ''">{{ run.summary ?? '' }}</td>
          <td>
            <span class="pill" :class="verdictClass(run.verdict)" :title="run.reason ?? ''">{{ run.verdict ?? '—' }}</span>
          </td>
          <td>
            <span class="pill" :class="toneClass(endingTone(run.ending))" :title="run.endingDetail ?? ''"
              >{{ endingLabel(run.ending) }}<template v-if="liveStage(run)"> · {{ liveStage(run) }}</template></span
            >
          </td>
          <td class="num">
            <template v-if="run.pr"
              ><a :href="run.pr.url" target="_blank" rel="noopener" class="small-link">PR #{{ prNumber(run.pr.url) }}</a>
              <span
                class="pill"
                :class="prStateClass(run.pr.state)"
                :title="run.pr.fetchedAt ? `read ${fmtTime(run.pr.fetchedAt)}` : (run.pr.error ?? 'not read yet')"
                >{{ prState(run) }}</span
              ></template
            >
          </td>
          <td class="num">{{ fmtDuration(runSeconds(run)) }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="history && !runs.length" class="empty">No runs match.</div>
  </Frame>
</template>
