# PRD: Public REST API for Client Integrations

## Problem Statement

Conclave currently only exposes programmatic access via MCP tools. Clients that want to integrate — CI/CD pipelines, external dashboards, third-party agents, mobile apps — need a well-documented REST API they can call directly with an API key. No MCP required.

The existing Fastify routes already serve the MCP client, but they're undocumented, lack API key auth, and have no discoverable spec. External integrators have to reverse-engineer the MCP tool definitions to figure out what endpoints exist.

## Solution

Expose the existing Fastify routes as a documented, authenticated REST API. The REST API is not a lite version — it exposes the same tools as the MCP and enforces the same protocols: budget costs, channel subscription gates, self-review blocks, dimension validation, org isolation, and the consistent response envelope. The only difference is transport (HTTP vs MCP).

Add an API key management system (`clv_api_keys` table) for org-scoped keys with permission levels (read, write, admin). Publish an OpenAPI 3.1 spec alongside the API.

## User Stories

1. As a CI/CD pipeline operator, I want to submit a task for review via `curl`, so that I can integrate Conclave into my deployment pipeline without installing an MCP client.

2. As a third-party agent developer, I want to call Conclave's opinion and review endpoints from any HTTP client, so that I can build agents in any language without MCP SDK support.

3. As an org admin, I want to create and revoke API keys with specific permission levels (read, write, admin), so that I can control access for different integrations.

4. As an API consumer, I want to authenticate with `Authorization: Bearer <clv_key>`, so that I can use the same auth pattern as every other REST API.

5. As an API consumer, I want a consistent JSON response envelope (`{ data, error, meta }`) on every endpoint, so that I can write generic error handling.

6. As an API consumer, I want to see rate limit headers (`x-ratelimit-remaining`) in every response, so that I can back off gracefully.

7. As an API consumer, I want an OpenAPI 3.1 spec I can load into Postman or generate a client from, so that I don't have to hand-craft every request.

8. As an API consumer, I want the REST API to enforce the same budget costs and protocol rules as the MCP, so that I can't bypass Conclave's economic model by switching transports.

9. As an org admin, I want API keys to be org-scoped, so that keys from one org can't access another org's data.

10. As an API consumer, I want to list available endpoints and their schemas via a spec endpoint, so that I can discover the API programmatically.

## Implementation Decisions

### Auth Model

Two auth mechanisms, both using the existing `Authorization: Bearer` header:

1. **Agent tokens** (`clv_` prefixed): Already exist in the `clv_agents` table. Authenticated by the existing `authenticate()` middleware. Scoped to a single agent/principal. Best for agent-to-agent integration.

2. **API keys** (`clv_api_` prefixed): New `clv_api_keys` table for org-level keys. Permission levels: `read` (list, get), `write` (create, submit), `admin` (manage keys, manage org). Authenticated by extending the existing `authenticate()` middleware.

No separate auth middleware — reuse and extend the existing `authenticate()` handler in `src/middleware/auth.ts`.

### API Key CRUD

New endpoints:

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/v1/api-keys` | admin | Create a new API key with name, permission level |
| `GET` | `/v1/api-keys` | admin | List all API keys for the org (key values masked) |
| `GET` | `/v1/api-keys/:id` | admin | Get a single API key |
| `DELETE` | `/v1/api-keys/:id` | admin | Revoke an API key |

New table `clv_api_keys`:

| Column | Type | Description |
|---|---|---|
| id | TEXT PK | `clv_api_<uuid>` |
| org_id | TEXT FK → orgs | Owning org |
| name | TEXT | Human-readable label (e.g., "CI/CD Pipeline") |
| key_hash | TEXT | Hashed key value (store hash, not plaintext) |
| key_prefix | TEXT | First 8 chars of key for identification |
| permission | TEXT | `read`, `write`, or `admin` |
| created_at | TEXT (ISO8601) | |
| revoked_at | TEXT (ISO8601) | Null if active |

The plaintext key is returned once at creation time (like GitHub's token creation flow).

### Existing Endpoints (Already Working)

All existing route groups are already registered under `/v1/` and work with `Authorization: Bearer`:

| Group | Key Endpoints | Already Enforces |
|---|---|---|
| Tasks | `POST/GET /v1/tasks`, `POST /v1/tasks/:id/reviews`, `POST /v1/tasks/:id/dismiss` | Budget costs, channel subscription, self-review block, dimension validation, org isolation |
| Opinions | `POST/GET /v1/opinions`, `POST /v1/opinions/:id/nodes`, `GET /v1/opinions/:id/graph` | Budget costs, channel subscription, org isolation |
| Agents | `POST/GET /v1/agents`, `PATCH /v1/agents/:id` | Org isolation |
| Principals | `POST/GET /v1/principals` | Org isolation |
| Channels | `GET /v1/channels`, `POST /v1/channels/:id/subscribe`, `DELETE /v1/channels/:id/subscribe` | Org isolation |
| Budget | `GET /v1/budget` | Org isolation |
| Health | `GET /v1/health` | Public (no auth) |
| Auth | `POST /v1/auth/register`, `POST /v1/auth/login` | Public (no auth) |

### OpenAPI 3.1 Spec

- Auto-generated from Fastify route schemas using `@fastify/swagger`
- Published at `GET /v1/openapi.json`
- Covers all endpoints with request/response schemas
- Includes auth section showing `Authorization: Bearer` usage
- Includes example curl commands

### Response Envelope

Already implemented — every endpoint returns:

```json
{
  "status": "success" | "error",
  "data": { ... },
  "error": { "code": "...", "message": "..." },
  "meta": { "request_id": "...", "timestamp": "...", "rate_limit_remaining": 1199 }
}
```

### Rate Limiting

Already implemented — 1200 requests per minute per key, with `x-ratelimit-remaining` header and `rate_limit_remaining` in the meta envelope.

### CORS

Already implemented — allows all origins, methods, and standard headers.

### Modules

| Module | Location | Responsibility |
|---|---|---|
| API key service | `src/services/api-keys.ts` (new) | Key generation, hashing, CRUD, permission checking |
| API key routes | `src/routes/api-keys.ts` (new) | `POST/GET/DELETE /v1/api-keys` |
| Auth middleware | `src/middleware/auth.ts` (modify) | Add `clv_api_` token lookup with permission check |
| DB migration | `src/db/migrations/` (new) | `clv_api_keys` table |
| Server index | `src/server/index.ts` (modify) | Register API key routes, add `@fastify/swagger` |
| OpenAPI spec | Auto-generated via `@fastify/swagger` | Published at `GET /v1/openapi.json` |

## Testing Decisions

Good tests verify the REST API through its HTTP interface — not the MCP client.

**What to test:**
- **API key CRUD**: Create key → returns plaintext once. List keys → values masked. Delete key → subsequent requests fail.
- **Auth**: Agent token works. API key works. Invalid token returns 401. Revoked key returns 401.
- **Permission enforcement**: Read key can't create tasks. Write key can't manage keys. Admin key can do everything.
- **Protocol parity**: Submit task via REST costs same budget as MCP. Self-review blocked. Channel subscription enforced. Dimension validation enforced.
- **OpenAPI spec**: `GET /v1/openapi.json` returns valid OpenAPI 3.1 document.

**How to test:** Integration tests with a test Fastify instance (mirrors existing patterns). HTTP-level tests using `light-my-request` (Fastify's built-in test injector).

**What NOT to test:** Every individual route's business logic (already covered by existing route tests). The MCP client's ability to call the API (different transport, same routes).

## Out of Scope

- Swagger UI / try-it-out playground (can be added later via `@fastify/swagger-ui`)
- Cursor-based pagination on list endpoints (tracked in conclave#1)
- WebSocket/SSE streaming via REST (use the existing Pulse SSE endpoint)
- Python/TypeScript SDKs (tracked in conclave#10, conclave#11)
- OAuth2 / social login (JWT + API keys suffice for MVP)
- Audit logging for API key usage (can be added later)

## Further Notes

- The REST API is not a separate deployment — it's the same Fastify server that serves the MCP client. Adding `@fastify/swagger` and the API key routes is additive, not a new service.
- The `clv_api_` prefix distinguishes API keys from agent tokens (`clv_`). The auth middleware checks `clv_api_` tokens against the `clv_api_keys` table and `clv_` tokens against the `clv_agents` table.
- Permission levels are coarse for MVP: `read` = GET only, `write` = POST/PUT/PATCH/DELETE on non-admin resources, `admin` = everything including key management.
- The OpenAPI spec is auto-generated from Zod schemas via `@fastify/swagger`, which means it stays in sync with the code. No hand-written spec to maintain.
