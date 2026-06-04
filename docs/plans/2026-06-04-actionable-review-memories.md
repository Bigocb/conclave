# Actionable Review Memories — Design Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task.

**Goal:** Replace the current useless review memories (raw scores, keyword-grep comment fragments) with structured, actionable conventions that agents can actually use and users can actually read.

**Architecture:** Three-phase pipeline — (1) LLM-distill review comments into structured conventions, (2) store with full context (task, reviewer, timestamp), (3) inject into fleet reviews as structured context, not raw strings. UI shows grouped, human-readable observations.

**Tech Stack:** TypeScript, Drizzle ORM, existing MemoryService + fleet backends

---

## Current State (The Problem)

### What `writeMemoryFromReview` writes today

| Key | Value | Why it's useless |
|---|---|---|
| `review:score:correctness:high` | `9` | No context — what task? what was the issue? |
| `review:score:security:low` | `3` | Same — a number with zero explanation |
| `review:topic:naming` | `"The naming convention..."` | Raw 200-char comment fragment, not a distilled convention |
| `review:last:approved` | `true` | Overwrites every time, loses history |
| `review:suggestions:count` | `2` | A count with no content |

### How memories are consumed

**Fleet reviews** (`manager.ts:718`): `memories = memoryEntries.map(m => m.value)` — injects raw strings like `"9"` or `"true"` into the LLM prompt. No structure, no context, no value.

**UI**: Shows flat key-value pairs with no grouping, no source attribution, no way to tell what's stale.

---

## Design

### Phase 1: Memory Schema — Add Context Fields

**Goal:** Every memory entry carries enough context to be useful on its own.

**New fields on `clv_principal_memory`:**

| Field | Type | Purpose |
|---|---|---|
| `source_task_id` | `text` | The task that generated this memory (links back to the review) |
| `source_principal_id` | `text` | Who wrote the review that produced this memory |
| `confidence` | `real` | How confident the system is in this convention (0.0-1.0) |
| `ttl_days` | `integer` | Auto-expire after N days (conventions decay) |

**Migration:** Add columns to existing table. Nullable for backward compat.

### Phase 2: Memory Extraction — LLM Distillation, Not Keyword Grep

**Goal:** Replace the keyword-matching loop with an LLM call that extracts actual actionable conventions from review comments.

**New service: `MemoryExtractor`**

```
Review comment + scores + task description
    ↓
LLM call: "Extract 0-3 actionable conventions from this review feedback"
    ↓
Structured output: [{ convention, category, confidence, evidence }]
    ↓
Write to memory with full context
```

**Prompt for extraction:**

```
You are analyzing a code review to extract durable conventions the agent should remember.

Task: {task_description}
Review comment: {comment}
Scores: {scores_json}
Suggestions: {suggestions}

Extract 0-3 actionable conventions. A convention is a specific rule or pattern
the agent should follow in future work. Examples:
- "Error messages must include a correlation ID" (not "error handling could be better")
- "Use async/await, not .then() chains" (not "style needs work")
- "All public functions need docstrings" (not "add more documentation")

Return as JSON array:
[{ "convention": "...", "category": "style|architecture|testing|error-handling|naming|docs|performance|security", "confidence": 0.0-1.0, "evidence": "quote from comment" }]

Return [] if no actionable conventions found.
```

**Cost:** 1 LLM call per review submission. Non-blocking (fire-and-forget, failures logged).

**Fallback:** If LLM call fails, fall back to the current keyword-grep approach (better than nothing).

### Phase 3: Memory Injection — Structured, Not Raw Strings

**Goal:** Fleet reviewers receive memories as structured context, not raw value strings.

**Current (`manager.ts:718-719`):**
```typescript
const memoryEntries = await this.memoryService.getByPrincipal(principalId);
memories = memoryEntries.map(m => m.value);
```

**New approach:** Format memories as a structured conventions block in the review prompt:

```
## Known Conventions (from past reviews)

The following conventions have been established in previous reviews.
Follow them unless you have a strong reason to deviate.

1. [convention] (confidence: 0.9, category: style)
   Evidence: "Use async/await consistently"
   Source: task tsk_abc123

2. [convention] (confidence: 0.7, category: error-handling)
   Evidence: "All API errors should include a correlation ID"
   Source: task tsk_def456
```

**Filtering:** Only inject conventions with `confidence >= 0.6` and `ttl_days` not expired.

### Phase 4: UI — Grouped, Human-Readable View

**Goal:** The UI shows memories grouped by category, with source context, not a flat key-value dump.

**API change:** `GET /v1/memory` returns an additional `grouped` view:

```json
{
  "memories": [...],
  "grouped": {
    "style": [
      { "convention": "Use async/await", "confidence": 0.9, "source_task": "tsk_abc", "count": 3 }
    ],
    "testing": [...],
    "error-handling": [...]
  }
}
```

**UI rendering:** Category tabs (Style, Testing, Architecture, etc.) with convention cards showing:
- The convention text (bold)
- Confidence bar
- Source task link
- How many reviews reinforced this convention

### Phase 5: Decay & Reinforcement

**Goal:** Conventions that keep appearing get reinforced; stale ones expire.

- Each time the same convention is extracted, increment a `reinforcement_count` and reset TTL
- Conventions not reinforced within `ttl_days` get auto-expired by the existing cleanup cron
- `confidence` is the average of all extraction confidences for that convention key

**Dedup key:** `convention:<normalized-hash>` — same convention text (normalized) maps to the same key, so reinforcement works.

---

## Implementation Plan

### Task 1: Add context columns to memory schema

**Objective:** Add `source_task_id`, `source_principal_id`, `confidence`, `ttl_days` columns to `clv_principal_memory`

**Files:**
- Modify: `src/db/schema.ts` (principalMemory table)
- Modify: `src/db/index.ts` (migration SQL)
- Modify: `src/services/memory.ts` (MemoryEntry interface + upsert)

**Step 1: Update schema**

Add to `principalMemory` table in `src/db/schema.ts`:
```typescript
sourceTaskId: text('source_task_id'),
sourcePrincipalId: text('source_principal_id'),
confidence: real('confidence').default(0.5),
ttlDays: integer('ttl_days').default(30),
```

**Step 2: Add migration SQL**

In `src/db/index.ts`, add to the initDb migration:
```sql
ALTER TABLE clv_principal_memory ADD COLUMN IF NOT EXISTS source_task_id text;
ALTER TABLE clv_principal_memory ADD COLUMN IF NOT EXISTS source_principal_id text;
ALTER TABLE clv_principal_memory ADD COLUMN IF NOT EXISTS confidence real DEFAULT 0.5;
ALTER TABLE clv_principal_memory ADD COLUMN IF NOT EXISTS ttl_days integer DEFAULT 30;
```

**Step 3: Update MemoryEntry interface + upsert**

In `src/services/memory.ts`, add the new fields to `MemoryEntry` and `upsert()`.

**Step 4: Commit**
```bash
git add src/db/schema.ts src/db/index.ts src/services/memory.ts
git commit -m "feat: add context fields to principal memory (source_task, confidence, ttl)"
```

---

### Task 2: Create MemoryExtractor service

**Objective:** New service that uses an LLM call to distill review comments into actionable conventions

**Files:**
- Create: `src/services/memory-extractor.ts`
- Modify: `src/services/tasks.ts` (wire it into `writeMemoryFromReview`)

**Step 1: Create MemoryExtractor**

```typescript
// src/services/memory-extractor.ts
export interface ExtractedConvention {
  convention: string;
  category: 'style' | 'architecture' | 'testing' | 'error-handling' | 'naming' | 'docs' | 'performance' | 'security';
  confidence: number;
  evidence: string;
}

export class MemoryExtractor {
  async extract(input: {
    taskDescription: string;
    comment: string;
    scores: Record<string, number>;
    suggestions?: string[];
  }): Promise<ExtractedConvention[]> {
    // Build prompt, call LLM, parse JSON response
    // Fallback to keyword-grep on failure
  }
}
```

**Step 2: Wire into `writeMemoryFromReview`**

Replace the keyword loop with:
```typescript
const conventions = await extractor.extract({ taskDescription, comment, scores, suggestions });
for (const c of conventions) {
  facts.push({
    key: `convention:${hash(c.convention)}`,
    value: c.convention,
    category: c.category,
    sourceTaskId: taskId,
    sourcePrincipalId: reviewerPrincipalId,
    confidence: c.confidence,
    ttlDays: 30,
  });
}
```

**Step 3: Commit**
```bash
git add src/services/memory-extractor.ts src/services/tasks.ts
git commit -m "feat: LLM-based memory extraction from review comments"
```

---

### Task 3: Structured memory injection in fleet reviews

**Objective:** Fleet reviewers receive conventions as structured blocks, not raw value strings

**Files:**
- Modify: `src/fleet/manager.ts` (memory formatting in `reviewTask`)
- Modify: `src/fleet/backends.ts` (prompt template for memory injection)

**Step 1: Format conventions block**

In `manager.ts`, replace the raw `memories.map(m => m.value)` with:
```typescript
const conventionsBlock = memoryEntries
  .filter(m => m.confidence >= 0.6 && m.category !== 'fact')
  .map(m => `- ${m.value} (confidence: ${m.confidence}, category: ${m.category})`)
  .join('\n');
```

**Step 2: Update prompt template**

In `backends.ts`, add a `## Known Conventions` section to the system prompt when conventions exist.

**Step 3: Commit**
```bash
git add src/fleet/manager.ts src/fleet/backends.ts
git commit -m "feat: structured convention injection in fleet review prompts"
```

---

### Task 4: Grouped API response for UI

**Objective:** `GET /v1/memory` returns a `grouped` view organized by category

**Files:**
- Modify: `src/routes/memory.ts` (add grouped response)
- Modify: `src/services/memory.ts` (add `getGroupedByOrg` method)

**Step 1: Add `getGrouped` to MemoryService**

```typescript
async getGroupedByOrg(orgId: string) {
  const memories = await this.getByOrg(orgId);
  const grouped: Record<string, any[]> = {};
  for (const m of memories) {
    const cat = m.category || 'general';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({
      convention: m.value,
      confidence: m.confidence,
      source_task: m.sourceTaskId,
      updated_at: m.updatedAt,
    });
  }
  return grouped;
}
```

**Step 2: Add `?grouped=true` query param to GET /memory**

In `routes/memory.ts`, when `grouped=true`, return the grouped view instead of flat list.

**Step 3: Commit**
```bash
git add src/routes/memory.ts src/services/memory.ts
git commit -m "feat: grouped memory API response for UI"
```

---

### Task 5: Clean up old junk memories

**Objective:** Remove the useless `review:score:*`, `review:topic:*`, `review:last:approved`, `review:suggestions:count` entries

**Files:**
- Create: `scripts/cleanup-junk-memories.sql`

**Step 1: Write cleanup SQL**

```sql
DELETE FROM clv_principal_memory
WHERE key LIKE 'review:score:%'
   OR key LIKE 'review:topic:%'
   OR key = 'review:last:approved'
   OR key = 'review:suggestions:count';
```

**Step 2: Run against production DB**

```bash
psql $DATABASE_URL -f scripts/cleanup-junk-memories.sql
```

**Step 3: Commit**
```bash
git add scripts/cleanup-junk-memories.sql
git commit -m "chore: cleanup script for junk review memories"
```

---

## Open Questions

1. **LLM provider for extraction** — Use the same provider as the fleet (ollama_cloud) or a dedicated one? Recommendation: same provider, it's a simple extraction task.
2. **Rate limiting** — Every review submission triggers an LLM call. At scale, this could be expensive. Consider batching or sampling (extract from 1 in N reviews).
3. **Convention dedup** — Same convention extracted from different reviews should reinforce, not duplicate. Use normalized hash as key.
4. **User-editable** — Should users be able to manually add/remove conventions? Yes — the existing POST/DELETE memory routes already support this.

## Decisions Log

| # | Decision | Choice | Date |
|---|---|---|---|
| 1 | Extraction method | LLM distillation with keyword-grep fallback | 2026-06-04 |
| 2 | Memory context fields | source_task_id, source_principal_id, confidence, ttl_days | 2026-06-04 |
| 3 | Convention dedup | Normalized hash as key, reinforcement increments count | 2026-06-04 |
| 4 | UI grouping | Category tabs with convention cards | 2026-06-04 |
| 5 | Fleet injection | Structured conventions block, confidence >= 0.6 filter | 2026-06-04 |
