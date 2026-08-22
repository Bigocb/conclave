# T11 — Freeze PROTOCOL.md at v0.1

**Mark:** AGENT
**Depends on:** nothing
**Estimated diff:** a header block and some file moves

## Files you may modify

- `PROTOCOL.md` (header only)
- `docs/proposals/` (destination for moved sections)
- `README.md` (the docs table row for PROTOCOL.md)

## Context

`PROTOCOL.md` is roughly 30,000 words specifying a protocol with one implementation
and no second implementer. Freezing it stops spec drift until an adapter proves what
the spec actually needs.

## Steps

1. Add this block immediately below the title in `PROTOCOL.md`:

   ```markdown
   > **Status: frozen at v0.1.**
   > This specification is stable and closed to additions until a second
   > implementation exists. Proposed changes belong in `docs/proposals/` and are
   > merged here only once an implementation has validated them.
   ```

2. Identify sections describing behaviour that is **not implemented**. Check each
   against the codebase before moving it — search `src/routes/` and `src/services/`
   for the endpoint or message type. Move only sections you can demonstrate have no
   implementation.

   For each, create `docs/proposals/protocol-<slug>.md` containing the section verbatim
   plus a one-line note recording that it came from `PROTOCOL.md` and is not
   implemented. Replace the original section with a one-line pointer.

3. Update the `PROTOCOL.md` row in the README docs table to mention the frozen status.

## Verify

```bash
head -20 PROTOCOL.md | grep -c "frozen at v0.1"
```
Expected output: `1`

```bash
ls docs/proposals/protocol-*.md 2>/dev/null | wc -l
```
Expected: `0` or more — zero is a valid outcome if every section is implemented.

```bash
npm run test:unit
```
Expected: no regression. `protocol-parity.test.ts` is an integration test and is not
run here; if it exists in the integration set, note that a human should run it.

## Stop conditions

- **Do not move a section unless you have verified it is unimplemented.** When in
  doubt, leave it. A wrongly-moved section makes the spec lie about working
  behaviour.
- If `protocol-parity.test.ts` asserts on the presence of a section you moved, revert
  the move rather than editing the test.

## Commit

```
docs(protocol): freeze spec at v0.1 and move unimplemented sections to proposals
```
