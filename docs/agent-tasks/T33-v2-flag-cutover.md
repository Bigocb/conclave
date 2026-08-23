# T33 — Wire v2 in behind a flag

**Mark:** AGENT
**Depends on:** T31, T32
**Estimated diff:** ~40 lines in the entrypoint, no changes to v1's logic

## Files you may modify

- `src/fleet/opinion-router.ts` (the `main()` function and `start()` method only —
  see the exact boundary in step 2)
- `.env.example`
- `DEPLOYMENT.md`

## Context

This is the only task before T34 that touches the live router file, and it changes
nothing about how v1 behaves. It adds a fork at startup: which engine's polling loop
runs. Nothing about `nextState`, `routeOpinion`, `triggerVoteRound`, or any of v1's
functions changes here.

## Steps

1. Add to `.env.example`:

   ```
   # 'v1' (default) runs the synthesis-based opinion engine. 'v2' runs the
   # critique-then-simultaneous-vote engine (docs/opinion-engine-v2.md).
   # v2 is new — validate it against a non-production database before flipping
   # this in an environment with real traffic.
   OPINION_ENGINE=v1
   ```

2. In `src/fleet/opinion-router.ts`'s `main()` function (bottom of the file), branch
   on `process.env.OPINION_ENGINE`:

   ```ts
   async function main() {
     const engine = process.env.OPINION_ENGINE === 'v2' ? 'v2' : 'v1';
     if (engine === 'v2') {
       const { startV2 } = await import('./opinion-router-v2.js');
       await startV2(/* same parsed config main() already builds for v1 */);
     } else {
       const router = new OpinionRouter(/* existing construction, unchanged */);
       await router.start();
     }
   }
   ```

   `opinion-router-v2.ts` doesn't have a `startV2` entrypoint yet — add one, modeled
   directly on v1's `OpinionRouter.start()` (the DB connection setup, the health-check
   HTTP server, the `LISTEN`/poll loop wiring), but polling `claimNextOpinionV2` and
   calling `routeOpinionV2` instead of v1's equivalents. Do not restructure v1's
   `start()` to make this fit — write v2's version fresh, even though some of it looks
   similar; a shared `start()` abstracted over both engines is a refactor for after
   the cutover, not part of getting v2 running.

3. Update `DEPLOYMENT.md`'s opinion router section with the new env var and a one-line
   pointer to `docs/opinion-engine-v2.md` for anyone deciding whether to flip it.

## Verify

```bash
grep -c "OPINION_ENGINE" src/fleet/opinion-router.ts .env.example
```
Expected: `1` or more in each.

```bash
git diff src/fleet/opinion-router.ts | grep -c "^-" 
```
Expected: a small number — this task should show almost entirely additions in `main()`,
very few deletions. A large deletion count means v1's existing logic was disturbed;
stop and report if so.

```bash
npx tsc --noEmit && npm run test:unit
```
Expected: no new errors, no regression.

## Manual check (ask a human to run this)

Against a non-production database: run the router with `OPINION_ENGINE=v2`, submit an
opinion with real channel subscribers, and confirm it reaches `closed` with a
`close_tag` and that `clv_opinion_ballots` has one row per critic. Then confirm running
with the env var unset (or `v1`) still produces v1's exact existing behaviour —
`synthesizing` still appears, the dashboard's `/graph` view still renders it the same
as before this task.

## Stop conditions

- If wiring v2's `start()` requires changing anything in v1's `OpinionRouter` class
  beyond what's needed to read the env var in `main()`, stop and report which change
  seemed necessary. v1 must be provably unchanged after this task, and the diff review
  in Verify is how to catch a violation before it ships.

## Commit

```
feat(opinions): wire the v2 engine behind OPINION_ENGINE=v2
```
