# T29 — The v2 pure state machine

**Mark:** AGENT (design pass complete)
**Depends on:** nothing (independent of T28 — this is pure logic, no database)
**Estimated diff:** one new file

## Read first

`docs/opinion-engine-v2.md`, section **States and events**. This task implements
`nextStateV2` exactly as specified there. Do not derive the transitions yourself —
they're already derived, and they're deliberately simpler than v1's: four states, five
events, no loops.

## Files you may modify

- `src/opinions/machine-v2.ts` (create)

## Context

This does not replace `src/opinions/machine.ts` (T13's v1 state machine, which T22–T24
fix bugs in). v1 keeps running unmodified until T33 wires v2 in behind a flag and T34
retires v1's synthesis-handling code. Building this in a separate file means the two
never conflict and v1 stays untouched until the cutover is deliberate.

## Steps

1. Create `src/opinions/machine-v2.ts` containing exactly the types and function given
   in the design doc's **States and events** section:

   ```ts
   export type OpinionStatusV2 = 'open' | 'critiquing' | 'voting' | 'closed';

   export type OpinionEventV2 =
     | { type: 'CLAIMED' }
     | { type: 'ROUTE_FAILED' }
     | { type: 'NO_SUBSCRIBERS' }
     | { type: 'CRITIQUES_COLLECTED'; succeeded: number; requested: number }
     | { type: 'VOTES_SETTLED'; ballots: Array<{ approved: boolean | null }> };

   export interface TransitionV2 {
     status: OpinionStatusV2;
     closeTag?: 'consensus_reached' | 'consensus_not_reached';
   }

   export function nextStateV2(
     current: OpinionStatusV2,
     event: OpinionEventV2,
   ): TransitionV2 | null;
   ```

2. Implement the **Required behaviour** block from the design doc precisely:

   ```
   CLAIMED
     current !== 'open'                     → null
     otherwise                              → { status: 'critiquing' }

   ROUTE_FAILED                             → { status: 'open' }
   NO_SUBSCRIBERS                           → { status: 'open' }

   CRITIQUES_COLLECTED
     succeeded >= requested                 → { status: 'voting' }
     otherwise                              → { status: 'open' }

   VOTES_SETTLED
     ballots.length === 0                   → { status: 'closed', closeTag: 'consensus_not_reached' }
     ballots.some(b => b.approved !== true) → { status: 'closed', closeTag: 'consensus_not_reached' }
     otherwise                              → { status: 'closed', closeTag: 'consensus_reached' }
   ```

   Evaluate `VOTES_SETTLED`'s conditions in the order written — the empty-ballots case
   must be checked before the `.some()` check, since `[].some(...)` is `false` and
   would otherwise fall through to `consensus_reached` on zero votes.

   The function must be pure: no database access, no `Date.now()`, no logging. It does
   not need to know anything about `current` for `ROUTE_FAILED`, `NO_SUBSCRIBERS`, or
   `VOTES_SETTLED` — only `CLAIMED` checks the current state. Match this asymmetry; it
   isn't an oversight in the spec, `CLAIMED` is the only event with a guard on origin
   state because it's the only one reachable from more than one caller context.

3. Add a short module-level comment (2–3 lines) noting that this machine has no loop —
   `voting` only ever transitions to `closed` — and that this is deliberate, per D5 in
   `docs/opinion-state-machine.md`. A future reader should not "fix" the missing
   loop-back without reading why it's missing.

## Verify

```bash
grep -c "export function nextStateV2" src/opinions/machine-v2.ts
```
Expected output: `1`

```bash
npx tsc --noEmit
```
Expected: no new errors. The file has no callers yet, so nothing should reference it.

```bash
grep -c "import.*machine.js\|from '\.\./opinions/machine\.js'" src/opinions/machine-v2.ts
```
Expected output: `0` — this file must not import anything from v1's `machine.ts`. The
two are independent by design.

## Stop conditions

- If you find yourself wanting to add an event or a transition not in the design doc's
  table, stop and report rather than adding it. The whole point of v2 is fewer states
  and no implicit loops; extending the table here undermines that.
- Do not touch `src/opinions/machine.ts` or anything under `src/fleet/opinion-router.ts`
  in this task.

## Commit

```
feat(opinions): add the v2 pure state machine
```
