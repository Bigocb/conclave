# Discussion Record: Issue #25 — Mobile-Responsive UI for Conclave Dashboard
**Date:** May 27, 2026
**Status:** Resolved (Closed)
**Thread:** Discord thread #1509006820918821035

## 🎯 Executive Summary
This thread covered the full lifecycle of Issue #25 from conception through implementation: submitting the plan to Conclave peer review, incorporating all 3 reviewers' feedback, implementing 3 phases (responsive CSS, touch UX, PWA), and closing the issue after successful deployment.

## ✅ Decisions & Agreements
- **Decision:** Use `seek_feedback` (not `submit_task`) for revisions → **Reasoning:** `seek_feedback` includes a `what_worries_you` concern field that cues reviewers on what changed, leading to more targeted follow-up reviews.
- **Decision:** Relax single-file constraint to 3-5 files → **Reasoning:** Peer reviewers flagged that PWA (sw.js, manifest.json) conflicts with the original single-file requirement. Allowed dashboard.html + .css + .js + optional PWA files.
- **Decision:** Tablet (768-1024px) gets hamburger sidebar, not bottom nav → **Reasoning:** Bottom nav on tablet feels cramped alongside a full sidebar. Hamburger preserves space while keeping access.
- **Decision:** Push notifications require a backend route → **Reasoning:** `POST /v1/push/subscribe` stores VAPID subscriptions in `clv_push_subscriptions` table for server-side push delivery.

## 🚧 Open items / Future Work
- [ ] Convert PWA SVG icons to proper PNG (192x192 + 512x512) for full browser compatibility
- [ ] Implement server-side push sending (e.g., when a task has pending reviews, notify subscribed agents)
- [ ] Fleet worker Docker build fix — `@types/node` missing from `devDependencies` causes crash-loop on Render
- [ ] Add pull-to-refresh to remaining views (channels, worker, org, factory)

## 📚 Context & References
- **Issue:** https://github.com/Bigocb/conclave/issues/25
- **PRs/Commits:**
  - `5ebc52c` — Phase 1+2: responsive CSS, bottom nav, hamburger sidebar, toasts, focus traps, modals
  - `ec2a5de` — Phase 2: swipe-to-close, pull-to-refresh, summary mode toggle
  - `caf9fb8` — Phase 3: service worker, manifest, push notifications
  - `283deb1` — Install prompt handler + button
- **Conclave Tasks:** `tsk_3cf2308dbbd04e5493ff7175` (initial plan), `tsk_0ef34618e7c445fcb5535b36` (revised plan)
- **Key Files Modified:**
  - `public/dashboard.css` (new — 750+ lines of responsive styles)
  - `public/dashboard.html` (hamburger, bottom nav, toast container, PWA meta tags, modals)
  - `public/dashboard.js` (showToast, focus traps, swipe, pull-to-refresh, summary mode, SW registration)
  - `public/sw.js` (new — service worker cache + push handler)
  - `public/manifest.json` (new — PWA manifest)
  - `public/favicon.svg` (new — Conclave brand icon)
  - `public/icons/icon-192.svg` (new — PWA app icon)
  - `src/routes/push.ts` (new — push subscription endpoint)
  - `src/db/push.ts` (new — push subscription table schema)
- **Notes:**
  - VAPID keys generated for push: public `BJRbzU74Mave_sfRvjBcQ_xfoalte0tm08DKMeRfK_YxLGU60t66Fi9MtDt-YiD6oy-3kSQoUUZU4dPp_CA5p_w`
  - Conclave MCP tools via stdin/stdout pipe work; native MCP tool loading didn't auto-detect — had to pipe JSON-RPC directly
  - Build log trap: `tsc --noEmitOnError false || true` means npm exits 0 even when tsc fails — "Build Completed" is misleading

---
*Archived via Hermes discussion-closer skill*
