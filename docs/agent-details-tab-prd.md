# PRD: Agent Details Tab — Identity, Credentials & Activity

## Problem Statement

The Agent Detail Modal currently provides two tabs: **Overview** (an edit form for agent configuration) and **MCP Config** (connection snippets). There is no single place to see who an agent belongs to — its principal, the organization that principal operates under, the agent's authentication token, the API key stored in the vault, or summary statistics about the agent's activity.

Users must cross-reference between the Principals view, the Organisations view, the Agents list, and the Vault view to piece together an agent's full identity and credentials. This friction makes it hard to audit, debug, and manage agents at a glance.

## Solution

Add a **Details** tab to the Agent Detail Modal that displays the agent's complete identity chain and credentials in a read-only, copy-friendly layout:

```
Agent → Principal → Organization
```

Plus the agent's authentication token, vault API key (resolved on demand), and activity summary statistics. The tab is read-only by default — edits happen in the Overview tab.

## User Stories

1. As a fleet operator, I want to see which **principal** an agent belongs to, so that I can verify the agent's ownership and permissions.
2. As a fleet operator, I want to see which **organization** the principal belongs to, so that I can verify org-level context without opening the org admin view.
3. As a fleet operator, I want to **copy the agent's `clv_` auth token** to my clipboard, so that I can configure MCP clients and external integrations.
4. As a fleet operator, I want to **resolve and copy the agent's vault API key** from the detail view, so that I don't need to navigate to a separate key management page.
5. As a fleet operator, I want to see the agent's **activity summary** (review count, opinion count, status, created date), so that I can assess whether the agent is productive at a glance.
6. As a fleet operator, I want to see the **roles** of the principal (displayed as tags), so that I can assess what permissions the agent inherits.
7. As a fleet operator, I want vault key resolution to show a **loading state** while the key is being fetched, so that I know the UI hasn't stalled.
8. As a fleet operator, I want the token and key copy buttons to **confirm the copy action visually**, so that I know the value was captured.
9. As an API consumer, I want `GET /v1/agents/:id` to return **enriched principal and org fields**, so that I can display agent identity without making multiple API calls.
10. As a developer, I want the Details tab to require **no additional DB queries** beyond what the existing endpoint already provides (or can be trivially enriched), so that performance doesn't regress.

## Implementation Decisions

### Modules

Two modules are modified — one per repository:

| Module | Repo | File(s) | Role |
|--------|------|---------|------|
| **Agent route** (backend) | `conclave` | `src/routes/agents.ts` | Enrich `GET /v1/agents/:id` response with org name/slug |
| **AgentDetailModal** (frontend) | `conclave-fe` | `src/components/factory/AgentDetailModal.tsx` | Add third "Details" tab |
| **Agent types** (frontend) | `conclave-fe` | `src/types/api.ts` | Add `principal` and `org` fields to `Agent` type |

### Backend: `GET /v1/agents/:id` enrichment

The endpoint already:

- Looks up the agent by ID
- Validates org isolation (agent must belong to caller's org)
- Fetches principal via `PrincipalService.getById()` and appends `principal: { id, name, roles }`

**New behavior:** After the principal lookup, also fetch the organization from the `clv_organizations` table using `agent.org_id` and append:

```json
{
  "org": {
    "id": "org_xxx",
    "name": "My Org",
    "slug": "my-org"
  }
}
```

No new service module is needed — the org table is trivially queried via Drizzle from the existing route handler using `fastify.db`.

### Frontend: AgentDetailModal tabs

Current tab structure:

```
[Overview | MCP Config]
```

New structure:

```
[Overview | Details | MCP Config]
```

The **Details** tab is the second tab. Rationale: Overview (edit form) is the primary action, Details (read-only reference) is secondary, MCP Config (integration setup) is tertiary. This keeps the edit path as the default landing.

### Details tab layout

Each section is a distinct visual block with a header:

**🔑 Authentication Token**
- Display the agent's `clv_` auth token
- Token is likely null in the cached Agent type (only returned on registration). If `agent.token` is present, show it with a copy button and visual confirmation ("Copied!" toast). If absent, show "Token not available in cache — regenerate" with a link/button to POST `/v1/agents/:id/regenerate-token`.
- Copy button: click copies to clipboard, button briefly shows "Copied!" state

**👤 Principal**
- Principal name
- Principal ID (short display + full copy button)
- Roles as tags (from `agent.principal.roles`)
- Principal ID shown as truncated `prn_...xxxx` with a copy button for the full ID

**🏢 Organization**
- Org name (from `agent.org.name`)
- Org slug (from `agent.org.slug`)
- Org ID (short display + copy button)

**🔐 Vault API Key**
- Resolved on tab mount via `POST /v1/agents/:id/resolve-key` with `{ fallback_to_provider: true }`
- Loading spinner while resolving
- On success: show provider name and masked key with "Show / Copy" button
- On failure or empty result: show "No API key in vault for this agent"
- The resolve-key endpoint is already secured by org isolation middleware

**📊 Activity Summary**
- Review count (queried from `clv_reviews` where `reviewer_id = agent.id`)
- Opinion count (queried from `clv_opinion_nodes` where `agent_id = agent.id`)
- Status (active / decommissioned — from agent.status)
- Created at (from agent.created_at)
- Note: counts require a new lightweight API call. Add `GET /v1/agents/:id/stats` backend endpoint returning `{ review_count, opinion_count }`.

### API contract: new `GET /v1/agents/:id/stats`

Add a new backend route:

```
GET /v1/agents/:id/stats
Authorization: Bearer <token>
```

Response:

```json
{
  "status": "success",
  "data": {
    "review_count": 42,
    "opinion_count": 7
  },
  "meta": { "request_id": "...", "timestamp": "..." }
}
```

Implementation: simple COUNT queries on `clv_reviews` (WHERE reviewer_id = agent.id) and `clv_opinion_nodes` (WHERE agent_id = agent.id). Both are indexed columns. No pagination needed.

### Frontend type changes

```typescript
// src/types/api.ts — Agent interface additions
export interface Agent {
  // ... existing fields
  principal?: {
    id: string;
    name: string;
    roles: string[];
  };
  org?: {
    id: string;
    name: string;
    slug: string;
  };
}
```

### Deep module extraction

No deep modules are extracted. The changes are:

1. **Backend**: Two small additions to existing route handlers — one field enrichment (org lookup on `GET /v1/agents/:id`), one new lightweight route (`GET /v1/agents/:id/stats`). Each is < 20 lines of new code against existing patterns.

2. **Frontend**: One new tab in an existing tabbed modal. The tab renders a read-only layout with minimal local state (loading for vault key, copy state for clipboard). No new hooks, stores, or complex state management.

Neither change warrants extracting a new service or module.

## Testing Decisions

### What makes a good test

Good tests verify the reactive contract — what the user sees when the data is in a given state — not the internals of how the tab component renders.

### Which modules will be tested

**Backend (conclave) — integration tests:**
- `GET /v1/agents/:id` returns enriched `org` field with name and slug
- `GET /v1/agents/:id` org isolation still enforced (cross-org agent returns 403)
- `GET /v1/agents/:id/stats` returns review_count and opinion_count
- `GET /v1/agents/:id/stats` for an agent with no reviews returns 0 count

**Frontend (conclave-fe) — component tests:**
- Details tab renders with all sections when agent has principal + org data
- Token section: copy button works when token is present
- Token section: regenerate prompt shown when token is null
- Vault key section: shows loading state, then resolved key, then "no key" on empty
- Activity summary: renders counts from stats endpoint

### Prior art

- Backend integration tests follow the existing `app.inject()` pattern used elsewhere in the codebase
- Frontend tests would be new (no prior art in conclave-fe currently — the repo has no test setup). If tests are out of scope for this PRD, manual verification via the running Vercel deployment is acceptable for MVP.

## Out of Scope

- **Pagination or filtering on stats** — counts only, no list of reviews/opinions
- **Clickable principal/org links** — plain text display only. Navigation to principal or org management views is tracked separately (conclave-fe has no principal detail view yet)
- **Activity history list** — just counts, not a chronological feed
- **Token health check** — no verification that the token is still valid against the API
- **Vault key reveal-on-demand with auto-expiry** — key is fetched and displayed in the browser DOM. A future enhancement could add timed auto-hide
- **Frontend tests** — no test infrastructure exists in conclave-fe. Adding test setup is tracked in a separate issue

## Further Notes

- The vault key is fetched and displayed in the browser DOM. This is acceptable because the vault key is already accessible via the `POST /v1/agents/:id/resolve-key` endpoint, which requires authentication and org isolation. The browser already has the ability to make this API call from the developer console. Adding a timed auto-hide for the key display is a future enhancement.
- The backend changes are additive — no existing behavior is modified. The org enrichment adds a new field, the stats endpoint is a new route. No migration, no schema change.
- The tab structure uses the existing `TabId` union pattern and `tabs` array in `AgentDetailModal.tsx`. Adding a third tab is a mechanical change.