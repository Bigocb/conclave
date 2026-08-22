# T08 — Rewire `fleet/manager.ts` onto `executeReview`

**Mark:** AGENT
**Depends on:** T07
**Estimated diff:** ~120 lines removed

## Files you may modify

- `src/fleet/manager.ts`

## Context

`FleetManager.reviewTask` currently branches across the four backends itself and
carries a local `callLLM`. `executeReview` now does that. This is mostly deletion.

`fleet/manager.ts` already submits reviews over REST via
`ConclaveApiClient.submitReview()`, so it already gets budget, the duplicate guard,
memory extraction, and the GitHub callback. **Do not change how it submits.**

## Steps

1. Delete the local `callLLM` function (around line 162).

2. In `reviewTask`, replace the backend branching with one call:

   ```ts
   const output = await executeReview(agent, input, { url: llmUrl, key: llmKey }, {
     timeoutMs: proc.timeoutMs ?? 60000,
     template: promptTemplate,
   });
   ```

   Use the variable names already in scope. Read the surrounding code to find what
   the resolved URL, key, and template are actually called.

3. Add the import:
   ```ts
   import { executeReview } from '../review/execute.js';
   ```
   Remove now-unused imports of `runLlmReview`, `runSlimReview`, `runCodeReview`,
   `runPipelineReview`. Keep the `ReviewInput` and `ReviewOutput` type imports if
   still referenced.

4. Leave untouched: vault key resolution, the pulse broadcasts, the
   `reviewedTaskIds` dedup set, the human/hybrid mode branch, and every
   `client.submitReview` call.

## Verify

```bash
grep -c "async function callLLM" src/fleet/manager.ts
```
Expected output: `0`

```bash
grep -c "runLlmReview\|runSlimReview\|runCodeReview\|runPipelineReview" src/fleet/manager.ts
```
Expected output: `0`

```bash
grep -c "submitReview" src/fleet/manager.ts
```
Expected: the same number as before your change. Record it first with
`git stash` / `git stash pop` if unsure.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Stop conditions

- If removing the branching changes which agent record is passed to the backend,
  stop and report. The agent record carries `type`, `model`, `provider`,
  `instructions` and `command` — all of them must still reach `executeReview`.
- Do not change the mode handling (`auto` / `human` / `hybrid`). T10 covers that.

## Commit

```
refactor(fleet): route manager reviews through executeReview
```
