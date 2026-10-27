# pipeline-ui

Web console for the `webui` ticket pipeline: the queue of tickets, the loop that runs them one at
a time, the run in flight with its stage, and the history of runs under `webui/.pipeline-runs/`.
What it is for and what it must do: [.about/prd/pipeline-web-ui.md](.about/prd/pipeline-web-ui.md).

Lives next to `webui`; the only thing `webui` knows about it is the `PIPELINE_SESSION` entry point
in `tools/ticket-pipeline/start.sh`.

## Parts

- `server/session/` — drives one ticket's Claude Code session through the Claude Agent SDK.
  `bin/session` is the program `start.sh` runs when `PIPELINE_SESSION` names it; it prints the
  session's events (stages, rate limits, turns, the ending) as JSON lines on the file descriptor
  `PIPELINE_EVENTS_FD` names, stdout by default.

## Run one session by hand

The same way the service will, from the `webui` checkout, with the pipeline's secrets loaded:

```bash
set -a; . ~/.config/webui-pipeline.env; set +a; unset ANTHROPIC_API_KEY
PIPELINE_SESSION=/home/cgs/npb/pipeline-ui/bin/session tools/ticket-pipeline/run.sh KAZ-1234
```

## Checks

```bash
npm run check   # tsc
npm test        # vitest
```

Node 24 runs the TypeScript directly; there is no build step for the server.
