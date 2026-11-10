# The run settings are changed from the console, over the environment's defaults

Date: 2026-11-10

## Context

The base branch a run starts from and its pull request goes to, whether a run may open its pull
request (or only a draft) and a session's time limit were the environment's alone
(`PIPELINE_BASE_BRANCH`, `PIPELINE_PULL_REQUESTS`, `PIPELINE_TIMEOUT_HOURS`): to change one, the
operator edited `.env` on the server and restarted the service, which can be done only while
nothing is in flight and stops the loop. They are the operator's everyday choices, not the
machine's: a freeze moves the base to `dev` and back, a first run on a new branch is made with
drafts only, a long ticket wants more hours.

## Decision

The three are the **run settings** (`server/store/settings.ts`). The environment gives each its
default; the console's cockpit (the Target branch card, Settings) and the command line
(`pipeline set base-branch|pull-requests|timeout-hours VALUE`, `pipeline settings`) set another,
kept in the database's `settings` table (migration 2), one row per setting that differs from its
default. A setting put back to its default is forgotten rather than kept, so a later change of
the environment shows again, and the console says for each which it is.

The service reads them when it needs them, never once at start: the preflight checks the entry
point on the branch of that moment, and the runner asks for its settings when a run starts
(`createRunner` takes a function). A change is therefore for the next run; the run in flight
keeps the branch, the pull requests and the time limit it started with, and nothing is restarted.

A branch is kept only when a run could start from it. `PUT /api/settings` (and `pipeline set`)
runs the entry point's check on it first (`checkEntry`: a fetch of origin, the branch, its
`prepare-worktree.sh`, the launch script with `PIPELINE_SESSION`), and answers with the check's
own words when it fails, so the dialog says "origin has no branch x" where the person is
looking instead of the loop refusing its next run. That check writes nothing: the copy of the
prepare script is written by the preflight alone, when nothing is in flight, since a run in
flight may be reading it. A branch name is also refused unless it is one git takes and nothing
a command line could read as an option. The console's field is a select of origin's branches
(`GET /api/branches`, which fetches first, so a branch pushed a minute ago is there, and falls
back to the last fetch when origin cannot be reached): the branches in use first (the current
one, the default), then every other by name. `pipeline set` takes any name.

Every change is a `settings_changed` event in the service's log with what changed.

## Considered options

- **Rewrite `.env` from the console** — one place for a setting, but the service would write a
  file that holds secrets, a change would still need a restart, and a unit's `Environment=`
  would win over it in silence.
- **Keep every value set in the console, the default's included** — simpler to write, but the
  environment would stop meaning anything after the first Save, without a word.
- **Per-ticket settings in the queue** (this ticket into `dev`, that one as a draft) — more than
  the operator asked for; the queue's rows and the run's record would both grow. The settings
  are the service's, for whatever runs next.
- **More settings in the dialog** (the webui checkout, the data directory, the console's
  address, the login, Jira) — they are the machine's, read once, and a wrong one stops the
  service; they stay in the environment.

## Consequences

- `service_start` logs the settings in force, and `pipeline status` prints them with their
  source; `.env` is no longer the whole answer to "which branch do runs go to".
- A database from before gets the `settings` table at the next start (or the next command), with
  a copy made first.
- The old service's code does not serve `PUT /api/settings`: the console shows Settings only
  once the service that runs is one that sends the defaults.
