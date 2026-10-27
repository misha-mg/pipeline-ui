# pipeline-ui

Web console for the `webui` ticket pipeline: the queue of tickets, the loop that runs them one at
a time, the run in flight with its stage, and the history of runs under `webui/.pipeline-runs/`.
What it is for and what it must do: [.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md).

Lives next to `webui`; the only thing `webui` knows about it is the `PIPELINE_SESSION` entry point
in `tools/ticket-pipeline/start.sh`.

Decisions: [.about/adr/](.about/adr/). Words: [.about/glossary.md](.about/glossary.md).

## Parts

- `server/session/` — drives one ticket's Claude Code session through the Claude Agent SDK.
  `bin/session` is the program `start.sh` runs when `PIPELINE_SESSION` names it; it prints the
  session's events (stages, rate limits, turns, the ending) as JSON lines on the file descriptor
  `PIPELINE_EVENTS_FD` names, stdout by default.
- `server/store/` — the SQLite database (`node:sqlite`): the queue, the loop's state, the runs
  the service started and their events; the Jira lookup for a queued ticket's summary.
- `server/loop/` — the loop that takes the queue's head and runs it through `run.sh`
  (`runner.ts`), records what the session reports and how the run ended, and stops itself on
  the usage limit.
- `server/cli.ts`, `bin/pipeline` — the service (`pipeline serve`) and the commands that drive
  it through the database: `enqueue`, `remove`, `reorder`, `list`, `start`, `stop`, `cancel`,
  `status`, `runs`, `events`.
- `server/history/` — every run under `.pipeline-runs/` as its files tell it (as `pipeline-tui`
  reads them), and the pull requests' states from Bitbucket, kept in the database.
- `server/health.ts` — what the console depends on: `.pipeline-runs/`, the tmux session
  `batch.sh` uses, Jira, the device mock, Bitbucket.
- `server/http/` — the JSON API (`/api/state`, `/api/runs`, `/api/runs/KEY/N`, the queue, loop
  and cancel actions) and the built UI.
- `ui/` — the console, Vue 3 + Vite: the loop and its Start/Stop, the run in flight, the queue,
  the runs with counts and filters, each run's reports, the dependencies. It polls the API
  every 2 s (the history every 10 s), so two browsers show the same within 5 s.

## Run the service

Only once `tools/ticket-pipeline/start.sh` with `PIPELINE_SESSION` is on webui's `origin/master`:
`run.sh` makes each run's worktree from there, and an older `start.sh` runs the plain CLI
instead, unwatched and to a pull request (ADR webui-entry-point).

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
`PIPELINE_TIMEOUT_HOURS` (one session, 4). The secrets file is sourced inside the run, never
printed.

## Run one session by hand

The same way the service will, from the `webui` checkout, with the pipeline's secrets loaded:

```bash
set -a; . ~/.config/webui-pipeline.env; set +a; unset ANTHROPIC_API_KEY
PIPELINE_SESSION=/home/cgs/npb/pipeline-ui/bin/session tools/ticket-pipeline/run.sh KAZ-1234
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
