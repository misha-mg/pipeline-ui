# The session is driven through the Claude Agent SDK, not a tmux window

Date: 2026-10-27

The service runs each ticket's Claude Code session through `@anthropic-ai/claude-agent-sdk`
(`server/session/driver.ts`) and learns what the session does from typed messages: the stages
from the `SubagentStart`/`SubagentStop` hooks, the ending from the result message and the
rate-limit events. `batch.sh` learns the same by reading a tmux pane every 30 seconds and
matching Anthropic's wording for "usage limit" and "API Error": a change in that wording leaves a
stalled session to the four-hour timeout, and the stage a run is in is known only once the run is
closed. Checked on 2026-10-27 with KAZ-7785 run-2: the subscription token works under the SDK,
the Workflow tool, the sandbox settings, the project's skills and agents load, every stage start
and stop reached the hooks, and the session stayed alive across the background workflow.

The session is a program of its own (`bin/session`, `server/session/main.ts`) that `start.sh`
runs in the ticket's worktree, not an SDK call inside the service: it gets the settings, MCP
config and runs directory `start.sh` built, so the confinement stays in one place (ADR
webui-entry-point), and a session that hangs or crashes is a child process the service can kill
and record, not a corrupted service.

The session's environment drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, so the CLI signs
in with the subscription's `CLAUDE_CODE_OAUTH_TOKEN` and never bills per token, and sets
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so a print-mode session waits for the background
workflow however long a stage takes.

## Considered options

- **tmux window and the session's transcript**, as `batch.sh` does — stages and endings come
  from screen scraping and the transcript's JSON, both unversioned formats; kept as the fallback
  if the subscription token were ever refused under the SDK.
- **The SDK `query()` inside the service process** — the service would have to rebuild the
  settings `start.sh` computes, and a session's crash would be the service's.

## Consequences

- The service depends on the SDK's message and hook types; an SDK upgrade is a change to check
  with one real run.
- Revisit when the wait ceiling cuts a long stage short (a `turn` arriving before the stage's
  stop), or when the token is refused under the SDK.
