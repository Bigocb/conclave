# Conclave Packaging & Distribution Plan

**Goal:** Define how Conclave is packaged, installed, and run across three targets — Docker Compose, npm package, and Helm chart — with the frontend bundled into every distribution.

---

## Current State

Three Dockerfiles exist (API, worker, opinion router) but no one has run them together. A CLI skeleton exists in `src/cli/index.ts` with `commander` commands — functional but not polished. The frontend (`conclave-fe`) is a **separate Vercel project** — no self-hosted distribution serves the UI alongside the API.

## Cross-Cutting Requirement: Frontend Bundling

Every distribution must serve the UI alongside the API as a single deployable. Users should hit `http://localhost:3000` and get the dashboard — not a separate URL.

**Pattern (applies to all three targets):**
1. Add `@fastify/static` dependency to the API server
2. Register a static route for `dist/ui/` or `public/` that serves the FE build on all non-API paths
3. The Dockerfile gets a multi-stage build: build FE → build API → runtime image with both
4. npm package ships pre-built FE assets as `dist/ui/`
5. Helm chart uses the same container image, just deployed on K8s

---

## Target 1: Docker Compose

**What it delivers:** `docker compose up` starts Postgres + API server (with bundled FE) + fleet worker + opinion router + pulse daemon.

**What exists:**
- `Dockerfile` — API server (node:20-slim, multi-stage, port 3000)
- `Dockerfile.worker` — Fleet worker (node:22-alpine)
- `Dockerfile.opinion` — Opinion router (node:22-alpine)
- `fleet.docker.yaml` — Bootstrap fleet config
- `.env.example`

**What's needed (4 slices):**
1. **docker-compose.yml** — wire Postgres(16) + all 4 services, shared network, volumes, health checks, migration execution at startup
2. **FE bundling in Dockerfile** — multi-stage build that builds the FE and copies into the API runtime image; register `@fastify/static` to serve it
3. **.env.example + docs/self-host.md** — document all env vars, write setup guide
4. **docker-compose.override.yml** — local dev variant with hot reload, Postgres exposed on host

**Success state:**
```sh
git clone https://github.com/Bigocb/conclave
cd conclave
cp .env.example .env   # edit keys
docker compose up -d
open http://localhost:3000   # 🎯 serves both API and dashboard
```

---

## Target 2: npm Package

**What it delivers:** `npx conclave dev` starts the full stack with one command — embedded SQLite, built-in fleet, self-served FE.

**What exists:**
- `src/cli/index.ts` — 150 lines of `commander` commands
- Three `bin` entries in `package.json`
- `commander` already a dependency

**What's needed (4 slices):**
1. **SQLite backend** — add better-sqlite3, dual-mode DB in `src/db/index.ts` (SQLite for local, Postgres for prod)
2. **FE bundling** — pre-build FE, include in npm package as `dist/ui/`, register `@fastify/static` in local mode
3. **CLI polish** — `conclave dev` with embedded fleet + SQLite + FE, `conclave init` walkthrough, `conclave mcp` server mode
4. **npm publish** — CI pipeline, README, version strategy

**Success state:**
```sh
npx @conclave/cli dev
open http://localhost:3000   # 🎯 API + dashboard + fleet
```

---

## Target 3: Helm Chart

**What it delivers:** Helm chart to deploy Conclave on Kubernetes — API (with bundled FE) + fleet worker + opinion router + pulse daemon. Postgres via Bitnami or external.

**What exists:** Nothing — net new.

**What's needed (4 slices):**
1. **Chart skeleton + API deployment** — Chart.yaml, values.yaml, templates for API Deployment/Service/Ingress/HPA
2. **FE bundling in API container** — same multi-stage Dockerfile change as Target 1; the Helm chart deploys the same image
3. **Worker deployments** — templates for fleet, opinion, pulse with ConfigMaps and Secrets
4. **Values polish + docs** — env profiles, NOTES.txt, docs/helm.md

**Success state:**
```sh
helm repo add conclave https://conclave.charts
helm install conclave conclave/conclave \
  --set ingress.host=conclave.example.com
open https://conclave.example.com   # 🎯 API + dashboard
```

---

## Execution Priority

```
Phase 1: Docker Compose       (ship fast — unblocks all self-hosters)
Phase 2: npm package polish   (unblocks local dev)
Phase 3: Helm chart           (unblocks production K8s)
```

Docker Compose is highest impact because:
- Existing Dockerfiles just need wiring
- FE bundling pattern is the same for all three targets — prove it in Docker first
- Single `docker compose up` is the lowest friction self-host path

npm Package also requires the SQLite backend work (Slice 1), which is net-new code. Helm chart is pure config once the Docker images exist.

## Issues Created

| Target | PRD | Slices |
|---|---|---|
| Docker Compose | #158 | #161 docker-compose.yml, #162 env/docs, #163 dev override, *(new)* FE bundling |
| npm Package | #159 | #164 SQLite backend, #165 CLI polish, #166 npm publish, *(new)* FE bundling |
| Helm Chart | #160 | #167 API deployment, #168 worker deployments, #169 values/docs, *(new)* FE bundling |

All on the conclave project board, labeled `phase:ecosystem` / `ready-for-agent`.

## Out of scope

- Python SDK (issue #11)
- TypeScript SDK library (issue #10)
- Debian/Homebrew packages
- ARM-specific builds (alpine images cover this natively)