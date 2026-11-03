# Web console for the ticket pipeline

Status: in progress (2026-11-01: queue, loop, CLI, API, console and Jira search built, the search within a JQL since 2026-11-03; runs start from the base branch `PIPELINE_BASE_BRANCH`, `dev` during webui's code freeze, with pull requests off; the first real run through the loop was done on 2026-10-27)

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
owns the queue and starts each run with `tools/ticket-pipeline/prepare-worktree.sh`, as `batch.sh`
does today; `webui` is not changed for it beyond one entry point in `launch-session.sh`. Everything it shows comes
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
  ticket, summary (one line), verdict, ending, duration, pull request and its state as Bitbucket
  last reported it; filterable by verdict (by family, done or blocked, or one verdict, or none)
  and ending, each filter's counts following the other. A run the service did not drive shows the
  ending `unwatched`, never `completed`. A stage that ran several times shows each round's result. Over it, a strip of what the runs shown add up to: how many, done, blocked or
  failed, pull requests by state, the time in all and per run. The ticket key opens the run, an
  arrow beside it the Jira ticket; the run in flight stands out, with its stage and its time so far.
- A run's page: its full summary, start, end and duration, a link to Jira, running the ticket
  again, and a diagram of its steps as blocks joined by links (the assignment, each agent in
  order, the stages still to come while it is in flight, the verdict). Choosing a block shows what
  it left: its report, or, while the run is in flight, what the agent handed back as it stopped
  (the pipeline writes the reports only when the run ends). A stage that ended badly (a failed
  review, a blocked test) is marked so; the reason a run stopped is shown whole under its header.
- Notifications that come and go by themselves: an action done or refused (a ticket Jira does
  not know), a run starting, moving to its next stage, opening its pull request or stopping, the
  loop stopping by itself. Changes move rather than jump: queue rows glide when reordered, slide
  in when added and out when removed or started.
- Counts of runs by verdict for the last batch, the last 7 days and all time (the API still has
  them; the cockpit stopped showing them on 2026-11-01, they wait for a statistics page of their own).
- The webui branch a run starts from and its pull request goes to, and whether pull requests are
  on, off or drafts only (`PIPELINE_PULL_REQUESTS=draft`: every pull request opens as a draft,
  ADR draft-pull-requests).
- Actions: start and stop the service's loop; add a ticket at the end or at the front of the
  queue; remove or reorder queued tickets; cancel the run in flight; run a finished ticket again.
- A queued ticket's summary, read from Jira when it is added; a key Jira does not know is refused.
- The state of what the console depends on: `.pipeline-runs/`, the tmux session, Jira. Not the
  device mock (the agents switch its board while they work) nor Bitbucket (dropped 2026-11-01:
  a pull request's state shows as unknown in the runs without it).
- A ticket search (added 2026-10-28, first planned as a PRD of its own): a ticket key finds that
  ticket; a project key first (`KAZ`, `KAZ search pane`) keeps the search to that project, with
  the words after it if any; other words are searched in the summary, description and comments
  of every project. The latest updated first, 20 at a time with more on request, beside how
  many Jira counts in all; each found ticket with its status, type, assignee, its place in the queue or the run in
  flight, and its latest run; queued from the result at the end or the front, by the same rules
  as a key typed in.
- A JQL to search within (added 2026-11-03, ADR jql-search): the operator applies any JQL Jira
  takes; with nothing typed it lists every ticket the JQL finds, in its ORDER BY or the latest
  updated first, and a key, a project key or words typed in are searched only among those. Jira's
  own words say why a JQL is refused, a field or value it does not know included. A switch turns
  the JQL on and off without losing it; both stay in that browser.

## Non-goals

- Choosing tickets from Jira by a query (Instrumenta's "Pick"): people fill the queue; the search,
  a JQL included, only helps them find a ticket, and nothing is queued without a click. One JQL
  kept in the browser is all: no named saved queries, no filter builder.
- A budget or cost per run, in money or tokens: runs go under a subscription, and nobody reads
  the number.
- Access control: anyone who reaches the console's address (Tailscale or the office LAN) may act;
  the network is the fence.
- Replacing `pipeline-tui` or `batch.sh`: both stay as they are and are not developed further.
  `batch.sh` is for a server without the service; the two are not run at the same time.
- Writing anything into `webui` beyond one entry point in `launch-session.sh` for the service to start
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
- Opening a run shows every stage report, in order, and `state.md`, as the files read, one step
  of its timeline at a time.
- A run in flight: its page shows the working agent within 5 s of its start, and an agent's last
  message within 5 s of its stop, with no reload.
- A run with a pull request: the console shows the PR's state (open, merged, declined) and the
  time it was read from Bitbucket; without a Bitbucket token it says the state is unknown and the
  rest works.
- Each dependency the console cannot reach (`.pipeline-runs/`, tmux, Jira) is
  shown as not OK with the error, and what does not depend on it keeps working; without Jira a
  ticket is still queued, with its key alone.
- The operator types a key or two words or more into the search: within 2 s the tickets Jira
  finds are listed, with how many there are in all; `KAZ` lists only KAZ tickets, `KAZ search
  pane` only KAZ tickets with those words; a key Jira does not know lists nothing; one character
  asks nothing; "Show 20 more" adds the next 20. Queuing
  a found ticket puts it in the queue with its summary and marks its row queued; a ticket
  already queued or in flight cannot be queued from the search again. The state polls leave the
  results as they are. Without Jira the search says why it cannot search and the rest works.
- The operator applies a JQL (`statusCategory != Done AND labels = pipeline`): with the field
  empty the tickets it finds are listed with their count; `KAZ`, words or a key typed then search
  only among them, and a key outside it lists nothing. A JQL Jira refuses, or one naming a field
  or a value Jira does not know, shows Jira's message instead of "nothing found". After a reload
  the search is as it was: what was typed, the JQL, its switch and the first page of results; switched off or removed, the search covers every
  project again.
- The console is opened from a browser on another machine on the network: it shows the same queue,
  run and history as the server's files, and an action taken in one browser shows in another
  within 5 s.

## Open questions

- Vocabulary: "run", "queue", "loop", "in flight", "verdict", "ending" are used here;
  Instrumenta's "attempt", "Pick", "Minion", "Foreman" are not. Settled in `.about/glossary.md`.
- The service can only drive a session from a base branch whose `launch-session.sh` has
  `PIPELINE_SESSION`: `prepare-worktree.sh` builds every worktree from `origin/<base>`, and an
  older launch script runs the plain CLI unwatched, to a pull request (2026-10-27, KAZ-7785
  run-3; ADR webui-entry-point). Since webui PR #666 the base is `PIPELINE_BASE_BRANCH`
  (`master` by default) and the pull request goes to it; during the code freeze the service runs
  from `dev`. It refuses any run whose scripts on that branch lack the entry point, or, for a
  base other than `master`, lack `PIPELINE_BASE_BRANCH` (ADR webui-entry-point, The base
  branch). The ref workaround it replaces (`PIPELINE_LAUNCH_SESSION_REF`, 2026-10-27 to
  2026-10-30) is gone.
- The session is driven through the Claude Agent SDK (stages from its SubagentStart/Stop hooks,
  endings from its typed result and rate-limit events) instead of a tmux window and the
  session's transcript. Checked on 2026-10-27 with one run of KAZ-7785 (run-2) through the SDK
  under the subscription's token: the token works, the Workflow tool, the sandbox settings, the
  project skills and agents load, every stage start and stop reached the hooks, and the session
  stayed alive across the background workflow. The first run through the loop (2026-10-27,
  KAZ-7785 run-4, the launch script, then named `start.sh`, from `pipeline-improvements`) did the same end to end: the stage
  showed in the console, the session woke after the workflow's 7-minute investigation and closed
  the run (`done:nothing-to-build`, the fix already on master), recorded `completed`. The
  refusal of the push and the pull request was checked in a live session and in a subagent,
  not yet in a run that reaches its push. Left open: the print-mode wait ceiling
  (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, set to 0 in the run) was not exercised, since the
  session's idle wait was under 10 minutes; the service sets it to 0 and a longer run shows
  whether that is enough (a `turn` event arriving before the stage's stop would show it cut
  the wait short). If the token were ever refused, the fallback is a tmux window and the
  transcript, as `batch.sh` does today.
