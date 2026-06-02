# Dispatch Workers

Use this runbook after the ready queue is built.

## Pre-dispatch sanity checks

Before creating worktrees:

- confirm current checkout is inside the target repo
- confirm there are no uncommitted tracked changes in the coordinator checkout
- allow ignored/untracked orchestration artifacts such as `.work-issue/` and `worktrees/`
- confirm `gh` can read the repo and target issue
- confirm no background tasks are actively using git (see Git lock protection below)
- run `git fetch origin`
- detect the repo default branch
- confirm `worktrees/<run-id>/` does not already exist
- confirm `.work-issue/runs/<run-id>/` does not already exist

## Git lock protection

Background agents running in parallel may create transient git lock files (`.git/index.lock`, `.git/refs/heads/*.lock`). If a git command fails with a lock error:

1. Wait 2-3 seconds and retry the command once
2. If still locked, check for running git processes: `ps aux | grep git`
3. If no git processes are running, remove stale lock files: `find .git -name "*.lock" -type f -delete 2>/dev/null`
4. Retry the operation

Apply this retry pattern to all git commands in this runbook (`git fetch origin`, `git worktree add`, `git push`).

Use the repo default branch only. V1 does not support base branch override.

## Worktree creation

For each selected issue:

```bash
git worktree add worktrees/<run-id>/issue-<number> -b agent/issue-<number>-<run-slug> origin/<default-branch>
```

Do not push the branch before coordinator review passes.

## GitHub state

When a worker starts, the coordinator moves the issue from `Todo` to `In Progress`.

If this project field update fails after readiness was already confirmed, report it in the run ledger and run summary. Do not let workers perform the update.

## Prompt creation

Create a worker prompt from `templates/worker-prompt.md`.

Write it to:

```text
.work-issue/runs/<run-id>/prompts/issue-<number>.md
```

## Dispatch contract

Read `.work-issue/operator-config.yaml`.

The selected dispatch mode must be one of:

- `manual_sessions`
- `in_session_subagents`
- `background_sessions`
- `non_interactive_batch`
- `external_service`

Only the selected mode must be configured and valid.

Follow `dispatch.instructions` exactly unless unsafe, contradictory, missing required details, or impossible in the current environment. If invalid, stop and ask the operator to run `setup-work-issue`.

If `dispatch.supports_model_selection` is true, use `models.worker` as described by `dispatch.instructions`.

## Worker lifecycle ledger

For each worker, create:

```text
.work-issue/runs/<run-id>/workers/issue-<number>.yaml
```

Track:

- issue number
- worktree path
- branch name
- prompt path
- lifecycle state
- dispatch mode
- worker model if applicable
- started time
- last update time
- result/report path
- PR number if created

## Completion signal

The worker must write:

```text
.work-issue-worker-report.md
```

inside its assigned worktree.

The coordinator reviews workers as they finish rather than waiting for the entire wave.
