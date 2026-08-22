# T13 — Extract the opinion state machine

**Mark:** AGENT (design pass complete — the target is fully specified)
**Depends on:** nothing in the T00–T12 chain; can run in parallel
**Estimated diff:** one new file, ~11 call sites changed

## Read first

`docs/opinion-state-machine.md`. It contains the full transition table, the counts each
guard needs, and the exact required behaviour of the function you are writing. **Do not
derive the transitions yourself — they are already derived.**

## Files you may modify

- `src/opinions/machine.ts` (create)
- `src/fleet/opinion-router.ts`

## The rule that matters most

**Preserve behaviour exactly, including the defects.**

`docs/opinion-state-machine.md` lists seven known defects (D1–D7). This task fixes
**none** of them. T14 writes tests that lock in current behaviour; the fixes come after,
each as its own task with its own test change.

If you fix a bug here, T14's tests will encode the fixed behaviour, and nobody will ever
find out which of the seven were real. Resist it.

The one exception is the `VOTE_ROUND_STARTED` collapse, which the design doc marks as
intentional and specifies precisely.

## Steps

1. Create `src/opinions/machine.ts` containing exactly the types and function signature
   given under **Target: `nextState()`** in the design doc, implementing the behaviour in
   the **Required behaviour** block. Evaluate conditions in the order written.

   Export `HARD_NODE_LIMIT = 25` from this module and import it in the router rather
   than keeping two copies.

   The function must be pure: no database access, no `Date.now()`, no logging.

2. In `src/fleet/opinion-router.ts`, replace each of the eleven status writes with:
   gather the counts, call `nextState`, apply the single returned transition. Use one
   private helper so there is exactly one `UPDATE clv_opinions SET status` statement in
   the file:

   ```ts
   private async applyTransition(opinionId: string, t: Transition | null): Promise<void> {
     if (!t) return;
     if (t.closeTag) {
       await this.sql`UPDATE clv_opinions SET status = ${t.status}, close_tag = ${t.closeTag} WHERE id = ${opinionId}`;
     } else {
       await this.sql`UPDATE clv_opinions SET status = ${t.status} WHERE id = ${opinionId}`;
     }
   }
   ```

3. Add a private helper that loads `OpinionCounts` for an opinion id. The six queries are
   listed in the design doc under **Counts the guards depend on**; the existing ones are
   already in `checkAndFinalizeConsensus` — move them, do not rewrite them. In
   particular keep the `votesOnSynthesis` query's edge direction exactly as it is
   (`e.source_node_id = synthId`), and keep the reversed `followUpEdges` query's absence
   — it is unused, so simply do not carry it over.

4. **Transition 2 also writes `metadata`.** Line 845 records the route error:
   `SET status = 'open', metadata = ${meta}`. `applyTransition` handles status and
   `close_tag` only, so keep that metadata write at the call site — apply the
   transition, then write metadata, or pass it through as an optional argument. Do not
   drop it; it is the only record of why routing failed.

5. **Leave the claim `UPDATE` at line 811 alone.** It is an atomic
   `FOR UPDATE SKIP LOCKED` claim; its `SET status = 'in_review'` is part of the
   concurrency primitive. Do not route it through `applyTransition`. It is the one
   permitted second write site.

6. Preserve every early return that currently exists. If `triggerVoteRound` returns early
   when there is no synthesis node, it must still do so. Those early returns *are* D3;
   removing them is a fix, and fixes are out of scope.

## Verify

```bash
grep -c "SET status" src/fleet/opinion-router.ts
```
Expected output: `2` — one inside `applyTransition`, one in the atomic claim.

```bash
grep -c "HARD_NODE_LIMIT" src/opinions/machine.ts
```
Expected: `1` or more (the definition).

```bash
grep -c "const HARD_NODE_LIMIT\|HARD_NODE_LIMIT =" src/fleet/opinion-router.ts
```
Expected output: `0` — the router imports it, it does not define it.

```bash
grep -c "followUpEdges" src/fleet/opinion-router.ts
```
Expected output: `0`

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If a status write does not map onto one of the six events in the design doc, **stop and
  report it**. That means the table is incomplete and the design doc needs updating
  before the extraction is safe.
- If removing a duplicated query changes which rows it returns, restore the original and
  report.
- Do not add, remove, or rename a state. Do not touch `routes/opinions.ts`.

## Commit

```
refactor(opinions): extract pure state machine from the opinion router
```
