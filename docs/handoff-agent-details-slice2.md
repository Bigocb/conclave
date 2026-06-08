# Handoff: Agent Details Tab (Slice 2) — conclave-fe#18

## Summary

Built a **Details** read-only tab in the Agent Detail Modal for the Conclave FE. The tab shows the agent's identity chain: token, principal, organization, vault API key, and activity summary.

This was the FE companion to conclave#133 (backend enrichment: `GET /v1/agents/:id` now returns `principal` + `org` fields, and a new `GET /v1/agents/:id/stats` stats endpoint exists).

## What's Done

- **`DetailsTab.tsx`** — 5-section read-only component at `src/components/factory/DetailsTab.tsx`
- **Wired into `AgentDetailModal`** as 3rd tab (Overview → Details → MCP Config)
- **Type changes** — `Agent` interface now has optional `principal?` and `org?` fields
- **Test infra** — vitest + testing-library + jsdom added to project
- **16 tests** covering rendering, loading spinners, null/undefined fallbacks, clipboard copy/feedback, vault key API states (success/empty/error), and stats display
- **conclave-fe PR #19** (feature) → merged `509b0ef`
- **conclave-fe PR #20** (fix: fetch enriched data on mount) → merged `bc75923`
- **conclave PR #134** (backend enrichment, was never merged) → merged `784a614`

## Key Pitfall (Documented)

The list endpoint `GET /v1/agents` does **not** return enriched `principal`/`org` fields — only `GET /v1/agents/:id` does. The original DetailsTab read from the prop (coming from list data) and showed "No data available". Fix: fetch `GET /v1/agents/:id` on mount with `api.get()` in a `useEffect`.

## PRs & Commits

| Repo | PR | Commit | Description |
|------|----|--------|-------------|
| conclave-fe | #19 | `509b0ef` | Feature: Details tab with 5 sections |
| conclave-fe | #20 | `bc75923` | Fix: fetch enriched agent data on mount |
| conclave | #134 | `784a614` | Backend: enrich GET /v1/agents/:id + stats endpoint |

## Suggested Skills

- **tdd** — All FE work was built with red-green-refactor TDD
- **github-pr-workflow** — For any further PR operations on conclave-fe

## Next Work (Open Issues on conclave-fe Backlog)

| # | Title | Notes |
|---|-------|-------|
| 7 | Agent models dropdown based on provider | UI-only, no backend dependency |
| 1 | Gesture Navigation (Pull-to-Refresh, Swipe-to-Close) | Mobile UX |
| 2 | Token storage migration (localStorage → httpOnly cookies) | Auth security |
| 3 | PWA Integration (Service Worker & Manifest) | |

Larger unstarted FE slices (from earlier audit): Budget UI, Reputation Leaderboard, Channel Subscriptions UI, Task Submission from FE, Live Pulse Updates for opinion graphs.