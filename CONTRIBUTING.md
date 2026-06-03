# Contributing to Conclave

Welcome to the Conclave Sovereign Protocol. Because this project implements a trust and reputation system, we hold the codebase to the same standard as the protocol: **verified, disciplined, and surgical.**

## 🚫 The Golden Rule: No Direct Pushes to Main
**Never push directly to the `main` branch.** 
All changes must follow a feature-branch workflow to ensure the project remains deployable and stable.

### The Workflow
1. **Create a Feature Branch:** `git checkout -b feat/your-feature-name` or `git checkout -b fix/bug-description`.
2. **Surgical Commits:** Keep PRs small and focused. One issue = one PR.
3. **Local Verification:** Ensure `npm run build` (or `npx tsc --noEmit`) passes.
4. **Open a PR:** Link your PR to the corresponding GitHub issue.
5. **The Conclave Quality Gate:** Before a human merge, complex logic changes should be submitted to the Conclave agent network for peer review using the `mcp_conclave_submit_task` tool.

## 🛠️ Technical Standards

### 1. Identity & IDs
- **Semantic Prefixes:** All IDs must use their semantic prefix.
  - `org_` (Organization), `prn_` (Principal), `agt_` (Agent), `tsk_` (Task), `opn_` (Opinion), `rev_` (Review), `ch_` (Channel).
- **No UUIDs in Logic:** Use the prefixed strings throughout the API and DB.

### 2. Database Integrity
- **Org Isolation:** Every query that touches a resource must filter by `org_id`.
- **Drizzle ORM:** Use Drizzle for standard CRUD. For complex aggregations or DDL, use raw SQL via `dbClient.unsafe()`.
- **Migrations:** If you add a table or column, you must update `src/db/schema.ts` AND provide the raw SQL migration in `src/server/index.ts` (via `initDb()`).

### 3. API Design
- **Response Envelope:** All responses must follow the standard envelope:
  `{ status: 'success' | 'error', data: {...}, error?: { code, message }, meta: { request_id, timestamp } }`
- **Zod Validation:** Every route must have a corresponding Zod schema in `src/schemas/index.ts`.

## 🚦 Triage & Labels
When creating issues, use the following taxonomy:
- **Type:** `bug`, `feature`, `refactor`, `docs`
- **Priority:** `priority:high`, `priority:medium`, `priority:low`
- **Phase:** `phase:api`, `phase:fe`, `phase:fleet`

---
*Failure to follow the "No Main" rule or the "Surgical PR" standard will result in an immediate request to rebase and resubmit.*