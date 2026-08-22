# T18 — Stop reputation returning fabricated scores

**Mark:** AGENT
**Depends on:** T02
**Estimated diff:** ~40 lines

## Files you may modify

- `src/services/reputation.ts`
- `src/routes/reputation.ts`
- `src/mcp/index.ts` (the reputation tool's output only)
- `src/mcp/api-client.ts` (`markHelpful` only)
- `src/__tests__/reputation-dormant.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)
- `AGENTS.md` (transitional state table only)

## Context

The reputation subsystem has never run.

- `computeAndSnapshot()` has **zero callers** anywhere in the repository.
- With no snapshot, `getByPrincipal()` returns a hand-built object of `0` values.
- `computeAndSnapshot()` hardcodes `reviewerAlignment: 0` and `reviewerHelpfulness: 0`
  even when it does run — it never reads the `helpful` column.
- The dashboard has **zero references** to reputation or the leaderboard. It is not
  displayed anywhere.

So `GET /v1/reputation/:id` returns `overall: 0`, which reads as "this agent scored
zero" when the truth is "nothing was ever computed". A number that lies is worse than
an absent number.

**This task does not build reputation.** It makes the subsystem tell the truth about
its own state. Building it is T19–T21, which are optional product work.

## Steps

1. In `src/services/reputation.ts`, change the no-snapshot branch of `getByPrincipal()`
   to return `null` for every score and an explicit marker, rather than zeros:

   ```ts
   return {
     principal_id: principalId,
     computed: false,
     performer: { overall: null, by_dimension: {}, confidence: null, total_tasks_completed: 0 },
     reviewer: { overall: null, alignment_score: null, helpfulness_score: null, total_reviews_given: 0 },
   };
   ```

   Add `computed: true` to the branch that does find a snapshot. Apply the same change
   to the no-snapshot fallback inside `__bulkGetByPrincipals()`.

2. In `getLeaderboard()`, exclude principals whose reputation is not computed rather
   than ranking them at zero. If none are computed, return an empty array. A leaderboard
   of fabricated zeros is the same lie in aggregate.

3. In `src/routes/reputation.ts`, pass the `computed` flag straight through in the
   response envelope. Do not translate it into a 404 — the principal exists, its
   reputation simply has not been computed.

4. In `src/mcp/index.ts`, find the reputation tool's output formatting (around line 715,
   where it prints `Helpfulness: ${rep.reviewer?.helpfulness_score ?? 0}`). When
   `computed` is false, print a single line instead:

   ```
   Reputation has not been computed for this principal yet.
   ```

   Remove the `?? 0` fallbacks in that block so a null can never render as a zero.

5. **Fix the broken client method.** `ConclaveApiClient.markHelpful` sends only
   `{ review_id: reviewId }`, but `MarkHelpfulSchema` requires
   `helpful: z.boolean()` — so every call through the client returns 422. Change the
   signature to accept and send the flag:

   ```ts
   async markHelpful(taskId: string, reviewId: string, helpful: boolean) {
     return this.request('POST', `/tasks/${taskId}/helpful`, { review_id: reviewId, helpful });
   }
   ```

   Update any caller. If there are none, that is expected — record it in your report.

6. Create `src/__tests__/reputation-dormant.test.ts` asserting:
   - with no snapshot, `getByPrincipal()` returns `computed: false` and `overall` is
     `null`, not `0`
   - with a snapshot present, `computed` is `true` and the values come from the snapshot
   - `getLeaderboard()` returns `[]` when nothing is computed
   - `markHelpful` includes `helpful` in its request body

   Mock the database; this must run without a live connection.

7. Add a row to the transitional-state table in `AGENTS.md`:

   | Current state | Why it exists | Converge when |
   |---|---|---|
   | Reputation is dormant — `computeAndSnapshot()` has no caller and endpoints report `computed: false` | The score has no input signal: no UI captures the `helpful` flag | T19–T21 land a reviewer scorecard |

## Verify

```bash
grep -c "computed" src/services/reputation.ts
```
Expected: `3` or more.

```bash
grep -c "overall: 0" src/services/reputation.ts
```
Expected output: `0`

```bash
grep -c "helpful" src/mcp/api-client.ts
```
Expected: `2` or more — parameter and body.

```bash
npx vitest run src/__tests__/reputation-dormant.test.ts
```
Expected: all four cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If a consumer breaks on `null` where it expected a number, report it rather than
  restoring the zeros. The dashboard does not read these endpoints, so the blast radius
  should be limited to the MCP tool.
- Do not delete `computeAndSnapshot()`, the `clv_reputation_snapshots` table, or the
  time-decay maths. The computation is correct and well-written; it is only unreachable.

## Commit

```
fix(reputation): report dormant state instead of fabricated zero scores
```
