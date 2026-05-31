# Agent Memory — Design TDD

> **Status:** Draft for discussion
> **Channel:** This Discord thread
> **Context:** Conclave code review agents have no persistent memory — every review starts fresh. This design adds project-convention memory to the review workflow.

---

## The Problem

A fleet reviewer reviews the same codebase multiple times. Each review:
- Re-learns the project's conventions (Drizzle camelCase accessors, `|| true` tsc mask, pre-push rebase ritual)
- Has no context of what it reviewed yesterday
- Cannot know: "I flagged this issue on the last 3 reviews — it hasn't been fixed"
- Cannot adapt: "The project switched from REST to GraphQL — update your review criteria"

**Cost:** ~5-10% of every review is wasted on re-discovery. More critically, reviewers cannot escalate repeated findings or calibrate to project evolution.

---

## Design Decisions

### #1: What Kind of Memory First?

**Decision: Project Conventions** (agent-level, deterministic, key-value)

| Kind | Complexity | Value | Decision |
|------|-----------|-------|----------|
| Project conventions | Low | High | ✅ **Build first** |
| Review history ("this issue was flagged before") | Medium | High | Next |
| Semantic/vector memory | High | Medium | Last |
| User preferences about review style | Low | Medium | Parallel |

**Why conventions first:** Cheapest to build, most immediate impact. An agent that knows "this project masks tsc errors with `|| true`" reviews differently than one that doesn't. This is the gap the fleet currently has.

### #2: Memory Scope

| Scope | Pro | Con |
|-------|-----|-----|
| **Agent-level** (each agent has its own memory) | Simple, isolated | Knowledge doesn't transfer between agents under same principal |
| **Principal-level** (shared across all agents of a principal) | Knowledge shared across agents | Collision if agents disagree |
| **Channel-scoped** (memory belongs to a channel like `code-review`) | Convention knowledge is channel-specific | Cross-contamination with other channels |
| **Org-scoped** (org-wide conventions) | Global | Too broad for per-project knowledge |

**Decision: Principal-scoped memory** with optional `channel` filter.

A principal represents a reviewer identity (e.g., "Code Reviewer for Conclave"). All agents under that principal share the memory. When injected, memories are filtered by the current task's channel (e.g., only show memories tagged `channel=code-review` when reviewing a code-review task).

**Rationale:** Fleet creates/reuses agents under the same principal — those agents should share knowledge. A "channel" filter prevents the security reviewer from seeing code-review conventions.

### #3: Memory Shape

**Decision: Structured key-value with metadata**

```typescript
type AgentMemory = {
  id: string;                          // mem_<uuidv7>
  principalId: string;                 // prn_xxx
  orgId: string;                       // org_xxx  
  channel: string | null;              // optional — scope memory to a channel
  key: string;                         // e.g., "project:conclave:convention"
  value: string;                       // "src/ uses Drizzle camelCase accessors"
  category: string;                    // "convention" | "preference" | "lesson" | "observation"
  sourceTaskId: string | null;         // tsk_xxx — which task generated this memory
  sourceReviewId: string | null;       // rev_xxx — which review generated this
  helpfulScore: number;                // 0.0-1.0 — crowd-sourced quality signal
  createdAt: string;
  updatedAt: string;
}
```

**Why not vector embeddings for now:** Deterministic key matching (exact + prefix) covers conventions well. "Find me memories about TypeScript errors" is just `key LIKE 'convention:typescript:%'`. We add vectors in Phase 2 when we need semantic "find me anything related to this code diff."

### #4: Memory Injection Point

**Where in the review pipeline do memories get read?**

```
Fleet polls channel feed
  → Gets task
  → Fetches full task details
  → **NEW: Fetch relevant memories**
  → Builds system prompt (with memories injected as "Known Project Facts")
  → Calls LLM
  → **NEW: Extract learnings from the review → save as memory**
  → Submits review
```

**Decision:** Inject memories into the system prompt as a "Known Project Facts" section, right after the agent instructions. Each fact is a bullet point with its category tag.

### #5: Automatic Memory Extraction

After each review completes, the agent runs a *second small LLM call* (or the same response includes a structured section) that answers:

> "Did this review reveal any new project conventions, recurring patterns, or review-worthy facts that should be remembered?"

This is critical — it turns every review into a learning opportunity. Without it, memory is only as good as what a human manually enters.

**Risk:** LLM hallucinates conventions that aren't real. Mitigation:
- Minimum confidence threshold (0.8) before saving
- New memories start with `helpfulScore = 0.5` — each subsequent review that cites a memory and finds it useful increments the score
- Manual override via API: set `helpfulScore = 0` to suppress

---

## Data Model

```sql
CREATE TABLE clv_agent_memory (
  id TEXT PRIMARY KEY,                    -- mem_<uuidv7>
  principal_id TEXT NOT NULL REFERENCES clv_principals(id),
  org_id TEXT NOT NULL REFERENCES clv_organizations(id),
  channel TEXT,                           -- NULL means cross-channel
  key TEXT NOT NULL,                      -- "convention:drizzle:accessors"
  value TEXT NOT NULL,                    -- "Drizzle returns camelCase keys, not snake_case"
  category TEXT NOT NULL DEFAULT 'convention', 
  source_task_id TEXT REFERENCES clv_tasks(id),
  source_review_id TEXT REFERENCES clv_reviews(id),
  helpful_score REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_principal_channel ON clv_agent_memory(principal_id, channel);
CREATE INDEX idx_memory_key ON clv_agent_memory(key);
```

**Key naming convention:** Use dot-separated namespaced keys for prefix search:
- `convention:typescript:tsc-mask` — "project masks tsc errors with || true"
- `convention:drizzle:accessors` — "use camelCase, not snake_case"
- `lesson:deploy:check-build-logs` — "always check Vercel build logs after push"
- `preference:review:verbosity` — "this reviewer prefers detailed code examples"

---

## API Surface

### Store memory (manual + automatic)

```
POST /v1/principals/:id/memory
{
  channel: "code-review",          // optional
  key: "convention:typescript:tsc-mask",
  value: "This project masks tsc errors with || true — check build logs, not exit codes",
  category: "convention",
  source_task_id: "tsk_xxx"        // optional
}
→ 201 { id: "mem_xxx", ... }
```

### Query memories

```
GET /v1/principals/:id/memory?channel=code-review&key_prefix=convention:typescript
→ { data: [ ... ] }
```

Returns all memories for the principal, optionally filtered by channel and key prefix. Ordered by `helpful_score DESC, updated_at DESC`.

### Update memory (helpful score, edit value)

```
PATCH /v1/principals/:id/memory/:mem_id
{
  value: "Updated text",
  helpful_score: 0.9
}
```

### Delete memory

```
DELETE /v1/principals/:id/memory/:mem_id
```

---

## Integration into Fleet Workflow

### In `runLlmReview()` — Memory Injection

After building the system prompt but before calling the LLM:

```typescript
// In backends.ts, runLlmReview():
async function runLlmReview(agent, input, llmUrl, llmKey, timeoutMs) {
  const systemPrompt = buildLlmSystemPrompt(input);
  
  // NEW: Inject relevant memories
  const memories = await fetchRelevantMemories(
    agent.principalId,
    input.channel
  );
  if (memories.length > 0) {
    const memorySection = memories
      .map(m => `- [${m.category}] ${m.key}: ${m.value}`)
      .join('\n');
    systemPrompt += `\n\n## Known Project Facts\n\nThese facts about the project were learned from previous reviews. Keep them in mind:\n\n${memorySection}`;
  }
  
  // ... rest of existing code
}
```

### In Fleet Manager — Memory Extraction After Review

After a review is submitted successfully:

```typescript
// After submitReview():
try {
  const learnings = await extractMemoryFromReview(
    reviewer.llmUrl, 
    reviewer.llmKey,
    reviewer.model,
    task, 
    reviewResult
  );
  for (const learning of learnings) {
    await client.storeMemory(principalId, {
      channel: task.channel,
      key: learning.key,
      value: learning.value,
      category: learning.category,
      source_task_id: task.id,
    });
  }
} catch (err) {
  console.warn(`Memory extraction failed (non-fatal): ${err.message}`);
}
```

### Memory Extraction Prompt

A lightweight LLM call (or structured output from the main review call) that produces:

```json
{
  "learnings": [
    {
      "key": "convention:typescript:error-handling",
      "value": "The project uses Result<T, E> pattern for error handling, not try/catch",
      "category": "convention",
      "confidence": 0.85
    }
  ]
}
```

---

## Phasing Plan

### Phase 1: Table + API (this sprint)
- Create `clv_agent_memory` table in `src/db/schema.ts` and `src/db/index.ts`
- Create `src/services/memory.ts` — CRUD service with channel filtering
- Create `src/routes/memory.ts` — POST/GET/PATCH/DELETE endpoints
- Wire routes into `src/main.ts`
- **Test:** `curl POST /v1/principals/prn_dev/memory` → get back `201`
- **Test:** `curl GET /v1/principals/prn_dev/memory` → see saved memory

### Phase 2: Inject into Reviews
- Add `fetchRelevantMemories(principalId, channel)` method to ConclaveApiClient
- Modify `backends.ts` `runLlmReview()` to accept and inject memories
- Fleet manager passes memories when calling backends
- **Test:** Submit a task, review system prompt includes "Known Project Facts"

### Phase 3: Automatic Extraction
- Add memory extraction prompt to the review loop
- Call extraction after successful review submission
- Filter by confidence threshold
- **Test:** Submit a task with clear conventions → verified in DB after review

### Phase 4: Dashboard + Manual Management
- Add "Agent Memory" view in dashboard (`#view-memory`)
- Display stored memories with category + key + value
- Allow manual add, edit, delete
- Show `helpful_score` and source task links

---

## Open Questions (discuss here)

1. **Memory per principal or per channel?** The design says principal-scoped + channel filter. Would you want memory that's truly *project-scoped* (across principals)?
2. **Automatic extraction — same LLM call or separate?** Separate gives more control but costs more. Same call (structured output in the review response) is cheaper but adds latency to review.
3. **What's the right first memory category?** Conventions is clear. Do we also want "review observations" out of the gate? ("This PR hasn't fixed the type error flagged 2 reviews ago")
4. **Memory TTL / expiration?** Conventions change. Do we need a `ttl_days` field, or is editing enough?
5. **Dashboard placement —** new sidebar item "Memory" or a section inside existing views (Factory / Fleet)?
