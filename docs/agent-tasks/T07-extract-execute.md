# T07 — Extract `src/review/execute.ts`

**Mark:** AGENT
**Depends on:** T06
**Estimated diff:** one new file

## Files you may modify

- `src/review/execute.ts` (create)
- `src/__tests__/review-execute.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)

## Context

`src/fleet/backends.ts` already exports the four backends. What is missing is the
single entry point that chooses between them. This task adds only that dispatcher —
it changes no caller. T08 and T09 do the rewiring.

## Steps

1. Create `src/review/execute.ts` with exactly this public surface:

   ```ts
   import {
     runLlmReview,
     runSlimReview,
     runCodeReview,
     runPipelineReview,
     type AgentRecord,
     type ReviewInput,
     type ReviewOutput,
   } from '../fleet/backends.js';

   export interface ReviewCredentials {
     url: string;
     key?: string;
   }

   export interface ExecuteOptions {
     timeoutMs?: number;
     template?: string;
   }

   /**
    * Run one review through whichever backend the agent is configured for.
    * The only place an LLM is invoked for a review.
    */
   export async function executeReview(
     agent: AgentRecord,
     input: ReviewInput,
     creds: ReviewCredentials,
     opts: ExecuteOptions = {},
   ): Promise<ReviewOutput>;
   ```

2. Dispatch on `agent.type`:

   | `agent.type` | backend |
   |---|---|
   | `'slim'` | `runSlimReview` |
   | `'code'` | `runCodeReview` |
   | `'pipeline'` | `runPipelineReview` |
   | `'llm'`, `undefined`, `null`, anything else | `runLlmReview` |

   Default `timeoutMs` to `60000`. Pass `creds.url` and `creds.key` through in the
   positions each backend already expects — read their signatures, do not assume.

3. Wrap the backend call in try/catch. On throw, return the same low-confidence
   fallback shape `parseReviewResponse` produces on failure, with a comment naming
   the backend and the error message. `executeReview` must never throw.

4. Create `src/__tests__/review-execute.test.ts`. Use `vi.mock` on
   `../fleet/backends.js` so no network call happens. Assert:
   - `type: 'slim'` calls `runSlimReview` and nothing else
   - `type: 'code'` calls `runCodeReview`
   - `type: 'pipeline'` calls `runPipelineReview`
   - `type: undefined` calls `runLlmReview`
   - `type: 'nonsense'` calls `runLlmReview`
   - when a backend rejects, `executeReview` resolves with `reviewer_confidence: 0`
     rather than rejecting

5. Add the test to `include` in `vitest.unit.config.ts`.

## Verify

```bash
npx vitest run src/__tests__/review-execute.test.ts
```
Expected: all six cases pass.

```bash
npx tsc --noEmit
```
Expected: no new errors.

```bash
grep -rn "executeReview" src/ --include=*.ts | grep -v "__tests__" | grep -vc "review/execute.ts"
```
Expected output: `0` — nothing calls it yet. That is correct at this stage.

## Stop conditions

- If a backend's parameter order differs from what you assumed, fix your call, not
  the backend signature.
- Do not modify `src/fleet/backends.ts` in this task.

## Commit

```
feat(review): add executeReview backend dispatcher
```
