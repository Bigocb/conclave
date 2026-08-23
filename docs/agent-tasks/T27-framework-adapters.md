# T27 — Framework adapters

**Mark:** AGENT
**Depends on:** T26
**Estimated diff:** two small new packages, ~150 lines each

## Files you may modify

- `adapters/langgraph/` (create — `package.json`, `src/index.ts`, `README.md`)
- `adapters/python/` (create — `pyproject.toml`, `conclave_client/__init__.py`,
  `conclave_client/crewai.py`, `conclave_client/adk.py`, `README.md`)
- `docs/integrations/adapters.md` (create)

## Context

These wrap `ConclaveApiClient.getVerdict()` from T26 and nothing else. If an adapter
needs logic beyond "submit, wait, return findings," that logic belongs in the server,
not here — this task adds no new server behaviour, and if you find yourself wanting to,
stop and report rather than building it into an adapter.

Neither package is published to a registry in this task — that's a separate decision
about ownership and versioning. This task gets them working and documented locally.

## Steps

1. **`adapters/langgraph/`** — a TypeScript package, one exported function:

   ```ts
   export interface ConclaveReviewNodeConfig {
     serverUrl: string;
     token: string;              // clv_ agent token
     channel: string;
     dimensions: string[];
   }

   /** A LangGraph node: reads state.diff, submits it, waits for the verdict. */
   export function conclaveReviewNode(config: ConclaveReviewNodeConfig) {
     return async (state: { diff: string; description?: string }) => {
       // 1. submitTask via ConclaveApiClient (reuse the existing client — depend on
       //    the conclave package directly rather than reimplementing the HTTP calls)
       // 2. getVerdict(taskId) — long-poll, default timeout
       // 3. return { ...state, conclaveVerdict: verdict }
     };
   }
   ```

   Depend on the `conclave` package's `ConclaveApiClient` directly (path or workspace
   dependency — match however this repo already references itself internally; check
   `package.json`'s `bin` and `main` fields before choosing). Do not vendor a copy of
   the client.

2. **`adapters/python/`** — a small Python client plus two thin tool wrappers:

   - `conclave_client/__init__.py` — `ConclaveClient` with `submit_task()` and
     `get_verdict()`, calling the same REST endpoints `ConclaveApiClient` calls. Match
     field names exactly — read `src/schemas/index.ts`'s `CreateTaskSchema` for the
     request shape and `src/services/verdict.ts`'s `Verdict` interface for the
     response shape, don't guess at either.
   - `conclave_client/crewai.py` — one `@tool`-decorated function,
     `submit_for_review(diff: str, channel: str) -> dict`, calling submit then
     `get_verdict`.
   - `conclave_client/adk.py` — the equivalent wrapped as an ADK `FunctionTool`.

3. Each package's `README.md` is a config block plus one worked example — submit a
   diff, print whether it passed, print the dissent if any. Real values in the
   example (a plausible channel name, plausible dimensions), no placeholders like
   `<your-value-here>`.

4. Create `docs/integrations/adapters.md` linking both packages and stating the one
   rule that keeps them thin: *if an adapter needs logic beyond calling the verdict
   endpoint, that logic belongs in the server, not the adapter.*

## Verify

```bash
test -f adapters/langgraph/src/index.ts && test -f adapters/python/conclave_client/__init__.py && echo OK
```
Expected output: `OK`

```bash
wc -l adapters/langgraph/src/index.ts adapters/python/conclave_client/*.py
```
Expected: each file under roughly 150 lines. If any is bigger, it has likely grown
logic that belongs elsewhere — say so in your report rather than shipping it.

```bash
cd adapters/langgraph && npx tsc --noEmit
```
Expected: no errors.

```bash
cd adapters/python && python3 -m py_compile conclave_client/*.py
```
Expected: no errors.

## Stop conditions

- If you can't determine the exact request/response field names from
  `src/schemas/index.ts` and `src/services/verdict.ts`, stop and report which field is
  ambiguous rather than guessing — a silently wrong field name in a client library is
  much harder to catch than a compiler error.
- Do not add retry logic, caching, or a queue inside an adapter. Long-poll with a
  timeout, once, is the whole contract.

## Commit

```
feat(adapters): add LangGraph node and CrewAI/ADK tool wrappers over the verdict API
```
