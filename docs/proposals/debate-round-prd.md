# PRD: Confidence-Gap-Triggered Critic Debate Round

## Problem Statement

The opinion router (`src/fleet/opinion-router.ts`) collects critiques from multiple critics in parallel, each producing a `CritiqueNode` with a `confidence` score (0-1). Currently, these confidence scores are stored but never compared across critics. When two critics have significantly divergent confidence levels — one highly confident, one deeply uncertain — there is no mechanism for them to engage with each other's reasoning. The "Socratic Loop" described in the brand narrative is incomplete: critics respond to the synthesis independently but never debate each other.

This means divergent perspectives are never reconciled before synthesis, reducing the quality of the final consensus and missing the core value of multi-agent deliberation.

## Solution

Add a **debate round** to the opinion router's Democratic topology state machine. After all initial critiques are collected, the router detects whether any pair of critics has a confidence gap exceeding a configurable threshold. If so, it triggers a structured pairwise debate between the highest-confidence and lowest-confidence critic before proceeding to synthesis.

The debate is bounded (max 2 rounds, with early exit on convergence), uses existing edge kinds (`refutes`, `addresses`), and carries no budget cost. The state machine gains a new `debating` status between `in_review` and `synthesizing`.

## User Stories

1. As an agent critic, I want my confidence score to be compared against other critics' scores, so that significant disagreement is detected automatically rather than ignored.

2. As an agent critic, I want to explain *why* I lack confidence when my confidence is significantly lower than another critic's, so that my uncertainty is surfaced and addressed before synthesis.

3. As an agent critic, I want to respond to a low-confidence critic's concerns when my confidence is high, so that I can address their specific doubts and potentially narrow the gap.

4. As the asking agent, I want the debate round to complete before I produce my synthesis, so that my synthesis incorporates the refined positions of all critics.

5. As a fleet operator, I want the debate to be bounded (max 2 rounds), so that stalled disagreements don't loop forever or burn excessive LLM budget.

6. As a fleet operator, I want the debate to exit early if the confidence gap narrows below threshold, so that unnecessary rounds are skipped when convergence happens quickly.

7. As a fleet operator, I want the confidence gap threshold and max debate rounds to be configurable via fleet YAML, so that I can tune the behavior per deployment.

8. As a user viewing an opinion thread, I want debate rounds to be visually grouped under a collapsible "⚡ Debate Round N" section in the Conversation tab, so that I can distinguish debate exchanges from independent critiques.

9. As a user viewing the Blackboard tab, I want debate nodes to show clear edge labels (`refutes`, `addresses`), so that the graph structure of the debate is traceable.

10. As an agent critic, I want my debate round responses to carry no budget cost, consistent with the existing policy that follow-up nodes in opinion threads are free.

## Implementation Decisions

### Gap Detection

After all initial critiques are collected in `routeOpinion()`, the router calculates the pairwise max-min confidence spread. If `max(confidence) - min(confidence) > threshold`, it transitions to the `debating` state instead of `synthesizing`.

- **Detection point**: After `Promise.all(critiquePromises)` resolves, before the status update at line 944-957 of `opinion-router.ts`
- **Threshold**: Configurable via fleet YAML / env var (`CONFIDENCE_GAP_THRESHOLD`, default `0.4`)
- **Scope**: Only the highest-confidence and lowest-confidence critic participate in the debate. Middle critics are not involved.

### State Machine

A new `debating` status is added between `in_review` and `synthesizing`. No schema migration needed — `status` is already a TEXT column in `clv_opinions`.

```
open → in_review → debating → synthesizing → voting → closed
```

The polling loop in `startPolling()` already handles unknown statuses gracefully — no changes needed to the polling infrastructure.

### Debate Round Mechanics

- **Round 1**: Low-confidence critic is prompted to explain their uncertainty, specifically addressing the high-confidence critic's position. Produces a CritiqueNode with edge `refutes` → high-confidence critic's original CritiqueNode.
- **Round 1 response**: High-confidence critic is prompted to respond to the low-confidence critic's concerns. Produces a CritiqueNode with edge `addresses` → low-confidence critic's rebuttal.
- **Round 2** (if needed): Same pattern, but each critic sees the full exchange history. After round 2, proceed to synthesis regardless.
- **Early exit**: After each round, recalculate the confidence gap. If `max - min <= threshold`, exit debate and proceed to synthesis immediately.

### Edge Kinds

Uses existing edge kinds already defined in the schema — no migration needed:

- `refutes`: Low-confidence critic's debate node → high-confidence critic's original CritiqueNode
- `addresses`: High-confidence critic's response → low-confidence critic's debate node

### Budget Model

Debate round responses are free — consistent with the existing policy (user story #12 in the opinion fleet PRD) that follow-up nodes in opinion threads carry no budget charge. Critics already earned +2 for their first critique.

### Configuration

Two new fleet YAML / env var fields:

| Field | Env Var | Default | Description |
|---|---|---|---|
| `confidence_gap_threshold` | `CONFIDENCE_GAP_THRESHOLD` | `0.4` | Max-min confidence spread that triggers debate |
| `max_debate_rounds` | `MAX_DEBATE_ROUNDS` | `2` | Max debate rounds before forced convergence |

### UI Representation

- **Conversation tab**: Debate nodes are grouped under a collapsible "⚡ Debate Round N" header per round, with critic names and a debate badge. Subdued styling to distinguish from primary critiques.
- **Blackboard tab**: Debate nodes appear as CritiqueNodes with edge labels `refutes` and `addresses`, branching from the original critique nodes.

### Modules

| Module | Location | Responsibility |
|---|---|---|
| `triggerDebateRound()` | `src/fleet/opinion-router.ts` (new method) | Orchestrates the pairwise debate: identifies divergent pair, runs up to 2 rounds of exchange, checks convergence, transitions to synthesizing |
| `routeOpinion()` | `src/fleet/opinion-router.ts` (modify) | After critiques collected, check confidence gap and call `triggerDebateRound()` instead of transitioning directly to synthesizing |
| `checkDebatingOpinions()` | `src/fleet/opinion-router.ts` (new method) | Polling handler for opinions in `debating` state — checks if debate round is complete and transitions |
| `buildDebatePrompt()` | `src/fleet/opinion-router.ts` (new function) | Builds the LLM prompt for a debate round participant, including the exchange history and the other critic's position |
| Fleet config | `src/fleet/config.ts` (modify) | Add `confidence_gap_threshold` and `max_debate_rounds` fields |

## Testing Decisions

Good tests verify the debate round state machine through the opinion router's public interfaces — not the LLM's ability to produce valid debate responses.

**What to test:**
- **Gap detection**: Given critiques with confidences [0.9, 0.3, 0.7] and threshold 0.4, verify debate is triggered. Given [0.8, 0.7, 0.9], verify debate is skipped.
- **Debate lifecycle**: Full cycle — critiques collected → gap detected → debating state → round 1 complete → gap still wide → round 2 complete → transition to synthesizing.
- **Early exit**: Round 1 narrows gap below threshold → exit to synthesizing immediately (no round 2).
- **Edge cases**: Only 1 critic (no debate possible). All critics have same confidence (no gap). Critic goes unresponsive during debate (skip and proceed).
- **Config**: Verify threshold and max rounds are read from fleet config with correct defaults.

**How to test:** Unit tests with mocked DB for the opinion router, mirroring the existing test patterns in `src/__tests__/`. The `triggerDebateRound()` method should be testable by injecting mock LLM responses.

**What NOT to test:** The LLM's ability to produce valid debate responses. The UI rendering (covered by conclave-fe).

## Out of Scope

- Multi-critic broadcast debate (pairwise only for MVP)
- New edge kinds beyond `refutes` and `addresses` (both already exist in schema)
- Embedding-based similarity for detecting disagreement (confidence gap is sufficient for MVP)
- Real-time streaming of debate exchanges (polling-based for MVP)
- Human-in-the-loop participation in debates (agent-only for MVP)
- Cross-org opinion threads (org-isolated, same as tasks)
- Debate history versioning (append-only for MVP)

## Further Notes

- The `refutes` and `addresses` edge kinds already exist in the `clv_blackboard_edges` schema but are not yet used by the opinion router. This PRD puts them to first use.
- The 10-node hard limit (`HARD_NODE_LIMIT`) still applies as a backstop — if debate rounds push the total node count to 10, the opinion is force-closed with `consensus_not_reached`.
- This design extends the existing opinion fleet automation (conclave#57) and is a prerequisite for more complex graph topologies (multi-critic broadcast, hierarchical debate, etc.).
- The `debating` status is a TEXT column value — no DB migration required.
