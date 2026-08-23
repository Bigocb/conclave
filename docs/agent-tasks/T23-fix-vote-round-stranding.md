# T23 — Fix vote round stranding (D3)

**Mark:** AGENT
**Depends on:** T14
**Fixes:** D3 in `docs/opinion-state-machine.md`

## Files you may modify

- `src/opinions/machine.ts`
- `src/fleet/opinion-router.ts`
- `src/__tests__/opinion-machine.test.ts`

## Context

`triggerVoteRound` moves the opinion to `voting` and only then checks its
preconditions. Three of them can fail — no opinion row, no synthesis node, no critic
principals — and each returns early, leaving the opinion in `voting` with nothing to
advance it.

`checkVotingOpinions` compensates by re-running the vote round whenever
`voters < critics`, but with no synthesis that re-run early-returns again on every
poll, forever. An infinite no-op loop, and the reason the merged fix "re-trigger vote
round for voting opinions missing consensus votes" exists at all.

T13 already collapsed the node-limit check to happen before the write. This task does
the same for the remaining preconditions.

## Steps

1. Add two events to `src/opinions/machine.ts`:

   ```
   VOTE_ROUND_NO_SYNTHESIS   → { status: 'synthesizing' }
   VOTE_ROUND_NO_CRITICS     → { status: 'closed', closeTag: 'consensus_not_reached' }
   ```

   No synthesis means the opinion was advanced too early — send it back to wait for
   one. No critics means nobody can vote, which is terminal.

2. In `triggerVoteRound`, gather the opinion row, the latest synthesis, and the critic
   principals **before** applying `VOTE_ROUND_STARTED`. Then:
   - opinion row missing → return without any transition (the row is gone)
   - no synthesis → apply `VOTE_ROUND_NO_SYNTHESIS` and return
   - no critics → apply `VOTE_ROUND_NO_CRITICS` and return
   - otherwise → apply `VOTE_ROUND_STARTED` and proceed

   After this, no path leaves an opinion in `voting` with nothing to advance it.

3. **Remove the compensating poll.** In `checkVotingOpinions`, delete the
   `voters.length < critics.length → triggerVoteRound(...)` branch and always call
   `checkAndFinalizeConsensus`. That branch existed only to paper over this bug; with
   the preconditions checked up front it now re-enters a vote round that is already
   correctly stated.

   T15's stop conditions told you to leave this alone. That instruction expires here —
   this is the task that fixes what it was working around.

4. Add cases to `src/__tests__/opinion-machine.test.ts` for both new events. Update the
   D3 defect-locking test: it currently asserts that `VOTE_ROUND_STARTED` returns
   `voting` even with `syntheses: 0`. That expectation moves to `null`, because the
   router no longer reaches `VOTE_ROUND_STARTED` in that situation.

## Verify

```bash
grep -c "VOTE_ROUND_NO_SYNTHESIS\|VOTE_ROUND_NO_CRITICS" src/opinions/machine.ts
```
Expected: `2` or more.

```bash
grep -c "voters.length < critics.length" src/fleet/opinion-router.ts
```
Expected output: `0`

```bash
npx vitest run src/__tests__/opinion-machine.test.ts
```
Expected: all cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Against a non-production database, put an opinion into `voting` with no synthesis node
and start the router. It must move back to `synthesizing` within one poll interval
rather than looping. Confirm the log no longer prints the `n/m voted` line every poll.

## Stop conditions

- If removing the compensating poll leaves any opinion stuck in a local run, stop and
  report which state — that means another precondition path is unguarded and the design
  doc needs a new row.
- Do not touch `checkAndFinalizeConsensus` in this task; D6 is T22.

## Commit

```
fix(opinions): check vote round preconditions before entering voting (D3)
```
