# T06 — Extract `src/review/prompt.ts`

**Mark:** AGENT
**Depends on:** T05
**Estimated diff:** one new file, two call sites updated

## Files you may modify

- `src/review/prompt.ts` (create)
- `src/__tests__/review-prompt.test.ts` (create)
- `vitest.unit.config.ts` (add the new test to `include`)
- `src/fleet/backends.ts`
- `src/fleet/manager.ts`
- `src/workers/reviewer.ts`

## Context

Review prompt assembly happens in three places: `buildLlmSystemPrompt` inside
`src/fleet/backends.ts`, plus inline construction in `manager.ts` and
`workers/reviewer.ts`. Consolidate into one builder.

**Preserve this behaviour exactly:** agent instructions must appear at the **top** of
the system prompt. A merged fix (`fix(prompts): place agent instructions at the top
of system prompts`) established this deliberately. Moving them breaks reviewer
behaviour silently — no test will catch it.

## Steps

1. Read `buildLlmSystemPrompt` in `src/fleet/backends.ts` in full, plus the prompt
   construction in both runners. Note the section order in the existing
   `backends.ts` version — that ordering is the one to keep.

2. Create `src/review/prompt.ts`:

   ```ts
   import type { ReviewInput } from '../fleet/backends.js';

   /**
    * Assemble the system prompt for a review.
    * Section order is load-bearing: agent instructions come first.
    */
   export function buildReviewPrompt(
     input: ReviewInput,
     template?: string,
   ): string;
   ```

   Section order, top to bottom:
   1. agent instructions (`input.instructions`), when present
   2. the base review template — `template` when given, otherwise
      `DEFAULT_REVIEW_PROMPT` from `src/reviewer/prompts.js`
   3. the memory block (`input.memories`), when non-empty
   4. the dimension list (`input.dimensions`)
   5. the required JSON output shape

3. Create `src/__tests__/review-prompt.test.ts` asserting:
   - when `instructions` is set, its text appears before the base template text
   - when `instructions` is absent, no empty heading is emitted
   - every entry in `dimensions` appears in the output
   - `memories` entries appear when present and the block is omitted when the array
     is empty
   - the output always contains the JSON shape block

   The first assertion is the important one. Write it as an index comparison:
   ```ts
   expect(out.indexOf('CUSTOM_INSTRUCTION')).toBeLessThan(out.indexOf('peer reviewer'));
   ```
   Adjust the second needle to match whatever the real template opens with.

4. Add the test to `include` in `vitest.unit.config.ts`.

5. Replace `buildLlmSystemPrompt` in `src/fleet/backends.ts` with a call to
   `buildReviewPrompt`. Delete the old function. Update the two runners if they build
   prompts inline.

6. While in `src/fleet/backends.ts`, replace the debug block that starts at line 92
   — the `[LLM-DEBUG]` and `[DBG-payload]` `console.log` calls, including the
   `## Your Reviewer Instructions` offset probe — with a single guarded line:

   ```ts
   if (process.env.LOG_PROMPTS === 'true') {
     console.log(`[review] agent=${agent.name} provider=${provider} model=${agent.model} prompt_chars=${systemPrompt.length}`);
   }
   ```

   Delete every other `console.log` in that block. Do not log prompt contents, and
   do not log the key even partially.

## Verify

```bash
grep -c "DBG-payload\|LLM-DEBUG" src/fleet/backends.ts
```
Expected output: `0`

```bash
grep -rn "function buildLlmSystemPrompt" src/ --include=*.ts ; echo "exit=$?"
```
Expected: no matches, `exit=1`.

```bash
npx vitest run src/__tests__/review-prompt.test.ts
```
Expected: all cases pass.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression against the T02 baseline.

## Stop conditions

- If you cannot reproduce the existing section order with confidence, stop and
  report. Getting this wrong changes every review the fleet produces, and no test
  will fail.
- Do not change `DEFAULT_REVIEW_PROMPT` or `CHANNEL_PROMPTS` in
  `src/reviewer/prompts.ts`. This task moves assembly only, not content.

## Commit

```
refactor(review): extract shared prompt builder and quiet LLM debug logging
```
