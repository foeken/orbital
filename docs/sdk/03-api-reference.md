# SDK API reference

All modules are CommonJS. "Node" below means the plain graph JSON node; "Document" means `sdk/document.js`'s class. Errors are thrown (or rejected) as plain `Error`s; Connect failures are `ConnectError`s with a `code`.

## `sdk/index.js`

```js
createTanaClient({ baseUrl?, getAccessToken, orgId, peerId, storageId?, logger?, clientName? })
  → { transport, graph: GraphClient, sync: SyncConnection, close(): Promise }
```
Also re-exports `createTransport`, `GraphClient`, `SyncConnection`, `Document`, `derivePeerId`, everything in `node.js`, and `access` (`capabilities`, `setSharing`, `previewMove`, `moveToSpace`, `canWrite`, `canDelete`, `audienceOf`).

## `sdk/transport.js`

`createTransport({ baseUrl = 'https://home.tana.inc/platform', getAccessToken, clientName = 'tana-tasks', fetch = globalThis.fetch })` → Connect transport (`@connectrpc/connect-web`, binary protobuf). Sets `authorization`, `x-client-name`, `x-request-id`; on HTTP 401 calls `getAccessToken({ refresh: true })` once and resends (safe: bodies are byte arrays). Covers the stream too, since an unauthenticated stream fails before its first frame.

## `sdk/graph.js` — `class GraphClient(transport)`

| Method | Params (protobuf JSON, lowerCamelCase) | Returns |
|---|---|---|
| `listNodes(params)` | ListNodesRequest fields (see data model §3) | `{ nodes: Node[], totalCount? }` — `nodes` always an array |
| `listEdges({ fromNodeIds?, toNodeIds?, edgeTypes? })` | | `{ edges: [{ fromNodeId, toNodeId, type, properties }] }` |
| `getEdge({ fromNodeId, toNodeId, type })` | | `{ edge, fromNode, toNode }` |
| `getOwnerChain(nodeId)` | | `{ entries: [{ uri, restricted, accessible }], effectivelyRestricted }` nearest-first |
| `traverse(params)` | `{ startNodeId, maxDepth, edgeTypes, nodeTypes, direction, includeProposals, includeArchived }` | async iterator of `{ node, edge, depth }` |

Enums are passed by name (`'SORT_FIELD_UPDATE_TIME'`, `'LIST_NODES_MODE_WITH_COUNT'`). Timestamps are RFC 3339 strings.

## `sdk/sync.js` — `class SyncConnection extends EventEmitter`

Constructed by `createTanaClient`; `{ transport, orgId, peerId, storageId, logger }`.

| Member | Behaviour |
|---|---|
| `connect(): Promise<void>` | Opens `ServerSync`; resolves after the server's `peer` frame. Keeps reconnecting in the background (backoff 250 ms→5 s before the first success, 1 s→30 s after; watchdog = 3× heartbeat interval). Rejects and stays closed on PermissionDenied / Unauthenticated-before-first-frame. |
| `subscribe(id, init?): Promise<Document>` | Creates (or returns) the Document for `id` and bootstraps it (begin_document_sync → import server updates → apply_bootstrap_updates catch-up → bootstrap_complete). Resolves once live. `init(loro)` runs in a transact *before* bootstrap: for an unknown id this turns the server's MISSING into a create (the full snapshot is the catch-up). Without `init`, an unknown id rejects with `document not found` after ~60 s / 5 attempts. Idempotent per id. |
| `getDocument(id)` | Document or undefined. A handle can exist before bootstrap is ready; await `subscribe` before reading it. |
| `unsubscribe(id): Promise` | Sends `unsubscribeDocument` when live; detaches listeners. |
| `softDelete(id): Promise` | `documentAction.softDelete`; the doc disappears from graph queries. Needs the stream open. |
| `close(): Promise` | Unsubscribes everything, aborts the stream, stops reconnecting. |
| `connected`, `docs` | State; `docs` maps id → session entry (`state`: new / bootstrapping / retrying / live / resyncing / disconnected / closed). |

Events: `connected` `({ heartbeatIntervalMs })`, `disconnected`, `heartbeat`, `change` `(docId, { origin: 'local' | 'remote' })`, `ephemeral` `(docId, bytes)`, `error` `(err)` (only emitted if a listener exists; always logged).

Outbound: local ops are batched 5 ms, one in-flight `liveDocumentUpdate` per document, 256 KiB budget (overflow → re-bootstrap). Inbound frames for a stale `sessionId` are dropped. `resync_required` re-bootstraps; `DISCARD_LOCAL` resets the Document first. After a reconnect every document is re-bootstrapped with the same Document object.

`derivePeerId(userExternalId)` → decimal u64 string: `(sha256(lowercased id)[0..8] >> 16) << 16 | random16`. New nonce per process; keep `storageId` (a UUID you persist) for a non-ephemeral peer.

## `sdk/access.js`

These helpers are the app's verified native capability boundary. Ownership is an audience/location boundary, never a write grant; unknown ACLs fail closed.

| Function | Behaviour |
|---|---|
| `canWrite(node, userUri, ctx)` | Accepts a direct `admin`/`editor`/`attendee` participant, or recursively checks an unrestricted owner chain and the organisation membership document. Restricted or unknown access is not guessed. |
| `audienceOf(node, userUri, ctx)` | Returns a snapshot such as `only-me`, `people`, `space`, `everyone`, or `unknown`, including the boundary and sorted participants where known. |
| `capabilities(document, userUri, ctx)` | Returns `sharing`, `move`, `deletable`, available `rules`/`roles`, current and inherited audience snapshots, and a `sharingToken` derived from the observed ACL/audience state. |
| `setSharing(document, userUri, selection, ctx)` | Supports `me`, `people`, and verified `inherit`. Inherit requires the current `sharingToken`; the helper checks that observed documents stayed stable before transacting. |
| `previewMove(document, targetSpace, userUri, ctx)` | Checks source/target write access, space validity, cycles, type home/count constraints, audience before/after and observation stability. Returns `{ allowed, reason, audienceChanged, requiresConfirmation, token }`. |
| `moveToSpace(document, targetSpace, userUri, ctx, confirmation)` | Re-runs the preview and requires its exact token when confirmation is required (or when a confirmation was supplied). |
| `canDelete(document, userUri, ctx, restoring?)` | Checks supported, non-deleted kind, write access and calendar-event organizer rules. Restore checks a copy with `deletedAt` removed and never mutates the document. |

`main.js` calls these helpers for access mutations and for native document actions. The renderer's `editable` flag is only a companion UI capability and does not replace server authorization.

## `sdk/document.js` — `class Document extends EventEmitter`

| Member | Behaviour |
|---|---|
| `new Document(id, { peerId })` | LoroDoc with `setPeerId`, `setRecordTimestamp(true)`, `setChangeMergeInterval(60)`, and an `UndoManager({ mergeInterval: 0, maxUndoSteps: 200 })`. |
| `id`, `loro`, `data`, `content` | The LoroDoc and its two root maps. |
| `transact(fn)` | `fn(loro)`; commit; export ops since the last export; emit `local-update` (bytes) and `change` ({ origin: 'local' }). |
| `undo()` / `redo()` → bool, `canUndo()` / `canRedo()` | Local-only, CRDT-aware; the resulting ops flow out like any local change. |
| `applyRemote(updates: Uint8Array[])` → bool | Imports; emits `change` ({ origin: 'remote' }); true when ops are pending on missing deps. |
| `exportSince(vv?)` | Update since `vv`, or a full snapshot; marks everything exported. |
| `version()` | Encoded oplog version vector. |
| `reset()` | Fresh LoroDoc (DISCARD_LOCAL). |
| `toJSON()` | `{ data, content, … }` plain JSON. |

## `sdk/node.js`

| Function | Behaviour |
|---|---|
| `readNode(document)` → `{ id, ...data }` | The data map as JSON plus the id. |
| `setTitle(document, title)` | Sets `title`, deletes `titleAutoGenerated` (what the web client does). |
| `setState(document, stateType, byUri)` | `stateType` ∈ `STATE_TYPES`; sets `stateEnteredAt` (now) and `stateChangedBy`; deletes workflow keys. Throws on bad state or non-profile uri. |
| `contentText(document)` | Plain text of the content tree (blocks joined by \n, mentions as labels). |
| `taskMeta(document)` | `{ assignees, restricted, participants }` straight from the data map. |
| `audienceMetadata(document, userUri, graph, sync)` | `{ audience: 'only-me' | 'people' | 'space' | 'everyone' | 'unknown', audienceSpace?: { uri, title? } }`. Direct `restricted` first, then the nearest restricted owner-chain boundary (a space names itself, the org root means everyone), then `effectivelyRestricted === false`. Guest profiles count as people; groups, empty participant sets and inaccessible boundaries stay unknown. See docs/sdk/05-gotchas.md. |
| `ulid(now?)` | 26-char lowercase Crockford ULID. |
| `initDocument(loro, title, byUri, { kind = 'doc' | 'task' | 'meeting', now })` | Seeds a new document's data map like the web client (participants { byUri: admin }, restricted, sharedPinDates, attributes) plus the empty content skeleton; task adds the open state assigned to `byUri`; meeting makes an event (next half hour, 30 min, local timezone, origin 'tana'). Use inside `sync.subscribe(id, init)`. |
| `STATE_TYPES` | `['proposed', 'open', 'closed', 'not_now']`. |

The native title contract is a plain metadata string. `setTitle` cannot store mention nodes; profiles and unsupported kinds are read-only, and events currently remain read-only because the organizer/calendar write capability is outside the graph contract.

## `sdk/content.js` — outline over the content tree

Outline node: `{ id: blockId, text, kind: 'block', heading?: level, type?: 'image', image?: { uri, alt, width, height }, segments: [{ text } | { mention: { label, uri } }], hasChildren, children: OutlineNode[] }`.

| Function | Behaviour |
|---|---|
| `readOutline(document)` | Outline nodes (`[]` for an empty content map). |
| `setText(document, id, value)` | `value`: string or segments. Runs matched by position: text runs updated in place (keeps marks/concurrent edits), same-uri mentions kept, others replaced, trailing runs dropped. |
| `insertAfter(document, id | null, text)` → newId | Sibling after `id` (inside a listItem: a new listItem); `null` appends at the end of the doc; creates the doc skeleton if missing. |
| `insertChild(document, id, text)` → newId or null | First child (creates the nested bulletList/listItem; wraps a bare paragraph into a listItem). Null for headings/quotes/code. |
| `remove(document, id)` | Removes the node and its children; prunes emptied lists. |
| `indent(document, id)` / `outdent(document, id)` | Under the previous sibling / after the parent. No-ops at the edges; only paragraphs and listItems can be moved. |
| `move(document, id, 'up' | 'down')` | Swap with the neighbouring sibling (lists move as a whole). |

All operations run inside `document.transact`, so each is one undo step and one live update. Containers are copied and deleted (Loro cannot move containers); text runs keep their marks via `toDelta/applyDelta`.

## App mutation and history boundary

The SDK's `Document.undo()`/`redo()` only undo local CRDT transactions for that document. `main.js` adds a global stack across documents and routes renderer Cmd+Z, Cmd+Shift+Z and Cmd+Y through it. Native delete/restore is a separate `documentAction` command: the main process checks `access.canDelete`, requires a `documentActionResponse`, and records the action so undo of delete restores and undo of restore deletes. A failed action is not removed from history. Restore visibility and document state arrive through the server's live update.

## `sdk/query.js`

| Function | Behaviour |
|---|---|
| `parseQuery(query)` → `{ text, tags }` | Extracts `#word` tokens. |
| `searchParams(parsed, typesByLowerTitle, limit = 20)` → ListNodes params or null | Default nodeTypes `['text', 'event', 'user-profile']`, `textQuery`, TEXT_RANK sort; `#task` → text + all four states, `#meeting` → event, `#member` → user-profile, `#<Type>` → `entityTypes`; unknown type or empty query → null. |
| `needsTypes(parsed)` | True when a non-kind tag needs the type map. |
| `taskParams(filter, me, limit = 500)` | `{ states: string[] | null, assignee: 'me' | 'anyone' | 'unassigned' | uri }` → ListNodes params, UPDATE_TIME desc. |
| `libraryQueries(filter, me, limit = 100)` | One `{ kind, params }` per kind in `meetings | tasks | docs | chats | canvases | agents | skills` (+ optional `textQuery`); the caller filters `docs` to nodes without state. |
| `DEFAULT_TASK_FILTER`, `DEFAULT_LIBRARY_FILTER`, `LIBRARY_KINDS` | Constants. |

## `sdk/pins.js` (all `async (sync, userUri, …)`)

`listSidebar` → uris in tree order · `pinSidebar(docUri)` (dedup) · `unpinSidebar(docUri)` · `dates(docUri)` → `['YYYY-MM-DD']` · `pinDate(docUri, date)` (dedup, unmutes) · `unpinDate(docUri, date)`. They subscribe the profile, then the collection / pin-map it points to; throw if the profile has no `pinnedCollectionUri` / `pinMapUri` yet (the web client creates those lazily on first pin; we don't).

## `sdk/assets.js`

`fetchImage(uri, { getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch })` → `{ mime, bytes: Buffer }`; validates `tana:image:<ulid>`, follows the 302 manually carrying the `Cloud-CDN-Cookie`, retries once on 401. `IMAGE_URI` regex exported.

## `sdk/proto/descriptors.js`

`files.{sync, graph, search, history}` (protobuf-es file descriptors), `message(file, name)`, `SyncService`, `GraphService`, `SearchService`. Regenerate by extracting the `Mr(` base64 blobs from the current `shared-*.js` bundle (see gotchas).
