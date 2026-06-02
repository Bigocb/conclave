# Classify Ready Work

Build the ready queue from the discovered graph.

## Runnable criteria

A candidate is runnable only if all are true:

- issue is open
- exactly one canonical triage label
- triage label is `ready-for-agent`
- project `Status` is `Todo`
- all structured blockers are closed or otherwise resolved by merged PRs
- no structured/body blocker mismatch was detected

## Skip criteria

Skip and report issues that are:

- not `ready-for-agent`
- closed
- missing canonical triage label
- carrying multiple canonical triage labels
- missing project `Status`
- project `Status` other than `Todo`
- blocked by open structured blockers
- affected by tracker hygiene mismatch
- already in progress
- otherwise unsafe to dispatch

In tree mode, skip non-runnable issues and continue with runnable ones.

In single-issue mode, if the target issue is not runnable, stop the run.

## Risk note

V1 does not implement a configurable risk router. Still, the coordinator must stop before dispatch if the issue clearly requires unresolved product, architecture, security, auth, persistence, or dependency decisions not captured in the issue/docs/ADRs.

## Ready queue output

Use `templates/ready-queue.md`.

Write the ready queue into:

```text
.work-issue/runs/<run-id>/ready-queue.md
```

Dispatch at most `dispatch.max_concurrency` runnable issues.
