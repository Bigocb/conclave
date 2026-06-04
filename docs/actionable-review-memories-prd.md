# PRD: Actionable Review Memories

## Problem Statement

When agents submit reviews through Conclave, the system auto-writes "memory facts" to the reviewer's and submitter's principals. Currently, these memories are useless — they store raw score numbers (`review:score:correctness:high` → `"9"`), keyword-grep comment fragments (`review:topic:naming` → `"The naming convention..."`), and boolean flags (`review:last:approved` → `"true"`). None of these carry enough context to be actionable.

When the fleet injects memories into future review prompts, it passes raw value strings like `"9"` or `"true"` — the LLM gets no useful signal. When the user views memories in the UI, they see a flat list of meaningless key-value pairs with no grouping, no source attribution, and no way to tell what's stale.

## Solution

Replace the current keyword-grep memory extraction with an LLM-based distillation pipeline that extracts **actionable conventions** from review comments. Each convention is stored with full context (source task, reviewer, confidence, TTL) and injected into future fleet reviews as a structured conventions block. The UI groups conventions by category (style, testing, architecture, etc.) and shows them as human-readable cards.

## User Stories

1. As an agent submitting work for review, I want the feedback I receive to be distilled into actionable conventions, so that I can improve my future work.
2. As a fleet reviewer, I want to see known conventions injected into my review prompt as a structured block, so that I can check whether the work follows established patterns.
3. As a user viewing the memory UI, I want to see conventions grouped by category (style, testing, architecture), so that I can quickly understand what patterns my agents are learning.
4. As a user, I want each convention to show its source task and confidence level, so that I can evaluate whether it's still relevant.
5. As a user, I want conventions that haven't been reinforced in 30 days to auto-expire, so that stale patterns don't accumulate.
6. As a user, I want to manually add or remove conventions via the existing POST/DELETE memory API, so that I can override what the system learns.
7. As a developer, I want the memory extraction to be non-blocking (fire-and-forget), so that review submission latency is not affected.
8. As a developer, I want a fallback to keyword-grep extraction if the LLM call fails, so that we never lose memory extraction entirely.
9. As a user, I want the old junk memories (`review:score:*`, `review:topic:*`, etc.) cleaned up, so that the UI isn't cluttered with noise.

## Implementation Decisions

### Memory Schema — New Context Fields

Four new nullable columns on `clv_principal_memory`:

- `source_task_id` (text) — Links each convention back to the task that produced it
- `source_principal_id` (text) — Who wrote the review that produced this memory
- `confidence` (real, default 0.5) — How confident the extraction was
- `ttl_days` (integer, default 30) — Auto-expire after N days without reinforcement

### MemoryExtractor Service

A new service (`MemoryExtractor`) that replaces the current keyword-grep loop in `writeMemoryFromReview`. It calls an LLM with a structured prompt that takes the review comment, scores, suggestions, and task description, and returns 0-3 actionable conventions as a JSON array.

Each convention has: `{ convention, category, confidence, evidence }`.

Categories: `style`, `architecture`, `testing`, `error-handling`, `naming`, `docs`, `performance`, `security`.

**Fallback:** If the LLM call fails, fall back to the current keyword-grep approach.

**Non-blocking:** The extraction runs in a try/catch after the review is submitted — failures are logged but don't fail the review.

### Convention Deduplication

Same convention text (normalized) maps to the same memory key via a hash. When the same convention is extracted from multiple reviews, it reinforces (increments a count, resets TTL) rather than duplicating.

### Structured Fleet Injection

The fleet manager (`reviewTask` in `manager.ts`) currently passes `memories = memoryEntries.map(m => m.value)`. This changes to format conventions as a structured block:

```
## Known Conventions (from past reviews)

- Use async/await consistently (confidence: 0.9, category: style)
  Evidence: "Prefer async/await over .then() chains"
  Source: task tsk_abc123
```

Only conventions with `confidence >= 0.6` and non-expired TTL are injected.

### Grouped API Response

`GET /v1/memory?grouped=true` returns conventions organized by category:

```json
{
  "grouped": {
    "style": [
      { "convention": "Use async/await", "confidence": 0.9, "source_task": "tsk_abc", "updated_at": "..." }
    ],
    "testing": [...]
  }
}
```

### Cleanup

A SQL script to delete all old-format junk memories (`review:score:*`, `review:topic:*`, `review:last:approved`, `review:suggestions:count`).

## Testing Decisions

- **MemoryExtractor** should be tested in isolation — mock the LLM call, verify the extraction logic and fallback behavior.
- **MemoryService** tests already exist in `src/__tests__/memory.test.ts` — extend to cover the new context fields.
- **Fleet memory injection** — test that conventions are formatted correctly and filtered by confidence threshold.
- **Grouped API** — test that `?grouped=true` returns the correct shape.
- **What makes a good test:** Test external behavior (correct conventions extracted, correct API response shape), not implementation details (which LLM provider is used, how the hash is computed).

## Out of Scope

- User-editable conventions in the UI (the API already supports POST/DELETE — a UI for this is future work)
- Multi-LLM-provider extraction routing (use the same provider as the fleet)
- Real-time convention reinforcement visualization (charts, trends)
- Cross-org convention sharing
- Batch extraction (extract from 1 in N reviews for cost savings — future optimization)

## Further Notes

- The existing `writeMemoryFromReview` function in `src/services/tasks.ts` is the single point of change for extraction — all review submissions flow through it.
- The existing cleanup cron in `src/routes/cron.ts` already handles TTL-based expiry — the new `ttl_days` field integrates with it.
- The `GET /v1/memory` route was recently updated (PR #103) to aggregate across all org principals for user JWTs — the grouped view builds on this.
- The LLM extraction prompt should be kept in a constant, not hardcoded in the service, so it can be iterated on without code changes.
