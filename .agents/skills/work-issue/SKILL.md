---
name: work-issue
description: Coordinates one wave of ready-for-agent GitHub issue work using isolated worker worktrees, a local run ledger, structured worker reports, and coordinator-owned review/PR gates. Use when the user says "work issue" or wants agents to execute a parent issue, issue tree, or ready-for-agent issue graph.
---

# Work Issue

Coordinate one wave of GitHub issue work. This is orchestrator-only: the coordinator does not implement issues directly.

## Quick Start

1. Require valid `.work-issue/operator-config.yaml`; if missing or invalid, stop and tell the operator to run `setup-work-issue`.
2. Discover whether the target is tree mode or single-issue mode.
3. Build a ready queue from GitHub source-of-truth state.
4. Dispatch up to `dispatch.max_concurrency` workers in isolated worktrees.
5. Review each worker report and diff before pushing or opening PRs.
6. Post a concise run summary comment, offer cleanup, and stop after one wave.

## Core Contract

- Use GitHub as durable source of truth for issues, sub-issues, blockers, labels, project fields, PR links, comments, and merged state.
- Use `.work-issue/runs/<run-id>/` only as ephemeral coordinator state.
- The coordinator is the only writer to the canonical run ledger.
- Workers implement exactly one issue each in isolated worktrees.
- Workers must write `.work-issue-worker-report.md` in their assigned worktree.
- The coordinator owns readiness checks, dispatch, GitHub state updates, review, PR creation, run summaries, and cleanup.

## Target Modes

- Tree mode: if the target has structured GitHub sub-issues, only those sub-issues are dispatch candidates.
- Single-issue mode: if the target has no structured sub-issues, the target issue itself is the dispatch candidate.

In both modes, implementation happens through a worker worktree and coordinator review gate.

## Readiness Rule

Only dispatch candidates that satisfy all criteria:

- open issue
- exactly one canonical triage label
- triage label is `ready-for-agent`
- project `Status` is `Todo`
- no open structured blockers
- no structured/body blocker mismatch

In tree mode, skip non-runnable issues and report reasons. In single-issue mode, stop if the target is not runnable.

## One Wave

Run exactly one wave per invocation:

1. Validate config and pre-dispatch sanity.
2. Discover issue graph.
3. Classify ready work.
4. Dispatch workers.
5. Review completed workers.
6. Allow one fix pass per issue if review fails.
7. Open PRs for accepted work if configured.
8. Complete the run and offer cleanup.

Do not automatically start another wave after PRs merge or blockers clear.

## Required Runbooks

Load these runbooks as needed:

- `runbooks/discover-issue-graph.md`
- `runbooks/classify-ready-work.md`
- `runbooks/dispatch-workers.md`
- `runbooks/review-worker-output.md`
- `runbooks/complete-parent.md`
- `runbooks/cleanup.md`

Use templates from `templates/` for worker prompts, worker reports, ready queues, coordinator reviews, PR bodies, run summaries, and completion summaries.

## Guardrails

- Do not implement code in the coordinator checkout.
- Do not dispatch non-`ready-for-agent` issues or issues with open blockers.
- Do not use issue-body parent links or blocker text as authoritative GitHub state.
- Do not let multiple workers write in the same checkout.
- Do not let workers update GitHub issue labels, project fields, blockers, or parent relationships.
- Do not push worker branches before coordinator review passes.
- Do not open PRs unless `permissions.coordinator_may_open_prs` is true.
- Do not merge PRs unless `permissions.coordinator_may_merge` is true and the operator explicitly delegated merge authority.
- Do not commit `.work-issue-worker-report.md`.
- Do not run git commands while background tasks may also be touching git (see `dispatch-workers.md` Git lock protection).
- Stop if configuration, dispatch instructions, GitHub state, or architecture/product requirements are contradictory or unsafe.

## Naming

- Worktrees: `worktrees/<run-id>/issue-<number>/`
- Branches: `agent/issue-<number>-<run-slug>`
- Reports imported to: `.work-issue/runs/<run-id>/reports/issue-<number>.md`

If paths or branches already exist, stop and ask the operator to clean up or choose a new run.
