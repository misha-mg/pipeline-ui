# pipeline-ui

A service and a web console for the `webui` ticket pipeline: the queue, the loop that runs one
ticket at a time, the run in flight, the run history. Start with [README.md](README.md), then
[.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md) (what it must do) and
[.about/adr/](.about/adr/) (why it is built this way). Words follow
[.about/glossary.md](.about/glossary.md): run, queue, loop, in flight, verdict, ending, entry
point, base branch. Not "attempt", "job", "Pick", "Minion", "Foreman".

## Checks

Before every commit, all three:

```bash
npm run check   # tsc for the server, vue-tsc for the UI
npm test        # vitest, no network, no real webui
npm run build   # the UI into ui/dist
```

One test file: `npx vitest run server/store/jira.test.ts`.

Node 24 runs the server's TypeScript as it is (type stripping): only erasable syntax, `.ts` in
import paths, no enums or parameter properties (`tsconfig.json` enforces it).

## Conventions

- Code, comments, commit messages and every file in the repository are in English.
- Commits follow Conventional Commits (`feat(ui):`, `fix(loop):`, `refactor(loop):`, `docs:`);
  the subject says what changes for the operator, the body why. No AI attribution lines: no
  `Co-Authored-By` trailer and no "Generated with" line, whatever a tool suggests.
- Each file opens with a comment that says what it is for; comments explain why, not what.
- No machine-specific values in the repository: no home paths, user names, hosts or the Jira
  site. They come from the environment, read in `server/config.ts` (the `PIPELINE_*` settings)
  and `server/store/jira.ts` (`JIRA_*`), set in each machine's `.env` (see `.env.example`); the
  same clone runs on a laptop and on the pipeline's server.
- The UI imports the API's types from the server (`ui/src/api.ts` from `server/http/view.ts`
  and `server/store/jira.ts`): changing a view's shape is a change on both sides, and
  `npm run check` catches the side left behind.
- A behaviour change updates the PRD (what), an ADR (a decision and its reasons, dated) or the
  glossary (a new word) in the same commit, and the README when running it changes.
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
- `ui/src/sheet.css` is the design system shared with bug-validator (its
  `src/ui/static/sheet.css`): an edit to one is copied to the other. The console's own layout
  goes in `ui/src/style.css`.
- Never print the secrets files (`~/.config/webui-pipeline.env`, `.env`) or an unfiltered `env`.

## The running service

`bin/pipeline serve` is the operator's own process, with the queue and history in `data/`
(gitignored). A real run costs a Claude session and may end in a pull request, so:

- never start the loop or queue a ticket on the operator's service unless asked;
- a change to `server/` needs the service restarted to take effect: only when nothing is in
  flight (`bin/pipeline status`), and with the same settings it ran with (`/proc/<pid>/environ`
  shows them; most live in `.env`);
- a change to `ui/` needs only `npm run build`; the service serves `ui/dist` as it is.
