# Fleet YAML Management from Dashboard — Phased Implementation Plan (v2)

## Overview
Move fleet config from `fleet.yaml` on disk to DB-backed storage with a full dashboard UI. Self-hosted and hosted experiences become identical — just the config source differs (file vs DB).

**Key design decisions (reviewer-informed):**
- JSONB for config storage — atomic reads/writes, schema flexibility, proven choice
- Polling-based hot-reload initially — upgrade to pg_notify when needed
- Optimistic locking via `updated_at` to prevent concurrent edit conflicts
- Migration path: seeding from fleet.yaml, then DB takes over

## Phase 1: Backend — Fleet Config Storage & API

### 1a. DB Schema
```sql
CREATE TABLE clv_fleet_configs (
  org_id TEXT PRIMARY KEY REFERENCES clv_organizations(id),
  config JSONB NOT NULL DEFAULT '{}',  -- full fleet.yaml structure
  updated_at TIMESTAMP DEFAULT NOW()
);
```

JSONB stores the full config (org_id, scope, providers, reviewers array) — avoids rigid schema changes as config evolves.

**Why JSONB over separate tables:**
- Config shape is inherently flexible (custom providers, varied reviewer fields)
- No schema migrations when adding new reviewer fields (skills, type, command)
- Atomic read/write — no partial config state
- Drizzle supports JSONB with `jsonb()` type

### 1b. API Endpoints — Optimistic Locking

All config writes use optimistic locking to prevent concurrent edit conflicts:

```
PUT /v1/fleet/config
  Headers: If-Match: "<updated_at timestamp>"
  Body: { ... full config ... }

  → 200 if updated_at matches DB
  → 409 CONFLICT if another edit happened first
  → Client re-fetches GET /v1/fleet/config, merges, retries
```

Since fleet config is a single JSONB document per org (not multi-row), the write is atomic within a DB transaction. The `updated_at` check is the only concurrency mechanism needed — no application-level locking. Conflicts are rare (single admin editing fleet config) and easy to resolve (just re-fetch + re-edit).

**`GET /v1/fleet/config`** — Return the fleet config
- Merge: DB config first, seeded fallback from file
- Response: `{ org_id, scope, providers, reviewers }` — mirrors fleet.yaml shape
- Fallback config (if nothing saved yet):
  ```json
  {
    "org_id": "<current_org>",
    "scope": "public",
    "providers": {},
    "reviewers": []
  }
  ```

**`PUT /v1/fleet/config`** — Save + trigger re-provisioning
- Accepts full config body
- Validates: at least 1 reviewer, each reviewer has name + channels
- Stores `llm_key` references in vault (not in config JSON)
- On save: computes diff vs previous config → stores in response metadata
- Returns: `{ saved: true, diff: { added: [...], removed: [...], modified: [...] } }`

**`POST /v1/fleet/config/apply`** — Dry-run: compute diff without saving
- Accepts a config body
- Compares against stored config (or empty)
- Returns the same diff structure as PUT but does NOT persist

**`GET /v1/fleet/config/export`** — Download as YAML
- Returns `Content-Type: application/x-yaml`
- Serializes the config back to fleet.yaml format
- Includes `# Managed by Conclave Dashboard` header

**`POST /v1/fleet/config/import`** — Upload YAML config
- Accepts YAML body
- Parses, validates, stores as JSONB
- Same validation + diff logic as PUT

### 1c. Files to create/modify

| File | Action | Notes |
|------|--------|-------|
| `src/db/schema.ts` | Add `fleetConfigs` table | Drizzle pgTable with JSONB |
| `src/services/fleet-config.ts` | **Create** | `FleetConfigService` — CRUD + diff logic |
| `src/routes/fleet-config.ts` | **Create** | 5 endpoints |
| `src/server/index.ts` | Register new route | `fastify.register(fleetConfigRoutes)` |
| `src/middleware/auth.ts` | No change | Org isolation via existing middleware |

**Dependencies:**
- `yaml` npm package for export/import (lightweight, no native deps)
- `deep-diff` or custom comparison function for config diffing

## Phase 2: Dashboard UI — Fleet Config Editor

### 2a. Fleet View Redesign

Replace current "Principals" fleet view with a config editor. The new Fleet view shows:

**Top section:** Config summary bar — scope, reviewer count, providers, "Last saved" timestamp

**Reviewer cards:** One card per reviewer entry showing:
- Name, type icon (llm/slim/code/pipeline), replicas badge
- Provider + model
- Channel tags (clickable → filter tasks by channel)
- Instructions preview (truncated with expand)
- Skills tags
- Edit / Remove buttons

**Actions bar:**
- "Add Reviewer" button → opens modal
- "Preview Changes" button → shows diff modal
- "Export YAML" → downloads fleet.yaml
- "Import YAML" → file upload

### 2b. Add/Edit Reviewer Modal

Form fields:

| Field | Type | Notes |
|-------|------|-------|
| Name | text input | Required |
| Type | dropdown | llm / slim / code / pipeline |
| Channels | multi-select | From existing channels, with "new channel" option |
| Provider | dropdown | From existing providers + custom option |
| Model | text input | Free text (any model name) |
| LLM API Key | password + "Use vault key" toggle | If vault key exists for this provider, pre-fill toggle |
| Replicas | number input | 1-20 |
| Instructions | textarea (monospace, 6 rows) | System prompt |
| Skills | multi-tag input | Free-text tags |
| Command | text input | Only for type=code |
| Interval | number input | Seconds between polls (default: 15) |

### 2c. Diff Preview Modal

When user clicks "Preview Changes":

Shows a split-view diff:
- **Green section:** New reviewers to create (name, model, provider, channels)
- **Red section:** Reviewers to decommission (name, agent IDs)
- **Yellow section:** Modified reviewers (old → new config side by side, with changed fields highlighted)

"Apply" button at bottom → calls `PUT /v1/fleet/config`

### 2d. Files to modify

| File | Action | Notes |
|------|--------|-------|
| `public/dashboard.html` | Add `#view-fleet-config` section | New view container, diff modal, import/export buttons |
| `public/dashboard.js` | Add fleet-config CRUD functions | ~300 lines of JS |
| `public/style.css` | Minor additions | Card styles, diff colors, skill tags |

## Phase 3: Fleet Daemon Integration

### 3a. Migration Path: File → DB

**Initial deployment (no saved config yet):**
1. FleetManager starts, calls `GET /v1/fleet/config`
2. No DB config exists → returns empty config (`reviewers: []`)
3. FleetManager reads `fleet.yaml` file as fallback (legacy mode)
4. Dashboard shows the file-based config as read-only, with "Import fleet.yaml to DB" prompt

**First DB save:**
1. Admin imports or manually enters config via dashboard
2. `PUT /v1/fleet/config` saves to DB
3. FleetManager detects DB config exists (vs empty) on next poll → switches to DB source
4. file-based fallback is no longer queried

**Rollback if migration fails:**
- File-based config is never deleted — it stays on disk as a safety net
- `DELETE /v1/fleet/config` removes DB config, FleetManager falls back to file
- Docker image continues bundling `fleet.docker.yaml` as the default seed

### 3b. Make Fleet Manager Read from DB

Current flow in `src/fleet/manager.ts`:
```typescript
constructor(config: FleetConfig) {
  this.config = config;
}
```

New flow — FleetManager accepts an optional `orgId` + `serverUrl` + `token` and fetches config from API:
```typescript
constructor(opts: { orgId: string; serverUrl: string; token: string }) {
  // Config fetched on start via GET /v1/fleet/config
}
```

For backward compatibility: keep the `FleetConfig` constructor, add `FleetConfigSource` union type.

### 3b. Hot-Reload on Config Change

Two mechanisms (pick one or both):

**Option A: Poll-based (simple)**
FleetManager polls `GET /v1/fleet/config` every 60s and compares `updated_at`. If changed, re-provisions changed reviewers.

**Option B: Signal-based (efficient)**
When `PUT /v1/fleet/config` is called, it sends a notification via `pg_notify('fleet_config_changed', orgId)`. The fleet worker (running PG LISTEN) picks it up and re-provisions.

**Recommendation:** Start with Option A (polling) since it requires no DB LISTEN changes on the fleet side. The local fleet already polls every 15-25s — adding a 60s config poll is negligible overhead.

### 3c. Re-Provisioning Logic (Diff + Apply)

Extract from `provision()` into a standalone `reconcile()` method:

```typescript
async reconcile(): Promise<ProvisioningDiff> {
  const desired = this.config.reviewers;
  const current = this.getCurrentReviewerProcesses();

  // Calculate diff
  const added = desired.filter(d => !current.has(principalSlug(d.name)));
  const removed = current.filter(c => !desired.find(d => principalSlug(d.name) === c));
  const modified = desired.filter(d => {
    const existing = current.get(principalSlug(d.name));
    if (!existing) return false;
    return !isConfigEqual(d, existing);
  });

  // Apply
  for (const reviewer of removed) await this.decommissionReviewer(reviewer);
  for (const reviewer of added) await this.provisionReviewer(reviewer);
  for (const reviewer of modified) await this.updateReviewer(reviewer, current.get(principalSlug(reviewer.name)));

  return { added, removed, modified };
}
```

### 3d. Decommission Logic (Orphan fix, issue #24)

When removing a reviewer or reducing replicas:

```typescript
async decommissionReviewer(slug: string): Promise<void> {
  const process = this.processes.get(slug);
  if (process) {
    clearInterval(process.timer);
    this.processes.delete(slug);
  }
  // Decommission agents via API
  const agents = await client.listAgentsUnderPrincipal(process.principalId);
  for (const agent of agents) {
    await client.deleteAgent(agent.id);
  }
  // Decommission principal (or leave for history)
  await client.deletePrincipal(process.principalId);
}
```

### 3e. Files to modify

| File | Action | Notes |
|------|--------|-------|
| `src/fleet/manager.ts` | Add `reconcile()`, `decommissionReviewer()`, `updateReviewer()` | Extract from provision() |
| `src/fleet/config.ts` | Add `FleetConfigSource` type, `isConfigEqual()` helper | Union type for file vs DB |
| `src/fleet/index.ts` | Accept `--org-id` + `--server-url` flags for DB mode | CLI parity |
| `fleet.docker.yaml` | No change | Env vars already passed; fleet reads from DB |

### 3f. Error Recovery During Re-Provisioning

Re-provisioning must be resilient to partial failures. If a config change adds 3 reviewers and removes 2, a crash mid-way should not leave a half-done state.

**Strategy: Two-phase apply with rollback logging**

```
1. Log intent:  write audit log entry "re-provisioning: +3, -2"
2. Decommission removals first (these are idempotent — agents already processed tasks don't need undo)
3. Create new reviewers/agents (these are the risky operations)
4. Mark audit log as "applied" on success
5. On crash recovery: FleetManager checks for incomplete re-provisioning and:
   a. If decommissioning was in progress → continue decommissioning remaining agents
   b. If agent creation was in progress → check which ones succeeded via `listAgentsUnderPrincipal` and create only missing ones
   c. Neither is ideal but both are safe — worst case: orphaned agents that do nothing, picked up next reconcile
```

**Key insight:** The fleet polls every 15-25s. If `PUT /v1/fleet/config` errors mid-way, the next poll will fetch the stored config and try to reconcile again. Polling IS the recovery mechanism. No separate rollback transaction needed — just retry on next poll cycle.

**Partial decommission safety (from issue #24):**
```typescript
// Decommission removes agents from the bottom of the replica list first
const toDecommission = existingAgents.slice(desiredReplicas);
// Delete from last to first to preserve agent ordering during crash
for (let i = toDecommission.length - 1; i >= 0; i--) {
  await client.deleteAgent(toDecommission[i].id);
}
```

If the fleet crashes mid-decommission (deleted 2 of 5 surplus agents), the next reconcile sees surplus agents still present and finishes the job.

## Risk & Mitigation

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Config diff logic misses field changes | Low | Unit test `isConfigEqual()` with known configs |
| Fleet agent token expires during re-provision | Medium | Fleet re-auths on each poll cycle — auto-recover |
| JSONB schema incompatible with future fleet.yaml features | Low | JSONB is schemaless — new fields merge without migration |
| Dashboard fleet view clobbers existing `#view-fleet` | Medium | Add `#view-fleet-config` as separate view; old fleet view still works for legacy |
| Fleet restart creates duplicate agents on config change | High | Issue #24 fix is prerequisite — must decommission surplus agents first |

## Effort Estimate

| Phase | Files | Estimated complexity | Dependencies |
|-------|-------|---------------------|-------------|
| Phase 1a (schema) | 1 | Low | — |
| Phase 1b (3 endpoints) | 2 new | Medium | Phase 1a |
| Phase 1c (export/import) | 0 (add to phase 1b routes) | Low | Phase 1a |
| Phase 2 (dashboard UI) | 2 modified | Medium-High | Phase 1b |
| Phase 3a (fleet reads from DB) | 2 modified | Medium | Phase 1b |
| Phase 3b (hot-reload) | 1 modified | Low | Phase 3a |
| Phase 3c (reconcile + decommission) | 1 modified | Medium | Issue #24, Phase 3a |

**Total:** ~6-8 files, medium complexity. Can be staged across 3 PRs.

## Not Included (Out of Scope)

- Multi-org fleet config management (one dashboard, multiple orgs)
- Fleet runtime auto-scaling (adjust replicas based on load)
- RBAC for fleet config editing (who can add/remove reviewers)
