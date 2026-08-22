# T05 — Extract `src/review/parse.ts`

**Mark:** AGENT
**Depends on:** T04
**Estimated diff:** one new file, one new test file, two call sites updated

## Files you may modify

- `src/review/parse.ts` (create)
- `src/__tests__/review-parse.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)
- `src/fleet/manager.ts`
- `src/workers/reviewer.ts`

## Context

After T04, two identical-in-purpose response parsers remain:

- `src/fleet/manager.ts` — `parseReviewResponse` at roughly line 225
- `src/workers/reviewer.ts` — `parseReviewResponse` at roughly line 157

Both take raw LLM text and produce scores, a weighted overall, a confidence, a
comment, and suggestions. They differ in what malformed output they tolerate. Unify
them, keeping the **union** of tolerances — never the intersection.

Do **not** touch `src/fleet/opinion-router.ts`. Its `callOpinionCritiqueLLM` and
`callVoteLLM` parse opinion payloads, not reviews. Different shape, out of scope.

## Steps

1. Read both existing implementations in full before writing anything. List the input
   forms each one handles — fenced ` ```json ` blocks, bare JSON, JSON embedded in
   prose, missing fields, out-of-range numbers.

2. Create `src/review/parse.ts` exporting exactly this signature:

   ```ts
   import type { ReviewOutput } from '../fleet/backends.js';

   /**
    * Parse raw LLM output into a ReviewOutput.
    * Tolerates fenced JSON, bare JSON, and JSON embedded in prose.
    * Never throws — returns a low-confidence fallback when parsing fails.
    */
   export function parseReviewResponse(
     raw: string,
     dimensions?: string[],
   ): ReviewOutput;
   ```

   Requirements:
   - Handle every input form either original handled.
   - Clamp `weighted_overall` to 0–10 and `reviewer_confidence` to 0–1. If confidence
     arrives above 1, divide by 10 — `workers/reviewer.ts` already does this.
   - Truncate `comment` to 1500 characters.
   - Always return an array for `suggestions`, never `undefined`.
   - On total parse failure return a fallback with `reviewer_confidence: 0` and a
     comment naming the failure. Do not throw.

3. Create `src/__tests__/review-parse.test.ts` with at least these cases:
   - fenced ` ```json ` block
   - bare JSON object
   - JSON preceded by prose
   - confidence given as `8` (expect `0.8`)
   - `weighted_overall` of `15` (expect `10`)
   - missing `suggestions` (expect `[]`)
   - a comment longer than 1500 characters (expect truncation)
   - completely unparseable input (expect the fallback, no throw)

4. Add `'src/__tests__/review-parse.test.ts'` to the `include` array in
   `vitest.unit.config.ts`.

5. In `src/fleet/manager.ts` and `src/workers/reviewer.ts`, delete the local
   `parseReviewResponse` function and import the shared one:
   ```ts
   import { parseReviewResponse } from '../review/parse.js';
   ```
   Adjust the relative path per file. Keep every call site as-is; the signature is
   compatible.

## Verify

```bash
grep -rn "function parseReviewResponse" src/ --include=*.ts
```
Expected: exactly one match, in `src/review/parse.ts`.

```bash
npx tsc --noEmit
```
Expected: no new errors.

```bash
npx vitest run src/__tests__/review-parse.test.ts
```
Expected: all cases pass.

```bash
npm run test:unit
```
Expected: no regression against the T02 baseline.

## Stop conditions

- If the two originals disagree on a field's meaning — for example one treats
  `approved` as required and the other defaults it — stop and report the conflict
  rather than picking one.
- Do not change `ReviewOutput` in `src/fleet/backends.ts`. If the parser cannot
  satisfy the existing type, report why.

## Commit

```
refactor(review): extract shared review response parser
```
