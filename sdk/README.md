# sdk/ — Tana platform SDK

Self-contained Node client for the new Tana (home.tana.inc): graph queries, live Loro document sync, outline editing, pins, assets, meeting attendance. No Electron, no app knowledge; auth is injected as `getAccessToken({ refresh })`.

Docs, in reading order:

1. [docs/sdk/01-overview.md](../docs/sdk/01-overview.md) — what each module does, layering rules, entry point
2. [docs/sdk/02-data-model.md](../docs/sdk/02-data-model.md) — Tana's data model: ids, data/content maps per kind, graph Node JSON, filters, pins, assets, session
3. [docs/sdk/03-api-reference.md](../docs/sdk/03-api-reference.md) — every exported function, class and event
4. [docs/sdk/04-recipes.md](../docs/sdk/04-recipes.md) — copy-paste tasks with their CLI equivalents
5. [docs/sdk/05-gotchas.md](../docs/sdk/05-gotchas.md) — protocol, Loro and tooling pitfalls

Wire protocol: [docs/PLATFORM-PROTOCOL.md](../docs/PLATFORM-PROTOCOL.md). Pins: [docs/PINNING.md](../docs/PINNING.md).

```js
const { createTanaClient, readNode, setTitle } = require('./sdk');
const content = require('./sdk/content');
const client = createTanaClient({ getAccessToken, orgId, peerId, storageId });
await client.sync.connect();
const doc = await client.sync.subscribe('tana:text:…');
readNode(doc).title; content.readOutline(doc);
setTitle(doc, 'New title');                                   // sent as a live update within 5 ms
client.sync.on('change', (id, { origin }) => { /* remote or local */ });
await client.close();
```

Checks: `npm run check` (offline, fake SyncService). Live: `node scripts/platform-cli.js <cmd>` — with node, not `./node_modules/.bin/electron`, which aborts in AppKit inside an agent sandbox (docs/ELECTRON-SANDBOX.md); the CLI re-execs Electron itself for the cookie session.
