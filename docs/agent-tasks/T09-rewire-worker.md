# T09 — Route `workers/reviewer.ts` through the service layer

**Mark:** AGENT
**Depends on:** T08
**Estimated diff:** ~150 lines changed

## Files you may modify

- `src/workers/reviewer.ts`

## Context

**This is the highest-value task in the queue.** It is not a cleanup — it switches on
features that are already written and currently inert.

`workers/reviewer.ts` writes reviews with a raw `INSERT INTO clv_reviews` (around
line 625) and then sets task status with its own `UPDATE clv_tasks`. That bypasses
`TaskService.submitReview()`, so every review this worker produces silently skips:

- `budgetSvc.earn(+3)` — the reviewer's principal earns nothing
- the `DUPLICATE_REVIEW` guard
- the consensus-alignment bonus (+2) and high-score bonus (+10)
- `writeMemoryFromReview` — **no conventions are extracted to memory**
- the GitHub PR comment callback

The convention-learning loop is the product's main differentiator and it does not run
on this path.

Keep what makes this worker worth having: the `LISTEN` subscription and the
`FOR UPDATE SKIP LOCKED` claim. Those are better than the manager's polling and are
not in scope to change.

## Steps

1. Replace the local `callLLM` (around line 113) with `executeReview`, as in T08:
   ```ts
   import { executeReview } from '../review/execute.js';
   ```

2. Replace the raw review insert with a REST submission through
   `ConclaveApiClient`. The worker already resolves an agent and its token; use that
   token to construct the client, matching how `fleet/manager.ts` builds
   `apiClients`.

   ```ts
   import { ConclaveApiClient } from '../mcp/api-client.js';
   ```

   Call `client.submitReview(taskId, { scores, weighted_overall, reviewer_confidence, comment, suggestions, approved })`.

3. **Delete** the `UPDATE clv_tasks SET status = 'completed'` block that follows the
   insert, and the `SELECT COUNT(*) FROM clv_reviews` that feeds it.
   `TaskService.submitReview()` owns the status transition and the completion
   bonuses. Leaving this in place double-counts.

4. Keep the confidence normalisation (`> 1` divides by 10) only if
   `src/review/parse.ts` does not already do it. It does — check, and if so remove
   the duplicate here.

5. Keep the `mode` branch that decides `approved`. If mode is `human`, the review
   should not be submitted at all yet — T10 introduces the durable queue. For now,
   preserve whatever the current behaviour is for `human` mode and add a `TODO(T10)`
   comment. Do not invent new behaviour.

## Verify

```bash
grep -c "INSERT INTO clv_reviews" src/workers/reviewer.ts
```
Expected output: `0`

```bash
grep -c "UPDATE clv_tasks SET status = 'completed'" src/workers/reviewer.ts
```
Expected output: `0`

```bash
grep -c "submitReview" src/workers/reviewer.ts
```
Expected: `1` or more.

```bash
grep -c "SKIP LOCKED" src/workers/reviewer.ts
```
Expected: unchanged from before — the claim logic must survive.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Against a **non-production** database with the worker running, submit one task and
confirm all three:

```sql
SELECT * FROM clv_budget_history WHERE action = 'submit_review' ORDER BY created_at DESC LIMIT 1;
SELECT * FROM clv_principal_memory ORDER BY updated_at DESC LIMIT 3;
SELECT status FROM clv_tasks WHERE id = '<task_id>';
```

A row in each of the first two, and a correct status in the third, means the task
worked. Without this check the change is unverified — the unit tests do not cover it.

## Stop conditions

- If the worker has no agent token available to build an API client, stop and
  report. Do not fall back to the raw insert, and do not invent a token source.
- If calling back over HTTP from a process that holds a direct database connection
  seems wrong to you — it is a real tradeoff, and it was decided deliberately.
  The alternative is importing `TaskService` directly. Either is acceptable; a second
  copy of the side effects is not. If you take the `TaskService` route, say so in
  your report.

## Commit

```
fix(worker): submit reviews through the service layer so budget and memory fire
```
