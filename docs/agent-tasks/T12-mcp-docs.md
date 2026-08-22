# T12 — Document the MCP integration surface

**Mark:** AGENT
**Depends on:** nothing
**Estimated diff:** one new doc

## Files you may modify

- `docs/integrations/mcp.md` (create)
- `README.md` (add one row to the docs table)

## Context

`src/mcp/index.ts` registers sixteen tools. Any MCP-speaking client — Claude Code, an
ADK agent, a LangGraph graph behind an MCP adapter — can already drive Conclave
through them. That surface is built and undocumented, which makes it invisible.

This task documents what exists. It adds no code.

## Steps

1. Read `src/mcp/index.ts` and list every registered tool: its name, its parameters,
   and one line on what it does. There are sixteen `server.tool(` calls.

2. Read `src/mcp/api-client.ts` to see which REST endpoint each tool calls, so the
   descriptions match real behaviour rather than the tool's own doc string.

3. Create `docs/integrations/mcp.md` with these sections:

   - **What this is** — two sentences. An MCP server exposing Conclave to any MCP
     client.
   - **Setup** — the client config block. `conclave-mcp` is declared as a binary in
     `package.json`, so the command is `npx conclave-mcp`. List the environment
     variables it needs; read the top of `src/mcp/index.ts` to find them rather than
     guessing.
   - **Tool reference** — a table of all sixteen: name, parameters, what it does.
   - **A first task, end to end** — register an agent, subscribe to a channel, submit
     a task, read the reviews. Use real tool names and realistic arguments.
   - **Troubleshooting** — at minimum: what a `NOT_SUBSCRIBED` error means (the
     principal is not subscribed to the target channel) and what a 402 means
     (insufficient attention budget).

4. Add a row to the docs table in `README.md` pointing at the new file.

## Verify

```bash
test -f docs/integrations/mcp.md && echo OK
```
Expected output: `OK`

```bash
grep -c "server.tool(" src/mcp/index.ts
```
Record this number. The tool reference table in your doc must have the same number of
rows. State both numbers in your report.

```bash
grep -c "docs/integrations/mcp.md" README.md
```
Expected: `1` or more.

## Stop conditions

- If a tool's implementation contradicts its registered description, document the
  **implementation** and note the discrepancy at the bottom of the doc. Do not change
  the code in this task.
- Do not document tools that do not exist, and do not describe planned behaviour.

## Commit

```
docs(mcp): document the MCP server tool surface and setup
```
