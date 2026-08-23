# T28 — Add the opinion ballot table

**Mark:** AGENT (design pass complete — read `docs/opinion-engine-v2.md` first)
**Depends on:** nothing in the T00–T27 chain
**Estimated diff:** one table, one migration statement

## Read first

`docs/opinion-engine-v2.md`, section **Schema — one new table**. This task builds
exactly that table. Do not modify its columns or the unique index.

## Files you may modify

- `src/db/schema.ts`
- `src/db/index.ts` (boot DDL block only)

## Context

v2's whole fix for D6 depends on this table existing: one row per critic per opinion,
with a unique constraint that makes a double vote impossible at the database level
rather than an application check that can be forgotten. `approved` is nullable on
purpose — it distinguishes "voted no" from "never produced a usable vote," which v1's
graph-edge counting couldn't tell apart.

This task is purely additive. Nothing reads or writes this table yet — T29 defines the
pure logic that will use it, T32 wires the router to populate it.

## Steps

1. Add to `src/db/schema.ts`, following the file's existing conventions (TEXT primary
   keys with semantic prefixes, TEXT timestamps via `$defaultFn`):

   ```ts
   export const opinionBallots = pgTable('clv_opinion_ballots', {
     id: text('id').primaryKey(),                      // bal_<uuidv7>
     opinionId: text('opinion_id').notNull().references(() => opinions.id),
     principalId: text('principal_id').notNull().references(() => principals.id),
     agentId: text('agent_id').notNull().references(() => agents.id),
     approved: integer('approved'),                     // 1 | 0 | null — this project
                                                          // stores booleans as integers
                                                          // elsewhere (see clv_reviews);
                                                          // match that convention here
     confidence: doublePrecision('confidence'),
     reasoning: text('reasoning'),
     attemptCount: integer('attempt_count').notNull().default(1),
     createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
   }, (table) => ({
     opinionPrincipalIdx: index('idx_ballots_opinion_principal').on(table.opinionId, table.principalId),
   }));
   ```

   The design doc's SQL sketch uses a native `BOOLEAN` column and a `UNIQUE` index.
   Check `clv_reviews.approved` in this same file first — if this project stores
   booleans as `integer` throughout (it does, as of writing), follow that convention
   here for consistency rather than the doc's literal SQL. Note this choice in your
   report if you deviate from the doc for this reason.

2. Add the matching `CREATE TABLE IF NOT EXISTS clv_opinion_ballots (...)` to the DDL
   block in `src/db/index.ts`, placed after the `clv_blackboard_edges` statement.
   Column types must match the Drizzle definition exactly, including the boolean
   representation decided in step 1.

3. Add the unique constraint as a genuine database constraint, not just an index:

   ```sql
   ALTER TABLE clv_opinion_ballots ADD CONSTRAINT IF NOT EXISTS
     uq_ballots_opinion_principal UNIQUE (opinion_id, principal_id);
   ```

   Check how existing `ALTER TABLE ... ADD CONSTRAINT` statements in this file handle
   "already exists" — Postgres doesn't support `ADD CONSTRAINT IF NOT EXISTS` in all
   versions used here; if the file already has a pattern for this (a `DO $$ ... EXCEPTION
   WHEN duplicate_object THEN NULL; END $$;` block, for instance), match it rather than
   introducing a new pattern.

   Do not add a migration file — this project creates schema through the boot DDL.

## Verify

```bash
grep -c "clv_opinion_ballots" src/db/schema.ts src/db/index.ts
```
Expected: `1` or more in each.

```bash
grep -c "opinionPrincipalIdx\|idx_ballots_opinion_principal" src/db/schema.ts src/db/index.ts
```
Expected: `1` or more in each.

```bash
npx tsc --noEmit
```
Expected: no new errors.

```bash
npm run test:unit
```
Expected: no regression — this task adds no logic, so nothing should change.

## Stop conditions

- If you can't find an existing pattern for a conditional unique constraint in
  `src/db/index.ts`, add the constraint without the `IF NOT EXISTS` guard and wrap the
  whole statement in the same broad try/catch the surrounding DDL block already uses.
  Report that you did this rather than inventing new error-handling structure.
- Do not add anything to `src/services/` or `src/fleet/` in this task. It is schema
  only.

## Commit

```
feat(opinions): add clv_opinion_ballots for the v2 engine
```
