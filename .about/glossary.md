# pipeline-ui glossary

The words the service, its records and the console use. Instrumenta's "attempt", "Pick",
"Minion" and "Foreman" are not used.

**Run**: one start of the pipeline for one ticket, from `prepare-worktree.sh` to the session's end; a run
directory `run-N` under `.pipeline-runs/<KEY>/`. _Avoid_: attempt, job.

**Queue**: the tickets waiting to run, in order. The service takes the first one.

**Loop**: the service's cycle that takes the next ticket when nothing is in flight. It is
running or stopped; it stops itself on the usage limit, and before a run whose entry point is
refused.

**In flight**: the run going on now. At most one. The API names it `in-flight`; the console
writes "in flight".

**Verdict**: the pipeline's word on a run, `family:word`, the last such line of `state.md`:
`done:pr-opened`, `done:draft-pr`, `done:nothing-to-build`, `blocked:*`, `failed:*`
(`server/history/outcome.ts`). Only a closed run has one; a run without one counts as `none`.
A line of another shape is not a verdict.

**Verdict family**: the part before the colon: `done` (green), `blocked` and `failed` (rust).

**Reason**: why a run stopped: `state.md`'s `reason:` line, or, for a blocked or failed run
without one, its last free line.

**Stage result**: the word an agent ended its stage on (`pass`, `fail`, `done`, `opened`,
`blocked`, `confidence low`): a stage's own outcome, not the run's verdict. A review `fail` that
leads to a rework does not end the run.

**Ending**: the service's word on how a run's session ended: `completed`, `usage-limit`,
`error`, `cancelled`, `timeout`, `restart`, `exited`, `no-result`. Every run the service started
has one once it is over. The console shows three more for runs it reads from the files:
`in-flight` (going on now), `unwatched` (closed, but not by a session the service drove: runs
from before the console) and `died` (never closed, and nothing runs it). An ending is not a
verdict: a `completed` session can leave `blocked:tooling`.

**Entry point**: the `launch-session.sh` a run goes through, and the `prepare-worktree.sh`
that hands over to it, both from `origin/<base>`, the base branch (`master` by default). Checked before every run.

**Preparation**: what the entry point does for a run before its session starts, in steps:
`git fetch`, `worktree`, `npm ci`, `sandbox check`, `mock reset`, `session start` (until the
session's first event). The service reads them from `prepare-worktree.sh`'s trace (ADR
preparation-steps); a run in it shows `preparing: <step>` where a stage would show. Not a stage.

**Base branch**: the webui branch a run's worktree starts from and its pull request goes to
(`PIPELINE_BASE_BRANCH` by default; a run setting). The console calls it the target branch.

**Run settings**: the base branch, whether a run may open its pull request (on, drafts only,
off) and a session's time limit. The environment gives each its default; the masthead's gear
or `pipeline set` changes one for the next run, never for the run in flight.

**The JQL**: the Jira query the operator applies to the ticket search; whatever is typed is
searched only among the tickets it finds. Kept in the browser, not in the service. Not a
"filter" or a "saved query".

**Stage**: one agent's turn in a run (investigate, implement, diff, review, app-test, `rework N`,
`same cause?`, `pull request`; in a screen migration spec and compare in place of investigate and
app-test, and `re-compare N` after a rework), as the session's hooks report it and `timings.tsv`
names it. A stage that ran several times is matched to its `state.md` lines in order.

**Screen migration**: a run of webui's screen-migration workflow, for a ticket labelled
`vue-migration`: a legacy screen rebuilt in Vue, compared with the legacy page row by row. Marked
after the ticket's key wherever the key shows.

**Merged as opened**: a pull request merged with the same lines added and removed as the
pipeline pushed, whatever was rebased. **Merged with changes**: merged with lines the pipeline
did not push, or without some it did (ADR statistics).

**Failed after merge**: a ticket that testing sent to Jira's `Failed` status after the
pipeline's pull request for it was merged: a fix that did not hold, whatever became of the ticket
later (ADR statistics).

**Period**: on the statistics page, the runs counted: those started in the last batch, 7, 30 or
90 days, or all time; their pull requests and tickets count with them, whenever they were merged
or done.

**Sheet**: the design system both consoles share (`ui/src/sheet.css`, `ui/public/theme.js`,
`ui/public/fonts/`): the CGS Glass kit's tokens (`--cg-*`) and its parts under the sheet's own
class names (ADR glass-kit); this repository is its source of truth, bug-validator syncs a copy
(ADR unification). "The sheet's part" is a class defined there; the console's own
layout is `ui/src/style.css`.

**Console guard**: what the HTTP server checks before it serves anything (`server/http/guard.ts`):
the security headers, the Host it knows, that an action comes from the console's own pages, the
optional login (`PIPELINE_USER`, `PIPELINE_PASSWORD`), the body cap.

**Heartbeat**: the `service` row the running service rewrites every second (pid, started at,
seen at). The console and `/healthz` say the service is running while it is fresher than 5 s.
