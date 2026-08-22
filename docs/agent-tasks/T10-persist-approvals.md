# T10 — Persist the human-approval queue

**Mark:** AGENT
**Depends on:** T09
**Estimated diff:** one table, ~80 lines changed

## Files you may modify

- `src/db/schema.ts`
- `src/db/index.ts` (the boot DDL block only)
- `src/fleet/manager.ts`
- `src/workers/reviewer.ts`

## Context

`src/fleet/manager.ts` line 256 holds the approval queue in memory:

```ts
private pendingApprovals: PendingReview[] = [];
```

Every draft queued by a `human` or `hybrid` reviewer is lost on restart, and
`GET /v1/fleet/status` reports a count that silently resets to zero.

## Steps

1. Add to `src/db/schema.ts`, following the existing conventions in that file — TEXT
   ids with semantic prefixes, TEXT timestamps, JSON stored as TEXT:

   ```ts
   export const pendingReviews = pgTable('clv_pending_reviews', {
     id: text('id').primaryKey(),                  // pnd_<uuidv7>
     orgId: text('org_id').notNull().references(() => organizations.id),
     principalId: text('principal_id').notNull().references(() => principals.id),
     agentId: text('agent_id').notNull().references(() => agents.id),
     taskId: text('task_id').notNull().references(() => tasks.id),
     draft: text('draft').notNull(),               // JSON — the ReviewOutput
     status: text('status').notNull().default('pending'), // pending | approved | rejected
     createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
     resolvedAt: text('resolved_at'),
   }, (table) => ({
     orgStatusIdx: index('idx_pending_org_status').on(table.orgId, table.status),
   }));
   ```

2. Add a matching `CREATE TABLE IF NOT EXISTS clv_pending_reviews (...)` to the DDL
   block in `src/db/index.ts`. Match the style of the statements already there and
   place it after the `clv_reviews` statement. Column types must match the Drizzle
   definition exactly.

3. In `src/fleet/manager.ts`, convert the four queue operations to database calls,
   keeping their existing signatures:
   - `getPendingApprovals()` — select where `status = 'pending'`, scoped to
     `this.config.org_id`
   - the two `push` sites (around lines 925 and 947) — insert a row
   - `approvePending(pendingId, edits?)` — read the row, apply `edits` to the draft,
     submit the review through the same path `reviewTask` uses, then set
     `status = 'approved'` and `resolvedAt`
   - `rejectPending(pendingId)` — set `status = 'rejected'` and `resolvedAt`

   Delete the `pendingApprovals` array field. `getStats()` reads its count from the
   database instead.

4. In `src/workers/reviewer.ts`, replace the `TODO(T10)` left by T09: when mode is
   `human`, insert a pending row instead of submitting.

## Verify

```bash
grep -c "pendingApprovals" src/fleet/manager.ts
```
Expected output: `0`

```bash
grep -c "clv_pending_reviews" src/db/index.ts src/db/schema.ts
```
Expected: `1` in each file (`schema.ts` matches the table name string).

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Against a non-production database: queue a draft with a `human`-mode reviewer,
restart the worker, then call `GET /v1/fleet/status`. The pending count must survive
the restart.

## Stop conditions

- If the DDL block in `src/db/index.ts` has a different column-type convention than
  the Drizzle schema (for example `TIMESTAMP` rather than `TEXT`), follow the DDL
  block's existing convention and report the discrepancy.
- Do not add a migration file. This project creates tables through the boot DDL; do
  not introduce a second mechanism.

## Commit

```
fix(fleet): persist the human approval queue across restarts
```
