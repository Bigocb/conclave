# T17 — Require admin permission to grant budget

**Mark:** AGENT
**Depends on:** nothing
**Estimated diff:** ~5 lines

## Files you may modify

- `src/routes/budget.ts`
- `src/__tests__/budget-grant-permission.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)

## Context

`POST /v1/principals/:id/budget/grant` mints budget. It checks that the target
principal belongs to the caller's organisation, and nothing else — no permission level.
Any token scoped to the organisation can create unlimited budget, which makes the
scarcity model advisory even when `BUDGET_ENFORCE` is on.

`requirePermission` already exists in `src/middleware/auth.ts` with the hierarchy
`read < write < admin`.

## Steps

1. Import the helper in `src/routes/budget.ts`:

   ```ts
   import { requirePermission } from '../middleware/auth.js';
   ```

2. Attach it as a `preHandler` on the grant route only:

   ```ts
   fastify.post('/principals/:id/budget/grant',
     { preHandler: requirePermission('admin') },
     async (requestS, reply) => { ... });
   ```

   Leave the `GET` budget routes open as they are.

3. Create `src/__tests__/budget-grant-permission.test.ts` asserting that
   `requirePermission('admin')`:
   - rejects a request whose `permission` is `read` with 403
   - rejects `write` with 403
   - allows `admin`
   - allows a request with no `permission` set (agent tokens default to admin)

   Follow the pattern in the existing `src/__tests__/require-permission.test.ts` — read
   it first and match its style rather than inventing a new harness.

4. Add the test to `include` in `vitest.unit.config.ts`.

## Known limitation — record it, do not fix it here

`requirePermission` treats a missing `permission` as `admin`:

```ts
const permission = req.permission || 'admin'; // agent tokens = admin by default
```

Agent tokens (`clv_`) never set `permission`, so they still pass. This task therefore
restricts `clv_api_` keys scoped to `read` or `write`, and nothing else.

Making agent tokens carry a real permission level is a broader authentication change
affecting every route, and it needs a decision about what an agent token should be able
to do by default. Add a one-line note to that effect at the top of the new test file so
the next reader knows the gap is known rather than missed. Do not change the default in
this task.

## Verify

```bash
grep -c "requirePermission('admin')" src/routes/budget.ts
```
Expected output: `1`

```bash
grep -c "preHandler" src/routes/budget.ts
```
Expected output: `1` — only the grant route is gated.

```bash
npx vitest run src/__tests__/budget-grant-permission.test.ts
```
Expected: all four cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If gating the route breaks an existing test that grants budget with a non-admin token,
  the test is asserting the bug. Report it; do not weaken the gate.
- Do not add `requirePermission` to any other route in this task. Auditing the full
  route surface for permission gaps is separate work.

## Commit

```
fix(budget): require admin permission to grant budget
```
