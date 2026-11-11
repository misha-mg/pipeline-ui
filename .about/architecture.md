# Architecture

A small long-running service and a web console. The service owns the queue, starts one run at a
time through webui's own pipeline scripts, drives the ticket's Claude Code session through the
Agent SDK, records what the session reports and how the run ended, and reads the history every
run leaves under `webui/.pipeline-runs/`. The console shows all of it and takes the operator's
actions. Why things are as they are: `prd/pipeline-web-ui.md` and `adr/`. The words: `glossary.md`.

## Layers

```
bin/
  pipeline               the service and its commands (sources the pipeline's secrets file and .env, execs server/cli.ts)
  session                the session program webui's launch-session.sh runs (PIPELINE_SESSION): server/session/main.ts
server/
  cli.ts                 serve | enqueue | remove | reorder | list | start | stop | cancel | status | runs | events | maintain
  config.ts              env → typed Config through one zod schema; fails fast naming every bad value
  log.ts                 one JSON line per event on stdout (the same file as bug-validator's)
  format.ts              dates, clocks, durations, "ago" as both consoles write them (the same file as bug-validator's)
  service.ts             the service process: the heartbeat, the loop's tick, the background round, the HTTP server, the stop
  health.ts              the state sources: .pipeline-runs/, the tmux session batch.sh uses, Jira
  maintain.ts            a backup of the database (the latest 14 kept), the log cut down once past 5 MB
  store/
    db.ts                the SQLite file (node:sqlite): the versioned schema, MIGRATIONS, a copy before a migration
    queue.ts             the queue: add (with the summary and the labels from Jira), remove, reorder
    runs.ts              the runs the service started, their events and preparation steps, the loop's state, the heartbeat
    settings.ts          the run settings (base branch, pull requests, a session's hours): the environment's defaults, what the console set over them
    jira.ts              Jira REST v3 through api.atlassian.com: a ticket's summary, the search (within a JQL), the statuses; read only
  loop/
    loop.ts              one tick: take the queue's head when nothing is in flight, record events, the ending, stop on the usage limit
    entry.ts             the entry point checked before every run: prepare-worktree.sh and launch-session.sh from origin/<base>
    runner.ts            starts prepare-worktree.sh as batch.sh does, with bin/session as the session program, an events pipe and the script's trace
    preparation.ts       the preparation's steps (git fetch, worktree, npm ci, sandbox check, mock reset, session start) from that trace
    runfiles.ts          the run directory a run made, its verdict and summary
  session/
    main.ts              the session program: argv from launch-session.sh, events as JSON lines on PIPELINE_EVENTS_FD
    driver.ts            drives the session through the Agent SDK: stages from the hooks, rate limits, turns, one ending
    transcript.ts        what an agent handed back, read from its transcript (StructuredOutput)
  history/
    runs.ts              every run under .pipeline-runs/ as its files tell it (as pipeline-tui reads them)
    outcome.ts           the words and tones of a verdict, an ending, a stage (the console imports it too)
    bitbucket.ts         the pull requests' states from Bitbucket, each merged one compared with what the pipeline opened
    changes.ts           the patch pushed against the patch merged, both from the webui checkout (git diff)
    tickets.ts           the tickets' Jira statuses and their moves, for the statistics
    stats.ts             the statistics' sums for one period (the console imports it too)
  http/
    api.ts               the JSON API under /api, /healthz, the built UI; applies the guard
    guard.ts             security headers, the Host check, same origin for actions, optional login, the body cap (the same file as bug-validator's)
    view.ts              the state, the history, one run, the statistics, assembled from the sources
ui/
  index.html, public/    the page, theme.js (light or dark before the first paint), fonts/ (Inter, JetBrains Mono; OFL)
  src/sheet.css          the sheet: the CGS Glass kit's tokens and parts, the design system both consoles share; its source of truth
  src/style.css          the console's own layout: the cockpit grid, the queue, the run diagram, the statistics' grids
  src/api.ts             the API's types from the server, the calls, the outcome words and the formats re-exported
  src/console.ts         the polled state and history, the actions, the notifications of what changed
  src/search.ts          the ticket search and the JQL it is made within
  src/toasts.ts          the notifications' stack
  src/views/             Cockpit, RunsView, RunView, Statistics
  src/components/        Frame, Columns (the column chart), Toasts
deploy/                  systemd user units: the service, the daily maintain service and its timer
```

Node 24 runs the server's TypeScript as it is; the UI is built with Vite into `ui/dist`, which
the service serves. The console imports the server's types and three pure modules
(`outcome.ts`, `stats.ts`, `format.ts`): a change of a view's shape is a type error on both
sides.

## Data flow

1. **A ticket is queued** (the console's field or `pipeline enqueue`): `store/queue.ts` asks
   Jira for its summary (`store/jira.ts`) and writes the row. Every command writes the database
   and returns; the service's loop acts on it within a second.
2. **The loop takes it** (`loop/loop.ts`, ticked every second by `service.ts`): when the loop is
   wanted running and nothing is in flight, the preflight (`loop/entry.ts`) fetches origin,
   copies `origin/<base>`'s `prepare-worktree.sh` into `data/entry/` and checks that the launch
   script it hands over to knows `PIPELINE_SESSION`; refused, the loop stops and says why.
3. **The run** (`loop/runner.ts`): `prepare-worktree.sh KEY` as `batch.sh` runs it, with the
   pipeline's secrets sourced inside the child, `bin/session` named as the session program and
   a pipe on file descriptor 3 for the session's events. The prepare script runs under `bash -x`
   with its trace on descriptor 4 (`BASH_XTRACEFD`): each command it runs arrives as a line when
   it starts, and `loop/preparation.ts` takes the preparation's steps from a few of them into
   `run_steps`, until the session's first event ends the last one (ADR preparation-steps). The
   run's log gets a `[service] preparing: <step>` line for each. `launch-session.sh` builds the
   prompt and the settings and runs `bin/session`.
4. **The session** (`session/driver.ts`): the Agent SDK drives Claude Code in the worktree; the
   SubagentStart/Stop hooks give the stages, rate-limit events the usage limit, the result the
   ending. Each event goes down the pipe as a JSON line; `loop.ts` records it in `run_events`
   and keeps the run's stage current.
5. **The ending**: the session's last result (`completed`, `usage-limit`, `error`), or the
   service's own word (`cancelled`, `timeout`, `restart`, `exited`, `no-result`). The run's
   directory under `.pipeline-runs/` gives the verdict (`state.md`) and the reports. On the usage
   limit the loop stops itself.
6. **The history** (`history/runs.ts`): every run directory, the service's or older, read from
   its files; the pull requests' states (`history/bitbucket.ts`) and the tickets' statuses
   (`history/tickets.ts`) refreshed by the service's background round once a minute and kept in
   the database; the statistics (`history/stats.ts`) summed from them.
7. **The console** polls `/api/state` every 2 s and `/api/runs` every 10 s; an action is a POST
   that writes the database and ticks the loop at once. The run settings (`store/settings.ts`:
   the base branch, the pull requests, a session's hours) are changed with `PUT /api/settings`,
   which checks a new branch's entry point first; the preflight and the runner read them when
   a run starts, so a change is for the next run. Two browsers show the same within 5 s.

## Log

The service writes one JSON line per event on stdout (`log.ts`): `ts`, `level`, `event`, then
the event's fields. Under the unit the lines go to `data/serve.log`; `maintain` cuts the file
once it is past 5 MB. The commands print text for a person.

| event | level | fields |
|---|---|---|
| `service_start` | info | pid, version, commit (the code it runs, `+` after a commit the tree moved on from), db, webui, entry, baseBranch, pullRequests, timeoutHours (the run settings in force), loop (`stopped`: nothing resumes by itself) |
| `settings_changed` | info | the run settings that changed, each with its new value: baseBranch, pullRequests, timeoutHours |
| `migration` | info | db, from, to (schema versions), copy (the file copied before, null for a new database) |
| `console_listening` | info | url, ui (false: the UI is not built, the API alone is served), note |
| `run_started` | info | runId, key, summary |
| `run_ended` | info | runId, key, ending, verdict, runDir; `warn` with ending `restart` and a note for a run that was in flight when the service last stopped |
| `loop_refused` | error | why: the entry point refused the run; the loop stopped, the ticket stays queued |
| `health_changed` | info / warn | ok; problems (each source not ok with its detail), only when the state changes |
| `pull_requests_read` | info | count: pull requests whose state was read from Bitbucket |
| `pull_requests_compared` | info | count: merged pull requests compared with what the pipeline opened |
| `ticket_statuses` | info / warn | ok, count; error, when Jira could not be read (said once per change) |
| `round_failed` | error | error: the background round threw |
| `service_stopping` | info | signal, inFlight (the run's id), ending (`restart`) |
| `service_stopped` | info | pid |
| `fatal` | error | error (and command for `maintain`): the service could not start, a bad setting included |
| `backup` | info | file, bytes, removed (older backups beyond the 14 kept); from `maintain` |
| `log_cut`, `log_cut_skipped` | info / warn | file, bytes, keptAs; or reason (the service wrote to the log between the copy and the cut) |

`/healthz` answers `{ ok, state, loop, inFlight, health }`: 200 while the service's heartbeat
is fresh (written every second to the `service` row) and every state source checked so far is
ok, 503 otherwise. It needs no login.

## Configuration

Every setting is read once at start through one zod schema (`server/config.ts`) into one
`Config`; a bad value stops the process with every problem named. `bin/pipeline` sources the
pipeline's secrets file (`PIPELINE_ENV`) and then the repository's `.env`, whose values win; the
service loads `.env` itself too, a variable already set winning. Nothing in the repository names
a machine, a user or a site. Three of them are only defaults: the run settings (the base branch,
the pull requests, a session's hours) can be set from the console or with `pipeline set`, are
kept in the database and win over the environment until they are put back (ADR run-settings).

| variable | default | meaning |
|---|---|---|
| `PIPELINE_WEBUI` | `../webui` | the webui checkout a run starts in; read-only from here |
| `PIPELINE_DATA` | `./data` | the database (`pipeline.db`), the run logs, the entry point's copy, the backups, `serve.log` |
| `PIPELINE_ENV` | `~/.config/webui-pipeline.env` | the pipeline's secrets file, sourced inside each run; never printed |
| `PIPELINE_TIMEOUT_HOURS` | `4` | one session at most; a run setting's default (below) |
| `PIPELINE_BASE_BRANCH` | `master` | the webui branch a run's worktree starts from and its pull request goes to; must have the entry point; a run setting's default |
| `PIPELINE_PULL_REQUESTS` | `on` | `off`: a run ends before its push; `draft`: every pull request opens as a draft; a run setting's default |
| `PIPELINE_HOST`, `PIPELINE_PORT` | `0.0.0.0`, `8787` | the console's address |
| `PIPELINE_PORTAL_URL` | — | the start page the mark in the masthead leads to (the tools' portal, "All tools"); unset, the mark is part of the name and leads to the cockpit |
| `PIPELINE_HOSTNAMES` | — | names the console may be opened by, comma-separated, besides IP addresses, localhost and the machine's name |
| `PIPELINE_USER`, `PIPELINE_PASSWORD` | — | both set: every page asks for this login (`/healthz` does not) |
| `PIPELINE_BACKUP_DIR` | `<data>/backups` | `maintain`'s copies of the database, the latest 14 kept |
| `PIPELINE_LOG_FILE` | `<data>/serve.log` | the service's log as the unit appends it; `maintain` cuts it |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | — | the site with its scheme and a scoped API token; without all three tickets are queued by key alone, the search is off and keys are not linked |
| `JIRA_CLOUD_ID` | read from the site | every REST request goes through `api.atlassian.com/ex/jira/<id>` |
| `BITBUCKET_TOKEN` | — | the pull requests' states; usually in the pipeline's secrets file |

`PIPELINE_LAUNCH_SESSION_REF` and `PIPELINE_START_SH_REF`, the code freeze's old workaround, are
refused. The console's poll intervals, the heartbeat's freshness (5 s), the body cap (64 KB),
the backups kept (14) and the log's size before the cut (5 MB) are constants in the code.

## Running

```
npm ci
cp .env.example .env                 # the Jira site and credentials; chmod 600
npm run build                        # the console into ui/dist
bin/pipeline serve                   # the service and the console at http://<host>:8787/
bin/pipeline enqueue KAZ-1234        # the summary comes from Jira
bin/pipeline start                   # the loop takes the next ticket within a second
bin/pipeline status
bin/pipeline cancel                  # the run in flight ends within 30 s and is recorded cancelled
bin/pipeline stop                    # the run in flight finishes; nothing new starts
bin/pipeline maintain                # a backup of the database, the log cut down to size
npm run check && npm test            # tsc, vue-tsc, prettier; vitest
```

A change to `server/` needs the service restarted, only when nothing is in flight; a change to
`ui/` needs only `npm run build`, the service serves `ui/dist` as it is. After a restart the
service starts nothing by itself: the run it had in flight is recorded as ended by the restart,
the queue is kept, the loop waits for `start`. `npm run dev` serves the UI from Vite with the
API proxied to a running service.

### The console's pages

- **Cockpit** (`#/`): four cards (the loop, the run in flight with its stage and Cancel, the
  next ticket, the target branch with whether pull requests are on), Start or Stop, the field
  that queues a key or searches Jira (within a JQL while the switch is on), the queue, the
  latest runs, the state sources folded into one lamp. Cancel asks first through the sheet's
  confirmation dialog; removing a queued ticket does not, it can be queued again.
- **Runs** (`#/runs`): every run with filters by verdict (by family or one verdict) and ending,
  a strip of what the runs shown add up to, each run's pull request and its state. A run
  (`#/runs/KEY/N`) is a diagram of its steps; choosing one shows its report.
- **Statistics** (`#/stats`): for the runs of a period, the pull requests and what became of
  them, the tickets' Jira statuses, why runs stopped, charts by day or week, every pull request.
- The look is the sheet (`ui/src/sheet.css`, `ui/public/theme.js`, `ui/public/fonts/`): the CGS
  Glass kit's tokens and parts (ADR glass-kit), the design system shared with bug-validator and
  kept here as its source of truth (ADR unification).

### Deploy

systemd user units (`deploy/`): `pipeline-ui.service` (the service and the console),
`pipeline-ui-maintain.service` with `pipeline-ui-maintain.timer` (daily at 04:30). Machine-specific
in each: `WorkingDirectory` (the clone, `%h/npb/pipeline-ui`) and the node path in `PATH` (claude
is installed under that node; `PATH` must also hold git and tmux). The units set
`TZ=Europe/Warsaw`, give up after 5 failed starts in 10 minutes, give a stop 60 s (the run in
flight is ended as `restart`: its session is told to end and has up to 30 s), and append the
service's log to `data/serve.log`. On the server, as the user the service runs as:

- the pipeline's secrets file (`~/.config/webui-pipeline.env`, or `PIPELINE_ENV`), the one
  webui's pipeline reads: `CLAUDE_CODE_OAUTH_TOKEN` signs the session in on the subscription
  (`ANTHROPIC_API_KEY` is dropped, so nothing is billed per token; ADR session-driver) and
  `BITBUCKET_TOKEN` lets the console show each pull request's state; no `claude login` is needed;
- the webui checkout next to this repository (or `PIPELINE_WEBUI`), whose git can fetch `origin`
  and, with pull requests on, push to it;
- `.env` from `.env.example`: the Jira site and credentials, the base branch (it must have the
  entry point: `PIPELINE_BASE_BRANCH=dev` while webui's `master` does not), and who can reach the
  console. It listens on all interfaces by default: anyone who reaches port 8787 can queue
  tickets and start the loop, and every run costs a Claude session and may open a pull request.
  Keep the port behind a firewall, or set `PIPELINE_HOST=127.0.0.1` and open the console through
  `ssh -L 8787:localhost:8787 <server>`; beyond the office network, set `PIPELINE_USER` and
  `PIPELINE_PASSWORD` for a login and `PIPELINE_HOSTNAMES` for the name it is opened by.

```
mkdir -p ~/.config/systemd/user && cp deploy/pipeline-ui*.service deploy/pipeline-ui-maintain.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pipeline-ui pipeline-ui-maintain.timer
loginctl enable-linger $USER                  # survive logout
systemctl --user status pipeline-ui
tail -f data/serve.log                        # one JSON line per event
curl -s http://127.0.0.1:8787/healthz
journalctl --user -u pipeline-ui-maintain     # backup, log_cut
```

Without systemd, a tmux session does (`tmux new -s pipeline-ui 'bin/pipeline serve'`), but not
one named `pipeline`: that is `batch.sh`'s session, and the console reads it as a batch running.
`batch.sh` and the loop never run on the same machine at the same time.

The first runs on a new machine are best made with `PIPELINE_PULL_REQUESTS=off`: a run ends
before its push (`blocked:tooling`) with its commits on the local ticket branch, to be looked
at before the next one. To update: wait until nothing is in flight (`bin/pipeline status`, or
`bin/pipeline stop` and wait), then `git pull && npm ci && npm run build` and
`systemctl --user restart pipeline-ui`. A migration runs at the start, after a copy of the
database next to it (`data/pipeline.db.before-v<N>-<time>`), and is logged as `migration`. The
queue and the history in `data/` survive a restart.
