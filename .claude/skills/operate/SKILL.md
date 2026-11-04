---
name: operate
description: "Run and look after the service: the systemd units, what the log says at start and when something fails, a migration and its backup, restarting only when nothing is in flight. Use when the service is to be started, stopped or restarted, when the console says the service is not running, when the loop stopped by itself, or after a change to server/, .env or the machine."
user-invocable: true
---

# Operate the service

Two systemd user units (`deploy/`): `pipeline-ui` (the service and the console on 8787) and the
`pipeline-ui-maintain` timer (a daily backup of the database, the log's size). The whole of it:
`.about/architecture.md`, Deploy and Log. Nothing below starts the loop, queues a ticket or
writes to Jira or Bitbucket; a real run costs a Claude session and may open a pull request.

```
systemctl --user status pipeline-ui
bin/pipeline status                              # the loop, the run in flight, the queue
systemctl --user restart pipeline-ui             # after a change to server/ or .env; only when nothing is in flight
tail -f data/serve.log                           # one JSON line per event
journalctl --user -u pipeline-ui-maintain        # backup, log_cut
curl -s http://127.0.0.1:8787/healthz            # 200 while it runs and every state source is ok, 503 otherwise
```

A change to `ui/` needs only `npm run build`: the service serves `ui/dist` as it is. Without
systemd the service runs in a tmux session not named `pipeline` (that is `batch.sh`'s).

## Restart only when nothing is in flight

A stop ends the run in flight as `restart`: its session is told to end (up to 30 s), the run is
recorded with that ending, and the ticket is not queued again by itself. So before a restart:
`bin/pipeline status` says `in flight: nothing`, or `bin/pipeline stop` and wait for the run to
finish (the console's card goes to `nothing running`). After the restart the loop is stopped
whatever it was: the operator presses Start when the time is right. Restart with the same
settings it ran with: most are in `.env`; `/proc/<pid>/environ` shows the rest. Never print the
secrets files (`~/.config/webui-pipeline.env`, `.env`) or an unfiltered `env`.

## What a start must show

The first lines after a start: `migration` (only when the schema moved: `from`, `to`, the
`copy` made first), then `service_start` with `db` (the expected file), `webui` (the checkout),
`entry` (the entry point's label: `prepare-worktree.sh` from `origin/<base>` handing over to a
launch script that knows `PIPELINE_SESSION`), `baseBranch`, `pullRequests` (`on`, `draft` or
`off`) and `loop: stopped`; then `console_listening` with `ui: true` (false: `npm run build`
was not run). A `run_ended` with `ending: restart` before them is the run that was in flight
when the service last stopped.

A start refused: `fatal` in the log with the error. `Bad configuration` names every bad value
in `.env` (`PIPELINE_PULL_REQUESTS`, the Jira site without its scheme, a user without a
password); `PIPELINE_LAUNCH_SESSION_REF is no longer read` is the code freeze's old workaround
still set; `EADDRINUSE` is another service on the port (the operator's own `bin/pipeline serve`
in a tmux session, or the unit already running).

## A migration

The schema's version is `PRAGMA user_version`; the service migrates at start and copies the file
first (`data/pipeline.db.before-v<N>-<time>`). Nothing to do but read `service_start` afterwards;
the copy can be deleted once the service has run a day. `maintain` keeps 14 daily backups in
`data/backups/` (`PIPELINE_BACKUP_DIR`), and cuts `data/serve.log` to `.1` once past 5 MB.

## The console says…

- **service not running:** the heartbeat is older than 5 s. `systemctl --user status
  pipeline-ui`: crashed (the log's last `fatal`; systemd restarts it up to 5 times in 10
  minutes), or stopped by hand. The queue and the history are in `data/` and wait.
- **the loop is stopped, usage limit at …:** the subscription's limit; the queue is untouched,
  Start takes the next ticket once the limit resets (the card says when).
- **the loop is stopped, entry point refused …:** `loop_refused` says why: the base branch
  (`PIPELINE_BASE_BRANCH`) lacks the entry point, or origin could not be fetched. Fix, then Start.
- **a state source not OK:** the folded frame names it. `.pipeline-runs` is `PIPELINE_WEBUI`;
  `tmux — batch.sh` means a `pipeline` tmux session is running: do not start the loop; Jira is
  the `JIRA_*` settings or the token. What does not depend on a failed source keeps working.
- **cancelling for more than 30 s:** the session was told to end and did not; the runner kills
  it after 30 s and the run is recorded `cancelled`. If the card stays, look at `serve.log`.

## Do not

- Delete or edit `data/pipeline.db`: the queue and every run the service drove are in it.
  Restore from `data/backups/` if it is lost, before a start.
- Run two services on one database, or the loop and `batch.sh` on the same machine.
- Touch `webui` from here: never commit, push or change branches there (CLAUDE.md, Boundaries).
