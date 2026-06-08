# Test Coverage Compression Plan

**Goal:** Systematic test coverage across the entire Conclave stack — backend services, fleet/worker, frontend components, and E2E protocol conformance.

**Current baseline:** 98 backend tests (feature-specific, zero core service coverage) + 17 frontend tests (1 component only). All pass.

---

## PRD A: Backend Core Service & Route Tests

**Why:** The most critical gap. Budget, tasks, reputation, auth, and vault are the backbone — zero tests on any of them. Every feature PR since MVP has added tests for itself but nobody's gone back to cover the foundation.

**Scope:**

| Area | What to test | Priority |
|---|---|---|
| **BudgetService** | earn/spend/getByPrincipal, daily passive earn, consensus bonus, high-score bonus, spot-check award, insufficient budget (402), ensureBudget() auto-creation | Critical |
| **TaskService** | create/getById/list (pagination, filters, status), review submission (dimension validation, self-review block), duplicate detection, archive | Critical |
| **ReputationService** | time-decay calculation, alignment bonus, performance bonus, per-dimension breakdown, leaderboard ordering | High |
| **AuthService** | JWT create/verify/rotate, clv_ token decode, token expiry, invalid token rejection | High |
| **VaultService** | encrypt/decrypt/upsert/get, key rotation, missing key handling | Medium |
| **Route integration** | Full lifecycle via `app.inject()`: task create → review submit → budget deduction → reputation update, opinion create → response → consensus | Critical |

**Slice breakdown:**
1. BudgetService unit tests
2. TaskService unit tests
3. ReputationService unit tests
4. AuthService + VaultService unit tests
5. Route integration tests (task lifecycle, opinion flow)

---

## PRD B: Fleet & Worker Tests

**Why:** The fleet manager and reviewer backends are the most complex, most-deployed code in the system. They route real agent work, call LLM providers, and manage state machines. Zero coverage. A regression here breaks production.

**Scope:**

| Area | What to test | Priority |
|---|---|---|
| **Fleet manager** | Task routing (round-robin, channel subscription lookup), opinion routing, reviewer assignment, agent eligibility filtering, failed-agent tracking | Critical |
| **Reviewer backends** | `buildLlmSystemPrompt` (skills injection, conventions), `runLlmReview` (provider call, timeout, retry), `parseLlmReviewResponse` (JSON parsing, fallback, malformed response) | Critical |
| **Provider resolution** | Provider config lookup, API key resolution, endpoint construction, fallback chain | High |
| **Opinion router** | Gap detection, debating state transitions, convergence checking, unresponsive-critic handling | High |
| **Pulse SSE daemon** | Event broadcasting, org-scoped delivery, connection lifecycle | Medium |

**Slice breakdown:**
1. Reviewer backend tests (prompt building, response parsing, error handling)
2. Fleet manager routing tests (task/opinion assignment)
3. Provider resolution tests
4. Opinion router tests (gap detection, debate rounds)
5. Pulse daemon tests

---

## PRD C: Frontend Component Tests

**Why:** 21 untested components. The frontend is the user-facing surface — auth flows, task/opinion feeds, fleet management, memory browser. A broken render or missing error state is what users see.

**Scope:**

| Area | Components | What to test | Priority |
|---|---|---|---|
| **Feed views** | TaskFeed, OpinionFeed, FeedView, BlackboardView, OpinionThread | Render states (loading, empty, error, populated), pagination, thread expansion, opinion graph display | Critical |
| **Auth** | LoginView | Login flow, token storage, error states, redirect | Critical |
| **Fleet** | FleetView | Agent list, status display, config editing | High |
| **Factory** | AgentFactory, AgentDetailModal, DetailsTab, McpConfigTab | Agent creation/edit, detail display, MCP config generation, vault key display | High |
| **Memory** | MemoryView | Memory list, search, detail view | Medium |
| **Principals** | PrincipalsView | Principal list, detail, subscription management | Medium |
| **Pulse** | PulseView | SSE event display, connection status | Medium |
| **Vault** | VaultView | Key management UI | Medium |
| **Hooks** | useAuth, usePulse | Auth state management, SSE connection lifecycle | High |
| **UI primitives** | core.tsx (Button, Card, Modal, Input) | Render, interaction, accessibility | Medium |

**Slice breakdown:**
1. Feed views (TaskFeed, OpinionFeed, FeedView, BlackboardView, OpinionThread)
2. Auth + Fleet views
3. Factory components (AgentFactory, DetailsTab, McpConfigTab)
4. Memory + Principals + Pulse + Vault views
5. Hooks + UI primitives

---

## PRD D: E2E Protocol Conformance Tests

**Why:** Unit tests verify components in isolation. E2E tests verify the running system behaves correctly as a whole — budget enforcement across the lifecycle, multi-agent interactions, cross-org isolation. These catch integration bugs that unit tests miss.

**Scope:**

| Area | What to test | Priority |
|---|---|---|
| **Task lifecycle** | Full flow: create → review → complete, state machine transitions (open → in_review → completed), response envelope format | Critical |
| **Multi-agent flows** | Self-review block (403), budget deduction on submit (5), budget credit on review (3), insufficient budget (402), spot-check creation + resolution | Critical |
| **Opinion lifecycle** | Create → critique → synthesis → consensus, confidence gap detection, debate rounds, voting | High |
| **Cross-org isolation** | Agent from org A cannot access org B's tasks/reviews/budget, org-scoped channel subscriptions | High |
| **Auth enforcement** | Invalid token (401), expired token, missing token, wrong org token, permission levels (admin/write/read) | High |
| **Protocol parity** | REST API behavior matches MCP tool behavior for every operation | Medium |

**Slice breakdown:**
1. Task lifecycle + state machine E2E
2. Multi-agent budget + auth enforcement E2E
3. Opinion lifecycle E2E
4. Cross-org isolation + permission E2E
5. Protocol parity conformance suite

---

## Execution Order

```
Phase 1: PRD A (core services) — highest risk, no dependencies
Phase 2: PRD C (frontend) — can run in parallel with Phase 1
Phase 3: PRD B (fleet/worker) — depends on A's test infrastructure patterns
Phase 4: PRD D (E2E) — depends on all above, validates integration
```

Each PRD gets sliced into 4-5 vertical slices, each `ready-for-agent`. Slices within a PRD are sequential (each builds on the last). PRDs A and C can run in parallel.

---

## What this doesn't cover (explicitly out of scope)

- Performance/load tests
- Security penetration tests
- Visual regression tests (screenshot diffing)
- Mobile device testing matrix
- Documentation tests (link checking, example validation)
