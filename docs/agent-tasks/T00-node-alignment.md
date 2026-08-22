# T00 — Align Node version across images

**Mark:** AGENT
**Depends on:** nothing
**Estimated diff:** ~6 lines

## Files you may modify

- `Dockerfile`
- `package.json`
- `.nvmrc` (create)

## Context

Three Docker images disagree on Node version. `Dockerfile` uses `node:20-slim`;
`Dockerfile.worker` and `Dockerfile.opinion` use `node:22-alpine`. `DEPLOYMENT.md`
states Node 22+. Standardise on 22.

## Steps

1. In `Dockerfile`, change both `FROM node:20-slim` lines to `FROM node:22-slim`.
   There are two — one for the `base` stage and one for the production stage.
2. In `package.json`, add an `engines` block immediately after the `"license"` key:
   ```json
   "engines": { "node": ">=22" },
   ```
3. Create `.nvmrc` containing exactly one line: `22`

## Verify

```bash
grep -c "FROM node:22" Dockerfile
```
Expected output: `2`

```bash
node -e "console.log(require('./package.json').engines.node)"
```
Expected output: `>=22`

```bash
cat .nvmrc
```
Expected output: `22`

## Stop conditions

- If `Dockerfile` contains any `FROM node:` line that is neither 20 nor 22, stop and
  report the line rather than changing it.

## Commit

```
chore(docker): standardise on Node 22 across images
```
