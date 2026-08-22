# T16 — Make the attention budget observational

**Mark:** AGENT
**Depends on:** T02 (needs CI to verify)
**Estimated diff:** ~30 lines

## Files you may modify

- `src/services/budget.ts`
- `src/__tests__/budget-enforce.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)
- `.env.example`
- `AGENTS.md` (transitional state table only)

## Context

The attention budget currently blocks work in two places — `POST /v1/tasks`
(`routes/tasks.ts:84`) and `POST /v1/opinions` (`routes/opinions.ts:69`), both
returning 402 `INSUFFICIENT_BUDGET`.

At a single organisation this prevents nothing and costs real work. A principal that
only submits — a CI gate, for instance — starts at 15, spends 5 per task, and earns 5
per day passively. That is **three tasks, then blocked**, recovering one task per day,
because it never reviews and so never earns.

The ledger is worth keeping: it is a genuine record of contribution, and if a
multi-organisation network ever exists the economy will already be populated with real
history. Only the *enforcement* is harmful today.

**This task keeps every `spend()` and `earn()` call recording exactly what it records
now. It removes only the ability to refuse.**

## Steps

1. In `src/services/budget.ts`, add near the `BUDGET` constant:

   ```ts
   /**
    * When false (the default), spend() records the debit and always succeeds.
    * The ledger stays accurate; nothing is refused. Set BUDGET_ENFORCE=true to
    * make insufficient balance block submission — intended for multi-org
    * deployments where attention scarcity is the anti-spam mechanism.
    */
   export const BUDGET_ENFORCED = process.env.BUDGET_ENFORCE === 'true';
   ```

2. In `spend()`, change the single enforcement line:

   ```ts
   if (budget.available < amount) return false;
   ```

   to:

   ```ts
   if (BUDGET_ENFORCED && budget.available < amount) return false;
   ```

   Change nothing else in the method. The debit must still be written and
   `recordHistory` must still be called, exactly as now, so a principal can go
   negative on paper and the history stays truthful.

3. Do **not** modify `routes/tasks.ts` or `routes/opinions.ts`. Their 402 branches stay
   as they are — they fire when `spend()` returns false, which now only happens under
   enforcement. Keeping the routes untouched means enabling the flag restores the old
   behaviour exactly.

4. Create `src/__tests__/budget-enforce.test.ts`. `BUDGET_ENFORCED` is read at module
   load, so use `vi.resetModules()` plus `vi.stubEnv` (or dynamic `import()` after
   setting `process.env.BUDGET_ENFORCE`) to test both states. Assert:
   - enforcement off, balance below the amount → `spend()` resolves `true`
   - enforcement off → a `clv_budget_history` row is still written with the negative amount
   - enforcement on, balance below the amount → `spend()` resolves `false`
   - enforcement on, sufficient balance → `spend()` resolves `true`

   Mock the database. This is a unit test; it must not need a live connection.

5. Add to `.env.example`:

   ```
   # Set to 'true' to make insufficient attention budget block submission (402).
   # Default is observational: the ledger records, nothing is refused.
   BUDGET_ENFORCE=false
   ```

6. Add a row to the transitional-state table in `AGENTS.md`:

   | Current state | Why it exists | Converge when |
   |---|---|---|
   | Attention budget is observational, not enforced | Scarcity prevents nothing at one org and blocks the org's own submitters | A second organisation shares a channel |

## Verify

```bash
grep -c "BUDGET_ENFORCED" src/services/budget.ts
```
Expected: `2` or more — the export and the guard.

```bash
grep -c "INSUFFICIENT_BUDGET" src/routes/tasks.ts src/routes/opinions.ts
```
Expected: `1` in each — the 402 branches are untouched.

```bash
npx vitest run src/__tests__/budget-enforce.test.ts
```
Expected: all four cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If any existing test asserts that `spend()` returns false on insufficient balance,
  that test now needs `BUDGET_ENFORCE=true` set. Set it in that test rather than
  weakening the assertion, and say so in your report.
- Do not remove any budget table, column, or `earn()` call. Do not change the `BUDGET`
  constants. The ledger's accuracy is the entire point of keeping it.

## Commit

```
feat(budget): make attention budget observational unless BUDGET_ENFORCE is set
```
