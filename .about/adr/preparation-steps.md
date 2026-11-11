# The preparation's steps come from the entry point's own trace

Date: 2026-11-11

A ticket the loop takes spends its first minutes in `prepare-worktree.sh`: git fetch, a new
worktree, `npm ci`, the sandbox check, the mock's reset, then the hand-over to
`launch-session.sh`, which starts the session. The session's hooks report nothing of it, so the
console said only "preparing the worktree" (4554f7c), and a run that failed there said
"launch-session.sh without PIPELINE_SESSION?" whatever had failed. The operator wants to see
which step a run is at and what each one took.

The runner starts the copied prepare script as `bash -x`, with `BASH_XTRACEFD=4` and `PS4='+ '`,
and reads descriptor 4 as a fourth pipe. bash writes each command to the trace as it starts it,
so the moment a line arrives is the moment the command began. `loop/preparation.ts` knows six
commands, each beginning a step:

| Step | The traced command |
| --- | --- |
| `git fetch` | `git … fetch …` |
| `worktree` | `git … worktree add …` |
| `npm ci` | `npm ci` (or `npm install`) |
| `sandbox check` | `command -v bwrap` / `command -v socat` |
| `mock reset` | `tools/device-mock/<script>.sh …` (the check that the mock answers, then its reset) |
| `session start` | `exec tools/ticket-pipeline/<script>.sh …`, until the session's first event |

A step begins when its first command arrives and ends when the next one begins; the last ends with
the session's first event, or with the run. Each step is recorded once per run (`run_steps`,
migration 4). A run that ends in a step says so: `exited` "while preparing the run (npm ci),
before the session started", with the last line the scripts wrote; `cancelled` and `restart`
the same.

Only the prepare script is traced: the launch script it `exec`s is a new bash, which does not
inherit `-x`. The secrets are sourced in the shell before it, so they are not in the trace. Once
the session has sent its first event, the trace is ignored, should a child script turn on its own
`set -x`.

## Considered options

- **The scripts' output, timestamped as it arrives**: it is already in the run's log, but git
  fetch prints nothing when nothing changed, the mock's reset prints nothing when it works, and
  `npm ci` prints its first line only when it is done. Half the steps would be guesses.
- **The process tree, polled under `/proc`**: no coupling to the script's text, but Linux-only
  polling, a step shorter than the poll is missed, and it says what runs, not which step a
  command belongs to.
- **Markers written by `prepare-worktree.sh`** (a line per step on a descriptor the service
  names, for example `PIPELINE_STEPS_FD`: `{"step":"npm ci","at":"<ISO time>"}`, and one with
  `"ok":false` before an `exit` on failure): the cleanest contract, but a webui change, and webui
  is read-only from here (ADR webui-entry-point). The trace gives the same steps without it. Should
  the trace stop being enough (a step that is a function call, or a script that is no longer bash),
  this is the format to ask webui for.

## Consequences

- The commands above are a contract with `prepare-worktree.sh` as its last line already is (ADR
  webui-entry-point). A command the script no longer runs is a step the console does not show,
  never a wrong one: the run shows the steps that were seen, or "preparing the worktree" when
  none was.
- A run the service drove counts its duration from the moment the loop took the ticket, its
  preparation included; before, a finished run counted from its assignment's time, so its
  duration shrank when it ended.
- The console no longer takes an earlier run of the same ticket that never closed for the run in
  flight: a run directory of the key is the run in flight's only when it began since that run did.
- `prepare-worktree.sh` checks the sandbox tools after `npm ci`: a machine without `bwrap` fails
  a run only after its dependencies are installed. That order is webui's to change.
- When the service dies without its shutdown (SIGKILL, outside systemd), the prepare script's
  process group lives on until it writes to a pipe nobody reads; the next start records the run
  `restart` with its step, as before.
