# Cleanup

Cleanup is explicit and operator-approved only.

Do not clean up automatically.

## Offer cleanup

At the end of a run, show what can be removed:

- run-scoped worktrees
- local branches for abandoned work
- local run ledger
- remote branches, only if explicitly requested

## Never delete without approval

Before deleting, show exact paths and branch names.

Example:

```text
Will delete local worktrees:
- worktrees/<run-id>/issue-2
- worktrees/<run-id>/issue-3

Will delete local branches:
- agent/issue-2-<run-slug>

Will keep:
- remote branches
- PR branches
- .work-issue/runs/<run-id> unless approved
```

Ask for operator approval.

## Safety checks

Do not delete a worktree if it has uncommitted changes unless the operator explicitly confirms.

Do not delete remote branches without separate explicit approval.

Prefer keeping the run ledger by default for debugging. It is safe to delete only after durable GitHub state is correct.
