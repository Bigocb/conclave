# T31 — v2 router: critique phase

**Mark:** AGENT (design pass complete)
**Depends on:** T28, T29
**Estimated diff:** ~150 lines, mostly reused

## Read first

`docs/opinion-engine-v2.md`, section **Router loop — critique phase**. This phase is
almost unchanged from v1 — only the terminal transition differs.

## Files you may modify

- `src/fleet/opinion-router-v2.ts` (create)
- `src/__tests__/opinion-router-v2-critique.test.ts` (create)
- `vitest.integration.config.ts` (add the new test to `include`)

## Context

v2 is built as a separate module, not a modification of `opinion-router.ts`. Nothing
routes opinions through it yet — T33 does that behind a flag. Building it standalone
means v1 (and T22–T24's fixes to it) stay untouched until the cutover is deliberate.

## Steps

1. Create `src/fleet/opinion-router-v2.ts`. Import and reuse, verbatim, from
   `src/fleet/opinion-router.ts`:
   - the channel-subscription / eligible-critic query (lines 923–940, already
     confirmed correct)
   - `callOpinionCritiqueLLM` (line 473) and `buildOpinionCritiquePrompt` (line 367)
     — neither depends on synthesis, both are safe to reuse unchanged
   - `resolveAgentLlmKey`, `normalizeLlmUrl`, `refreshAgentToken`, `decryptVaultValue`,
     `resolveVaultKey` — all pure plumbing, no state-machine coupling

   These functions are not currently exported from `opinion-router.ts`. Add `export`
   to each one you need rather than copy-pasting its body — a second copy of the vault
   decryption logic is exactly the duplication this whole effort has been removing.
   If exporting a function requires exporting a type it depends on, export that too;
   do not inline or redefine it.

2. Implement `routeOpinionV2(opinion: OpinionRow): Promise<void>`, following v1's
   `routeOpinion` (`opinion-router.ts:855`) for structure but stopping at the
   critique phase:
   - create the ProposalNode (same REST call v1 makes)
   - select critics (the reused query)
   - if no subscribers: apply `nextStateV2(current, { type: 'NO_SUBSCRIBERS' })` and
     return
   - call `callOpinionCritiqueLLM` for each selected critic in parallel
     (`Promise.all`, matching v1's existing parallelism here — this part was never
     sequential)
   - create a CritiqueNode for each success, exactly as v1 does
   - apply `nextStateV2(current, { type: 'CRITIQUES_COLLECTED', succeeded, requested: count })`
   - on any thrown error during routing, apply
     `nextStateV2(current, { type: 'ROUTE_FAILED' })`

   There is no node-limit check in this phase — the design doc explains why (v2 can't
   run away). Do not port `HARD_NODE_LIMIT` into this file.

3. Implement `claimNextOpinionV2(): Promise<OpinionRow | null>` — the `SKIP LOCKED`
   claim, structurally identical to v1's claim at `opinion-router.ts:811` but selecting
   `status = 'open'` only (v2 has no `in_review`/`critiquing` reclaim path yet — that's
   T32, once `voting` exists to reclaim alongside it) and writing `status = 'critiquing'`
   instead of `'in_review'`.

4. Create `src/__tests__/opinion-router-v2-critique.test.ts` — an integration test
   (needs a database; follow `agent-detail.test.ts`'s setup/teardown pattern). Mock the
   LLM call (`callOpinionCritiqueLLM`) rather than hitting a real endpoint. Assert:
   - an opinion with enough subscribed critics reaches `voting` after routing
   - an opinion with no subscribers returns to `open` with `NO_SUBSCRIBERS` semantics
   - a ProposalNode and one CritiqueNode per successful critic are written to
     `clv_blackboard_nodes`

## Verify

```bash
grep -c "HARD_NODE_LIMIT" src/fleet/opinion-router-v2.ts
```
Expected output: `0`

```bash
grep -c "^async function callOpinionCritiqueLLM\|^function buildOpinionCritiquePrompt" src/fleet/opinion-router.ts
```
Expected: `0` — these are now exported, not redefined as bare `function`/`async function`
declarations. (If your editor turned them into `export function`, this grep pattern
correctly won't match — that's the point.)

```bash
grep -c "function callOpinionCritiqueLLM\|function buildOpinionCritiquePrompt" src/fleet/opinion-router-v2.ts
```
Expected output: `0` — v2 imports these, it does not redefine them.

```bash
npx tsc --noEmit
```
Expected: no new errors.

```bash
DATABASE_URL=<test db> npx vitest run --config vitest.integration.config.ts src/__tests__/opinion-router-v2-critique.test.ts
```
Expected: all three cases pass. Needs a live non-production database.

## Stop conditions

- If exporting a function from `opinion-router.ts` causes v1's own behaviour to change
  (it shouldn't — `export` doesn't change execution), that means something depended on
  the function being module-private in a way that isn't obvious. Stop and report rather
  than guessing why.
- Do not implement the vote phase in this task. `routeOpinionV2` stops once the opinion
  reaches `voting`; T32 picks it up from there.

## Commit

```
feat(opinions): v2 router — critique phase
```
