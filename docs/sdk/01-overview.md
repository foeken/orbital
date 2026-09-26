# Tana SDK — overview

`sdk/` is a self-contained Node client for the **new Tana** (home.tana.inc). It speaks Tana's own platform protocol (the one the web client uses), which is undocumented and versioned `v1alpha1`. It has no Electron or app dependencies; the Electron app, the CLI and the offline checks all use it through the same API.

Read in this order: this file → [02-data-model.md](02-data-model.md) → [03-api-reference.md](03-api-reference.md) → [04-recipes.md](04-recipes.md) → [05-gotchas.md](05-gotchas.md). The wire protocol itself is in [../PLATFORM-PROTOCOL.md](../PLATFORM-PROTOCOL.md) and pins in [../PINNING.md](../PINNING.md).

## What it does

| Concern | Module | One line |
|---|---|---|
| Auth plumbing | `transport.js` | Connect transport with `Authorization: Bearer`, request ids, one retry after 401 via `getAccessToken({ refresh: true })`; `unary`, the one protobuf-JSON unary call every service client goes through. |
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
| Calls | `calls.js` | Who is in a meeting *now*, from the live `sessions` of its `tana:call:` document, and who was in it earlier, from `data.sessionLog`; what the call left behind (recordings, presented documents, guests, raised hands, reactions, the write-up); its transcript, segments in time order plus the wrap-up's sections. |
| Meeting edits | `events.js` | Time, timezone, location, description and the attendee roster, written as Tana's event wrapper writes them. |
| Change history | `history.js` | `ChangeSummaryService.ListChanges`: the change summaries Tana's Changes panel shows. Read-only. |
| Semantic search | `search.js` | `SearchService.SemanticSearch`: the related results beside a text search. |
| Chats | `chat.js` | A chat's `data.messages` as read-only outline rows. |
| Dates | `dates.js` | `tana:plaindate:` / `tana:zoneddate:` mention uris: parse, make, label. |
| Notifications | `inbox.js` | The `tana:user-inbox:` document: items, unread count, read/unread writes, comment reminders. |
| AI proposals | `proposals.js` | Pending proposals from the chat graph; approve a proposed new document, reject any proposal. |
| Assets | `assets.js` | Image bytes for a `tana:image:` uri (two-hop CDN fetch); upload a file and seed the `tana:image:` document for it. |
| Schemas | `proto/descriptors.js` | Protobuf descriptors extracted from Tana's bundle, loaded at runtime (no codegen). |

## Layering rules

- `sdk/*` imports only `node:*`, `@bufbuild/protobuf`, `@connectrpc/connect(-web)`, `loro-crdt` and sibling modules. Never Electron, never app files.
- Auth is injected: every network-facing function takes `getAccessToken({ refresh })`. Who owns the cookie session (the app's `tana-session.js`) is not the SDK's business.
- The SDK knows Tana's model (documents, states, events, pins), not the app's views. The view presets and their one query builder live in `query.js` so the CLI and the app cannot drift apart; treat that as the boundary's soft edge (docs/VIEWS.md).
- Everything app-specific lives outside `sdk/`: the main process in `main.js` (the process boundary) and `main/` (everything that knows Tana on the app's behalf: caches, IPC handlers, icons, breadcrumbs), and the SQLite cache in `db.js`.

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
const graph = new GraphClient(transport);                          // reads only: no orgId, no peerId, no ServerSync
const sync = new SyncConnection({ transport, orgId, peerId });     // documents, without graph, history or search
```

`HistoryClient` and `SearchClient` take a transport the same way. Everything above the sync connection is a function of a `SyncConnection` you pass in (`openLiveQuery(sync, …)`, `openPresence(sync, …)`), so live queries and presence cost nothing unless opened, and each helper is required from the module that owns it (`sdk/node`, `sdk/content`, …), which is what every caller in the app does.

## Verification

`npm run check` runs the SDK's offline checks: `scripts/sdk-check.js` (proto round-trips, documents, outline ops, undo, query builders, pins, image fetch against fakes, and the full sync lifecycle against an in-process fake `SyncService`), `scripts/livequery-check.js` (the query the server receives, the status rule, the row diff) and `scripts/presence-check.js` (presence and the ephemeral channel commands), beside the app's own checks. Live behaviour is exercised with `scripts/platform-cli.js` (see recipes).

## Extending the SDK

Each kind of addition has one home. Add it there, document it in the module's section of [03-api-reference.md](03-api-reference.md), and cover it in the check named.

| Adding | Where | Check |
|---|---|---|
| A call on a service we already load | A method on its client class (`graph.js` `GraphClient`, `history.js`, `search.js`): a unary one goes through `transport.js` `unary(this.client, Service, 'methodName', params)`, which does the JSON mapping and the one retry; a server-streaming one is an async generator over `this.client.method(...)`, as `GraphClient.traverse` is. Normalise the answer there (omitted repeated fields to `[]`) and nowhere else. | `scripts/sdk-check.js`: a `createRouterTransport` fake serving the method, as the `GraphClient` checks do. |
| A new service | Its descriptor in `proto/descriptors.js` (a `fileDesc` blob from the bundle, see [05-gotchas.md](05-gotchas.md) Protocol, added to `files` and exported as `<Name>Service`), a small client class in a file of its own shaped like `history.js` (`constructor(transport) { this.client = createClient(Service, transport); }`), and, if the app should get it by default, four touches in `index.js`: require the class, construct it in `createTanaClient`, return the instance with the others, and export the class. | Add its request to the proto round-trips in `sdk-check.js` (sync and graph are there), a fake-transport check of the class, and an assertion that `createTanaClient` returns the new member (nothing checks that surface yet). |
| A new sync command or stream frame | A method on `sync.js` `SyncConnection` calling `this._command({ case, value })`, or `_lightCommand` for presence-sized ones, which queue behind at most four in flight; an inbound stream frame is a case in `SyncConnection._onFrame`, where every frame after the handshake is dispatched (the first frame, `peer`, is read in `_run`). Its wire shape goes in [../PLATFORM-PROTOCOL.md](../PLATFORM-PROTOCOL.md). A member the loaded sync descriptor does not have yet needs that descriptor re-extracted first (`proto/descriptors.js`, as for a new service). | A round-trip of the new member in the proto section of `sdk-check.js`, and the fake `SyncService` lifecycle there, whose stream must send the new frame and see it handled (ephemeral channels: `presence-check.js`). |
| A new document kind that Orbital creates | A `kind` branch in `node.js` `initDocument`, seeding exactly the keys Tana's own client writes (read them from a real document with `platform-cli.js rawdoc`). In `access.js`, a kind the access checks should handle at all goes in `KINDS` (enough for sharing and move); deleting it also needs `DELETABLE`, archiving `ARCHIVABLE`, a public link `LINK_SHAREABLE`. A kind whose title or outline may be edited needs a branch in `node.js` `editable()`, which answers false for any kind it does not name. The app side is `KINDS` in main/state.js, `PLAIN_KINDS` there too for a `tana:<kind>:` of its own (its rows keep their kind icon and tag, main/rows.js), and `creationOptions()` in main/documents.js for the kind to appear in the creation chooser. To be listed and found after it is made, it also needs a `KIND_NODE_TYPE` entry in `query.js` (views and saved searches) and its node type in `searchParams`' default `nodeTypes` (text search). The app has more per-kind lists than this; search for an existing sibling kind (`'canvas'`) across main/ and renderer/ to find the rest. | `sdk-check.js` asserts the seeded data map key by key, as it does for the task, meeting, chat, search and type kinds; its "creation chooser" check covers `creationOptions()`, and its saved-search round-trip runs over every `KIND_NODE_TYPE` kind. |
| Reading or writing a document's data map | A pure function of `(document, …)` in the module that owns that kind: tasks and titles in `node.js`, meetings in `events.js`, calls in `calls.js`, pins in `pins.js`, the inbox in `inbox.js`. Each write is one `document.transact`. | `sdk-check.js` on a local `Document`, with no server needed. |
| A field type or field rule | `fields.js`: `FIELD_TYPES` and `addField` for the definition, `setFieldText` for the value checks, both using Tana's wording. A new type is also a choice in the app: `FIELD_KINDS` in renderer/fields.js, and the per-type branches in renderer/render.js, views.js and pills.js (search for `'options'`). | `sdk-check.js` field sections; the app side in `scripts/renderer-behavior-check.js`. |
| An outline operation | `content.js`, one `document.transact` per user action so that it is one undo step. Copy and delete containers rather than moving them (Loro cannot move them). A field value is an outline too (`fields.fieldView`), so the op works there for free. | `sdk-check.js`: two `Document`s wired `local-update → applyRemote` must converge, and one `undo()` must revert the whole action. |
| A live-query key | `LISTS`/`SCALARS` (or `SIDE_*`) in `livequery.js`. Unknown keys throw on purpose. | `livequery-check.js`. |
| A query or view filter key | `query.js`: `FILTER_KEYS`, `validViewFilter`, `viewParams`, both saved-search conversions, and `searchQueryParams`, which runs a stored query on its own path (a key missing there is silently ignored by saved searches). A key the user sets is also a pill in renderer/pills.js, and a key in `sameFilter()` and `clearFilter()` in renderer/nodes.js, so a change marks a saved search edited and Clear filters resets it. A key Tana's stored query cannot hold (as `completedWithin` and `audience`) lives in the saved search's `view` instead: `node.js` `setSearchView`, the `search:setFilter` handler in main.js and `searchCreate` in main/views.js write it, the `search:filter` handler in main.js reads it back for the pills, main/related.js `searchRows` applies it, and each names its keys. | `sdk-check.js` query sections: the `filterToSearchQuery`/`searchQueryToFilter` round-trip and the request `searchQueryParams` builds; the pill, the edited state and Clear filters in `renderer-behavior-check.js`; for a view-only key, a save and reopen of a saved search that keeps it. |

Sibling requires point one way: `index` wires `transport`, `graph`, `history`, `search`, `sync` and `document`; `graph`, `history` and `search` lean on `transport`'s `unary` and the descriptors; `sync` on `document` and the descriptors; `livequery` on `node` and the descriptors (`EDGE_TYPES`); `access`, `content`, `events` and `query` on `node`; `fields` on `content` and `dates`; `proposals` on `content`. The rest stand alone. A module that takes a `sync` or `graph` argument, rather than requiring one, stays usable with a fake. Keep it that way, so no cycle can form.
