# pipeline-ui

Web console for the `webui` ticket pipeline: the queue of tickets, the loop that runs them one at
a time, the run in flight with its stage, and the history of runs under `webui/.pipeline-runs/`.
What it is for and what it must do: [.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md).

Lives next to `webui`; the only things `webui` knows about it are the `PIPELINE_SESSION` entry
point in `tools/ticket-pipeline/launch-session.sh` and the `PIPELINE_BASE_BRANCH` a run starts
from.

Decisions: [.about/adr/](.about/adr/). Words: [.about/glossary.md](.about/glossary.md). How to
work on it: [CLAUDE.md](CLAUDE.md).

## Install

Node 24 or later (it runs the server's TypeScript directly), git, and a `webui` checkout next to
this repository (or `PIPELINE_WEBUI` pointing at one), with the pipeline's secrets file
(`~/.config/webui-pipeline.env`, or `PIPELINE_ENV`).

```bash
npm ci
cp .env.example .env   # then fill in the Jira site and credentials
npm run build          # the console, into ui/dist
npm test
bin/pipeline serve     # the console at http://<host>:8787/
```

Every machine (a laptop, the pipeline's server) is the same clone with its own `.env`; nothing
in the repository names a machine, a user or a site.

## Deploy to a server

The same clone as anywhere else, with these on the server, as the user the service runs as:

- **The pipeline's secrets file** (`~/.config/webui-pipeline.env`, or `PIPELINE_ENV`), the one
  `webui`'s pipeline reads. A run sources it again inside the run: `CLAUDE_CODE_OAUTH_TOKEN`
  signs the session in on the subscription (`ANTHROPIC_API_KEY` is dropped, so nothing is billed
  per token; ADR session-driver), and `BITBUCKET_TOKEN` also lets the runs page show each pull
  request's state. No `claude login` is needed.
- **The `webui` checkout** next to this repository (or `PIPELINE_WEBUI`), whose git can fetch
  `origin` and, when pull requests are on, push to it.
- **`.env`**, from `.env.example`: the Jira site and credentials, and the base branch. The base
  branch must have the entry point (ADR webui-entry-point); while `webui`'s `master` does not,
  set `PIPELINE_BASE_BRANCH=dev`, or the loop stops before the first run and the console says
  why.
- **Who can reach the console.** It has no password and listens on all interfaces
  (`PIPELINE_HOST`, default `0.0.0.0`): anyone who reaches port 8787 can queue tickets and start
  the loop, and every run costs a Claude session and may open a pull request. Either keep the
  port behind a firewall, or set `PIPELINE_HOST=127.0.0.1` and open the console through a
  tunnel: `ssh -L 8787:localhost:8787 <server>`.

Nothing keeps the service running after the shell that started it closes; a tmux session will
do. Do not name it `pipeline`: that is `batch.sh`'s session, and the console reads it as a batch
running (its tmux check fails). `batch.sh` and the loop never run on the same machine at
the same time.

```bash
tmux new -s pipeline-ui 'bin/pipeline serve'
```

The first runs on a new machine are best made with `PIPELINE_PULL_REQUESTS=off` in `.env`: a run
ends before its push (`blocked:tooling`) with its commits on the local ticket branch, to be
looked at before the next one. Remove the line and restart the service to let runs open pull
requests, or set it to `draft` to have every pull request opened as a draft.

To update: wait until nothing is in flight (`bin/pipeline status`, or `bin/pipeline stop` and
wait), then

```bash
git pull && npm ci && npm run build
```

and restart the service. A change to `ui/` alone needs only the build; the queue and the history
in `data/` survive a restart, and the loop waits for `start`.

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
  `batch.sh` uses, Jira.
- `server/http/` — the JSON API (`/api/state`, `/api/runs`, `/api/runs/KEY/N`,
  `/api/jira/search?q=`, the queue, loop and cancel actions) and the built UI.
- `ui/` — the console, Vue 3 + Vite. The cockpit: a strip with the loop, the run in flight (its
  reports, Cancel), the next ticket and the target branch with whether pull requests are on; one
  Start or Stop button; one field that queues a ticket key at the end or the front and searches
  Jira for anything else; the queue; the latest runs; the state sources folded into one lamp.
  The runs page: every run with filters and counts, and each run's reports. A ticket key links
  to `JIRA_BASE_URL`. It polls the API
  every 2 s (the history every 10 s), so two browsers show the same within 5 s.
  Its look is the drafting sheet, light or dark (`ui/public/theme.js`): the tokens and parts are
  `ui/src/sheet.css`, the same file as bug-validator's `src/ui/static/sheet.css` (an edit to one
  is copied to the other); `ui/src/style.css` only lays out the console's pages.

## Run the service

webui's `prepare-worktree.sh` makes each run's worktree from `origin/<base>`, the base branch
`PIPELINE_BASE_BRANCH` names (`master` by default), and hands over to that worktree's
`launch-session.sh`; the run's pull request goes to the same branch. An older launch script runs
the plain CLI instead, unwatched and to a pull request. So before every run the service fetches
origin, copies `origin/<base>`'s prepare script into `data/entry/` and checks it and the launch
script it hands over to: when either is missing, the launch script has no `PIPELINE_SESSION`, or
a base other than `master` meets a prepare script without `PIPELINE_BASE_BRANCH` (it would build
the worktree from `master` and open the pull request there), no run starts, the loop stops and
the console says why (ADR webui-entry-point).

To run from another branch, for instance while `master` is frozen or does not have the entry
point yet, name it; add `PIPELINE_PULL_REQUESTS=off` for test runs that must end before their
push (`blocked:tooling`, the commits on the local ticket branch):

```bash
PIPELINE_BASE_BRANCH=dev bin/pipeline serve
```

```bash
bin/pipeline serve            # one per database; reads ~/.config/webui-pipeline.env itself
bin/pipeline enqueue KAZ-1234 # the summary comes from Jira (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)
bin/pipeline start            # the loop takes the next ticket within a second
bin/pipeline status
bin/pipeline cancel           # the run in flight ends within 30 s and is recorded cancelled
bin/pipeline stop             # the run in flight finishes; nothing new starts
```

After a restart the service starts nothing by itself: the run it had in flight is recorded as
ended by the restart, the queue is kept, and the loop waits for `start`.

Where things are, each with a default for the server: `PIPELINE_WEBUI` (the webui checkout,
`../webui`), `PIPELINE_DATA` (database and run logs, `./data`), `PIPELINE_ENV` (the secrets file),
`PIPELINE_TIMEOUT_HOURS` (one session, 4), `PIPELINE_BASE_BRANCH` (the branch a run's worktree
starts from and its pull request goes to, `master`), `PIPELINE_PULL_REQUESTS` (`on`, `draft` or
`off`, `on`; `draft` opens every pull request as a draft, ADR draft-pull-requests). `PIPELINE_LAUNCH_SESSION_REF` and `PIPELINE_START_SH_REF`, the freeze's old workaround,
stop the service from starting. The secrets file is sourced inside the run, never printed.

pipeline-ui's own secrets go in `.env` at the repository's root (gitignored; `.env.example`
names them), read by `bin/pipeline` after the pipeline's file, so its values win: `JIRA_EMAIL`
and `JIRA_API_TOKEN` for the summary lookup and the ticket search, and any of the settings above
that stay with a machine, such as `PIPELINE_PULL_REQUESTS=off` on one that only makes test runs.
`JIRA_BASE_URL` is the Jira site (`https://<site>.atlassian.net`): it has no default, and without
it, or without the credentials, tickets are queued by key alone, the search is off and keys are
not linked.
Each machine keeps its own.

## Run one session by hand

The same way the service does, from the `webui` checkout, with the pipeline's secrets loaded.
Mind that `prepare-worktree.sh` builds the worktree from `origin/$PIPELINE_BASE_BRANCH`
(`master` when unset): the worktree's `launch-session.sh` must already know `PIPELINE_SESSION`,
or the plain CLI runs the ticket instead (ADR webui-entry-point).

```bash
set -a; . ~/.config/webui-pipeline.env; set +a; unset ANTHROPIC_API_KEY
PIPELINE_BASE_BRANCH=dev PIPELINE_SESSION=/path/to/pipeline-ui/bin/session tools/ticket-pipeline/prepare-worktree.sh KAZ-1234
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

## License

MIT: see [LICENSE](LICENSE).
