# T04 — Delete the dead and broken runners

**Mark:** AGENT
**Depends on:** T03 (must have recorded `SAFE TO DELETE`)
**Estimated diff:** ~650 lines removed

## Precondition

Open `docs/agent-tasks/T03-findings.md`. If it does not exist, or its verdict is not
`SAFE TO DELETE`, **stop immediately** and report. Do not proceed on judgement.

## Files you may modify

- `src/reviewer/index.ts` (delete)
- `src/routes/cron.ts`
- `.github/workflows/cron-review.yml` (delete)
- `src/server/index.ts`
- `src/routes/health.ts` (only if it references a deleted route)

## Context

Three review paths exist. One of them (`fleet/manager.ts`) is correct and stays. This
task removes the two that do not work:

- `src/reviewer/index.ts` — 434 lines, superseded by `FleetManager`. The `daemon`
  npm script points at `src/reviewer-daemon.ts`, which imports `FleetManager`, not
  this file.
- `POST /v1/cron/next` and `POST /v1/cron/submit` — broken against the schema, and
  they bypass `TaskService.submitReview()` so they skip budget, the duplicate guard,
  memory extraction, and the GitHub callback.

`POST /v1/cron/memory-cleanup` in the same file is **correct** — it calls
`MemoryService.cleanupExpired()`. Keep it.

## Steps

1. Confirm nothing imports the reviewer daemon:
   ```bash
   grep -rn "reviewer/index" src/ --include=*.ts
   ```
   If this prints any line other than a match inside `src/reviewer/index.ts` itself,
   stop and report. Otherwise delete the file:
   ```bash
   git rm src/reviewer/index.ts
   ```

2. In `src/routes/cron.ts`, delete:
   - the `REVIEWERS` constant array near the top of `cronRoutes`
   - the entire `fastify.all('/cron/next', ...)` handler
   - the entire `fastify.all('/cron/submit', ...)` handler

   Keep `verifySecret` and the `/cron/memory-cleanup` handler. Remove any import that
   is now unused — likely `tasks`, `reviews`, `principals`, `agents`, `channels`,
   `channelSubscriptions`, and `and` from drizzle. Keep the `MemoryService` import.

3. Delete the workflow that drives the removed routes:
   ```bash
   git rm .github/workflows/cron-review.yml
   ```

4. Check whether `src/server/index.ts` needs changes. `cronRoutes` is still
   registered and still valid because `/cron/memory-cleanup` remains — do **not**
   remove the registration. Only change this file if `tsc` reports an error in it.

## Verify

```bash
npx tsc --noEmit
```
Expected: no new errors. Two pre-existing warnings about `downlevelIteration` and a
missing `node` type definition may appear if dependencies are not installed — those
are not yours.

```bash
test ! -f src/reviewer/index.ts && test ! -f .github/workflows/cron-review.yml && echo "deleted OK"
```
Expected output: `deleted OK`

```bash
grep -c "cron/memory-cleanup" src/routes/cron.ts
```
Expected output: `1`

```bash
grep -cE "cron/next|cron/submit|REVIEWERS" src/routes/cron.ts
```
Expected output: `0`

```bash
npm run test:unit
```
Expected: the same pass/fail set recorded in T02. `openapi-spec.test.ts` in
particular must not newly fail.

## Stop conditions

- If `openapi-spec.test.ts` newly fails, the removed routes were asserted in the
  spec test. Stop and report; do not edit the test.
- If removing imports from `cron.ts` causes a type error you cannot resolve in one
  attempt, restore the import and report.

## Commit

```
refactor(review): remove superseded reviewer daemon and broken cron review routes
```
