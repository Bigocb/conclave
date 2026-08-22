# T19 — Capture the review feedback signal

**Mark:** AGENT
**Depends on:** T18
**Part of:** the reviewer scorecard chain (T19 → T20 → T21)

> **Optional product work.** T19–T21 build a feature that does not exist today. They are
> not remediation. Skip the whole chain if you do not want a reviewer scorecard — T18
> already leaves the reputation subsystem honest about being dormant.

## Files you may modify

- `public/dashboard.js`
- `src/routes/tasks.ts` (the helpful route's response only)
- `src/__tests__/mark-helpful.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)

## Context

`POST /v1/tasks/:id/helpful` works and awards budget, but **nothing calls it**. The
dashboard has zero references to it, and the client method was broken until T18 fixed
it. So `clv_reviews.helpful` is null for every row.

Every metric in T20 depends on this column having values. Without a capture path, the
scorecard has no input — this task is the actual prerequisite, not a nicety.

## Steps

1. In `public/dashboard.js`, find the individual-review rendering inside
   `viewTaskDetail` — the `task.reviews.forEach(r => {` block at roughly line 914. Each
   review renders a card with the reviewer id, an approved/denied badge, the comment, and
   score chips.

   Add a feedback control to that card, after the score chips:

   ```js
   <div class="flex items-center gap-2 mt-3 pt-3 border-t border-[#1e2d4a]">
     <span class="text-[10px] text-gray-500 uppercase tracking-wider">Was this useful?</span>
     <button onclick="rateReview('${taskId}', '${r.id}', true)"
       class="text-xs px-2 py-1 rounded ${r.helpful === true ? 'bg-green-500/20 text-green-400' : 'bg-white/5 text-gray-500 hover:text-green-400'}">Yes</button>
     <button onclick="rateReview('${taskId}', '${r.id}', false)"
       class="text-xs px-2 py-1 rounded ${r.helpful === false ? 'bg-red-500/20 text-red-400' : 'bg-white/5 text-gray-500 hover:text-red-400'}">No</button>
   </div>
   ```

   `r.helpful` is already returned by `formatReview` in `src/services/tasks.ts` as
   `true`, `false`, or `null`, so the current state renders without any API change.

2. Add the handler alongside `dismissTask`:

   ```js
   async function rateReview(taskId, reviewId, helpful) {
     try {
       await apiRequest(`/v1/tasks/${taskId}/helpful`, 'POST', { review_id: reviewId, helpful });
       showToast(helpful ? 'Marked useful' : 'Marked not useful', 'success');
       viewTaskDetail(taskId);
     } catch (e) {
       showToast(`Could not save feedback: ${e.message}`, 'error');
     }
   }
   ```

   **Watch the call signature.** `apiRequest(endpoint, method = 'GET', body = null)` is
   positional. `dismissTask` calls it as `apiRequest(url, { method: 'POST' })`, which is
   wrong — it passes an object where the method string belongs. Do not copy that
   pattern. Do not fix `dismissTask` here either; note it in your report.

3. The route currently returns only `{ review_id, helpful }`. Leave the shape alone —
   step 1 re-fetches the task to refresh state.

4. Create `src/__tests__/mark-helpful.test.ts` asserting that `MarkHelpfulSchema`:
   - accepts `{ review_id: 'rev_x', helpful: true }`
   - accepts `helpful: false`
   - rejects a body with `review_id` but no `helpful`
   - rejects a non-boolean `helpful`

   The fourth case is what T18's client fix was about — keep it as a regression guard.

## Verify

```bash
grep -c "rateReview" public/dashboard.js
```
Expected: `3` — two buttons and the function definition.

```bash
grep -c "apiRequest(\`/v1/tasks/\${taskId}/helpful\`, 'POST'" public/dashboard.js
```
Expected output: `1` — positional call, not an options object.

```bash
npx vitest run src/__tests__/mark-helpful.test.ts
```
Expected: all four cases pass.

```bash
node --check public/dashboard.js
```
Expected: exits 0.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Open a completed task in the dashboard, click **Yes** on a review, and confirm the
button turns green and stays green after reopening the task. Then confirm
`SELECT helpful FROM clv_reviews WHERE id = '<review_id>'` is `1`.

## Stop conditions

- If `showToast` does not exist under that name, find the real notification helper in
  `dashboard.js` and use it. Do not add a new one.
- Do not refactor `viewTaskDetail`. Add to the existing template string; the function is
  long, and rewriting it puts every other view at risk.

## Commit

```
feat(dashboard): capture reviewer feedback on individual reviews
```
