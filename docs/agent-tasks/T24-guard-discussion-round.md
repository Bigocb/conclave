# T24 — Guard the discussion round against re-entry (D7)

**Mark:** AGENT
**Depends on:** T14
**Fixes:** D7 in `docs/opinion-state-machine.md`

## Files you may modify

- `src/fleet/opinion-router.ts`
- `src/__tests__/opinion-machine.test.ts` (comment only, if the D7 note needs updating)

## Context

`checkSynthesizingOpinions` calls `triggerDiscussionRound` for every `synthesizing`
opinion that has a synthesis node, on every poll, with no record of whether a round
already ran. It self-limits only because the round ends by calling
`triggerVoteRound`, which moves the opinion out of `synthesizing` — so today it costs
at most one extra LLM call per critic on a slow poll. But any future path that returns
an opinion to `synthesizing` (including a D5 revision round, if you build one) turns
this into an unbounded re-run: one LLM call per critic, every poll, forever.

This is not part of the state machine — `triggerDiscussionRound` doesn't decide a
status, it decides whether to call an LLM. The fix is a guard, not a `nextState` event.

## Steps

1. In `checkSynthesizingOpinions`, before calling `triggerDiscussionRound`, check
   whether a follow-up critique already exists for this synthesis node:

   ```sql
   SELECT 1 FROM clv_blackboard_edges e
   JOIN clv_blackboard_nodes n ON n.id = e.target_node_id
   WHERE e.source_node_id = ${synthNodes[0].id}
     AND e.kind = 'critiques'
     AND n.kind = 'critique'
   LIMIT 1
   ```

   This is the edge direction T13 already established as correct for a follow-up
   critique (synthesis → critique). If a row comes back, the discussion round for this
   synthesis has already run — skip it and fall straight through to
   `triggerVoteRound(opinionId)` instead of calling `triggerDiscussionRound` again.

2. Add a one-line comment above the check naming D7, so the next reader knows the guard
   is deliberate:

   ```ts
   // D7 guard: triggerDiscussionRound is not idempotent — it issues one LLM call per
   // critic every time it runs. Without this check, any future path that returns an
   // opinion to 'synthesizing' would re-run it on every poll.
   ```

## Verify

```bash
grep -c "D7 guard" src/fleet/opinion-router.ts
```
Expected output: `1`

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

```bash
npx vitest run src/__tests__/opinion-machine.test.ts
```
Expected: unchanged — this task does not touch `nextState`.

## Manual check (ask a human to run this)

Against a non-production database, let an opinion reach `synthesizing` with a synthesis
node present, and confirm the router's log shows `triggering discussion round` exactly
once across several poll cycles, not once per poll.

## Stop conditions

- Do not add a new column or table for this. The existing edge is sufficient evidence
  that a round ran.
- Do not change `triggerVoteRound` or anything in `checkAndFinalizeConsensus` — those
  are T22/T23 territory.

## Commit

```
fix(opinions): guard the discussion round against unbounded re-entry (D7)
```
