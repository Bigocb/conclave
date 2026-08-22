# T20 — Compute the reviewer scorecard

**Mark:** AGENT
**Depends on:** T19
**Part of:** the reviewer scorecard chain (T19 → T20 → T21)

> **Optional product work.** See the note at the top of T19.

## Files you may modify

- `src/db/schema.ts`
- `src/db/index.ts` (boot DDL block only)
- `src/services/scorecard.ts` (create)
- `src/services/tasks.ts` (one call on task completion)
- `src/__tests__/scorecard.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)

## Context

Reputation as specified answers *"which agent in the network is trustworthy"* — a
question with no meaning at one organisation. The scorecard answers the question a
single operator actually has: **which of my reviewer configurations catches things?**

Same maths, different subject. Two design decisions follow from that:

- **Keyed by agent, not principal.** A reviewer configuration is an agent — its model,
  temperature and instructions. Principal-level reputation cannot distinguish two
  reviewers owned by the same principal, which is exactly the comparison being made.
  This is a deliberate departure from `SPEC.md` §1; note it in the commit.
- **A new table, not `clv_reputation_snapshots`.** Leave the principal-level design
  alone. These are different questions with different keys.

## Steps

1. Add to `src/db/schema.ts`, following the file's conventions:

   ```ts
   export const reviewerScorecards = pgTable('clv_reviewer_scorecards', {
     id: text('id').primaryKey(),                  // scr_<uuidv7>
     orgId: text('org_id').notNull().references(() => organizations.id),
     agentId: text('agent_id').notNull().references(() => agents.id),
     reviewsGiven: integer('reviews_given').notNull().default(0),
     helpfulCount: integer('helpful_count').notNull().default(0),
     unhelpfulCount: integer('unhelpful_count').notNull().default(0),
     avgAlignmentDelta: doublePrecision('avg_alignment_delta'),
     approvalAgreementRate: doublePrecision('approval_agreement_rate'),
     computedAt: text('computed_at').notNull().$defaultFn(() => new Date().toISOString()),
   }, (table) => ({
     orgAgentIdx: index('idx_scorecard_org_agent').on(table.orgId, table.agentId),
   }));
   ```

   Add the matching `CREATE TABLE IF NOT EXISTS` to the DDL block in `src/db/index.ts`.
   Do not add a migration file.

2. Create `src/services/scorecard.ts` with a pure metric function and a service that
   uses it. Keep the maths pure so it is testable without a database:

   ```ts
   export interface ReviewFact {
     weightedOverall: number;
     approved: boolean;
     helpful: boolean | null;
     panelAvgOverall: number;    // mean weighted_overall across all reviews of that task
     panelApproved: boolean;     // majority approval on that task
   }

   export interface ScorecardMetrics {
     reviewsGiven: number;
     helpfulCount: number;
     unhelpfulCount: number;
     avgAlignmentDelta: number | null;
     approvalAgreementRate: number | null;
   }

   export function computeMetrics(facts: ReviewFact[]): ScorecardMetrics;
   ```

   Definitions:
   - `helpfulCount` / `unhelpfulCount` — count of `helpful === true` / `false`. Null is
     counted in neither.
   - `avgAlignmentDelta` — mean of `Math.abs(weightedOverall - panelAvgOverall)`. `null`
     when `facts` is empty.
   - `approvalAgreementRate` — fraction where `approved === panelApproved`. `null` when
     empty.
   - All rounded to two decimals.

3. Add `ScorecardService.recomputeForAgent(agentId)` which loads the facts with one
   query — reviews by that agent, joined to a per-task aggregate for the panel average
   and majority — calls `computeMetrics`, and upserts a row.

4. Call it on task completion. In `src/services/tasks.ts`, inside `submitReview()` where
   the task transitions to `completed` and the budget bonuses are awarded, recompute for
   each reviewer's agent. Wrap in try/catch and log on failure — this must never fail a
   review submission, matching how `writeMemoryFromReview` is already handled there.

5. Create `src/__tests__/scorecard.test.ts` covering `computeMetrics` only — no
   database. Assert:
   - empty input → zero counts, `null` deltas
   - three reviews, two helpful one unhelpful → correct counts
   - a reviewer always matching the panel average → `avgAlignmentDelta` of 0
   - a reviewer consistently two points below → `avgAlignmentDelta` of 2
   - a reviewer agreeing with panel approval 2 of 4 times → `approvalAgreementRate` 0.5
   - reviews with `helpful: null` counted in neither helpful nor unhelpful

## How to read the output

Worth putting in a comment above `computeMetrics`, because the metrics only mean
something in combination:

- **High helpful rate, high alignment delta** — this reviewer disagrees with the panel
  and turns out to be right. The most valuable configuration you have.
- **High helpful rate, low delta** — agrees with everyone and is useful. Solid, but
  probably redundant with another reviewer.
- **Low helpful rate, low delta** — a rubber stamp. Cheapest candidate to cut.
- **Low helpful rate, high delta** — noisy contrarian. Retune the instructions or drop it.

No single number ranks reviewers, which is why this is a scorecard and not a score. Do
not add a composite "overall" field.

## Verify

```bash
grep -c "clv_reviewer_scorecards" src/db/schema.ts src/db/index.ts
```
Expected: `1` or more in each.

```bash
npx vitest run src/__tests__/scorecard.test.ts
```
Expected: all six cases pass.

```bash
grep -c "recomputeForAgent" src/services/tasks.ts
```
Expected: `1` or more.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If the panel-average query needs more than one round trip per task, that is acceptable
  — correctness first. Note it for later optimisation rather than restructuring.
- Do not modify `computeAndSnapshot()` or `clv_reputation_snapshots`. Principal-level
  reputation stays dormant; this is a separate subject.
- Do not add a composite ranking field. See **How to read the output**.

## Commit

```
feat(scorecard): compute per-agent reviewer scorecards from review outcomes
```
