# Discover Issue Graph

Use this runbook after config validation and pre-dispatch sanity checks.

## Inputs

- target issue number or URL
- repository inferred from the current git checkout
- repo default branch
- `.work-issue/operator-config.yaml`

## Read target issue

Use GitHub as source of truth.

Recommended commands:

```bash
gh issue view <target> --comments --json number,title,body,state,labels,assignees,projectItems,url
```

Fetch structured sub-issues:

```bash
gh api repos/<owner>/<repo>/issues/<target>/sub_issues
```

Fetch richer relationship/project data with GraphQL when needed.

## Determine target mode

Tree mode:

- target issue has structured GitHub sub-issues
- candidates are the structured sub-issues only

Single-issue mode:

- target issue has no structured GitHub sub-issues
- candidate is the target issue itself

Do not include issues merely because they link to the target in their body. If body links and structured relationships disagree, report tracker hygiene but do not use body links for dispatch.

## Blocker authority

Use structured GitHub blocker relationships as authoritative.

Issue-body `## Blocked by` sections are hygiene cross-checks only. If body blocker text disagrees with structured blocker relationships, skip that issue and report the mismatch.

## Output

Write discovered graph state to:

```text
.work-issue/runs/<run-id>/run.yaml
```

Include:

- target issue
- target mode
- candidate issue numbers
- sub-issue relationships
- blocker relationships
- labels
- project status
- skipped tracker hygiene notes
