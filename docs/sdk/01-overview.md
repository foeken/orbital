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
| Data-map helpers | `node.js` | `readNode`, `setTitle`, `setState` (plain or workflow state), `workflowStates`, `contentText`, `ulid`, `initDocument` (new doc/task/meeting layout). |
| Access checks | `access.js` | Verified write, sharing, move-preview, delete, audience and confirmation-token checks used by the app boundary. |
| Outline editing | `content.js` | Read/write the loro-prosemirror content tree as an outline: segments, insert/remove/indent/outdent/move, images. |
| Query building | `query.js` | Search text + `#task/#meeting/#member/#space/#Type` tokens → ListNodes params; the one view query (`viewParams`) with its three presets; hidden-title rules. |
| Typed fields | `fields.js` | Read/write "attributes": the per-field ProseMirror trees in a document's own data map, named by its type's template. |
| Pins | `pins.js` | Sidebar (collection tree) and date (pin-map) pins, exactly as the web client writes them; items pinned on an event or a space (`pinnedItems`). |
| Live queries | `livequery.js` | A query the server keeps answering: new, changed and removed rows (nodes, or edges such as backlinks and pins) pushed as they happen, without polling or subscribing each node. |
| Presence | `presence.js` | Who is in a document right now and where their caret is, from the document's ephemeral channel; and being seen there yourself. |
| Meetings | `calls.js` | Who is in a meeting *now*, from the live `sessions` of its `tana:call:` document, and who was in it earlier, from `data.sessionLog`; what the call left behind (recordings, presented documents, guests, raised hands, reactions, the write-up); its transcript, segments in time order plus the wrap-up's sections. |
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

## Composing less than the whole client

`createTanaClient` builds everything, and needs `orgId` and `peerId` because it always builds a `SyncConnection`. The parts stand alone; take only what you need:

```js
const { createTransport, GraphClient, SyncConnection } = require('./sdk');
const transport = createTransport({ getAccessToken });             // auth, request ids, the 401 retry
const graph = new GraphClient(transport);                          // reads only: no orgId, no peerId, no stream
const sync = new SyncConnection({ transport, orgId, peerId });     // documents, without graph, history or search
```

`HistoryClient` and `SearchClient` take a transport the same way. Everything above the sync connection is a function of a `SyncConnection` you pass in (`openLiveQuery(sync, …)`, `openPresence(sync, …)`), so live queries and presence cost nothing unless opened, and each helper is required from the module that owns it (`sdk/node`, `sdk/content`, …), which is what every caller in the app does.

## Adding a Tana service call or descriptor

- **A method on a service we already have** is one method on that service's client (`GraphClient` in `graph.js`, `HistoryClient` in `history.js`, `SearchClient` in `search.js`), made through `unary(this.client, Service, 'methodName', params)` with protobuf JSON in and out. Normalise the answer there (for example `nodes ||= []`, since protobuf JSON omits empty lists), nowhere else.
- **A new service** is its `.proto` file descriptor in `proto/descriptors.js` (the base64 `fileDesc` blob from the `Mr(` calls in Tana's `shared-*.js` bundle, with its dependencies, added to `files` and its service exported by name), a client class in a file of its own shaped like `HistoryClient` (`constructor(transport) { this.client = createClient(Service, transport); }`), and one line in `createTanaClient` if the app should get it by default.
- **A new sync command** (`ServerSyncCommand`) is a method on `SyncConnection` calling `this._command({ case, value })`; presence-sized ones go through `_lightCommand` so they queue behind at most four in flight.

## Verification

`npm run check` runs `scripts/sdk-check.js` (offline: proto round-trips, documents, outline ops, undo, query builders, pins, image fetch against fakes, and the full sync lifecycle against an in-process fake `SyncService`) and `scripts/db-check.js`. Live behaviour is exercised with `scripts/platform-cli.js` (see recipes).
