# webui knows the service through one entry point in launch-session.sh

Date: 2026-10-27, amended 2026-10-28 (the scripts renamed) and 2026-10-30 (the base branch)

The service starts a run as `batch.sh` does, through `tools/ticket-pipeline/prepare-worktree.sh
KEY`, and `launch-session.sh` hands the session to the program `PIPELINE_SESSION` names, with the
prompt, the settings JSON, the MCP config and the runs directory it built. That variable, with
`PIPELINE_BASE_BRANCH` (The base branch, below), is the whole contract: the worktree, the sandbox, the app server, the cleanup trap and the run
directories stay `webui`'s, and the service adds nothing else there. The session program reports
events on the file descriptor `PIPELINE_EVENTS_FD` names, so the scripts' stdout and stderr stay
a plain log.

Anything else the console shows comes from what runs already leave under `.pipeline-runs/`
(`00-assignment.md`, the stage reports, `state.md`, `timings.tsv`) and from Jira and Bitbucket
directly. Those files are the pipeline's contract with `pipeline-tui` too, so the service reads
them as they are and asks for no new field.

## Considered options

- **A hook or a runner script inside webui that the service installs** — more of webui to keep
  in step with the service, and a second way to start a run next to `batch.sh`.
- **The service builds the settings and starts `claude` itself** — duplicates
  `launch-session.sh`'s confinement, which changes with the pipeline, not with the console.

## Consequences

- `prepare-worktree.sh` makes the worktree from `origin/<base>`, and the worktree's own
  `launch-session.sh` is what runs: on a base without the `PIPELINE_SESSION` change every run
  would be run by the plain CLI, unwatched, to its pull request. Seen on 2026-10-27 (KAZ-7785
  run-3, PR #665, through what was then `run.sh` and `start.sh`): the service records such a
  run as `exited` with no event at all. Since then the service checks before every run (below)
  instead of relying on the operator.
- The prepare script the service starts is always `origin/<base>`'s, copied into `data/entry/`:
  it is the one that matches the worktree it makes, whatever branch webui's checkout is on.
- A change to `launch-session.sh`'s arguments, to the form of `prepare-worktree.sh`'s last line,
  to how either reads `PIPELINE_BASE_BRANCH`, or to the run files is a change to the service;
  webui's ADR ticket-pipeline names those files as a contract.

## The base branch (2026-10-30)

webui PR #666 (`chore/pipeline-improvements` → `dev`) lets a run start from any branch:
`prepare-worktree.sh` reads `PIPELINE_BASE_BRANCH` (`master` when unset), exits 2 when
`origin/<base>` does not exist, makes the worktree from `origin/<base>` and exports the variable
to the worktree's `launch-session.sh`, which puts it into the session's settings; the
`ticket-pipeline` skill takes the diff's base and the pull request's target from it. Both scripts
come from the base branch. The service sets `PIPELINE_BASE_BRANCH` (default `master`) and passes
it to every run explicitly, next to `PIPELINE_SESSION`.

Before every run, with the queue's head still queued, the service fetches origin and reads
`origin/<base>`: its `prepare-worktree.sh`, and the launch script that script's last line,
`exec tools/ticket-pipeline/<script> "$@"`, hands over to. No run starts, the loop stops with the
reason `entry-point` and the console says why, the queue untouched, when:

- origin has no such branch, or the branch lacks the prepare script or the launch script;
- the prepare script ends another way, so the launch script cannot be found;
- the launch script has no `PIPELINE_SESSION`;
- the base is not `master` and the prepare script has no `PIPELINE_BASE_BRANCH`: an older script
  silently builds the worktree from `master` and the run opens its pull request there.

Otherwise the prepare script is copied into `data/entry/` and the runner starts that copy.

This replaces the code freeze's workaround (below): the entry point came from one ref
(`PIPELINE_LAUNCH_SESSION_REF`) while the worktree stayed `origin/master`'s, through a copy of
the prepare script whose last line was rewritten to a copied launch script, and pull requests
were off whenever a ref was set. The worktree and the scripts then came from two different
branches, and the service had to edit webui's script to splice them. With a base branch both
come from one commit, as webui ships them, so the service no longer rewrites anything; a run
during the freeze goes from `dev`, which has the entry point, to a pull request into `dev`. The
old variables stop the service with a message naming `PIPELINE_BASE_BRANCH` rather than being
ignored, since they used to turn pull requests off. `PIPELINE_PULL_REQUESTS` stays as its own
switch, `on` by default: off, the session's settings lose the push and the pull request and a
PreToolUse hook refuses them, so a test run ends before its push (`blocked:tooling`, the commits
on the local ticket branch). The old script names (`run.sh`, `start.sh`) are no longer looked
for: a branch with only those has no base-branch support either.

## During the code freeze (2026-10-27, superseded 2026-10-30)

webui's code freeze kept the `PIPELINE_SESSION` change (10a2022ee) off `origin/master`, and
`origin/dev` was then the same commit as `origin/master`. Instead of waiting, the service took
the launch script from another ref while the worktree stayed `origin/master`'s:
`PIPELINE_LAUNCH_SESSION_REF=<ref>` (first `PIPELINE_START_SH_REF`) wrote `origin/master`'s
prepare script into `data/entry/` with its last line pointed at that ref's launch script, copied
beside it, and turned pull requests off unless asked for. Considered then: a branch pushed to
origin with the entry point and the prepare script started from it — the prepare script took
the worktree from `origin/master` whatever branch it was run from. Replaced by the base branch
above.
