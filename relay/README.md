# Orbital's agent relay

The MCP server between Orbital and the agents linked to it (docs/AGENT-RELAY.md). `server.js` is the whole relay. It runs
two ways from that one file:

- **On Node** (orbital.md): `node server.js`, its rows in SQLite or PostgreSQL (`DATABASE_URL`), at `/mcp`.
- **On ChatGPT Sites**: `worker.js` hands each request to the same server, its rows in the Site's D1 database, at `/api/mcp`
  (Sites keeps `/mcp` for itself). `build.js` bundles both into `dist/server/index.js`.

A change to `server.js` reaches both. `npm run check` runs the relay end to end on Node and through `worker.js`.

## Deploy it on ChatGPT Sites

For a workspace that runs its own relay. An admin asks ChatGPT, with the instructions Orbital copies from
Cmd+K → Choose agents → Relay …, and pastes the URL it gives back into the same page.

1. Make a new Site (slug `orbital` if it is free) and put this folder in it as it is. `.openai/hosting.json` asks for
   one D1 database, `DB`.
2. `npm install`, then `npm run build`: `dist/server/index.js` and `dist/.openai/hosting.json`.
3. Publish it, then set its access to **public**. ChatGPT and the Orbital app reach it without signing in to Sites; the
   relay signs agents in itself (OAuth) and knows each Orbital by its key.
4. Check `https://<site>/api/mcp/health` answers `{"ok":true,…}`. Its `sha256` is the `server.js` it runs, the same
   hash orbital.md's `/mcp/health` gives for the same file.
5. Give back `https://<site>/api/mcp`.

Nothing else needs setting: the relay takes its public URL from the requests it gets (`RELAY_PUBLIC_URL` overrides it).
