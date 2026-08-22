# T21 — Surface the reviewer scorecard

**Mark:** AGENT
**Depends on:** T20
**Part of:** the reviewer scorecard chain (T19 → T20 → T21)

> **Optional product work.** See the note at the top of T19.

## Files you may modify

- `src/routes/scorecard.ts` (create)
- `src/server/index.ts` (route registration only)
- `public/dashboard.js`
- `public/dashboard.html`
- `src/__tests__/scorecard-routes.test.ts` (create)
- `vitest.integration.config.ts` (add the new test to `include`)

## Context

T20 computes scorecards into `clv_reviewer_scorecards`. Nothing reads them yet. Without
this task the chain produces a table nobody sees — the same failure mode as reputation.

## Steps

1. Create `src/routes/scorecard.ts` with two routes:

   - `GET /v1/scorecards` — every scorecard for the caller's org, joined to
     `clv_agents` for name, model and provider, so a row is readable without a second
     lookup. Sort by `reviewsGiven` descending.
   - `GET /v1/scorecards/:agentId` — one scorecard. 404 when the agent does not exist;
     when the agent exists but has no scorecard row, return 200 with
     `computed: false`, matching the convention T18 established for reputation.

   Scope both to `request.orgId` and return 403 on a cross-org request, following the
   pattern in `src/routes/agents.ts`.

2. Register in `src/server/index.ts` alongside the other `/v1` routes:

   ```ts
   await fastify.register(scorecardRoutes, { prefix: '/v1' });
   ```

3. Add a **Reviewers** panel to the dashboard. Follow the existing view pattern — a
   `view-*` container in `dashboard.html` plus a `refresh*` function in `dashboard.js`
   wired into `switchView`. Read how an existing view does it before writing; do not
   invent a new mechanism.

   Render one row per agent with: name, model, reviews given, helpful/unhelpful counts,
   alignment delta, approval agreement.

   Show the two-axis reading from T20 as a short legend under the table, because the
   numbers do not interpret themselves:

   ```
   High helpful + high delta  → catches what others miss. Your best reviewer.
   High helpful + low delta   → useful but likely redundant.
   Low helpful  + low delta   → rubber stamp. First candidate to cut.
   Low helpful  + high delta  → noisy. Retune the instructions.
   ```

   Do **not** rank the table by a composite score. Sorting by reviews given is enough.

4. Create `src/__tests__/scorecard-routes.test.ts` — an integration test, since it needs
   a database. Follow `src/__tests__/agent-detail.test.ts` for setup and teardown.
   Assert:
   - `GET /v1/scorecards` returns only the caller's org
   - `GET /v1/scorecards/:agentId` returns `computed: false` for an agent with no row
   - a cross-org request returns 403
   - a nonexistent agent returns 404

   Add it to `vitest.integration.config.ts`, not the unit config.

## Verify

```bash
grep -c "scorecardRoutes" src/server/index.ts
```
Expected: `2` — the import and the registration.

```bash
node --check public/dashboard.js
```
Expected: exits 0.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

```bash
DATABASE_URL=<test db> npx vitest run --config vitest.integration.config.ts src/__tests__/scorecard-routes.test.ts
```
Expected: all four cases pass. Needs a live non-production database.

## Manual check (ask a human to run this)

With at least one completed task that has feedback recorded via T19, open the Reviewers
panel and confirm the row shows non-zero counts matching
`SELECT * FROM clv_reviewer_scorecards`.

## Stop conditions

- If `switchView` does not cleanly support a new view, stop and report rather than
  refactoring it. `dashboard.js` is 1,362 lines with no tests, and a merged commit in its
  history is titled "clean a-la- la l la JS fragments" — it has been corrupted by
  tooling before. Additive changes only.
- Do not add a composite ranking or a "best reviewer" badge.

## Commit

```
feat(scorecard): expose reviewer scorecards via API and dashboard panel
```
