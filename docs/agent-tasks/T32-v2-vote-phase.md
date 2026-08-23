# T32 — v2 router: simultaneous vote phase

**Mark:** AGENT (design pass complete)
**Depends on:** T28, T29, T31
**Estimated diff:** ~180 lines

## Read first

`docs/opinion-engine-v2.md`, section **Router loop — vote phase**, and
**Claim expiry across both busy states**.

## Files you may modify

- `src/fleet/opinion-router-v2.ts`
- `src/opinions/machine-v2.ts` — column additions only, not the transition logic T29
  already implemented
- `src/db/schema.ts` (claim-expiry columns on `clv_opinions`, if T15 hasn't landed yet
  — check first; if `claimedAt`/`claimedBy` already exist, reuse them)
- `src/db/index.ts` (matching ALTER TABLE, only if the columns don't already exist)
- `src/__tests__/opinion-router-v2-vote.test.ts` (create)
- `vitest.integration.config.ts` (add the new test to `include`)

## A correction from the design doc

`docs/opinion-engine-v2.md` says the vote phase calls "the existing `callVoteLLM`."
That's half true. **`callVoteLLM` itself (the HTTP call and response parser) is
reusable as-is** — it just takes a `model` and a `systemPrompt` string. But
`buildVotePrompt` (`opinion-router.ts:412`) is not: it opens with *"You are
evaluating a synthesis produced by the asker..."* and takes a `synthesis` parameter.
v2 has no synthesis. Reusing that prompt would ask every critic to evaluate something
that doesn't exist.

**Write a new prompt builder, `buildBallotPrompt`, in `opinion-router-v2.ts`:**

```ts
function buildBallotPrompt(
  question: string,
  context: string | null,
  critiques: string[],   // every critique's concerns/reasoning, same shape v1 gathers
  instructions: string | null,
): string
```

Base it on `buildVotePrompt`'s structure (the instructions placement, the JSON output
shape it asks for) but rewrite the opening to evaluate the proposal directly in light
of the critiques — not a synthesis of them. Do not include a `priorVotes` parameter at
all; there are none, since every vote fires from the same input.

## Steps

1. Check whether `claimedAt` / `claimedBy` already exist on `clv_opinions` (T15 may
   have landed independently). If not, add them following T15's brief exactly — same
   column names, same TTL mechanism, same env var (`CLAIM_TTL_MINUTES`, default 15).
   Do not invent a different mechanism for v2.

2. Extend `claimNextOpinionV2` from T31 so the claim predicate (from T31, step 3) also
   reclaims a stale `voting` opinion, matching T15's expired-claim logic:

   ```sql
   WHERE status = 'open'
      OR (status IN ('critiquing', 'voting') AND claimed_at < ${staleBefore})
   ```

   Set `claimed_at` / `claimed_by` on every claim, including the transition into
   `voting` — that write happens in this task's `runVoteRound`, not in T31's critique
   claim.

3. Implement `castBallotWithRetry(opinion, critic, maxAttempts = 2)`:

   ```ts
   async function castBallotWithRetry(
     opinion: OpinionRow,
     critic: CriticAgent,
     critiqueTexts: string[],
     maxAttempts: number,
   ): Promise<{ approved: boolean; confidence: number; reasoning: string; attempts: number } | null> {
     for (let attempt = 1; attempt <= maxAttempts; attempt++) {
       try {
         const prompt = buildBallotPrompt(opinion.question, opinion.context, critiqueTexts, critic.instructions);
         const result = await callVoteLLM(critic.model || defaultModel, prompt, llmUrl, llmKey);
         if (result) return { approved: result.approved, confidence: result.agreement_level, reasoning: result.reasoning, attempts: attempt };
       } catch { /* fall through to retry */ }
     }
     return null; // every attempt failed — this critic's ballot is null, not missing
   }
   ```

   Resolve `llmUrl`/`llmKey` the same way T31's critique phase does (reuse
   `resolveAgentLlmKey`, `normalizeLlmUrl`).

4. Implement `runVoteRoundV2(opinion: OpinionRow): Promise<void>`:
   - fetch the critics who produced critique nodes for this opinion (same query
     pattern v1's `triggerVoteRound` uses at `opinion-router.ts:1268`, adapted to read
     from `clv_blackboard_nodes` — critique nodes are still written in T31)
   - fetch the critique texts to build the shared prompt input
   - `Promise.allSettled` over `critics.map(c => castBallotWithRetry(opinion, c, critiqueTexts, MAX_VOTE_ATTEMPTS))`
   - insert one row per critic into `clv_opinion_ballots` — `approved: null` for a
     failed critic, matching the table's nullable design
   - mirror each ballot as a `consensus`-kind blackboard node (same node shape v1
     creates at `opinion-router.ts:1372`), for display only — this write must not be
     read back by anything in this file
   - call `nextStateV2(current, { type: 'VOTES_SETTLED', ballots })` and apply the
     result
   - clear `claimed_at`/`claimed_by` on the same write, since this is always a
     terminal transition (v2 has no path back to `critiquing`)

5. Wire `routeOpinionV2` (from T31) so that after applying `CRITIQUES_COLLECTED` and
   landing in `voting`, it calls `runVoteRoundV2` before returning — the whole opinion
   lifecycle for v2 runs to completion in one pass from a single claim, since there's
   no polling loop waiting between phases.

6. Create `src/__tests__/opinion-router-v2-vote.test.ts` — integration test, database
   required. Mock `callVoteLLM`. Assert:
   - unanimous approval closes as `consensus_reached`
   - one dissent closes as `consensus_not_reached`
   - a critic whose every attempt fails produces a `null`-approved ballot and the
     opinion still closes as `consensus_not_reached` (not stuck, not silently
     excluded)
   - a killed-and-restarted claim (simulate: set `claimed_at` far in the past on an
     opinion stuck in `voting`) is reclaimed by the next `claimNextOpinionV2` call

## Verify

```bash
grep -c "function buildBallotPrompt" src/fleet/opinion-router-v2.ts
```
Expected output: `1`

```bash
grep -c "buildVotePrompt" src/fleet/opinion-router-v2.ts
```
Expected output: `0` — v2 must not import v1's synthesis-shaped prompt builder.

```bash
grep -c "priorVotes" src/fleet/opinion-router-v2.ts
```
Expected output: `0`

```bash
npx tsc --noEmit
```
Expected: no new errors.

```bash
DATABASE_URL=<test db> npx vitest run --config vitest.integration.config.ts src/__tests__/opinion-router-v2-vote.test.ts
```
Expected: all four cases pass. Needs a live non-production database.

## Stop conditions

- If you find yourself wanting to make a failed critic retry indefinitely rather than
  giving up after `maxAttempts`, don't — an unbounded retry inside a single claimed
  round is exactly the kind of open-ended loop this redesign removed. Two attempts and
  a `null` ballot is the intended behaviour, not a shortcut.
- Do not add a function that re-triggers `runVoteRoundV2` for an opinion already in
  `voting`. There is no v2 equivalent of v1's `checkVotingOpinions` — claim expiry is
  the entire recovery mechanism.

## Commit

```
feat(opinions): v2 router — simultaneous vote phase
```
