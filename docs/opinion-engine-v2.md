# Opinion Engine v2 — Design

This supersedes the synthesis-based pipeline documented in
`docs/opinion-state-machine.md` ("v1" from here on). It exists because D8 changed the
question: v1's middle step — a synthesizer that reconciles critiques into a proposal
for voting — was never automated. `checkSynthesizingOpinions` only reacts to a
synthesis node that already exists; nothing in the router ever creates one. Two of
three designed roles shipped. The third was always a manual gap.

Once that's true, the question stops being "how does a rejected vote loop back to the
synthesizer" (D5) and becomes "was the synthesizer worth building at all." This doc's
answer is no — v2 removes the step rather than automating it.

**v1 keeps running while v2 is built.** T28–T32 build v2 as new code alongside the
existing router, sharing nothing but the critic-selection query and the channel
subscription check, both of which aren't broken and don't need rethinking. T33 wires
v2 in behind a flag so it can be validated against a real database without touching
what's live. T34 is the only task that deletes v1 code, and it's the last one — do
not start it before v2 has run for real.

---

## What changes and why

| | v1 | v2 |
|---|---|---|
| States | `open, in_review, synthesizing, voting, closed` | `open, critiquing, voting, closed` |
| Critique → decision | critique → **synthesis (unbuilt)** → sequential vote | critique → simultaneous vote |
| Vote ordering | sequential — each critic sees prior votes and reasoning | parallel — every critic votes on the same input, nothing to anchor on |
| Consensus source | graph traversal (`votes_on` edges from the latest synthesis) | a ballot table, one row per critic per opinion |
| Rejected vote | stalls in `voting` forever (D5) | closes as `consensus_not_reached` — no loop, no synthesis to revise |
| Growth bound | `HARD_NODE_LIMIT = 25`, a proxy with no direct meaning | not needed — the graph is now structurally bounded (see below) |
| Blackboard | source of truth for control flow | display/audit mirror only; never read back to decide state |

**Why unanimity, not majority.** T26's verdict primitive uses majority approval for
task reviews, because a review is a gate — most reviewers agreeing is enough to pass.
An opinion is asking the network what it thinks; a single unresolved objection is
exactly the information worth surfacing rather than outvoting. v1 required all critics
to approve for `consensus_reached`, and v2 keeps that. This is a deliberate difference
from T26, not an oversight — the two features answer different questions.

**Why the node limit disappears.** `HARD_NODE_LIMIT` existed to catch a graph that
never stops growing, because a stuck `synthesizing ⇄ voting` cycle could add nodes
indefinitely. v2 removes the only path that let a graph grow unboundedly — there's no
loop. One opinion now produces exactly `1 proposal + N critiques + N ballots` nodes,
bounded by `requested_opinions` before it starts. No sanity valve is needed for a shape
that can't run away.

**Why a ballot table instead of graph traversal.** D6 happened because "how many
voted" and "how many voted yes" were two different graph queries that could disagree.
`clv_opinion_ballots` (below) makes both the same query. The blackboard still gets a
`consensus`-kind node per vote, written purely for the `/graph` endpoint and dashboard
— nothing in the state machine ever reads it back.

---

## Schema — one new table

```sql
CREATE TABLE clv_opinion_ballots (
  id TEXT PRIMARY KEY,                  -- bal_<uuidv7>
  opinion_id TEXT NOT NULL REFERENCES clv_opinions(id),
  principal_id TEXT NOT NULL REFERENCES clv_principals(id),
  agent_id TEXT NOT NULL REFERENCES clv_agents(id),
  approved BOOLEAN,                     -- NULL = attempted but failed after retries
  confidence DOUBLE PRECISION,
  reasoning TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_ballots_opinion_principal ON clv_opinion_ballots(opinion_id, principal_id);
```

One row per critic per opinion — the unique index makes a double vote a constraint
violation, not an application-level check. `approved IS NULL` records a critic who was
selected and attempted but never produced a usable vote after retries (see below) —
this is what lets the machine tell "everyone voted yes" apart from "we don't actually
know what everyone thinks," which v1's edge-counting couldn't distinguish (that
ambiguity is D6).

`clv_opinions` also gains the claim-expiry columns from T15, extended to cover the
`voting` state as well as `critiquing` — see **Claim expiry across both busy states**
below.

---

## States and events

```
open ──CLAIMED──► critiquing ──CRITIQUES_COLLECTED(succeeded≥requested)──► voting
  ▲                    │                                                      │
  └──ROUTE_FAILED──────┘                                                      │
  └──CRITIQUES_COLLECTED(succeeded<requested)                                 │
                                                                               ▼
                                                                            closed
                                                              (VOTES_SETTLED, both outcomes)
```

No transition ever returns to `critiquing` or introduces a `synthesizing` state. Once
`voting` is entered, the opinion terminates from there — this is the structural fix
for D5: there is nothing to loop back *to*.

### Events

```ts
export type OpinionStatusV2 = 'open' | 'critiquing' | 'voting' | 'closed';

export type OpinionEventV2 =
  | { type: 'CLAIMED' }
  | { type: 'ROUTE_FAILED' }
  | { type: 'NO_SUBSCRIBERS' }
  | { type: 'CRITIQUES_COLLECTED'; succeeded: number; requested: number }
  | { type: 'VOTES_SETTLED'; ballots: Array<{ approved: boolean | null }> };

export interface TransitionV2 {
  status: OpinionStatusV2;
  closeTag?: 'consensus_reached' | 'consensus_not_reached';
}

export function nextStateV2(
  current: OpinionStatusV2,
  event: OpinionEventV2,
): TransitionV2 | null;
```

### Required behaviour

```
CLAIMED
  current !== 'open'                    → null
  otherwise                             → { status: 'critiquing' }

ROUTE_FAILED                            → { status: 'open' }
NO_SUBSCRIBERS                          → { status: 'open' }

CRITIQUES_COLLECTED
  succeeded >= requested                → { status: 'voting' }
  otherwise                             → { status: 'open' }

VOTES_SETTLED
  ballots.length === 0                  → { status: 'closed', closeTag: 'consensus_not_reached' }
  ballots.some(b => b.approved !== true) → { status: 'closed', closeTag: 'consensus_not_reached' }
  otherwise (every ballot approved)     → { status: 'closed', closeTag: 'consensus_reached' }
```

`ballots.some(b => b.approved !== true)` deliberately treats a `null` (failed-after-
retries) ballot the same as an explicit rejection — an opinion cannot honestly close
as `consensus_reached` when one required critic's view was never captured.

This function is pure — no I/O, no clock. T29 implements it exactly as written above;
T30 tests every branch.

---

## Router loop — critique phase (T31)

Unchanged from v1 except for what it calls at the end. Reuse verbatim: the channel
subscription query, the round-robin critic selection (`opinion-router.ts:923–940`,
already read and confirmed unbroken), `callOpinionCritiqueLLM`, and the ProposalNode /
CritiqueNode creation calls. The only change is the transition at the end: instead of
writing `synthesizing`, apply `nextStateV2({ type: 'CRITIQUES_COLLECTED', ... })`.

## Router loop — vote phase (T32)

This is genuinely new orchestration, not a port. Where v1 voted critics sequentially
and fed each one the prior votes (the anchoring bug), v2 fires every critic's vote call
in parallel from the *same* input — the proposal, the full set of critiques, no prior
votes to see, because there are none yet.

```ts
async function runVoteRound(opinion: OpinionRow, critics: CriticAgent[]): Promise<void> {
  const results = await Promise.allSettled(
    critics.map(critic => castBallotWithRetry(opinion, critic, MAX_VOTE_ATTEMPTS)),
  );

  const ballots = results.map((r, i) => {
    const critic = critics[i];
    const outcome = r.status === 'fulfilled' ? r.value : null; // null = failed after retries
    return { principalId: critic.principal_id, approved: outcome?.approved ?? null, ... };
  });

  await persistBallots(opinion.id, ballots);        // insert into clv_opinion_ballots
  await mirrorBallotsToBlackboard(opinion.id, ballots); // consensus-kind nodes, display only

  const transition = nextStateV2(current, { type: 'VOTES_SETTLED', ballots });
  await applyTransitionV2(opinion.id, transition);
}
```

`castBallotWithRetry` calls the existing `callVoteLLM` (the prompt no longer needs
`priorVotes` — pass an empty array or drop the parameter, since nothing has voted yet
when every call fires at once) with up to `MAX_VOTE_ATTEMPTS` (default 2) attempts on
failure, returning `null` if every attempt fails. This bounded retry is the *entire*
replacement for v1's `checkVotingOpinions` re-triggering — there is no polling
loop that re-runs the vote round, because the round either completes (every critic has
a ballot, `null` or otherwise) or the process crashes mid-flight, which claim expiry
(below) recovers from.

## Claim expiry across both busy states

T15 added `claimed_at` / `claimed_by` to recover a router crash during `in_review`. v2
needs the same protection for `critiquing` (renamed, same purpose) **and** `voting`,
since the vote round is now a single in-flight batch of parallel calls rather than a
sequence of independently-committed steps — a crash mid-batch leaves every ballot
either written or not, with no partial-round ambiguity to clean up, but the opinion
itself still needs to be reclaimable. Reuse T15's columns and TTL mechanism unchanged;
extend the reclaim predicate to cover both `status IN ('critiquing', 'voting')`.

---

## Which defects this resolves

| Defect | Resolution |
|---|---|
| D3 | No precondition can strand `voting` — nothing enters it without critiques already collected, and nothing re-enters it. |
| D4 | The reversed edge query is deleted along with everything that read it. |
| D5 | Resolved by removing the state being looped back to, not by adding a transition. |
| D6 | Ballots are counted once, from one table, not reconciled across two definitions. |
| D7 | The discussion round doesn't exist in v2. |
| D8 | The synthesizer step doesn't exist in v2 — nothing needed to automate. |

D1 and D2 (already fixed by T15) and the claim-expiry mechanism they introduced carry
forward unchanged, extended to cover `voting` as described above.

---

## What must not change

- **The critique phase's external behaviour.** Same channels, same round-robin
  selection, same budget costs, same CritiqueNode shape. v2 does not touch what's
  already correct.
- **`clv_blackboard_nodes` / `clv_blackboard_edges`.** Both keep being written, for
  the same audit/display purpose. v2 changes what *decides state*, not what's shown.
- **The `/v1/opinions/:id/graph` response shape.** A v2 opinion's graph should look
  like a v1 opinion's graph with an empty synthesis layer — no consumer should need to
  branch on which engine produced it.
