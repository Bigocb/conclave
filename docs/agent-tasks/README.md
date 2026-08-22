# Agent Task Queue

Executable task briefs derived from the Conclave consolidation plan. Each brief is
self-contained: one atomic change, an exact file allowlist, a verify command, and a
commit message.

**These are written for a small model working one task per session.** Do not hand the
whole directory to one agent run. Give it exactly one task file.

---

## Execution protocol

Paste this block at the top of every agent session, above the task file.

```
You are executing ONE task from docs/agent-tasks/. Follow it literally.

RULES — these override anything the task seems to imply:
1. Modify ONLY files listed under "Files you may modify". If the task needs a
   file that is not listed, STOP and report.
2. Run `npx tsc --noEmit` before every commit. If it reports an error you did
   not introduce, note it and continue. If it reports an error you DID
   introduce, fix it or revert. Never commit with new type errors.
3. Never delete, skip, or weaken a test to make a check pass.
4. Never run: git push --force, git rebase, git commit --amend, git reset --hard.
5. Never modify .env, credentials, deploy config, or anything under .github/
   unless the task explicitly names the file.
6. Do not add npm dependencies unless the task explicitly names them.
7. If a verify step fails twice, STOP and report what you tried. Do not attempt
   a third approach.
8. Make exactly one commit, using the message given in the task.
9. Do not start the next task.
```

---

## Suitability

Not every step in the plan is small-model work. Three categories:

| Mark | Meaning |
|---|---|
| **AGENT** | Mechanical. Exact target stated in the brief. Safe for Haiku 4.5. |
| **DESIGN-FIRST** | Needs a target shape defined by a stronger model or a human. Once that lands in the brief, the implementation becomes AGENT work. |
| **HUMAN** | Touches production credentials or infrastructure. Do not delegate to any agent. |

---

## Queue

| ID | Task | Mark | Depends on |
|---|---|---|---|
| — | Rotate the production database password | **HUMAN** | — |
| T00 | Align Node version across images | AGENT | — |
| T01 | Add the missing eslint flat config | AGENT | — |
| T02 | CI workflow with a Postgres service | AGENT | T00, T01 |
| T03 | Prove the cron review path is dead | AGENT | T02 |
| T04 | Delete the dead and broken runners | AGENT | T03 |
| T05 | Extract `src/review/parse.ts` | AGENT | T04 |
| T06 | Extract `src/review/prompt.ts` | AGENT | T05 |
| T07 | Extract `src/review/execute.ts` | AGENT | T06 |
| T08 | Rewire `fleet/manager.ts` | AGENT | T07 |
| T09 | Rewire `workers/reviewer.ts` through the service layer | AGENT | T08 |
| T10 | Persist the human-approval queue | AGENT | T09 |
| T11 | Freeze PROTOCOL.md at v0.1 | AGENT | — |
| T12 | Document the MCP integration surface | AGENT | — |
| — | Single reviewer config source (plan A5) | **DESIGN-FIRST** | T09 |
| — | Opinion state machine extraction (plan B1–B2) | **DESIGN-FIRST** | — |
| — | Verdict stream primitive (plan C2) | **DESIGN-FIRST** | T09 |
| — | Framework adapters (plan C3) | DESIGN-FIRST | C2 |

The DESIGN-FIRST rows have no brief yet on purpose. Writing one requires deciding a
target shape — the transition table for the state machine, the wire format for the
verdict stream. That decision is the work; once it is written down, the
implementation drops to AGENT level.

---

## Why the credential task is not here

Rotating the production Postgres password means logging into Render, changing a
secret, and updating environment variables across two services plus Vercel. No agent
in this queue has or should have that access. Do it by hand before starting T00 —
the repo is public and the credential is in git history.

The repo-side half of that work (removing the literals from `scripts/*.ts`) is safe
to delegate, but it is pointless until the password is rotated, so it is folded into
T01's file allowlist rather than given its own brief.
