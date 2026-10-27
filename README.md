# pipeline-ui

Web console for the `webui` ticket pipeline: the queue of tickets, the loop that runs them one at
a time, the run in flight with its stage, and the history of runs under `webui/.pipeline-runs/`.
What it is for and what it must do: [.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md).

Lives next to `webui`; the only thing `webui` knows about it is the `PIPELINE_SESSION` entry point
in `tools/ticket-pipeline/launch-session.sh` (`start.sh` before webui renamed it).

Decisions: [.about/adr/](.about/adr/). Words: [.about/glossary.md](.about/glossary.md).

## Parts

- `server/session/` — drives one ticket's Claude Code session through the Claude Agent SDK.
  `bin/session` is the program `launch-session.sh` runs when `PIPELINE_SESSION` names it; it prints the
  session's events (stages, rate limits, turns, the ending) as JSON lines on the file descriptor
  `PIPELINE_EVENTS_FD` names, stdout by default.
- `server/store/` — the SQLite database (`node:sqlite`): the queue, the loop's state, the runs
  the service started and their events; Jira (`jira.ts`): a queued ticket's summary and the
  ticket search, read only.
- `server/loop/` — the loop that takes the queue's head, checks the entry point (`entry.ts`) and
  runs it through `prepare-worktree.sh` (`runner.ts`), records what the session reports and how the run ended, and stops itself on
  the usage limit.
- `server/cli.ts`, `bin/pipeline` — the service (`pipeline serve`) and the commands that drive
  it through the database: `enqueue`, `remove`, `reorder`, `list`, `start`, `stop`, `cancel`,
  `status`, `runs`, `events`.
- `server/history/` — every run under `.pipeline-runs/` as its files tell it (as `pipeline-tui`
  reads them), and the pull requests' states from Bitbucket, kept in the database.
- `server/health.ts` — what the console depends on: `.pipeline-runs/`, the tmux session
  `batch.sh` uses, Jira, the device mock, Bitbucket.
- `server/http/` — the JSON API (`/api/state`, `/api/runs`, `/api/runs/KEY/N`,
  `/api/jira/search?q=`, the queue, loop and cancel actions) and the built UI.
- `ui/` — the console, Vue 3 + Vite: the loop and its Start/Stop, the run in flight, the queue,
  the runs with counts and filters, each run's reports, the dependencies, the Jira search with
  its results queued at the end or the front. It polls the API
  every 2 s (the history every 10 s), so two browsers show the same within 5 s.

## Run the service

webui's `prepare-worktree.sh` makes each run's worktree from `origin/master` and hands over to
that worktree's `launch-session.sh`; an older launch script runs the plain CLI instead, unwatched
and to a pull request. So before every run the service fetches origin, copies `origin/master`'s
prepare script into `data/entry/` and checks the launch script it hands over to; without
`PIPELINE_SESSION` in it no run starts, the loop stops and the console says why (ADR
webui-entry-point). Until the rename reaches `origin/master`, the scripts there are still
`run.sh` and `start.sh`; both names are found.

While `origin/master` lacks it (webui's code freeze), take the launch script from a branch that has it;
the worktree stays `origin/master`'s, and pull requests are off unless asked for, so a run ends
before its push (`blocked:tooling`, the commits on the local ticket branch):

```bash
PIPELINE_LAUNCH_SESSION_REF=pipeline-improvements bin/pipeline serve   # PIPELINE_PULL_REQUESTS=off implied
```

```bash
bin/pipeline serve            # one per database; reads ~/.config/webui-pipeline.env itself
bin/pipeline enqueue KAZ-1234 # the summary comes from Jira (JIRA_EMAIL, JIRA_API_TOKEN)
bin/pipeline start            # the loop takes the next ticket within a second
bin/pipeline status
bin/pipeline cancel           # the run in flight ends within 30 s and is recorded cancelled
bin/pipeline stop             # the run in flight finishes; nothing new starts
```

After a restart the service starts nothing by itself: the run it had in flight is recorded as
ended by the restart, the queue is kept, and the loop waits for `start`.

Where things are, each with a default for the server: `PIPELINE_WEBUI` (the webui checkout,
`../webui`), `PIPELINE_DATA` (database and run logs, `./data`), `PIPELINE_ENV` (the secrets file),
`PIPELINE_TIMEOUT_HOURS` (one session, 4), `PIPELINE_LAUNCH_SESSION_REF` (none: `origin/master`'s own launch script; `PIPELINE_START_SH_REF` is still read),
`PIPELINE_PULL_REQUESTS` (`on`, or `off` when a ref is set). The secrets file is sourced inside the run, never
printed.

pipeline-ui's own secrets go in `.env` at the repository's root (gitignored; `.env.example`
names them), read by `bin/pipeline` after the pipeline's file, so its values win: `JIRA_EMAIL`
and `JIRA_API_TOKEN` for the summary lookup and the ticket search. Each machine keeps its own.

## Run one session by hand

The same way the service does, from the `webui` checkout, with the pipeline's secrets loaded.
Mind that `prepare-worktree.sh` builds the worktree from `origin/master`: the worktree's
`launch-session.sh` must already know `PIPELINE_SESSION`, or the plain CLI runs the ticket instead (ADR webui-entry-point).

```bash
set -a; . ~/.config/webui-pipeline.env; set +a; unset ANTHROPIC_API_KEY
PIPELINE_SESSION=/home/cgs/npb/pipeline-ui/bin/session tools/ticket-pipeline/prepare-worktree.sh KAZ-1234
```

The console is at `http://<server>:8787/` (`PIPELINE_HOST`, `PIPELINE_PORT`) once the UI is
built with `npm run build`; without the build the service serves the API alone. `npm run dev`
serves the UI from Vite with the API proxied to a running service.

## Checks

```bash
npm run check   # tsc for the server, vue-tsc for the UI
npm test        # vitest
npm run build   # the UI into ui/dist, which the service serves
```

Node 24 runs the TypeScript directly; there is no build step for the server.
