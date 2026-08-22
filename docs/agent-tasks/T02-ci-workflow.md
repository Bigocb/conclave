# T02 — CI workflow with a Postgres service

**Mark:** AGENT
**Depends on:** T00, T01
**Estimated diff:** two new files

## Files you may modify

- `.github/workflows/ci.yml` (create)
- `vitest.unit.config.ts` (create)
- `vitest.integration.config.ts` (create)
- `package.json` (scripts block only)

## Context

Fourteen test files exist and nothing runs them. Seven open a real Postgres
connection in `beforeAll`; seven do not. Split them so the fast half gates pull
requests immediately and the DB half runs against a service container.

Note: `tsconfig.json` excludes `src/__tests__`, so `tsc --noEmit` does not typecheck
test files. That is existing behaviour — do not change it in this task.

**Needs a database** (integration):
`agent-detail`, `api-key-auth-middleware`, `api-key-routes`, `api-key-service`,
`api-keys-schema`, `protocol-parity`, `require-permission`

**No database** (unit):
`fleet-memory`, `github-resolver`, `mcp-config`, `memory-extractor`, `memory`,
`openapi-spec`, `rate-limit-meta`

## Steps

1. Create `vitest.unit.config.ts`:

   ```ts
   import { defineConfig } from 'vitest/config';

   export default defineConfig({
     test: {
       testTimeout: 30000,
       include: [
         'src/__tests__/fleet-memory.test.ts',
         'src/__tests__/github-resolver.test.ts',
         'src/__tests__/mcp-config.test.ts',
         'src/__tests__/memory-extractor.test.ts',
         'src/__tests__/memory.test.ts',
         'src/__tests__/openapi-spec.test.ts',
         'src/__tests__/rate-limit-meta.test.ts',
       ],
     },
   });
   ```

2. Create `vitest.integration.config.ts` with the same shape but `testTimeout: 60000`
   and the seven integration files listed above.

3. In `package.json`, add these scripts alongside the existing `test` script. Do not
   remove `test`:

   ```json
   "test:unit": "vitest run --config vitest.unit.config.ts",
   "test:integration": "vitest run --config vitest.integration.config.ts",
   ```

4. Create `.github/workflows/ci.yml`:

   ```yaml
   name: CI

   on:
     pull_request:
     push:
       branches: [main]

   jobs:
     check:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
             cache: npm
         - run: npm ci
         - run: npx tsc --noEmit
         - run: npx eslint src/ --max-warnings 9999
         - run: npm run test:unit

     integration:
       runs-on: ubuntu-latest
       services:
         postgres:
           image: postgres:16
           env:
             POSTGRES_USER: conclave
             POSTGRES_PASSWORD: conclave
             POSTGRES_DB: conclave
           ports: ['5432:5432']
           options: >-
             --health-cmd pg_isready
             --health-interval 10s
             --health-timeout 5s
             --health-retries 5
       env:
         DATABASE_URL: postgres://conclave:conclave@localhost:5432/conclave
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
             cache: npm
         - run: npm ci
         - run: npm run test:integration
   ```

## Verify

```bash
npm run test:unit
```
Expected: runs 7 files. Some may fail — record which, do not fix them in this task.

```bash
node -e "const s=require('./package.json').scripts; console.log(!!s['test:unit'], !!s['test:integration'], !!s.test)"
```
Expected output: `true true true`

```bash
npx js-yaml .github/workflows/ci.yml > /dev/null 2>&1 || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"
```
Expected: exits 0 (the YAML parses).

## Stop conditions

- If a file in the unit list fails because it tries to open a database connection,
  move it to the integration config, note the move in your report, and continue.
- Do not fix failing tests in this task. Recording the failures **is** the
  deliverable — T03 onward depends on knowing the baseline.
- Do not mark the workflow as a required check; that is a repository setting a human
  must apply.

## Commit

```
ci: add unit/integration split and CI workflow with Postgres service
```
