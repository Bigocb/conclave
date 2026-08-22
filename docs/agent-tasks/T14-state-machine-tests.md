# T14 — Table-driven tests for the opinion state machine

**Mark:** AGENT
**Depends on:** T13
**Estimated diff:** one test file, ~30 cases

## Files you may modify

- `src/__tests__/opinion-machine.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)

## Context

`nextState` is pure, so this is the first part of the opinion router that can be tested
at all. These tests lock in **current** behaviour — including the defects listed in
`docs/opinion-state-machine.md`. That is deliberate: the fix tasks that follow will each
change exactly one of these expectations, which is how you will know the fix landed and
nothing else moved.

## Steps

1. Create `src/__tests__/opinion-machine.test.ts`.

2. Add a helper so each case reads as one line:

   ```ts
   const counts = (over: Partial<OpinionCounts> = {}): OpinionCounts => ({
     nodes: 0, syntheses: 0, critics: 0, voters: 0,
     votesOnSynthesis: 0, approvedVotes: 0, ...over,
   });
   ```

3. Cover every row below. One `it` per row; the name should state the rule.

   **CLAIMED**
   | current | counts | expected |
   |---|---|---|
   | `open` | default | `{ status: 'in_review' }` |
   | `in_review` | default | `null` |
   | `closed` | default | `null` |

   **ROUTE_STARTED**
   | current | counts | expected |
   |---|---|---|
   | `in_review` | `nodes: 24` | `null` |
   | `in_review` | `nodes: 25` | `closed` / `consensus_not_reached` |
   | `in_review` | `nodes: 40` | `closed` / `consensus_not_reached` |

   **ROUTE_FAILED**
   | current | counts | expected |
   |---|---|---|
   | `in_review` | default | `{ status: 'open' }` |

   **CRITIQUES_COLLECTED**
   | succeeded | requested | expected |
   |---|---|---|
   | 3 | 3 | `synthesizing` |
   | 4 | 3 | `synthesizing` |
   | 2 | 3 | `open` |
   | 0 | 3 | `open` |

   **VOTE_ROUND_STARTED**
   | current | counts | expected |
   |---|---|---|
   | `synthesizing` | `nodes: 10` | `voting` |
   | `voting` | `nodes: 10` | `voting` |
   | `synthesizing` | `nodes: 25` | `closed` / `consensus_not_reached` |

   **VOTES_COLLECTED**
   | counts | expected | why |
   |---|---|---|
   | `syntheses: 0` | `null` | no synthesis to vote on |
   | `syntheses: 1, critics: 3, voters: 2` | `null` | not everyone has voted |
   | `syntheses: 1, critics: 3, voters: 3, nodes: 25` | `closed` / `consensus_not_reached` | limit beats consensus |
   | `syntheses: 1, critics: 3, voters: 3, votesOnSynthesis: 3, approvedVotes: 3` | `closed` / `consensus_reached` | unanimous |
   | `syntheses: 1, critics: 3, voters: 3, votesOnSynthesis: 3, approvedVotes: 2` | `voting` | one dissent |
   | `syntheses: 1, critics: 3, voters: 3, votesOnSynthesis: 0, approvedVotes: 0` | `voting` | no linked votes |

4. Add three cases marked in their test names as **defect-locking**, each with a comment
   naming the defect. These assert behaviour that is currently wrong:

   ```ts
   // D6: consensus is declared on a partial vote count.
   // Three principals voted, but only two votes are edge-linked to the synthesis.
   // Current behaviour closes as consensus_reached, discarding the third vote.
   it('D6 — closes as reached when linked votes are unanimous but fewer than voters', () => {
     expect(nextState('voting', { type: 'VOTES_COLLECTED' },
       counts({ syntheses: 1, critics: 3, voters: 3, votesOnSynthesis: 2, approvedVotes: 2 })))
       .toEqual({ status: 'closed', closeTag: 'consensus_reached' });
   });
   ```

   Add equivalents for:
   - **D3** — `VOTE_ROUND_STARTED` returns `voting` even when `syntheses === 0`, which is
     what strands the opinion.
   - **D4/D5** — `VOTES_COLLECTED` with a dissent returns `voting` rather than
     `synthesizing`; the loop-back never fires.

   Each of these must carry a comment pointing at the defect ID in
   `docs/opinion-state-machine.md`, so the next reader knows the assertion is
   deliberate and not an oversight.

5. Add the file to `include` in `vitest.unit.config.ts`.

## Verify

```bash
npx vitest run src/__tests__/opinion-machine.test.ts
```
Expected: every case passes. If one fails, **T13's implementation is wrong** — fix
`machine.ts` to match the design doc, not the test to match the code.

```bash
grep -c "D3\|D4\|D5\|D6" src/__tests__/opinion-machine.test.ts
```
Expected: `3` or more.

```bash
npm run test:unit
```
Expected: no regression.

## Stop conditions

- If a case in the tables above fails, do not adjust the expectation. The tables come
  from the design doc, which came from the source. A mismatch means T13 diverged —
  report which row and stop.
- Do not add cases that assert behaviour you think *should* happen. This file records
  what does happen.

## Commit

```
test(opinions): add table-driven coverage of the opinion state machine
```
