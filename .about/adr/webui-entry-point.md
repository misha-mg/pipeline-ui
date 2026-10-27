# webui knows the service through one entry point in start.sh

Date: 2026-10-27

The service starts a run exactly as `batch.sh` does, with `tools/ticket-pipeline/run.sh KEY`,
and `start.sh` hands the session to the program `PIPELINE_SESSION` names, with the prompt, the
settings JSON, the MCP config and the runs directory it built. That variable is the whole
contract: the worktree, the sandbox, the app server, the cleanup trap and the run directories stay
`webui`'s, and the service adds nothing else there. The session program reports events on the
file descriptor `PIPELINE_EVENTS_FD` names, so `run.sh`'s stdout and stderr stay a plain log.

Anything else the console shows comes from what runs already leave under `.pipeline-runs/`
(`00-assignment.md`, the stage reports, `state.md`, `timings.tsv`) and from Jira and Bitbucket
directly. Those files are the pipeline's contract with `pipeline-tui` too, so the service reads
them as they are and asks for no new field.

## Considered options

- **A hook or a runner script inside webui that the service installs** — more of webui to keep
  in step with the service, and a second way to start a run next to `batch.sh`.
- **The service builds the settings and starts `claude` itself** — duplicates `start.sh`'s
  confinement, which changes with the pipeline, not with the console.

## Consequences

- `run.sh` makes the worktree from `origin/master`, and the worktree's own `start.sh` is what
  runs: until the `PIPELINE_SESSION` change is on `origin/master`, every run the service starts
  is run by the plain CLI, unwatched, to its pull request. Seen on 2026-10-27 (KAZ-7785 run-3,
  PR #665): the service records such a run as `exited` with no event at all. Since then the
  service checks before every run (below) instead of relying on the operator.

- A change to `start.sh`'s arguments or to the run files is a change to the service; webui's
  ADR ticket-pipeline names those files as a contract.

## During the code freeze (2026-10-27, amended)

webui's code freeze keeps the `PIPELINE_SESSION` change (10a2022ee) off `origin/master` for
about a week, and `origin/dev` is the same commit as `origin/master`. Instead of waiting, the
service can take `start.sh` from another ref while the worktree stays `origin/master`'s:

- Before every run, with the queue's head still queued, the service fetches origin and checks
  the `start.sh` the run would go through. When it has no `PIPELINE_SESSION`, no run starts: the
  loop stops with the reason `entry-point`, the console says why, the queue is untouched.
- `PIPELINE_START_SH_REF=<ref>` (e.g. `pipeline-improvements`): the service writes
  `origin/master`'s `run.sh` into `data/entry/` with its last line,
  `exec tools/ticket-pipeline/start.sh "$@"`, pointed at that ref's `start.sh`, copied beside it.
  The worktree, its branch, the agents, the skills and the confinement are still
  `origin/master`'s; only the entry point is the ref's. If `run.sh` ever ends differently the
  check refuses the run rather than guess.
- `PIPELINE_PULL_REQUESTS=off`, the default while a ref is set: the session's settings lose the
  push and the pull request (their allow rules and the push's sandbox exclusion; both denied)
  and a PreToolUse hook refuses `git push` and `mcp__bitbucket__createPullRequest` whatever the
  settings say, reporting each refusal as a `refused` event. A run then ends before its push,
  `blocked:tooling` naming the refused call, with its commits on the local ticket branch: a
  test run that cannot reach a pull request, as the freeze requires.

Nothing is written into webui's tracked files, and webui's `master` gets no commit. Once
`start.sh` with `PIPELINE_SESSION` is on `origin/master`, unset both variables: the check
passes for webui's own `run.sh` and pull requests are on again.

Considered: a branch pushed to origin with the entry point and `run.sh` started from it —
`run.sh` takes the worktree from `origin/master` whatever branch it is run from, and a pushed
branch is a change to webui during the freeze.
