# The queue and the loop live in the service's SQLite database, not in webui

Date: 2026-10-27

The queue of tickets, the loop's state (running or stopped, and why), every run the service
started and its events are rows in one SQLite file under the service's data directory
(`node:sqlite`, no driver to install). `webui` holds nothing of it: no queue file, no state the
runs would share with the console. The queue outlives the service and the server's reboot, as
the PRD asks, and `batch.sh` keeps working on a server without the service, since it never
looked for a queue.

Commands reach the loop through the same database: a CLI or an HTTP handler writes the wanted
loop state, a queued ticket or a cancel request, and the service's tick, once a second, acts on
what it reads. One process owns the child run; every other process only writes rows. After a
restart the service starts nothing by itself: it marks the run it had in flight as ended by the
restart and sets the loop to stopped, so a reboot never resumes a half-done run on a stale
worktree.

The service records a run's ending (completed, usage-limit, error, cancelled, timeout, restart,
exited) from what it saw, and the verdict from the `state.md` the run itself wrote: the ending is
the service's word, the verdict is the pipeline's, and a run can have one without the other.

## Considered options

- **A queue file in webui that `batch.sh` and the service share** — writes into webui, which the
  PRD rules out beyond the one entry point, and two writers of one file.
- **Commands over HTTP only** — the CLI, the tests and the later web UI would each need the
  service up to do anything; rows in the database work for all three and the HTTP layer adds a
  faster path later.
- **Resume the run in flight after a restart** — the session is gone with the process; a new
  run from a fresh worktree is what the pipeline does anyway (ADR ticket-pipeline in webui).

## Consequences

- One service per database file; two services on one file would both take the queue's head.
- The tick's one-second poll bounds how fast a command takes effect without the HTTP layer.
