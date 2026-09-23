# Tana SDK — overview

`sdk/` is a self-contained Node client for the **new Tana** (home.tana.inc). It speaks Tana's own platform protocol (the one the web client uses), which is undocumented and versioned `v1alpha1`. It has no Electron or app dependencies; the Electron app, the CLI and the offline checks all use it through the same API.

Read in this order: this file → [02-data-model.md](02-data-model.md) → [03-api-reference.md](03-api-reference.md) → [04-recipes.md](04-recipes.md) → [05-gotchas.md](05-gotchas.md). The wire protocol itself is in [../PLATFORM-PROTOCOL.md](../PLATFORM-PROTOCOL.md) and pins in [../PINNING.md](../PINNING.md).

## What it does

| Concern | Module | One line |
|---|---|---|
| Auth plumbing | `transport.js` | Connect transport with `Authorization: Bearer`, request ids, one retry after 401 via `getAccessToken({ refresh: true })`. |
| Discovery / queries | `graph.js` | `tana.graph.v1alpha1.GraphService`: ListNodes, ListEdges, GetEdge, GetOwnerChain, Traverse. Protobuf JSON in and out. |
| Live documents | `sync.js` | One `ServerSync` stream per client; per-document bootstrap → live; outbound batching; reconnect; resync; create (subscribe with init); soft delete. |
| A document | `document.js` | LoroDoc wrapper: `data`/`content` maps, `transact`, undo/redo, export/import, change events. |
| Data-map helpers | `node.js` | `readNode`, `setTitle`, `setState`, `contentText`, `ulid`, `initDocument` (new doc/task/meeting layout). |
| Access checks | `access.js` | Verified write, sharing, move-preview, delete, audience and confirmation-token checks used by the app boundary. |
| Outline editing | `content.js` | Read/write the loro-prosemirror content tree as an outline: segments, insert/remove/indent/outdent/move, images. |
| Query building | `query.js` | Search text + `#task/#meeting/#member/#space/#Type` tokens → ListNodes params; the one view query (`viewParams`) with its three presets; hidden-title rules. |
| Typed fields | `fields.js` | Read/write "attributes": the per-field ProseMirror trees in a document's own data map, named by its type's template. |
| Pins | `pins.js` | Sidebar (collection tree) and date (pin-map) pins, exactly as the web client writes them; items pinned on an event or a space (`pinnedItems`). |
| Live queries | `livequery.js` | A query the server keeps answering: new, changed and removed rows (nodes, or edges such as backlinks and pins) pushed as they happen, without polling or subscribing each node. |
| Presence | `presence.js` | Who is in a document right now and where their caret is, from the document's ephemeral channel; and being seen there yourself. |
| Meeting attendance | `calls.js` | Who is in a meeting *now*, from the live `sessions` of its `tana:call:` document, and who was in it earlier, from `data.sessionLog`. |
| Assets | `assets.js` | Image bytes for a `tana:image:` uri (two-hop CDN fetch); upload a file and seed the `tana:image:` document for it. |
| Schemas | `proto/descriptors.js` | Protobuf descriptors extracted from Tana's bundle, loaded at runtime (no codegen). |

## Layering rules

- `sdk/*` imports only `node:*`, `@bufbuild/protobuf`, `@connectrpc/connect(-web)`, `loro-crdt` and sibling modules. Never Electron, never app files.
- Auth is injected: every network-facing function takes `getAccessToken({ refresh })`. Who owns the cookie session (the app's `tana-session.js`) is not the SDK's business.
- The SDK knows Tana's model (documents, states, events, pins), not the app's views. The view presets and their one query builder live in `query.js` so the CLI and the app cannot drift apart; treat that as the boundary's soft edge (docs/VIEWS.md).
- Everything app-specific (SQLite cache, IPC, custom icons, breadcrumbs) lives in `main.js`.

## Entry point

```js
const { createTanaClient } = require('./sdk');
const client = createTanaClient({
  getAccessToken,   // async ({ refresh }) => bearer token from GET /api/auth/session
  orgId,            // WorkOS org id from the token's org_id claim, e.g. 'org_01EXAMPLE00000000000000000'
  peerId,           // derivePeerId(userExternalId): stable per user (48-bit hash), random 15-bit nonce per process
  storageId,        // persisted UUID for a non-ephemeral peer (omit → ephemeral peer)
  logger: console,  // optional
});
client.graph   // GraphClient
client.sync    // SyncConnection (call connect() first)
await client.close();
```

## Verification

`npm run check` runs `scripts/sdk-check.js` (offline: proto round-trips, documents, outline ops, undo, query builders, pins, image fetch against fakes, and the full sync lifecycle against an in-process fake `SyncService`) and `scripts/db-check.js`. Live behaviour is exercised with `scripts/platform-cli.js` (see recipes).
