# T26 — The verdict primitive

**Mark:** AGENT (design pass complete)
**Depends on:** T09 (needs reviews flowing through the service layer to be worth
building against)
**Decisions locked:**
- **Blocking rule:** majority approval decides pass/fail; dissent is always included
  in the response, never averaged away.
- **Transport:** SSE primary, long-poll fallback, same endpoint.

This is the integration primitive the product direction from review depends on: one
call that submits work and gets back a decision, for a caller that doesn't want to
poll `GET /v1/tasks/:id` in a loop.

## Files you may modify

- `src/services/verdict.ts` (create)
- `src/routes/tasks.ts` (add one route; reuse existing logic, do not duplicate it)
- `src/mcp/api-client.ts`
- `src/__tests__/verdict.test.ts` (create)
- `src/__tests__/verdict-route.test.ts` (create)
- `vitest.unit.config.ts` / `vitest.integration.config.ts` (add the new tests)
- `docs/integrations/mcp.md` (one section, if T12 already exists — check first)

## What already exists — reuse it, don't rebuild it

`GET /v1/tasks/:id` in `src/routes/tasks.ts` (around line 146) already computes
exactly the majority-approval rule that was chosen:

```ts
approved: approvalCount >= Math.ceil(reviews.length / 2)
```

alongside `avg_overall`, `avg_scores`, `approval_rate`, `top_suggestions`. This task
extracts that block into a named, reusable function and adds **dissent** to it — the
one thing the existing shape doesn't carry. It does not reinvent the scoring rule.

`REVIEW_SUBMITTED` is already broadcast via `pulseHub.broadcastToOrg` on every review
(`src/routes/tasks.ts`, in the review-submission handler) with `{ taskId, reviewId,
reviewerId }`. The verdict stream listens for this event filtered by `taskId` — no new
broadcast plumbing needed.

## Steps

1. Create `src/services/verdict.ts`:

   ```ts
   export interface Dissent {
     reviewer_id: string;
     approved: boolean;
     weighted_overall: number;
     comment: string;
   }

   export interface Verdict {
     status: 'pending' | 'decided';
     task_status: string;              // the underlying task.status, passed through
     reviews_received: number;
     reviews_requested: number;
     approved: boolean | null;         // null while status is 'pending'
     approval_rate: number | null;     // 0-100, null while pending
     avg_overall: number | null;
     avg_scores: Record<string, number>;
     dissent: Dissent[];               // reviewers who disagreed with the majority
     top_suggestions: string[];
   }

   export function computeVerdict(
     reviews: ReturnType<typeof formatReview>[],  // import the real return type from TaskService
     task: { status: string; requested_reviews: number },
   ): Verdict;
   ```

   Move the scoring body from `GET /v1/tasks/:id` into this function verbatim — same
   dimension averaging, same suggestion de-duplication, same `Math.ceil(reviews.length
   / 2)` majority rule. Do not change the arithmetic.

   Add dissent: once `approved` is computed, `dissent` is every review whose
   `approved` does not match it, carrying enough to explain *why* — reviewer id,
   its own approval, its score, its comment. When `reviews.length === 0`, return
   `status: 'pending'` with nulls and an empty dissent array. `status` is `'decided'`
   once `task.status === 'completed'`, `'pending'` otherwise — regardless of how many
   reviews are in, because more can still arrive under `human`/`hybrid` mode.

2. In `GET /v1/tasks/:id`, replace the inline `review_summary` IIFE with a call to
   `computeVerdict`. The response field name `review_summary` must not change — this
   task must not break the dashboard, which reads that key. Add the new fields
   (`dissent`, `status`) into the same object rather than introducing a second one.

3. Add `GET /v1/tasks/:id/verdict` to `src/routes/tasks.ts`:

   - Default (no query param): **long-poll.** Compute the verdict immediately; if
     `status === 'decided'`, return it as `200` right away. If `pending`, hold the
     request open (reuse the pattern from `src/routes/pulse.ts` — `reply.raw`, a
     never-resolving promise) and resolve as soon as a `REVIEW_SUBMITTED` event for
     this `taskId` produces a `decided` verdict, or after a timeout — default 90s, via
     `?timeout_ms=`. On timeout, return the current `pending` verdict with `200`, not
     an error; the caller decides whether to retry.
   - `?stream=sse`: **SSE.** Same headers and cleanup pattern as `pulseRoutes`, same
     `pulseHub.on('org:...')` subscription, but filter events to this `taskId` and
     emit a freshly computed verdict on each matching `REVIEW_SUBMITTED`, closing the
     stream itself (not waiting for client disconnect) once a `decided` verdict is
     sent.

   Both modes call `computeVerdict` fresh each time — do not cache it. Scope both to
   `request.orgId` exactly like `GET /v1/tasks/:id` does; a verdict is not public
   across orgs.

4. Add `ConclaveApiClient.getVerdict(taskId, opts?: { timeoutMs?: number })` — a plain
   `fetch` to the long-poll variant, since MCP tool calls are request/response, not
   streaming. This is the method C3's adapters will actually call.

5. Create `src/__tests__/verdict.test.ts` — pure unit tests of `computeVerdict`, no
   database:
   - empty reviews → `pending`, nulls, empty dissent
   - unanimous approval → `decided`, `approved: true`, empty dissent
   - 2-of-3 approve → `approved: true`, `dissent` contains the one reviewer who didn't
   - a tie (2-of-4) → `Math.ceil(4/2) = 2`, so `approved: true` — assert this exact
     rule, since "ties round to approved" is a real behavioural choice worth locking
     in a test, not just inheriting silently
   - task not yet `completed` even with enough reviews in → still `pending` (matches
     step 1's rule)

6. Create `src/__tests__/verdict-route.test.ts` — integration test (needs a database,
   follow `agent-detail.test.ts`'s setup). Assert:
   - long-poll returns immediately when the verdict is already decided
   - long-poll times out and returns a `pending` verdict with `200`, not an error, when
     `timeout_ms` is small and no review arrives
   - a cross-org request is rejected the same way `GET /v1/tasks/:id` rejects one

## Verify

```bash
grep -c "function computeVerdict" src/services/verdict.ts
```
Expected output: `1`

```bash
grep -c "review_summary" src/routes/tasks.ts
```
Expected: unchanged from before this task — the field name survives.

```bash
npx vitest run src/__tests__/verdict.test.ts
```
Expected: all five cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

```bash
DATABASE_URL=<test db> npx vitest run --config vitest.integration.config.ts src/__tests__/verdict-route.test.ts
```
Expected: all three cases pass. Needs a live non-production database.

## Stop conditions

- If the long-poll implementation can't resolve within the timeout under real load
  (event listener never fires, or fires after the response already timed out and
  crashes on double-write), that's a real bug — stop and report the failure mode
  rather than adding a broad try/catch around it.
- Do not change `Math.ceil(reviews.length / 2)`. It was chosen as the majority rule;
  if you think it's wrong, say so in your report, don't quietly pick a different one.
- Do not add authentication other than what `GET /v1/tasks/:id` already uses — this is
  not a new trust boundary.

## Commit

```
feat(tasks): add a verdict primitive — majority decision with dissent, SSE and long-poll
```
