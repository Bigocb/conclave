# T30 — Table-driven tests for the v2 state machine

**Mark:** AGENT
**Depends on:** T29
**Estimated diff:** one new test file

## Files you may modify

- `src/__tests__/opinion-machine-v2.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)

## Context

Same purpose as T14 served for v1: `nextStateV2` is pure, so every branch is directly
testable with no database. v2 has no defect-locking cases to write, because it has no
known defects yet — it hasn't run. That's exactly why this suite needs to be
exhaustive now, before T31–T32 build anything that depends on it.

## Steps

1. Create `src/__tests__/opinion-machine-v2.test.ts`.

2. Cover every row from `docs/opinion-engine-v2.md`'s **Required behaviour** block.
   One `it` per row, name states the rule:

   **CLAIMED**
   | current | expected |
   |---|---|
   | `open` | `{ status: 'critiquing' }` |
   | `critiquing` | `null` |
   | `voting` | `null` |
   | `closed` | `null` |

   **ROUTE_FAILED / NO_SUBSCRIBERS**
   | current | event | expected |
   |---|---|---|
   | `critiquing` | `ROUTE_FAILED` | `{ status: 'open' }` |
   | `critiquing` | `NO_SUBSCRIBERS` | `{ status: 'open' }` |

   Assert these fire the same regardless of `current` — the spec doesn't guard them on
   origin state. Add a case passing `current: 'voting'` to both and confirm the result
   is unchanged, as a check against a future implementation accidentally adding a guard
   that isn't in the spec.

   **CRITIQUES_COLLECTED**
   | succeeded | requested | expected |
   |---|---|---|
   | 3 | 3 | `{ status: 'voting' }` |
   | 4 | 3 | `{ status: 'voting' }` |
   | 2 | 3 | `{ status: 'open' }` |
   | 0 | 3 | `{ status: 'open' }` |

   **VOTES_SETTLED**
   | ballots | expected |
   |---|---|
   | `[]` | `closed` / `consensus_not_reached` |
   | `[{approved:true}]` | `closed` / `consensus_reached` |
   | `[{approved:true},{approved:true},{approved:true}]` | `closed` / `consensus_reached` |
   | `[{approved:true},{approved:false}]` | `closed` / `consensus_not_reached` |
   | `[{approved:true},{approved:null}]` | `closed` / `consensus_not_reached` |
   | `[{approved:null}]` | `closed` / `consensus_not_reached` |

   The last three cases are the ones that matter most — write a comment above each
   explaining what it's really testing:
   - a single dissent closes as not-reached (this is D5's resolution: no loop, just a
     terminal outcome)
   - a `null` (failed-after-retries) ballot is treated as a non-approval, not ignored
   - all-null is indistinguishable from all-dissent, which is correct — the opinion
     could not honestly reach consensus either way

3. Add the file to `include` in `vitest.unit.config.ts`.

## Verify

```bash
npx vitest run src/__tests__/opinion-machine-v2.test.ts
```
Expected: every case passes. If one fails, `machine-v2.ts` diverged from the design
doc — fix the implementation, not the test.

```bash
grep -c "it(" src/__tests__/opinion-machine-v2.test.ts
```
Expected: `17` or more (4 CLAIMED + 2×2 ROUTE_FAILED/NO_SUBSCRIBERS with the extra
current-state check + 4 CRITIQUES_COLLECTED + 6 VOTES_SETTLED, plus the module-level
sanity checks).

```bash
npm run test:unit
```
Expected: no regression.

## Stop conditions

- Do not add cases for events or states not in `docs/opinion-engine-v2.md`. This suite
  documents the spec as built, not as you might extend it.

## Commit

```
test(opinions): add table-driven coverage of the v2 state machine
```
