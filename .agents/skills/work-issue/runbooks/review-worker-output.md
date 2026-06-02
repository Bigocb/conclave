# Review Worker Output

Use this runbook whenever a worker reaches `ready-for-review`.

## Import report

Require this file inside the worker worktree:

```text
.work-issue-worker-report.md
```

Copy it into:

```text
.work-issue/runs/<run-id>/reports/issue-<number>.md
```

If the report is missing, mark the worker `needs-fix` if no fix pass has been used. Otherwise mark it `abandoned`.

Verify `.work-issue-worker-report.md` is not staged or committed.

## Inspect diff

From the coordinator checkout or directly against the worktree, inspect:

```bash
git -C worktrees/<run-id>/issue-<number> status
git -C worktrees/<run-id>/issue-<number> diff origin/<default-branch>...HEAD
```

Retry each command once if git reports a lock file. See `dispatch-workers.md` for the git lock retry pattern.

Review against:

- issue acceptance criteria
- parent issue if in tree mode
- `CONTEXT.md`
- `docs/agents/domain.md`
- `docs/agents/issue-tracker.md`
- `docs/project-board.md`
- relevant ADRs in `docs/adr/`
- existing tests and repo conventions

## Review checklist

Accept only if:

- implementation stays inside the assigned issue
- every acceptance criterion is addressed
- tests are meaningful or the lack of tests is explicitly justified
- relevant checks were run or inability to run them is clearly environmental/unrelated
- domain glossary terms are preserved
- repo docs and ADRs are respected
- generated files are updated when required
- unrelated cleanup is avoided
- report is complete
- no architecture/product/security/persistence decision was invented by the worker
- worker report file is not committed

## Review output

Use `templates/coordinator-review.md`.

Write the review to:

```text
.work-issue/runs/<run-id>/reviews/issue-<number>.md
```

## Fix pass

Each issue gets one fix pass per run.

If review fails and the fix pass has not been used:

- mark worker `needs-fix`
- give precise fix instructions
- send the worker back to the same worktree
- do not restart the implementation from scratch

If review fails after the fix pass:

- mark the issue `abandoned` or `blocked`
- return project status to `Todo` if no PR was opened
- summarize the reason in the run summary

## PR creation

If review passes and `permissions.coordinator_may_open_prs` is true:

1. push the branch
2. create a normal, non-draft PR
3. use `templates/pull-request-body.md`
4. include `Closes #<issue-number>`
5. record the PR number in the ledger

If PR creation is not allowed:

- mark the worker accepted locally
- report the branch and worktree path in the run summary

Do not merge unless `permissions.coordinator_may_merge` is true and merge authority was explicitly delegated.
