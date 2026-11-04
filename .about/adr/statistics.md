# The statistics count the runs of a period, and compare a merged pull request with what was opened

Date: 2026-11-04

The operator wants to see what the pipeline comes to: how many pull requests it opened, how many
are open, merged or declined, whether people merged them as the pipeline wrote them or changed
them first, whether the tickets reached Done in Jira, and where runs stopped, as numbers and day
by day. A page of its own (`#/stats`) shows it, over `/api/stats`.

**A period picks runs, not events.** The page counts the runs started in the period (the last
batch, 7, 30 or 90 days, all time) and follows each to its end: a pull request opened by a run in
the period counts with its merge whenever the merge came, and its ticket with its Done. Counting
the events of a period instead (merges in the last 7 days, of runs from any time) would mix runs
the period does not show into its rates. The charts put those same runs' events on the days they
happened, from the period's first day to today. Each ticket is counted once in the funnel (run,
pull request, merged, Done in Jira), however many runs it took. The sums are made in the browser
by `server/history/stats.ts`, a module without Node imports the tests run as it is, so a day is
the operator's own calendar day, not the server's.

**Merged as opened or with changes** is decided by the patches, not by the commits. A pull
request's branch is usually rebased before it is merged (fast-forward), so its commit always
changes, and a merged PR's commit says nothing. Bitbucket's activity gives the source and
destination commits of the PR's first update, which is what the pipeline pushed; its commit list
as merged gives the merged commits, from the parent of the oldest. The two patches are read with
`git diff from...to` in the webui checkout: the pipeline's commit is there, because it was made
there, even after Bitbucket dropped it on a force-push. Only the added and removed lines and the
files are compared, trailing space dropped: a rebase changes the hunks' line numbers and the
context around them, and nothing that was written. Of the first 52 merged PRs, 38 went in as
opened, 14 with changes; comparing whole patches (`git patch-id`) said 16, two of them only a
rebase over moved context. A merged PR is compared once; one that could not be (a commit missing
from the checkout, or an activity or commit list longer than the pages read, whose first update
or oldest commit would be cut off) is tried again an hour later and shows as "merged, not
compared".

A commit missing from the checkout (a merge since the last run's fetch) is fetched with
`git fetch --no-write-fetch-head --refmap= origin <branch>`: objects only, no ref and no
FETCH_HEAD written, so it cannot race the entry point's own fetch before a run, and the checkout
is otherwise only read (ADR webui-entry-point). The PR's destination branch, creation date and
draft flag are read with its state; a PR read before 2026-11-04 without them is read again once.

**Done in Jira** is the ticket's status category `done`, its date `statuscategorychangedate`
(the last move into Done; `resolutiondate` is set by some workflows before Done). Statuses come
from `/issue/bulkfetch`, 100 keys a call, every ticket the pipeline ran, every 10 minutes in the
service's background round, kept in a `tickets` table; a key Jira does not know is left out
rather than failing the call, as a JQL `key in (...)` would. The ticket's summary comes with it,
for older runs whose files have none.

**Failed after merge** (added 2026-11-04) is a move into the Jira status named `Failed` (the
workflow's status testing sends a ticket back to) after the ticket's pipeline pull request was
merged: the fix did not hold. A Failed before the merge is review, not the fix, and is not
counted. It is read from the changelog, not the current status: a failed ticket is reopened and
usually ends in Done, so its status alone hides it. The changelog comes in the same bulkfetch
(`expand: changelog`), which carries only the latest 40 or so histories; a ticket with more has
its changelog read by its own pages. Each ticket keeps its status moves in the `tickets` table;
a copy from before they were kept is read again once. The share is of the tickets merged, and
the merged pull requests are split by merged as opened or with changes, since a fix someone had
to change before the merge fails more often.

The cockpit's counts by verdict for the last batch, 7 days and all time (dropped from the cockpit
on 2026-11-01) are the page's periods now; the state API still carries them.
