# Web console for the ticket pipeline

Status: in progress (2026-10-27: queue, loop, CLI, API and console built; first real run through the loop done, with start.sh from `pipeline-improvements` and pull requests off)

## Problem

The person running ticket-pipeline batches on the server learns what the batch is doing only by
ssh-ing in and attaching the tmux session, and `pipeline-tui` shows a run's stages only once the run
is closed. A batch's tickets are fixed by its command line: none can be added, removed or reordered
while it runs; a stuck run is ended with `tmux kill-window` by hand; the next batch waits until
someone kills the finished session. With a batch every day or two and 77 runs so far, each of these
costs a trip to the server's shell.

## Users

The pipeline operator (today one person), who starts, watches and steers the pipeline from a
browser anywhere on the network instead of the server's shell. Later, teammates who want to know
whether a ticket is queued, running or done. Not for QA or reviewers to act on tickets or pull
requests: they keep Jira and Bitbucket.

## Success signal

For a week after the console is in use, every ticket is added, reordered or cancelled through it,
and every stuck run is ended there: the operator opens no ssh session for the pipeline's state or
its queue. Checked by asking the operator at the end of that week.

## Scope

A service of its own, in a repository next to `webui`, on the server the pipeline runs on. It
owns the queue and starts each run with `tools/ticket-pipeline/run.sh`, as `batch.sh` does today;
`webui` is not changed for it beyond one entry point in `start.sh`. Everything it shows comes
from the run directories under `.pipeline-runs/`, from the session it drives through the Claude
Agent SDK, and from its own records.

- A queue of tickets, in order, that the service takes from one at a time, one run at a time. The
  queue outlives the service and the server's reboot.
- The service's state: running, or stopped (it takes no new ticket; the run in flight finishes),
  with why it stopped when it stopped itself (the subscription's usage limit).
- The run in flight: ticket, summary, the stage it is in and since when, the rework round, how
  long the run has taken so far.
- The queue: ticket, summary, position.
- Run history: every run under `.pipeline-runs/`, runs from before the console included, with
  ticket, summary, verdict, start, duration, pull request and its state as Bitbucket last reported
  it, and each stage's report; filterable by verdict and ending.
- Counts of runs by verdict for the last batch, the last 7 days and all time.
- Actions: start and stop the service's loop; add a ticket at the end or at the front of the
  queue; remove or reorder queued tickets; cancel the run in flight; run a finished ticket again.
- A queued ticket's summary, read from Jira when it is added; a key Jira does not know is refused.
- The state of what the console depends on: `.pipeline-runs/`, the tmux session, Jira, the device
  mock, Bitbucket (for pull-request state).
- A ticket search field, present but disabled, where the Jira search will go.

## Non-goals

- Choosing tickets from Jira by a query (Instrumenta's "Pick"): people fill the queue. The search
  behind the disabled field comes with its own PRD.
- A budget or cost per run, in money or tokens: runs go under a subscription, and nobody reads
  the number.
- Access control: anyone who reaches the console's address (Tailscale or the office LAN) may act;
  the network is the fence.
- Replacing `pipeline-tui` or `batch.sh`: both stay as they are and are not developed further.
  `batch.sh` is for a server without the service; the two are not run at the same time.
- Writing anything into `webui` beyond one entry point in `start.sh` for the service to start
  the session itself: no queue file, no runner, no hook. The service reads what runs already
  leave and what the session reports to it.
- More than one run at a time, or runs on more than one server.
- Acting on the ticket or the pull request: commenting, approving, merging, moving a Jira ticket,
  editing a report.
- Notifications (mail, chat) when a run ends.
- Showing a run's live transcript; the stage and its report are enough.

## Acceptance criteria

"Within N s" means as seen in a browser already open on the console.

Queue and loop:

- The loop is running and the queue is empty; the operator adds KAZ-1: within 60 s KAZ-1 is in
  flight and the queue is empty.
- KAZ-1 is in flight; the operator adds KAZ-2, then KAZ-3, then moves KAZ-3 before KAZ-2: when
  KAZ-1 ends, KAZ-3 starts next, then KAZ-2.
- The operator adds a ticket at the front while others are queued: it is the next to start; the
  run in flight is not interrupted.
- The operator adds something that is not a ticket key (`kaz-1`, `KAZ`, `foo`): it is refused with
  a message and the queue is unchanged.
- The operator adds a ticket already in the queue: it is refused and the queue holds it once. A
  ticket in flight or finished can be queued again and gets a new run.
- The operator removes a queued ticket: it never starts; the run in flight is unaffected.
- The operator stops the loop while KAZ-1 is in flight: KAZ-1 finishes and is recorded as any
  other run; KAZ-2 stays queued and starts only after Start.
- The operator cancels the run in flight: its session ends within 30 s; the run is recorded
  `cancelled` with the stage it was in; its worktree, branch and reports written so far stay; the
  next queued ticket starts if the loop is running.
- A run ends on the subscription's usage limit: the service stops its loop; the console says so and
  shows when the limit was hit; the queue is untouched; Start takes the next ticket.
- A run ends on an API error, the run timeout, or its session exiting without `state.md`: the run
  is recorded with that ending and the loop takes the next ticket.
- The server reboots with KAZ-1 in flight and KAZ-2, KAZ-3 queued: after it, the queue still holds
  KAZ-2 and KAZ-3 in that order, KAZ-1 is recorded as ended by the restart, and the service starts
  nothing until Start.
- Start while the loop already runs: nothing changes; the queue is the only way to add work.

What it shows:

- A run moves to its next stage (investigate, implement, review, app-test, pull request, or a
  rework round): the console shows the new stage within 30 s.
- A run ends: its verdict, duration and pull request appear in the history within 30 s, and the
  run in flight is cleared.
- A run directory from before the console, with `state.md`: listed with that verdict, its start
  and PR. One without `state.md` and with no live session: listed as died.
- The verdict filter set to one verdict: the history shows only those runs, and the count beside
  the filter matches the rows.
- Opening a run shows every stage report, in order, and `state.md`, as the files read.
- A run with a pull request: the console shows the PR's state (open, merged, declined) and the
  time it was read from Bitbucket; without a Bitbucket token it says the state is unknown and the
  rest works.
- Each dependency the console cannot reach (`.pipeline-runs/`, tmux, Jira, mock, Bitbucket) is
  shown as not OK with the error, and what does not depend on it keeps working; without Jira a
  ticket is still queued, with its key alone.
- The disabled search field is visible, cannot be typed into and changes nothing.
- The console is opened from a browser on another machine on the network: it shows the same queue,
  run and history as the server's files, and an action taken in one browser shows in another
  within 5 s.

## Open questions

- Vocabulary: "run", "queue", "loop", "in flight", "verdict", "ending" are used here;
  Instrumenta's "attempt", "Pick", "Minion", "Foreman" are not. Settled in `.about/glossary.md`.
- The service can only drive a session once `start.sh` with `PIPELINE_SESSION` is on webui's
  `origin/master`: `run.sh` builds every worktree from there, and an older `start.sh` runs the
  plain CLI unwatched, to a pull request (2026-10-27, KAZ-7785 run-3; ADR webui-entry-point).
  Until then the service runs through `PIPELINE_START_SH_REF` (`start.sh` from a branch that
  has the entry point, the worktree still `origin/master`'s) with pull requests off, so a run
  ends before its push; and it refuses any run whose `start.sh` lacks the entry point (ADR
  webui-entry-point, During the code freeze).
- The session is driven through the Claude Agent SDK (stages from its SubagentStart/Stop hooks,
  endings from its typed result and rate-limit events) instead of a tmux window and the
  session's transcript. Checked on 2026-10-27 with one run of KAZ-7785 (run-2) through the SDK
  under the subscription's token: the token works, the Workflow tool, the sandbox settings, the
  project skills and agents load, every stage start and stop reached the hooks, and the session
  stayed alive across the background workflow. The first run through the loop (2026-10-27,
  KAZ-7785 run-4, start.sh from `pipeline-improvements`) did the same end to end: the stage
  showed in the console, the session woke after the workflow's 7-minute investigation and closed
  the run (`done:nothing-to-build`, the fix already on master), recorded `completed`. The
  refusal of the push and the pull request was checked in a live session and in a subagent,
  not yet in a run that reaches its push. Left open: the print-mode wait ceiling
  (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, set to 0 in the run) was not exercised, since the
  session's idle wait was under 10 minutes; the service sets it to 0 and a longer run shows
  whether that is enough (a `turn` event arriving before the stage's stop would show it cut
  the wait short). If the token were ever refused, the fallback is a tmux window and the
  transcript, as `batch.sh` does today.
