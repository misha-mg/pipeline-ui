# One product line: pipeline-ui and bug-validator read, run and are operated the same way

Date: 2026-11-04

pipeline-ui and bug-validator are two services of one author for one team: each a small Node
24 program with a SQLite file, a web console on the office network, Jira read through the same
scoped token, a systemd unit on the same kind of server. They had grown apart in the small
things: two date formats, two logs (free text here, JSON lines there), two ways to read the
environment, one console guarded and one not, one schema versioned and one patched by ad-hoc
ALTERs, one design system kept as two copies edited by hand. A person walking between the two
read different words for the same thing and operated them by different habits. This decision
makes them one line; the conventions themselves were decided for both at once and are not
re-argued here.

## The sheet has one source of truth

`ui/src/sheet.css`, `ui/public/theme.js` and `ui/public/fonts/` (Barlow, OFL) are the design
system both consoles draw with, and this repository holds the original. bug-validator copies
the three with its `npm run sheet:sync`, and a test there fails when its copy falls behind; an
edit is made here, never in the copy. Every reusable part is the sheet's: the cards (compact by
default), the strip (six cells, eight with `.eight`), the switch, the filters with their family
groups (`.group.ok`, `.group.bad`), bars, the column chart (whose SVG markup is a documented
contract, so bug-validator renders the same chart on the server), lamps and the pulse, the live
row, the state sources, the reason, the confirmation dialog (`dialog.confirm`), toasts, one
`--radius` token, the chart colour tokens, the fonts as `@font-face` over `/fonts/` (the
fontsource packages are gone). (The sheet's look changed since: ADR glass-kit, 2026-11-06.) Frames lost their corner crosses: this console had them off
already, and the two must look the same. `ui/src/style.css` lays out this console's pages and
nothing else. Cancelling the run in flight asks first through that dialog, as bug-validator's
"Post to Jira" does: both cannot be taken back. Removing a queued ticket does not ask.

## Three modules are the same file in both repositories

`server/format.ts` (dates `2026-11-04 23:10`, durations `5m 03s` and `2d 04h`, `5m 03s ago`),
`server/log.ts` (`log.info|warn|error(event, fields)`, one JSON line per event, `describeError`,
`parseLogLine`) and `server/http/guard.ts` (security headers, the Host check, same origin for
actions, optional basic auth, the body cap) are copied verbatim between the two. A change to one
is a change to both, by hand, with the same commit in each; they have no project-specific code
and no Node import a browser bundle cannot take (`format.ts` is bundled into the console).

## The console is guarded, and may ask for a login

The PRD's non-goal stands: the network is the fence. But a console reachable from any page on
that network could be turned against its visitors, so the guard runs before anything is served:
the security headers on every answer (a CSP that allows the console's own scripts and inline
style attributes, which Vue sets), a Host the console does not know refused with 421, an action
(any non-GET `/api` request) from another site's page refused with 403, a body over 64 KB with
413. When `PIPELINE_USER` and `PIPELINE_PASSWORD` are set, every page but `/healthz` asks for
the login; unset, nothing changes. `GET /healthz` answers 200 while the service's heartbeat is
fresh and every state source checked so far is ok, 503 otherwise, for a monitor and the units.

## The service's log is JSON lines; the settings go through one schema

The service logs snake_case events with fields (architecture.md, Log) through `log.ts`, so a
line can be read back by a program and the two logs read the same; the commands keep printing
text for a person. Every setting is read once through one zod schema in `server/config.ts`,
failing fast with every bad value named; the Jira and Bitbucket settings and the console's
(`PIPELINE_HOSTNAMES`, `PIPELINE_USER`, `PIPELINE_PASSWORD`, `PIPELINE_BACKUP_DIR`,
`PIPELINE_LOG_FILE`) are in the `Config` too, and no module reads `process.env` for a setting
any more (the run's own environment, passed through as the pipeline's secrets file gives it,
is the one exception). Everything of this project's own carries the `PIPELINE_` prefix; the
Jira names are the same in both projects.

## The schema is versioned; `maintain` keeps the file safe

`PRAGMA user_version` counts the migrations a database has had and `MIGRATIONS` in
`store/db.ts` lists them in order; migration 1 is every table as it was when the versions began,
with the columns earlier databases got by ad-hoc ALTERs, so a database from before comes to
version 1 with only what it lacks. Before a migration runs on a file, a copy is made next to it
(`<db>.before-v<N>-<time>`), and the service logs `migration`. `pipeline maintain`, run daily by
a systemd timer, copies the database (SQLite's `VACUUM INTO`) into `PIPELINE_BACKUP_DIR`, keeps
the latest 14, and cuts the service's log once past 5 MB by copying it to `.1` and emptying it
in place, so the unit that appends to it never notices.

## systemd units, prettier, the conventions

`deploy/` holds user units like bug-validator's: the service (`TZ=Europe/Warsaw`, 5 starts in
10 minutes at most, 60 s for a stop since the run in flight is ended as `restart`,
`NoNewPrivileges`, the log appended to `data/serve.log`) and the daily maintain service with
its timer; tmux stays as a one-line alternative. Prettier formats everything with the same
`.prettierrc.json` as bug-validator (no semicolons, single quotes, width 140), and
`npm run check` ends with `prettier --check .`; the formatting of the existing code was its own
commit. Both `tsconfig.json`s have `exactOptionalPropertyTypes` and `noImplicitOverride`. The
npm scripts have the same names in both (`start`, `check`, `test`, `format`, `build`); the
layout is the same (`bin/`, `server/`, `ui/`, `deploy/`, `.about/`, `.claude/skills/`);
commits, comments and file headers follow the same rules (CLAUDE.md).

## The tools' frame (2026-11-11)

The team's other tools (the `tools` repository, served from one server behind a start page, the
portal) are framed alike: the logo in the header leads to the start page ("All tools"), and a
footer names the build, `Build v1.4.2 (commit)`, the version counted from the tool's commits by
its `scripts/version.sh` (a `feat` the minor, a breaking commit the major, any other the patch;
nothing tagged). The two consoles are tools of the same team kept in repositories of their own,
so they take the same frame:

- **The mark leads to the start page** where `PIPELINE_PORTAL_URL` names one (bug-validator:
  `VALIDATOR_PORTAL_URL`): an `a.home` before the name, which still leads to the cockpit. Unset,
  nothing changes: the address is a deployment's, and a console opened from outside the office
  network cannot reach the portal, so no address is written into the code.
- **The foot names the build**: the version by the same `scripts/version.sh`, the commit, a `+`
  when the working tree has moved on from it, the commit a link where origin is GitHub or
  Bitbucket (a login in the remote's address is never passed on). `server/version.ts` reads it
  once when the process starts, since a service runs the code it was started with; the service
  logs it in `service_start` and sends it with the state. It is the fourth file the two
  repositories keep byte for byte the same.
- **Both are the sheet's parts** (`.masthead .home`, `.foot`), so the two consoles draw them alike.

Not taken: the tools' copyright line (pipeline-ui is under the MIT licence, and "all rights
reserved" would contradict it; the line is the owner's to decide), their full logo (the sheet
keeps its square mark) and their palette.

## Why

Two products of one line should read, run and be operated the same way: the same words on the
screen, the same log to grep, the same `.env` shape, the same units to restart, the same place
to look when something is wrong. Every difference that was not a difference of purpose cost the
person moving between them a moment of translation, and a design edit twice. One source of
truth for the sheet and three identical modules keep the two from drifting apart again.
