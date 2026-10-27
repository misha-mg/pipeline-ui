# pipeline-ui glossary

The words the service, its records and the console use. Instrumenta's "attempt", "Pick",
"Minion" and "Foreman" are not used.

**Run**: one start of the pipeline for one ticket, from `run.sh` to the session's end; a run
directory `run-N` under `.pipeline-runs/<KEY>/`. _Avoid_: attempt, job.

**Queue**: the tickets waiting to run, in order. The service takes the first one.

**Loop**: the service's cycle that takes the next ticket when nothing is in flight. It is
running or stopped; it stops itself on the usage limit, and before a run whose entry point is
refused.

**In flight**: the run going on now. At most one.

**Verdict**: the pipeline's word on a run, the last line of `state.md`: `done:pr-opened`,
`done:nothing-to-build`, `blocked:*`, `failed:*`. Only a closed run has one.

**Ending**: the service's word on how a run's session ended: `completed`, `usage-limit`,
`error`, `cancelled`, `timeout`, `restart`, `exited`, `no-result`. Every run the service started
has one once it is over.

**Entry point**: the `start.sh` a run goes through, and the `run.sh` that hands over to it:
webui's own, or `start.sh` from the ref `PIPELINE_START_SH_REF` names. Checked before every run.

**Stage**: one agent's turn in a run (investigate, implement, diff, review, app-test, a rework
round), as the session's hooks report it.
