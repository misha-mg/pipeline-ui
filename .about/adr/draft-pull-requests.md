# Drafts only: the service sends a ready pull request to the draft tool

Date: 2026-11-02

`PIPELINE_PULL_REQUESTS` takes a third value, `draft`, beside `on` and `off`. With it every pull
request a run opens is a draft, whatever the run decided. The operator wants this for test runs
into a branch people review from (`master`): the run goes all the way to a pull request, so its
push, title and description are tested too, and nobody merges what the pipeline opened before a
person has looked at it.

webui decides between a ready and a draft pull request itself (`.claude/workflows/ticket-pipeline.js`,
step 6: a draft when the review left a known defect or the app test did not verify the change),
and webui is read-only from here (ADR webui-entry-point). So the service does not change that
decision; it changes the session the decision runs in. With `draft`, the session's settings no
longer allow `mcp__bitbucket__createPullRequest`, and the PreToolUse hook that refuses publishing
with pull requests off refuses that call, its reason naming
`mcp__bitbucket__createDraftPullRequest` and saying it takes the same arguments.
`ticket-implementer` already opens drafts with that tool and those arguments, so the refused call
is followed by a draft. The ready call is not added to the settings' deny list: a denied tool is
taken out of the session, and the agent would then not meet the hook that redirects it. Each
refusal is a `refused` event in the run's log.

The run's ending is still webui's: a run whose workflow chose a ready pull request ends
`done:pr-opened` although its pull request is a draft. The pull request's state in the history
comes from Bitbucket, not from the ending.

The same change closes a gap in `off`: it refused `createPullRequest` but not
`createDraftPullRequest`. Without the push a draft could not have been opened from the ticket
branch, but the settings and the hook now name both.
