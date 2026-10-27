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
  PR #665): the service records such a run as `exited` with no event at all. The service must
  not be started against a webui whose `origin/master` lacks that entry point.

- A change to `start.sh`'s arguments or to the run files is a change to the service; webui's
  ADR ticket-pipeline names those files as a contract.
