# Ready Queue

Run ID: `<run-id>`
Target issue: #<target-issue-number>
Mode: `<tree|single-issue>`

## Runnable Issues

| Issue | Title | Status | Blockers | Worktree | Branch |
|---|---|---|---|---|---|
| #<n> | <title> | Todo | none | `worktrees/<run-id>/issue-<n>` | `agent/issue-<n>-<run-slug>` |

## Skipped Issues

| Issue | Title | Reason |
|---|---|---|
| #<n> | <title> | <not ready-for-agent / blocked / missing Status / etc.> |

## Dispatch Plan

Max concurrency: `<n>`

Selected for this wave:

- #<n>
- #<n>
