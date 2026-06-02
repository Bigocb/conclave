---
name: setup-work-issue
description: Configures local runtime settings for the work-issue skill. Use before work-issue when .work-issue/operator-config.yaml is missing, invalid, unsafe, or needs to change.
---

# Setup Work Issue

Configure local, gitignored operator settings for the `work-issue` orchestration skill. This is setup-only: do not dispatch workers, modify implementation files, or work GitHub issues.

## Quick start

1. Read `.work-issue/operator-config.yaml` if it exists.
2. Validate it against the rules below.
3. If missing or invalid, interview the operator and draft YAML from `templates/operator-config.example.yaml`.
4. Show the final YAML and write it only after operator approval.
5. Check whether `.work-issue/` is ignored by git and offer a `.gitignore` patch if needed.

## Responsibilities

Use this skill to:

- Explain the supported dispatch modes.
- Interview the operator about their runtime setup.
- Create or update `.work-issue/operator-config.yaml`.
- Validate the operator config.
- Optionally update `.gitignore` to ignore `.work-issue/`.

Never silently choose runtime, provider, model, or merge settings. Recommend values when useful, but ask before writing config.

## Output

Create or update `.work-issue/operator-config.yaml` from `templates/operator-config.example.yaml`. This file is local operator configuration and should not be committed.

## Dispatch modes

The operator must choose exactly one dispatch mode:

- `manual_sessions`: The coordinator creates worktrees and prompt files. The operator starts each worker session manually.
- `in_session_subagents`: The current runtime can start worker subagents inside the coordinator session.
- `background_sessions`: The runtime can launch and monitor independent background worker sessions.
- `non_interactive_batch`: The runtime can execute a worker prompt non-interactively and exit.
- `external_service`: An external service, queue, CI job, or custom orchestrator accepts worker tasks and reports results.

The selected mode must provide `dispatch.instructions`. Treat these instructions as the runtime contract. If the instructions are unsafe, contradictory, missing required details, or impossible in the current environment, stop and ask the operator to fix the config.

## Setup flow

1. Existing config: read, validate, summarize current settings, identify invalid fields, and ask whether to make targeted edits.
2. Missing or invalid config: ask for dispatch mode first, then only the follow-up questions needed for that mode.
3. Ask for `max_concurrency`; recommend `2`; allowed values are `1`, `2`, or `3`.
4. Ask whether the runtime supports worker model selection; if yes, ask for `models.worker`.
5. Ask PR and merge permissions.
6. Show the final YAML before writing.
7. Write `.work-issue/operator-config.yaml` only after operator approval.
8. Check whether `.work-issue/` is ignored by git; patch `.gitignore` only after operator approval.

## Safe defaults

Recommend these defaults unless the operator says otherwise:

```yaml
dispatch:
  max_concurrency: 2

permissions:
  coordinator_may_open_prs: true
  coordinator_may_merge: false
```

Do not invent:

- dispatch mode
- runtime-specific instructions
- model/provider names
- merge authority

## Validation rules

A valid config must satisfy:

- `dispatch.mode` is one of the supported dispatch modes.
- `dispatch.max_concurrency` is `1`, `2`, or `3`.
- `dispatch.instructions` is non-empty.
- `dispatch.supports_model_selection` is boolean.
- If `dispatch.supports_model_selection` is `true`, `models.worker` is required and non-empty.
- `permissions.coordinator_may_open_prs` is boolean.
- `permissions.coordinator_may_merge` is boolean.

## Gitignore

If `.work-issue/` is not ignored, propose adding this to the repo's existing local/agent section if one exists:

```gitignore
# Local work-issue orchestration state
.work-issue/
```

Do not require this patch for setup success unless the operator wants it.
