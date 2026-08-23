# T22 — Fix consensus declared on a partial vote count (D6)

**Mark:** AGENT
**Depends on:** T14
**Fixes:** D6 in `docs/opinion-state-machine.md`

## Files you may modify

- `src/opinions/machine.ts`
- `src/fleet/opinion-router.ts`
- `src/__tests__/opinion-machine.test.ts`

## Context

Two different denominators are compared:

- `voters` — distinct principals with a `consensus` node
- `votesOnSynthesis` — consensus nodes reachable from the latest synthesis by a
  `votes_on` edge

A consensus node created while the graph fetch failed has `latestSynthId = null`, so it
gets no edge. It counts as a voter but not as a vote. The gate
`voters >= critics` then passes on the larger number while unanimity is checked against
the smaller, and the opinion closes as `consensus_reached` on a subset. A dissenting
unlinked vote is discarded silently.

T14 has a defect-locking test asserting exactly this. **That test changes in this
task** — it is the single expectation that should move.

## Steps

1. In `src/opinions/machine.ts`, add one guard to `VOTES_COLLECTED`, after the
   `voters < critics` check and before the node-limit check:

   ```
   counts.votesOnSynthesis !== counts.voters   → null
   ```

   An unlinked consensus node means the graph is inconsistent. Do not finalise on
   partial data — return null so nothing is written and the next poll retries.

2. Fix the cause as well as the symptom. In `triggerVoteRound`, the consensus node is
   posted with `parent_node_id: latestSynthId` only when the graph fetch succeeded.
   Change it so a failed graph fetch **skips that voter** rather than creating an
   orphan node: log a warning, `continue` to the next critic, and let the next poll
   retry. Never create a consensus node without its `votes_on` edge.

3. Update the D6 test in `src/__tests__/opinion-machine.test.ts`. Change the
   expectation from `{ status: 'closed', closeTag: 'consensus_reached' }` to `null`,
   and rewrite the comment to describe the fixed behaviour rather than the defect.

   Every other case in that file must be untouched. If another fails, you changed more
   than intended — revert and report.

## Verify

```bash
npx vitest run src/__tests__/opinion-machine.test.ts
```
Expected: all cases pass, with exactly one changed expectation versus T14.

```bash
git diff --stat src/__tests__/opinion-machine.test.ts
```
Expected: a small diff touching only the D6 case and its comment.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If skipping a voter on graph-fetch failure means no voter ever succeeds in a local
  run, the graph endpoint itself is broken. Report that rather than restoring the
  orphan-node path.
- Do not change how `votesOnSynthesis` is counted. Counting consensus nodes directly
  instead of via edges would be simpler, but it is only correct if opinions never
  revise — that is D5, still undecided.

## Commit

```
fix(opinions): refuse to finalise consensus on an unlinked vote (D6)
```
