# T25 — Make the reviewer config database authoritative

**Mark:** AGENT (design pass complete)
**Depends on:** T09
**Decision:** the database wins; YAML becomes a one-time bootstrap import, never a
runtime source. This was a locked decision, not a default — do not reconsider it.

## Files you may modify

- `src/fleet/manager.ts`
- `src/routes/fleet.ts`
- `src/cli/index.ts`
- `src/fleet/config.ts`
- `src/__tests__/fleet-config-sync.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)
- `DEPLOYMENT.md`

## Context — what already exists and what's actually broken

Config currently has three sources with no settled precedence:

1. **YAML** (`fleet.yaml` / `.docker` / `.example` / `.test`) — read by `provision()` at
   startup to create principals/agents. This is what decides which reviewers *exist*.
2. **`clv_fleet_reviewers`** — the DB table. `syncReviewerConfig()` polls it every 5
   minutes and patches `model`, `llmUrl`, `llmKey`, `provider` onto **already-running**
   processes, matched by name.
3. **`cron.ts`'s hardcoded array** — removed by T04. Ignore it here.

Two real gaps, not just "unify them":

- **`syncReviewerConfig()` can only patch existing processes.** A reviewer added in the
  DB with no matching YAML entry is invisible — no process was ever started for it. A
  reviewer removed from the DB keeps running until the worker restarts.
- **`POST /v1/fleet/reload` is dead.** It flips `clv_fleet_config.scope` to
  `'reload_requested'` and nothing ever reads that value. It is not a working reload
  signal — it is a write nobody consumes, the same pattern as D8 in the opinion router.

## Steps

1. **Fix `POST /v1/fleet/reload` first — it's the mechanism everything else depends on.**
   Keep the DB write, but make `syncReviewerConfig()`'s poll loop actually check
   `scope`. Read `fleetConfig.scope` on each poll; when it is `'reload_requested'`, do a
   *full* re-provision (see step 2) instead of the current patch-only sync, then reset
   `scope` back to its prior value (`public` / `private` / `hybrid` — read it before
   overwriting, don't hardcode `'public'`).

   This turns the 5-minute poll into the mechanism, and the reload endpoint into a way
   to trigger it immediately rather than waiting up to 5 minutes.

2. **Make sync additive and subtractive, not patch-only.** Replace the body of
   `syncReviewerConfig()`:
   - Fetch `clv_fleet_reviewers` for the org (same endpoint it already calls).
   - For each DB row with no matching running process (match by name, as today):
     start one — call the same registration path `provision()` uses for a new
     reviewer (principal lookup/create, agent lookup/create, `startPolling`). Extract
     that path out of `provision()` into a private method
     `provisionOne(reviewer: ReviewerConfig)` so both call sites share it; don't
     duplicate the principal/agent creation logic.
   - For each running process with no matching DB row: stop it — clear its interval
     timer, remove it from `this.processes`, log that it was retired.
   - For each match: patch the mutable fields, exactly as today.

3. **YAML becomes an import, not a runtime source.** Add a CLI command:

   ```
   conclave fleet import --config fleet.yaml
   ```

   in `src/cli/index.ts`, reusing `parseFleetConfig` from `src/fleet/config.ts`. For
   each reviewer in the parsed YAML, upsert a row into `clv_fleet_reviewers` (insert if
   no row with that name exists for the org, otherwise leave the existing DB row alone
   — this is a one-time seed, not a sync, and a second import must not clobber
   dashboard edits). Print a summary: created N, skipped M (already present).

4. **`provision()` no longer reads YAML for anything but the initial import.** At
   startup, `FleetManager` should load its reviewer list from the DB via the same
   fetch `syncReviewerConfig()` uses, not from `this.config.reviewers`. Keep
   `fleet.yaml` parsing working for the `import` command and for
   `conclave fleet start --config fleet.yaml` in fully local/offline mode (no server) —
   don't remove that path, just stop it being the default for a server-backed
   deployment.

5. Create `src/__tests__/fleet-config-sync.test.ts`. Mock the API client and the
   process map; assert:
   - a DB reviewer with no running process gets provisioned
   - a running process with no DB row gets stopped and removed from `this.processes`
   - a reviewer present in both gets its mutable fields patched, not re-provisioned
     (no duplicate principal/agent creation call)
   - `scope: 'reload_requested'` triggers a full sync and resets `scope` to its prior
     value

6. Update `DEPLOYMENT.md`'s "Local Development" section: note that `fleet.yaml` is now
   a one-time import (`conclave fleet import`), not a file the running worker re-reads,
   and that `POST /v1/fleet/reload` now takes effect within one poll cycle instead of
   never.

## Verify

```bash
grep -c "provisionOne" src/fleet/manager.ts
```
Expected: `2` or more — the extracted method plus at least one caller.

```bash
grep -c "'reload_requested'" src/fleet/manager.ts
```
Expected: `1` or more — the poll loop now reads it, not just `routes/fleet.ts` writing it.

```bash
grep -c "fleet:import\|'import'" src/cli/index.ts
```
Expected: `1` or more.

```bash
npx vitest run src/__tests__/fleet-config-sync.test.ts
```
Expected: all four cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Against a non-production database with the worker running: add a reviewer row directly
to `clv_fleet_reviewers`, call `POST /v1/fleet/reload`, and confirm a new process starts
within one poll interval without a worker restart. Then delete the row and confirm the
process stops on the next poll.

## Stop conditions

- If extracting `provisionOne` changes behaviour for the initial-provision path (agent
  reuse logic, replica counting), stop and report — that logic is fragile and October's
  merged fixes suggest it's been broken before. Preserve it exactly; only change where
  it's called from.
- Do not delete `fleet.yaml` / `.docker` / `.example` / `.test`, or the
  `conclave fleet start --config` offline path. YAML stays valid for local/offline use;
  it just stops being read by a server-backed worker after the initial import.

## Commit

```
feat(fleet): make the database authoritative for reviewer config
```
