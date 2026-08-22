# T03 — Prove the cron review path is dead

**Mark:** AGENT
**Depends on:** T02
**Estimated diff:** one new file (a report). No source changes.

## Files you may modify

- `docs/agent-tasks/T03-findings.md` (create)

## Context

`src/routes/cron.ts` is scheduled to be deleted in T04. Before deleting it, prove it
is not the only thing producing reviews in production.

The route appears broken: it writes a `reviewsReceived` column to `clv_tasks` that
exists in neither `src/db/schema.ts` nor the boot DDL in `src/db/index.ts`, and it
inserts into `clv_principals` and `clv_agents` without an `id` (a TEXT primary key
with no default) or an `orgId` (NOT NULL). If that analysis is right, every call has
been failing and no reviews have come from this path.

**This task confirms or refutes that. It changes no source code.**

## Steps

1. Confirm the schema analysis without a database:

   ```bash
   grep -c "reviewsReceived" src/db/schema.ts
   grep -c "reviews_received" src/db/index.ts
   ```
   Both should print `0`. Record the actual numbers.

2. If a `DATABASE_URL` for a non-production database is available in the environment,
   run this query and record the result. **Do not connect to production.** If no such
   URL is available, skip to step 3 and record that the query could not be run.

   ```sql
   SELECT COUNT(*) AS cron_reviews
   FROM clv_reviews r
   JOIN clv_principals p ON r.principal_id = p.id
   WHERE p.name IN ('Code Reviewer', 'General Reviewer');
   ```

3. Write `docs/agent-tasks/T03-findings.md` containing:
   - the two grep counts from step 1
   - the query result, or a note that it could not be run and why
   - a one-line verdict: `SAFE TO DELETE` or `DO NOT DELETE`

   The verdict is `SAFE TO DELETE` only if both grep counts are `0` **and** the query
   either returned `0` or could not be run. Any other combination is `DO NOT DELETE`.

## Verify

```bash
test -f docs/agent-tasks/T03-findings.md && grep -qE "SAFE TO DELETE|DO NOT DELETE" docs/agent-tasks/T03-findings.md && echo OK
```
Expected output: `OK`

## Stop conditions

- Do not connect to any database whose host contains `render.com` or that you were
  not explicitly given. If the only available `DATABASE_URL` points at production,
  skip the query and record that.
- If the verdict is `DO NOT DELETE`, stop after writing the findings file. Do not
  start T04. Report the verdict.

## Commit

```
docs(tasks): record cron review path liveness findings
```
