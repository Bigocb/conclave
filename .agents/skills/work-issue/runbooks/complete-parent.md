# Complete Run

Use this runbook after every dispatched worker reaches a terminal state.

## Terminal states

A worker reaches terminal state when it is one of:

- accepted
- blocked
- abandoned

`needs-fix` is not terminal.

## Run summary comment

Post a concise summary comment to:

- parent target issue in tree mode
- target issue in single-issue mode

Use `templates/parent-run-summary-comment.md`.

Include:

- run ID
- dispatch mode
- issues worked
- PRs opened
- accepted local branches if PR creation was disabled
- skipped issues and reasons
- blocked/abandoned issues and reasons
- project status update failures, if any
- next recommended action

Do not include:

- full prompts
- full diffs
- full local ledger
- large worker reports

## Completion summary

Write a local completion summary to:

```text
.work-issue/runs/<run-id>/completion-summary.md
```

Use `templates/completion-summary.md`.

## Durable state check

Before ending:

- confirm PR links exist for PRs opened
- confirm accepted PR bodies include `Closes #<issue-number>`
- confirm skipped reasons are recorded
- confirm blocked/abandoned worker state is recorded
- confirm issues abandoned before PR creation were returned to `Todo` when possible

## Stop after one wave

Do not start another wave. Tell the operator to rerun `work-issue` after PRs merge, blockers clear, or issue state changes.
