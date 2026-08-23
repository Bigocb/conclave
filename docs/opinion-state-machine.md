# Opinion State Machine

Derived by reading every status write in `src/fleet/opinion-router.ts`. This documents
**observed behaviour**, not intended behaviour. Where the two differ, the difference is
recorded under [Defects](#defects) rather than silently corrected.

This document is the input to tasks T13–T15 and to the D3/D6/D7 fixes in T22–T24.

---

## States

| Status | Meaning | Who writes it |
|---|---|---|
| `open` | Awaiting a router to claim it | `routes/opinions.ts` on create; router on retry |
| `in_review` | Claimed; critique round running | router only |
| `synthesizing` | Critiques collected; awaiting a SynthesisNode | router only |
| `voting` | Vote round running or awaiting votes | router only |
| `closed` | Terminal | router only |

`in_review` is **not** in `SPEC.md` §3, and the file header comment calls this phase
`critiquing`. Three vocabularies for one state. `SPEC.md` should adopt `in_review`,
since that is what is written to the database.

`close_tag` is `consensus_reached` or `consensus_not_reached`. The schema comment also
lists `expired`, which the router never writes.

---

## Transitions as implemented

Line numbers are `src/fleet/opinion-router.ts` at commit `8279b6a`.

| # | Line | From | Trigger | Guard | To | close_tag |
|---|---|---|---|---|---|---|
| 1 | 811 | `open` | poll claim | channel has a subscriber, not the asker, with an active agent | `in_review` | — |
| 2 | 845 | `in_review` | `routeOpinion` threw | — | `open` | — |
| 3 | 913 | `in_review` | route started | `nodes >= 25` | `closed` | `consensus_not_reached` |
| 4 | 1036 | `in_review` | critiques collected | `succeeded >= requested` | `synthesizing` | — |
| 5 | 1040 | `in_review` | critiques collected | `0 < succeeded < requested` | `open` | — |
| 6 | 1044 | `in_review` | critiques collected | `succeeded == 0` | `open` | — |
| 7 | 1235 | `synthesizing` \| `voting` | vote round started | unconditional | `voting` | — |
| 8 | 1244 | `voting` | vote round started | `nodes >= 25` | `closed` | `consensus_not_reached` |
| 9 | 1545 | `voting` | votes collected | all critics voted **and** `nodes >= 25` | `closed` | `consensus_not_reached` |
| 10 | 1555 | `voting` | votes collected | all critics voted, `votesOnSynthesis > 0`, all approved | `closed` | `consensus_reached` |
| 11 | 1560 | `voting` | votes collected | all critics voted, not all approved | `voting` | — |

Transitions 5 and 6 differ only in logging. Transition 11 writes the state it is
already in.

## Counts the guards depend on

| Name | Query |
|---|---|
| `nodes` | `COUNT(*) FROM clv_blackboard_nodes WHERE opinion_id = ?` |
| `syntheses` | same, `AND kind = 'synthesis'` |
| `critics` | `COUNT(DISTINCT principal_id)`, `kind = 'critique'` |
| `voters` | `COUNT(DISTINCT principal_id)`, `kind = 'consensus'` |
| `votesOnSynthesis` | consensus nodes reachable from the latest synthesis by a `votes_on` edge |
| `approvedVotes` | of those, `payload.approved === true` |

`HARD_NODE_LIMIT` is 25.

---

## Defects

Found while deriving the table. **None of these are fixed by T13** — the extraction
must preserve behaviour exactly, bugs included, so that T14's tests lock in the real
current state. Fixes come after.

### D1 — `in_review` has no recovery path

`processNextOpinion` selects only `status = 'open'`. Nothing anywhere selects
`in_review`. If the router dies between the claim at line 811 and any terminal write,
the opinion is stranded permanently.

This is the single biggest structural hole. T15 fixes it with claim expiry.

### D2 — `routeOpinion` can strand an opinion in `in_review`

When the subscriber query returns empty, `routeOpinion` returns without writing a
status. The claim query's `EXISTS` clause normally prevents this, but a principal
unsubscribing or deactivating its last agent between the claim and the query leaves
the opinion stranded. Combined with D1, permanently.

### D3 — `triggerVoteRound` sets `voting` before it can fail

Line 1235 writes `voting` unconditionally, then three early returns can follow:
no opinion row, no synthesis node, no critic principals. Each leaves the opinion in
`voting` with nothing to advance it.

`checkVotingOpinions` partially compensates by re-running the vote round when
`voters < critics` — but with no synthesis node that re-run early-returns again, every
poll, forever. An infinite no-op loop, and the reason the merged fix "re-trigger vote
round for voting opinions missing consensus votes" exists.

### D4 — the follow-up critique query has its edge direction reversed

`routes/opinions.ts` creates edges as `source = parent_node_id`, `target = new node`.
A follow-up critique is posted with `parent_node_id = synthesisId`, so the edge runs
**synthesis → critique**.

`checkAndFinalizeConsensus` looks for the opposite:

```sql
WHERE e.target_node_id = ${synthId} AND e.kind = 'critiques' AND n.kind = 'critique'
```

That matches **critique → synthesis** and therefore always returns zero rows.
`followUpEdges` is also never read after being computed — dead and wrong.

Consequence: the machine cannot detect a follow-up critique, which is why a rejected
vote falls through to transition 11 and re-writes `voting` instead of looping back.

### D5 — the documented loop-back is structurally impossible

The file header describes `synthesizing → voting → synthesizing` on follow-up critique.
It cannot occur. `POST /v1/opinions/:id/nodes` rejects `kind: 'synthesis'` with 409
`NOT_SYNTHESIZABLE` unless the opinion is in `synthesizing`. Once transition 7 has moved
it to `voting`, no new synthesis can be accepted, and nothing ever moves it back.

A rejected vote therefore stalls in `voting` indefinitely. Fixing this needs a decision
about which state accepts a revised synthesis — it is a design change, not a bug fix,
and is out of scope for T13–T15.

### D6 — consensus can be declared on a partial vote count

`voters` counts consensus nodes by principal. `votesOnSynthesis` counts only those
reachable by a `votes_on` edge from the latest synthesis. A consensus node created when
the graph fetch failed has `latestSynthId = null`, so it gets no edge — it counts as a
voter but not as a vote.

The gate `voters.length >= critics.length` then passes while `totalVotes` is smaller,
and if every edge-linked vote approved, the opinion closes as `consensus_reached` on a
subset. A dissenting unlinked vote is silently discarded.

### D7 — the discussion round is unguarded

`checkSynthesizingOpinions` calls `triggerDiscussionRound` for every `synthesizing`
opinion that has a synthesis node, on every poll, with no record of having already run
one. It self-limits only because the round ends by calling `triggerVoteRound`, which
moves the state away. Any path that returns to `synthesizing` re-runs the full round —
one LLM call per critic, each time.

### D8 — nothing ever produces a synthesis, automatically

The PRD (`docs/opinion-fleet-prd.md:155`) describes the router's full lifecycle as
*"post ProposalNode → trigger critics → all respond → trigger synthesis → synthesizer
responds → trigger vote"* — synthesis generation was meant to be automated the same way
critique and voting are, via `callOpinionCritiqueLLM`-style LLM calls.

**No such call exists.** `checkSynthesizingOpinions` only polls for opinions that
*already have* a synthesis node (`src/fleet/opinion-router.ts:1050`) and reacts once one
appears. Nothing in the router ever `POST`s `kind: 'synthesis'` to
`/v1/opinions/:id/nodes`. `AGENTS.md`'s transitional-state table confirms this
obliquely — *"Opinions have no fleet automation (manual answer only) — conclave#57"* —
but understates it: critique and voting **are** automated; only the middle step, the
one the PRD calls the synthesizer, was never built.

Consequence: in an unattended deployment, every opinion that reaches `synthesizing`
sits there permanently unless a human or some other agent manually submits a synthesis
node through the API. This is not a bug in the state machine — `nextState` handles the
transition correctly once a synthesis exists — it is a missing producer. No amount of
fixing D1–D7 addresses it.

This is the fact that should drive any decision about rebuilding the opinion feature,
including D5: a synthesis step that nothing generates is not a step worth preserving
without first deciding whether to automate it or remove it.

---

## Target: `nextState()`

A pure function. No I/O, no clock, no randomness.

```ts
export type OpinionStatus = 'open' | 'in_review' | 'synthesizing' | 'voting' | 'closed';
export type CloseTag = 'consensus_reached' | 'consensus_not_reached' | 'expired';

export type OpinionEvent =
  | { type: 'CLAIMED' }
  | { type: 'ROUTE_STARTED' }
  | { type: 'ROUTE_FAILED' }
  | { type: 'CRITIQUES_COLLECTED'; succeeded: number; requested: number }
  | { type: 'VOTE_ROUND_STARTED' }
  | { type: 'VOTES_COLLECTED' };

export interface OpinionCounts {
  nodes: number;
  syntheses: number;
  critics: number;
  voters: number;
  votesOnSynthesis: number;
  approvedVotes: number;
}

export interface Transition {
  status: OpinionStatus;
  closeTag?: CloseTag;
}

/** Returns the transition to apply, or null to leave the row untouched. */
export function nextState(
  current: OpinionStatus,
  event: OpinionEvent,
  counts: OpinionCounts,
): Transition | null;
```

### Required behaviour

Evaluate in this order. `LIMIT` is 25.

```
CLAIMED
  current !== 'open'                      → null
  otherwise                               → { status: 'in_review' }

ROUTE_STARTED
  counts.nodes >= LIMIT                   → { status: 'closed', closeTag: 'consensus_not_reached' }
  otherwise                               → null

ROUTE_FAILED                              → { status: 'open' }

CRITIQUES_COLLECTED
  succeeded >= requested                  → { status: 'synthesizing' }
  otherwise                               → { status: 'open' }

VOTE_ROUND_STARTED
  counts.nodes >= LIMIT                   → { status: 'closed', closeTag: 'consensus_not_reached' }
  otherwise                               → { status: 'voting' }

VOTES_COLLECTED
  counts.syntheses === 0                  → null
  counts.voters < counts.critics          → null
  counts.nodes >= LIMIT                   → { status: 'closed', closeTag: 'consensus_not_reached' }
  votesOnSynthesis > 0
    && approvedVotes === votesOnSynthesis → { status: 'closed', closeTag: 'consensus_reached' }
  otherwise                               → { status: 'voting' }
```

### One intentional difference

`VOTE_ROUND_STARTED` collapses transitions 7 and 8 into a single decision. The current
code writes `voting` and *then* checks the node limit, producing two writes and a window
where a crash strands the opinion in `voting`. The final state is identical; only the
intermediate write disappears.

This is the sole permitted behaviour change in T13. Everything else must match the table
above exactly, defects included.

### Guards that stay in SQL

The claim predicate for transition 1 — channel has a subscriber other than the asker
with an active agent — stays in the `UPDATE ... FOR UPDATE SKIP LOCKED` statement. It is
a concurrency primitive, not a state rule, and moving it into `nextState` would break
the atomic claim.
