# pipeline-ui

A service and a web console for the `webui` ticket pipeline: the queue, the loop that runs one
ticket at a time, the run in flight, the run history. Start with [README.md](README.md), then
[.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md) (what it must do),
[.about/architecture.md](.about/architecture.md) (how it is built, the log's events, every
setting, deploy) and [.about/adr/](.about/adr/) (why it is built this way). Words follow
[.about/glossary.md](.about/glossary.md): run, queue, loop, in flight, verdict, ending, entry
point, base branch, sheet, console guard, heartbeat. Not "attempt", "job", "Pick", "Minion",
"Foreman". pipeline-ui and bug-validator are one product line (ADR unification): the same
layout, scripts, formats, log, guard and look.

## Checks

Before every commit, all three:

```bash
npm run check   # tsc for the server, vue-tsc for the UI, prettier --check .
npm test        # vitest, no network, no real webui
npm run build   # the UI into ui/dist
```

One test file: `npx vitest run server/store/jira.test.ts`. `npm run format` (prettier) before
`check` when a file was edited by hand.

Node 24 runs the server's TypeScript as it is (type stripping): only erasable syntax, `.ts` in
import paths, no enums or parameter properties (`tsconfig.json` enforces it, with
`exactOptionalPropertyTypes`: an optional property that may be set to `undefined` says so).

## Conventions

- Code, comments, commit messages and every file in the repository are in English.
- Commits follow Conventional Commits (`feat(ui):`, `fix(loop):`, `refactor(loop):`, `docs:`,
  `style:`, `chore:`); the subject says what changes for the operator, the body why. No AI
  attribution lines: no `Co-Authored-By` trailer and no "Generated with" line, whatever a tool
  suggests.
- Each file opens with a comment that says what it is for; comments explain why, not what.
- Prettier formats everything (`.prettierrc.json`: no semicolons, single quotes, width 140),
  `.vue` files included; `npm run check` fails on an unformatted file.
- No machine-specific values in the repository: no home paths, user names, hosts or the Jira
  site. Every setting comes from the environment through the one zod schema in
  `server/config.ts` into `Config`; no other module reads `process.env` for a setting (the run's
  own environment in `runner.ts` is the one exception). The run settings (the base branch, the
  pull requests, a session's hours) take their defaults from there and may be set in the
  console: read them through `server/store/settings.ts` when a run starts, never from `Config`.
  Everything of this project's own is a `PIPELINE_*` variable; the Jira names (`JIRA_*`) are the
  same as bug-validator's; each machine sets them in its `.env` (see `.env.example`).
- Three files are the same in both repositories and are copied verbatim, never adapted:
  `server/format.ts` (every date, duration and "ago" the console shows goes through it),
  `server/log.ts` (the service's log: `log.info|warn|error(event, fields)`, snake_case events,
  documented in `.about/architecture.md`) and `server/http/guard.ts`.
- The UI imports the API's types from the server (`ui/src/api.ts` from `server/http/view.ts`
  and `server/store/jira.ts`): changing a view's shape is a change on both sides, and
  `npm run check` catches the side left behind.
- The database's schema is versioned (`PRAGMA user_version`, `MIGRATIONS` in `server/store/db.ts`):
  a change to a table is a new migration appended to the list, never an edit of an old one or
  an ad-hoc `ALTER` elsewhere.
- A behaviour change updates the PRD (what), an ADR (a decision and its reasons, dated) or the
  glossary (a new word) in the same commit, the README when running it changes, and
  `.about/architecture.md` when a module, a log event or a setting changes.
- Tests sit next to the code (`*.test.ts`), use an in-memory database and fakes for git, Jira,
  Bitbucket and the runner; nothing in a test reaches the network or a real `webui` checkout.

## Boundaries

- `webui` (`PIPELINE_WEBUI`, `../webui` by default) is read-only from here. Never commit, push
  or change branches there, and never touch its `master`. The service's only contract with it
  is the entry point: `PIPELINE_SESSION` in `launch-session.sh` and `PIPELINE_BASE_BRANCH` in
  `prepare-worktree.sh` (ADR webui-entry-point). `batch.sh` and `pipeline-tui` are not changed.
- Jira and Bitbucket are only read. Jira goes through `server/store/jira.ts`, by
  `api.atlassian.com/ex/jira/<cloudId>`: the token is a scoped one, and the site's own URL
  answers 401/404 to it. A 404 there is not a wrong key.
- `ui/src/sheet.css`, `ui/public/theme.js` and `ui/public/fonts/` are the design system (the
  sheet) shared with bug-validator, and this repository is its source of truth: bug-validator
  copies the three with its `npm run sheet:sync`, and a test there fails when its copy falls
  behind. Every reusable part (cards, the strip, filters, bars, the column chart, toasts, the
  confirmation dialog) goes in the sheet; only the console's own layout goes in
  `ui/src/style.css`.
- Never print the secrets files (`~/.config/webui-pipeline.env`, `.env`) or an unfiltered `env`.
- Never install or enable the units in `deploy/` from here; the operator does that on the server.

## The running service

`bin/pipeline serve` is the operator's own process (under `deploy/pipeline-ui.service`, or a
tmux session), with the queue and history in `data/` (gitignored) and its log in
`data/serve.log`, one JSON line per event. A real run costs a Claude session and may end in a
pull request, so:

- never start the loop or queue a ticket on the operator's service unless asked;
- a change to `server/` needs the service restarted to take effect: only when nothing is in
  flight (`bin/pipeline status`), and with the same settings it ran with (`/proc/<pid>/environ`
  shows them; most live in `.env`); the `operate` skill has the whole of it;
- a change to `ui/` needs only `npm run build`; the service serves `ui/dist` as it is;
- `GET /healthz` says whether it runs and its state sources are ok; `pipeline maintain` (the
  daily timer) backs the database up into `data/backups/` and cuts the log once past 5 MB; a
  migration at start copies the database first (`data/pipeline.db.before-v<N>-<time>`).
