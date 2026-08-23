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
| T13 | Extract the opinion state machine | AGENT | — |
| T14 | Table-driven state machine tests | AGENT | T13 |
| T15 | Claim expiry for stranded opinions | AGENT | T14 |
| T22 | Fix consensus declared on a partial vote count (D6) | AGENT | T14 |
| T23 | Fix vote round stranding (D3) | AGENT | T14 |
| T24 | Guard the discussion round against re-entry (D7) | AGENT | T14 |
| T16 | Make the attention budget observational | AGENT | T02 |
| T17 | Require admin permission to grant budget | AGENT | — |
| T18 | Stop reputation returning fabricated scores | AGENT | T02 |
| T19 | Capture the review feedback signal | AGENT · optional | T18 |
| T20 | Compute the reviewer scorecard | AGENT · optional | T19 |
| T21 | Surface the reviewer scorecard | AGENT · optional | T20 |
| T25 | Make reviewer config database authoritative (plan A5) | AGENT | T09 |
| T26 | The verdict primitive (plan C2) | AGENT | T09 |
| T27 | Framework adapters (plan C3) | AGENT | T26 |
| T28 | Add the opinion ballot table (v2 engine) | AGENT | — |
| T29 | The v2 pure state machine | AGENT | — |
| T30 | Table-driven tests for the v2 state machine | AGENT | T29 |
| T31 | v2 router: critique phase | AGENT | T28, T29 |
| T32 | v2 router: simultaneous vote phase | AGENT | T28, T29, T31 |
| T33 | Wire v2 in behind a flag | AGENT | T31, T32 |
| T34 | Retire the v1 opinion engine | AGENT · gated | T33 + human sign-off |

T13–T15 run in parallel with T00–T12: they touch `src/fleet/opinion-router.ts`, which
nothing else in the queue modifies.

Every DESIGN-FIRST row from the original plan now has a brief — A5, C2, and C3 all
turned into AGENT work once their target shape was decided (T25–T27). That decision is
always the real work; once it's written down, delegating the implementation is
mechanical, which is exactly what happened with the opinion state machine first, then
these three.

- **T25** settled the DB-vs-YAML precedence question, and along the way found that
  `POST /v1/fleet/reload` writes a flag nothing reads — the same "producer never built"
  pattern as D8, just in the fleet manager instead of the opinion router.
- **T26** builds the integration primitive the product direction depends on: one call
  that submits work and returns a decision. It reuses the majority-approval rule
  `GET /v1/tasks/:id` already computes rather than inventing a new one, and adds the
  one thing that computation was missing — dissent, always shown, never averaged away.
- **T27** is genuinely thin once T26 exists: two adapters that call one endpoint and
  do nothing else. If either grows real logic, that logic was supposed to live in the
  server.

## The opinion state machine

`docs/opinion-state-machine.md` is the completed design pass for T13–T15. It carries the
full transition table (11 sites, 6 events), the counts each guard reads, and eight
numbered defects found while deriving it.

**T13 fixes none of those defects.** The extraction is behaviour-preserving; T14 locks
current behaviour into tests, including three cases that deliberately assert wrong
behaviour and say so. T15 then fixes D1 and D2; T22–T24 fix D6, D3, and D7. Each is one
changed expectation against T14's baseline, not a silent rewrite.

Two defects have no brief, and won't get one from a bug-fix task:

- **D5** — the documented `voting → synthesizing` loop-back cannot happen; the API
  rejects a synthesis unless the opinion is already in `synthesizing`, and nothing ever
  moves it back. Not a bug fix — a decision about whether opinions revise at all.
- **D8** — nothing has ever automated synthesis generation. The PRD describes a
  synthesizer LLM call alongside the critique and vote calls; it was never built.
  Every opinion that reaches `synthesizing` unattended stalls forever, and no fix to
  the state machine touches this — it's a missing producer, not a bad transition.

D8 is the fact that should decide D5, and it's bigger than a state-machine bug: it means
the three-role pipeline (critique → synthesize → vote) the feature was designed around
has only ever run its first and third steps. `docs/opinion-engine-v2.md` is that
decision, made: drop the unbuilt synthesizer rather than build it, and remove
sequential voting's anchoring bias along the way. T28–T34 build it.

**T22–T24 are not superseded by this — they're bridge work, and the queue treats them
that way.** v1 keeps running, bugs fixed, until T33 makes v2 available behind
`OPINION_ENGINE=v2` and T34 — gated on it actually being validated, not just built —
retires v1's code. If v2 is never flipped on, T22–T24 remain what's live and their
fixes remain correct. Do not start T34 as "next in the queue"; it deletes code T15 and
T22–T24 were keeping correct, and its own brief refuses to proceed without a human
confirming v2 has actually run, not just that it compiles.

## Budget and reputation

T16–T18 resolve a decision made in review: the attention budget and the reputation
system are priced for a multi-organisation network that does not exist, and at one
organisation they cost more than they return.

- **T16** keeps the budget ledger and removes the enforcement. Every `spend()` and
  `earn()` still records; nothing is refused unless `BUDGET_ENFORCE=true`. This
  preserves the whole option value — if a second organisation ever shares a channel,
  one flag turns scarcity back on, and the economy already has real history in it.
  Today the only thing enforcement achieves is blocking a submit-only principal after
  three tasks.
- **T17** closes the hole that made enforcement notional anyway: any org-scoped token
  could mint unlimited budget through `POST /principals/:id/budget/grant`.
- **T18** stops reputation reporting fabricated zeros. It does not build reputation —
  `computeAndSnapshot()` still has no caller. It makes the subsystem say so.

T19–T21 are **optional**. They build the reviewer scorecard, which is the version of
reputation that means something at one organisation: not *which agent is trustworthy*
but *which of my reviewer configurations catches things*. Skip the chain entirely if
you do not want the feature — T18 leaves the codebase honest without it.

The chain has a hard prerequisite that is easy to miss: `clv_reviews.helpful` is null
for every row, because nothing has ever called the endpoint that sets it. T19 builds
that capture path. Starting at T20 produces a scorecard with no input.

---

## Why the credential task is not here

Rotating the production Postgres password means logging into Render, changing a
secret, and updating environment variables across two services plus Vercel. No agent
in this queue has or should have that access. Do it by hand before starting T00 —
the repo is public and the credential is in git history.

The repo-side half of that work (removing the literals from `scripts/*.ts`) is safe
to delegate, but it is pointless until the password is rotated, so it is folded into
T01's file allowlist rather than given its own brief.
