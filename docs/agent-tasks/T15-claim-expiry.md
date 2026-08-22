# T15 — Claim expiry for stranded opinions

**Mark:** AGENT
**Depends on:** T13, T14
**Fixes:** D1 and D2 from `docs/opinion-state-machine.md`
**Estimated diff:** two columns, one query, one test change

## Files you may modify

- `src/db/schema.ts`
- `src/db/index.ts` (boot DDL block only)
- `src/opinions/machine.ts`
- `src/fleet/opinion-router.ts`
- `src/__tests__/opinion-machine.test.ts`

## Context

**D1:** `processNextOpinion` selects only `status = 'open'`. Nothing selects
`in_review`. A router that dies mid-critique strands the opinion permanently.

**D2:** `routeOpinion` returns without a status write when the subscriber query comes
back empty, leaving `in_review`. Combined with D1, permanent.

This is the first task in the sequence that changes behaviour on purpose. T14's tests
exist so you can see exactly what moved.

## Steps

1. Add two columns to `clv_opinions` in `src/db/schema.ts`:

   ```ts
   claimedAt: text('claimed_at'),
   claimedBy: text('claimed_by'),
   ```

   Add the matching `ALTER TABLE clv_opinions ADD COLUMN IF NOT EXISTS ...` statements
   to the DDL block in `src/db/index.ts`, following the style already used there. Do not
   add a migration file — this project creates schema through the boot DDL.

2. In `src/fleet/opinion-router.ts`, set both columns in the atomic claim at line 811.
   Use a stable per-process identifier generated once at router startup:

   ```ts
   SET status = 'in_review', claimed_at = ${now}, claimed_by = ${this.routerId}
   ```

3. Widen the claim predicate so an expired claim is reclaimable. Replace
   `WHERE o.status = 'open'` with:

   ```sql
   WHERE (
     o.status = 'open'
     OR (o.status = 'in_review' AND o.claimed_at < ${staleBefore})
   )
   ```

   where `staleBefore` is an ISO timestamp `CLAIM_TTL_MINUTES` in the past. Default it to
   15 and read it from `process.env.CLAIM_TTL_MINUTES`. `claimed_at` is TEXT holding
   ISO-8601, which compares correctly as a string — match the existing convention, do not
   change the column type.

4. Clear both columns on every terminal transition. Extend `applyTransition` from T13 so
   any transition to `open`, `synthesizing`, `voting`, or `closed` also sets
   `claimed_at = NULL, claimed_by = NULL`. Only the claim sets them.

5. Fix D2 directly: in `routeOpinion`, the early return when the subscriber query is
   empty must apply a transition back to `open` rather than returning bare. Add a
   `NO_SUBSCRIBERS` event to `src/opinions/machine.ts`:

   ```
   NO_SUBSCRIBERS                          → { status: 'open' }
   ```

6. Update `src/__tests__/opinion-machine.test.ts`:
   - add cases for `NO_SUBSCRIBERS` from `in_review` and from `open`
   - leave every other case unchanged

   If any pre-existing case now fails, you have changed more than intended. Revert and
   report.

## Verify

```bash
grep -c "claimed_at" src/db/index.ts src/fleet/opinion-router.ts
```
Expected: at least `1` in each.

```bash
npx vitest run src/__tests__/opinion-machine.test.ts
```
Expected: all cases pass, including the three defect-locking ones for D3/D4/D5 — this
task fixes D1 and D2 only, so those three must be untouched.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Against a non-production database:

1. Start the opinion router, submit an opinion, and kill the process while it is in
   `in_review`.
2. Confirm the row sits in `in_review` with a non-null `claimed_at`.
3. Restart the router and wait past `CLAIM_TTL_MINUTES` (set it to 1 for the test).
4. The opinion must be reclaimed and progress.

Without step 4 the fix is unverified — no unit test covers the SQL predicate.

## Stop conditions

- If widening the claim predicate makes the `FOR UPDATE SKIP LOCKED` statement fail to
  parse, stop and report the statement. Do not restructure the claim into multiple
  queries — the atomicity is the point.
- Do not remove the compensating poll in `checkVotingOpinions` in this task. It works
  around D3, which is still open. Removing it belongs with the D3 fix.

## Commit

```
fix(opinions): reclaim stranded in_review opinions via claim expiry
```
