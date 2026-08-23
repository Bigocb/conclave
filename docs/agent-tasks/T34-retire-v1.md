# T34 — Retire the v1 opinion engine

**Mark:** AGENT
**Depends on:** T33, **and a human decision that v2 has run successfully**
**This task deletes code. Do not start it on schedule — start it when told to.**

## Precondition — do not skip this

This task is not "next after T33" the way T29 follows T28. T33 makes v2 available;
it does not make v2 *proven*. Before starting this task, confirm with whoever assigned
it that `OPINION_ENGINE=v2` has been running against real or realistic traffic and its
`closed` opinions look correct — not just that the manual check in T33 passed once.

If that confirmation hasn't happened, stop now and report that the precondition isn't
met, rather than proceeding on the assumption that being next in the queue is enough.

## Files you may modify

- `src/fleet/opinion-router.ts`
- `src/fleet/opinion-router-v2.ts` (drop the `V2` suffix — see step 4)
- `src/opinions/machine.ts` (delete)
- `src/opinions/machine-v2.ts` (rename — see step 4)
- `src/__tests__/opinion-machine.test.ts` (delete)
- `src/__tests__/opinion-machine-v2.test.ts` (rename)
- `PROTOCOL.md`
- `docs/opinion-state-machine.md` (mark as historical, don't delete)
- `AGENTS.md`

## Steps

1. **Delete v1's synthesis-handling functions** from `opinion-router.ts`:
   `triggerDiscussionRound`, `checkSynthesizingOpinions`, `triggerVoteRound` (the
   sequential version), `checkAndFinalizeConsensus`, `buildVotePrompt`,
   `checkVotingOpinions`, and `HARD_NODE_LIMIT`. Also delete `src/opinions/machine.ts`
   and `src/__tests__/opinion-machine.test.ts` — v1's pure state machine and its tests,
   built by T13/T14 and fixed by T15/T22–T24.

   These fixes were correct when they shipped, for code that was live. This deletion
   isn't a revert — note that explicitly in the commit body, since a future reader
   diffing history will otherwise see "fix a bug" immediately followed by "delete the
   fix" and reasonably wonder if the fix was wrong.

2. **Keep and repurpose:** `routeOpinion`'s critique-phase logic already has a v2
   equivalent (T31 built it independently), so v1's copy can go too — but first check
   nothing outside the opinion engine imports `resolveVaultKey`, `decryptVaultValue`,
   `resolveAgentLlmKey`, `normalizeLlmUrl`, or `refreshAgentToken` from
   `opinion-router.ts` specifically (T31 was told to `export` these for v2 to import
   rather than duplicate — confirm that's genuinely how they're shared before deleting
   the v1 copies they were exported from).

3. **Remove the `OPINION_ENGINE` branch.** `main()` calls v2's entrypoint
   unconditionally. Delete the `.env.example` entry T33 added — there's no longer a
   choice to make.

4. **Drop the "v2" naming**, now that it's the only engine: rename
   `opinion-router-v2.ts` → `opinion-router.ts` is not possible without colliding with
   the file you just gutted in step 1 — so do this in order: finish deleting v1's
   content from `opinion-router.ts` first (step 1), leaving only shared exports and
   `main()`; merge `opinion-router-v2.ts`'s contents into what remains of
   `opinion-router.ts`; delete `opinion-router-v2.ts`. Rename `machine-v2.ts` →
   `machine.ts` (it's now the only one) and update its imports at every call site.
   Rename `opinion-machine-v2.test.ts` → `opinion-machine.test.ts`. Drop the `V2`
   suffix from every function and type name (`nextStateV2` → `nextState`,
   `routeOpinionV2` → `routeOpinion`, etc.) across all files that reference them.

5. **Update `PROTOCOL.md`.** T11 froze this file and moved unimplemented sections to
   `docs/proposals/` — but the synthesis sections it documents (`kind: enum(...
   synthesis ...)` and *"Constraints: Kind `synthesis` only allowed when opinion status
   is `synthesizing`"*, both in the Blackboard section) describe something that *was*
   partially implemented, not something merely unimplemented. Remove `synthesis` from
   the node-kind enum and delete the `synthesizing`-status constraint. Add a line to
   the frozen-status note at the top recording that this is a v0.1 → v0.2 change with a
   stated reason (link to `docs/opinion-engine-v2.md`), since T11 explicitly said the
   spec doesn't change until an implementation validates a proposal — this is that
   validation.

6. **Update `docs/opinion-state-machine.md`.** Do not delete it — it's the accurate
   historical record of a real system that ran in production and the defects found in
   it. Add one line at the top: *"Describes the v1 engine, retired in favor of
   `docs/opinion-engine-v2.md`. Kept for history; do not use as current documentation."*

7. **Update `AGENTS.md`'s transitional-state table.** Remove any row this makes stale
   (check for one referencing opinion automation) and, if T16's budget row or others
   reference opinion behavior indirectly, leave those alone — this task only touches
   rows specifically about the opinion engine.

## Verify

```bash
grep -rc "triggerDiscussionRound\|checkSynthesizingOpinions\|checkAndFinalizeConsensus\|buildVotePrompt\|HARD_NODE_LIMIT" src/
```
Expected output: `0`

```bash
grep -rc "V2\b" src/fleet/ src/opinions/ 2>/dev/null
```
Expected output: `0` — no lingering `V2` suffix anywhere.

```bash
test -f src/fleet/opinion-router-v2.ts && echo "STILL EXISTS — FAIL" || echo "OK"
```
Expected output: `OK`

```bash
grep -c "synthesis" PROTOCOL.md
```
Expected: `0`, or only in a changelog-style note about the v0.1 → v0.2 change if you
added one — not in the active enum or constraint text.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression against the full suite — this is the task most
likely to break something, since it's the only one deleting live code paths.

```bash
DATABASE_URL=<test db> npm run test:integration
```
Expected: full pass, including whatever integration tests T31/T32 added — they should
still pass unchanged now that their target functions have lost the `V2` suffix, since
only names changed, not behaviour.

## Stop conditions

- **If the precondition at the top isn't confirmed, stop before making any change.**
  This is the one task in the entire queue where "I wasn't sure, so I proceeded anyway"
  is the wrong default.
- If step 4's renaming touches more call sites than expected (something outside
  `src/fleet/` and `src/opinions/` imports these names), stop and report the full list
  rather than renaming blind across the repo.
- If any test written for v1 (beyond the ones explicitly deleted in step 1) starts
  failing, that test was checking v1-specific behavior nothing told you to delete —
  stop and report it rather than deleting the test to make the suite pass.

## Commit

```
refactor(opinions): retire the v1 synthesis engine in favor of v2

v1's fixes (T15, T22-T24) were correct for code that was live at the
time. This isn't a revert of that work — it's removing the system
those fixes were keeping correct, now that v2 replaces it.
```
