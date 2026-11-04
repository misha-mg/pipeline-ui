# pipeline-ui

Web console for the `webui` ticket pipeline: the queue of tickets, the loop that runs them one at
a time, the run in flight with its stage, and the history of runs under `webui/.pipeline-runs/`.
What it is for and what it must do: [.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md).

Lives next to `webui`; the only things `webui` knows about it are the `PIPELINE_SESSION` entry
point in `tools/ticket-pipeline/launch-session.sh` and the `PIPELINE_BASE_BRANCH` a run starts
from.

How it is built: [.about/architecture.md](.about/architecture.md). Decisions:
[.about/adr/](.about/adr/). Words: [.about/glossary.md](.about/glossary.md). How to work on it:
[CLAUDE.md](CLAUDE.md).

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

The same clone as anywhere else, with the pipeline's secrets file, the `webui` checkout and
`.env` on the server, run by the systemd user units in `deploy/` (the service, and a daily
`maintain` that backs up the database and cuts the log): the whole of it, with the first runs on
a new machine and how to update, is [.about/architecture.md](.about/architecture.md), Deploy;
looking after the running service is the `operate` skill (`.claude/skills/operate/SKILL.md`).
The console listens on all interfaces by default: keep port 8787 behind a firewall, or set
`PIPELINE_HOST=127.0.0.1` and use an SSH tunnel; beyond the office network set `PIPELINE_USER`
and `PIPELINE_PASSWORD` for a login.

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
  `status`, `runs`, `events`; and `maintain` (a backup of the database, the log cut down),
  run daily by the timer in `deploy/`.
- `server/config.ts` — every setting through one zod schema into one `Config`; a bad value stops
  the start with every problem named. `server/log.ts` (the service's JSON-lines log),
  `server/format.ts` (dates and durations) and `server/http/guard.ts` are the same files as
  bug-validator's.
- `server/history/` — every run under `.pipeline-runs/` as its files tell it (as `pipeline-tui`
  reads them), the pull requests' states from Bitbucket, each merged one compared with what the
  pipeline opened (`changes.ts`, `git diff` in the webui checkout), the tickets' Jira statuses,
  all kept in the database; and the statistics' sums (`stats.ts`, shared with the console).
- `server/health.ts` — what the console depends on: `.pipeline-runs/`, the tmux session
  `batch.sh` uses, Jira.
- `server/http/` — the JSON API (`/api/state`, `/api/runs`, `/api/runs/KEY/N`, `/api/stats`,
  `/api/jira/search?q=&jql=`, the queue, loop and cancel actions), `/healthz` for a monitor, and
  the built UI; the console guard (`guard.ts`) runs first: security headers, the Host it knows,
  an action only from its own pages, the optional login, the body cap.
- `ui/` — the console, Vue 3 + Vite. The cockpit: a strip with the loop, the run in flight (its
  reports, Cancel), the next ticket and the target branch with whether pull requests are on; one
  Start or Stop button; one field that queues a ticket key at the end or the front and searches
  Jira for anything else, within a JQL while the "Within JQL" switch is on; the queue; the latest runs; the state sources folded into one lamp.
  The runs page: every run with filters and counts, and each run's reports. The statistics page:
  for the runs of a period, pull requests opened, open, merged as opened or with changes,
  declined, tickets Done in Jira or sent to Failed after the merge, why runs stopped, charts by day or week, and every pull request. A ticket key links
  to `JIRA_BASE_URL`. It polls the API
  every 2 s (the history every 10 s), so two browsers show the same within 5 s.
  Its look is the drafting sheet, light or dark (`ui/public/theme.js`): the tokens and every
  reusable part are `ui/src/sheet.css`, with the Barlow faces in `ui/public/fonts/`. The three
  are the source of truth of the design system bug-validator shares: it copies them with its
  `npm run sheet:sync`, and a test there checks the copy is current. `ui/src/style.css` only
  lays out the console's pages.

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
bin/pipeline maintain         # a backup of the database into data/backups, the log cut once past 5 MB
```

The service logs one JSON line per event (`service_start`, `run_started`, `run_ended`,
`loop_refused`, `health_changed`, …: [.about/architecture.md](.about/architecture.md), Log);
`GET /healthz` answers 200 while it runs and every state source is ok, 503 otherwise.

After a restart the service starts nothing by itself: the run it had in flight is recorded as
ended by the restart, the queue is kept, and the loop waits for `start`.

Where things are, each with a default for the server: `PIPELINE_WEBUI` (the webui checkout,
`../webui`), `PIPELINE_DATA` (database and run logs, `./data`), `PIPELINE_ENV` (the secrets file),
`PIPELINE_TIMEOUT_HOURS` (one session, 4), `PIPELINE_BASE_BRANCH` (the branch a run's worktree
starts from and its pull request goes to, `master`), `PIPELINE_PULL_REQUESTS` (`on`, `draft` or
`off`, `on`; `draft` opens every pull request as a draft, ADR draft-pull-requests); the console's
`PIPELINE_HOST`, `PIPELINE_PORT`, `PIPELINE_HOSTNAMES`, `PIPELINE_USER`, `PIPELINE_PASSWORD`;
`maintain`'s `PIPELINE_BACKUP_DIR` and `PIPELINE_LOG_FILE`. Every variable is in
[.about/architecture.md](.about/architecture.md), Configuration. `PIPELINE_LAUNCH_SESSION_REF`
and `PIPELINE_START_SH_REF`, the freeze's old workaround, stop the service from starting. The
secrets file is sourced inside the run, never printed.

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
npm run check   # tsc for the server, vue-tsc for the UI, prettier --check
npm test        # vitest
npm run build   # the UI into ui/dist, which the service serves
npm run format  # prettier --write
```

Node 24 runs the TypeScript directly; there is no build step for the server.

## License

MIT: see [LICENSE](LICENSE).
