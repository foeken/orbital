# SDK API reference

All modules are CommonJS. "Node" below means the plain graph JSON node; "Document" means `sdk/document.js`'s class. Errors are thrown (or rejected) as plain `Error`s; Connect failures are `ConnectError`s with a `code`.

## `sdk/index.js`

```js
createTanaClient({ baseUrl?, getAccessToken, orgId, peerId, storageId?, logger?, clientName? })
  → { transport, graph: GraphClient, history: HistoryClient, search: SearchClient, sync: SyncConnection, close(): Promise }
```
Also exports the client's parts: `createTransport`, `GraphClient`, `HistoryClient`, `SearchClient`, `SyncConnection`, `Document` and `derivePeerId`. That is the whole index. Every helper is required from its own module — `sdk/node` (`readNode`, `setTitle`, …), `sdk/content`, `sdk/livequery`, `sdk/presence`, `sdk/access`, `sdk/calls` and the rest — which is what every caller does; a new helper goes in the module that owns it and is not added here.

## `sdk/transport.js`

`createTransport({ baseUrl = 'https://home.tana.inc/platform', getAccessToken, clientName = 'tana-tasks', fetch = globalThis.fetch })` → Connect transport (`@connectrpc/connect-web`, binary protobuf). Sets `authorization`, `x-client-name`, `x-request-id`; on HTTP 401 calls `getAccessToken({ refresh: true })` once and resends (safe: bodies are byte arrays). Covers the stream too, since an unauthenticated stream fails before its first frame.

`unary(client, service, name, params)` → protobuf JSON: one unary call on a Connect client of `service` (a descriptor from `sdk/proto/descriptors.js`), `params` as protobuf JSON, retried once after 250 ms on `fetch failed`. `GraphClient`, `HistoryClient` and `SearchClient` make every unary read through it.

## `sdk/graph.js` — `class GraphClient(transport)`

| Method | Params (protobuf JSON, lowerCamelCase) | Returns |
|---|---|---|
| `listNodes(params)` | ListNodesRequest fields (see data model §3) | `{ nodes: Node[], totalCount? }` — `nodes` always an array |
| `listEdges({ fromNodeIds?, toNodeIds?, edgeTypes? })` | | `{ edges: [{ fromNodeId, toNodeId, type, properties }] }` |
| `getEdge({ fromNodeId, toNodeId, type })` | | `{ edge, fromNode, toNode }` |
| `getOwnerChain(nodeId)` | | `{ entries: [{ uri, restricted, accessible }], effectivelyRestricted }` nearest-first |
| `listAttendeeSuggestions({ limit? })` | | `[{ email, displayName?, lastSeenAt, eventCount, nextMeetingAt, identityUri? }]` — people this user meets (int64s as numbers), mapped as Tana's own client maps them |
| `traverse(params)` | `{ startNodeId, maxDepth, edgeTypes, nodeTypes, direction, includeProposals, includeArchived }` | async iterator of `{ node, edge, depth }` |

Enums are passed by name (`'SORT_FIELD_UPDATE_TIME'`, `'LIST_NODES_MODE_WITH_COUNT'`). Timestamps are RFC 3339 strings.

## `sdk/history.js` — `class HistoryClient(transport)`

`listChanges({ uri, withinId?, limit? })` → `{ parent?, summaries: [{ id, level, title, description, authors, sources, startTime, endTime, expandable, changeType }] }`: the change summaries Tana's own Changes panel shows for a node, `summaries` always an array. `withinId` asks for the summaries inside an expandable one; nothing here writes.

## `sdk/search.js` — `class SearchClient(transport)`

`semanticSearch({ query, limit?, spaceUris?, entityTypeUris? })` → `[{ documentId, title, snippet, score, vectorDistance }]`, best first, always an array: `tana.search.v1alpha1.SearchService.SemanticSearch`, the one method of that service Tana's UI calls (`Search` is unused, `HybridSearch` serves its AI agent only; issue #20). Tana's search page runs it beside the `listNodes` text search from four characters on, fetches the ids the text search did not return by `nodeIds` under the same filters, and lists them as related results; `FailedPrecondition` means not enabled for the org. `main/views.js` `search` does the same.

## `sdk/livequery.js` — a query the server keeps answering

`openLiveQuery(sync, query, { label = 'orbital', onRows })` → handle, once the server has taken the query. It creates a throwaway `tana:liveQuery:<ulid>` document holding the query, subscribes it as ephemeral (as Tana's own client does), and the server writes the answer into `data.result.nodes` and rewrites it whenever the answer changes, as ordinary live updates on the stream already open. `onRows` is attached as a `rows` listener before anything is read: a warm server answers inside the bootstrap, so the initial answer is emitted before the handle resolves, and a listener added afterwards never hears it.

- `query`: lists `uris types ownerUris entityTypeUris stateTypes chatInvocationIntents stateChangedBy stateWorkflowUris stateWorkflowStateIds assignedTo createdBy recurrenceIds occurrenceKeys orderBy exactParticipantUris hasParticipantUris useFields` and scalars `stateEnteredAtMin/Max createdAtMin/Max eventStartTimeMin/Max eventEndTimeMin/Max unassigned limit includeProposals includeArchived archivedOnly modifiedByUserHash uniqueByParticipants restricted linkShared`. Times are epoch ms; `orderBy` entries are field names, `-createdAt` for descending. Any other key throws before anything is subscribed. `externalIds` and `attributeFilters` are always written empty.
- `handle.state()` → `{ status: 'pending' | 'ready' | 'stale' | 'error', nodes, error }`: pending while `resultForVersion` is 0, stale while it trails `queryVersion` (Tana's rule). `statusOf(data)` is that rule on the query document's data as plain JSON (`statusOf(doc.data.toJSON())`; a `LoroMap` always reads as pending).
- `handle.on('rows', { added, removed, changed, initial })`: every time the answer moves; `initial` marks the first answer, `removed` is uris, `changed` means a row's title, state, state entry time, type, assignees, archive, `updatedAt` or owner changed (`updatedAt` and the owner because a query used as a trigger cannot say everything its list filters on).
- `handle.on('error', e)`: the server refused the query (emitted only when something listens).
- `handle.close()`: unsubscribes. `handle.id` is the query document's uri.

A row: `{ uri, type, title, entityType, createdAt, updatedAt, ownerUri, state: { type, enteredAt, changedBy }, assignedTo, participants, calendarEvent, archivedAt, … }`. Verified live 2026-09-22 (`platform-cli livequery`): a task created elsewhere arrived as an `added` row within seconds, and left as `removed` when deleted.

`LISTS`, `SCALARS` (a node query's keys) and `SIDE_LISTS`, `SIDE_SCALARS` (an edge query side's) are the accepted keys above; `sdk/query.js` `liveTrigger` cuts a ListNodes request down to them.

`openEdgeQuery(sync, query, { label = 'orbital', onRows })` → the same handle over edges (Tana's EdgeQueryResource): `queryType: 'edges'`, answer in `data.result.edges`.

- `query`: `{ subject?, predicate?: { edgeTypes: [number] }, object? }`. A side (where the edge starts, where it ends) takes the lists `uris types ownerUris entityTypeUris stateTypes stateChangedBy stateWorkflowUris stateWorkflowStateIds assignedTo` and the scalars `stateEnteredAtMin/Max`; an absent side is left out. Edge types are numbers: `EDGE_TYPES.LINKS_TO` (1), `ATTRIBUTE_LINKS_TO` (4), `HAS_PIN` (14), …, read from the graph descriptor's `EdgeType` enum (`files.graph.enums`), so a re-extracted descriptor brings new types along; an enum is never copied by hand. Any other key throws, and so does a query whose every list is empty (Tana answers that one itself, without the server).
- `handle.state()` → `{ status, edges, error }`. An edge: `{ fromNode, toNode, type: 'EDGE_TYPE_LINKS_TO', properties? }`; `properties` is `{ label }` for a mention, `{ attributeUri, label }` for a field reference, `{ messageId }` for a mention in a chat.
- `rows` events as above, keyed by the edge's ends, type and field: `removed` carries the edges themselves, `changed` an edge whose properties moved.

Tana's uses: `{ object: { uris: [page] } }` (the page's Backlinks section), `+ predicate [LINKS_TO, ATTRIBUTE_LINKS_TO]` ("Mentioned in"), `{ subject: { uris: events }, predicate: [HAS_PIN] }` (a meeting's pins), `{ object: { uris: [doc] }, predicate: [COMMENTS_ON] }` (comments). Verified live 2026-09-23 (`platform-cli livequery --to <id>` and scratch documents): a mention written into another document and a pin on a meeting each arrived within a fraction of a second, and left the same way.

## `sdk/sync.js` — `class SyncConnection extends EventEmitter`

Constructed by `createTanaClient`; `{ transport, orgId, peerId, storageId, logger }`.

| Member | Behaviour |
|---|---|
| `connect(): Promise<void>` | Opens `ServerSync`; resolves after the server's `peer` frame. Keeps reconnecting in the background (backoff 250 ms→5 s before the first success, 1 s→30 s after; watchdog = 3× heartbeat interval). Rejects and stays closed on PermissionDenied / Unauthenticated-before-first-frame. |
| `subscribe(id, init?): Promise<Document>` | Creates (or returns) the Document for `id` and bootstraps it (begin_document_sync → import server updates → apply_bootstrap_updates catch-up → bootstrap_complete). Resolves once live. `init(loro)` runs in a transact *before* bootstrap: for an unknown id this turns the server's MISSING into a create (the full snapshot is the catch-up). Without `init`, an unknown id rejects with `document not found` after ~60 s / 5 attempts. Idempotent per id. |
| `getDocument(id)` | Document or undefined. A handle can exist before bootstrap is ready; await `subscribe` before reading it. |
| `unsubscribe(id): Promise` | Flushes and waits for in-flight sends, sends `unsubscribeDocument` when live, detaches listeners. Released mid-bootstrap with local edits queued, it first lets that bootstrap finish (Tana's drain mode). |
| `softDelete(id): Promise` | `documentAction.softDelete`; the doc disappears from graph queries. Needs the stream open. |
| `restore(id): Promise` | `documentAction.restore`, the inverse of `softDelete`. Needs the stream open. |
| `archive(id)`, `unarchive(id): Promise` | `documentAction.archive` / `unarchive` (DocumentAction fields 4 and 5). The server writes `data.archivedAt` (epoch ms; 0 after unarchive) and `data.archivedBy` (the caller's profile) into the document, and the graph leaves an archived node out of every `listNodes` answer, `nodeIds` lookups included, unless the request sets `includeArchived`. Tana's client sends this for a document it does not have loaded; for a loaded one it writes the same keys itself (`setArchived`). Tana offers it for types only. Verified live 2026-09-23 on a scratch type. |
| `subscribeEphemeralChannel(channelId)`, `unsubscribeEphemeralChannel(channelId)`, `sendEphemeral(documentId, bytes)`, `viewingHeartbeat(documentId)` | Presence plumbing: channels are counted per id (two holders, one subscription) and resent after every reconnect; sends are best effort, resolve to whether they went and send nothing while disconnected. Incoming frames are the `ephemeral` event. Use `sdk/presence.js` rather than these directly. |
| `close(): Promise` | Unsubscribes everything, aborts the stream, stops reconnecting. |
| `connected`, `docs` | State; `docs` maps id → session entry (`state`: new / bootstrapping / retrying / live / resyncing / disconnected / paused / write-denied / closed). |

Events: `connected` `({ heartbeatIntervalMs })`, `disconnected`, `heartbeat`, `change` `(docId, { origin: 'local' | 'remote' })`, `ephemeral` `(docId, bytes)`, `write-denied` `(docId)` (Tana refused our edits but the document is still readable; `document.writeDenied` is set), `error` `(err)` (only emitted if a listener exists; always logged).

Outbound: local ops are batched 5 ms, one in-flight `liveDocumentUpdate` per document, 256 KiB budget (overflow → re-bootstrap). Inbound frames for a stale `sessionId` are dropped. `resync_required` re-bootstraps; `DISCARD_LOCAL` resets the Document first. After a reconnect every document is re-bootstrapped with the same Document object. Per-document resync backoff is 500 ms→5 s, fixed at 30 s after six consecutive resyncs, and the counter is reset by 15 s of healthy live (checked when the next resync starts, so a document nobody edits is counted too).

`derivePeerId(userExternalId)` → decimal u64 string: `(sha256(lowercased id)[0..8] >> 16) << 16 | nonce`, where the nonce is 15 random bits (only the top 48 bits matter: the server records them as `peerUserHash`). New nonce per process; keep `storageId` (a UUID you persist) for a non-ephemeral peer.

## `sdk/presence.js` — who is in a document, and where

`openPresence(sync, documentId, { timeout = TIMEOUT_MS, viewing = false })` → handle, once the document's presence channel is subscribed (`TIMEOUT_MS` 30000, how long an unrefreshed entry lives; `HEARTBEAT_MS` 10000, the viewing heartbeat). Tana's editor shares carets over an ephemeral channel named by the document uri: every peer keeps one entry in a Loro `EphemeralStore` keyed by its peer id, and changes travel as that store's own update bytes. Nothing is stored anywhere.

- `handle.peers({ exceptUserHash }?)` → `[{ peer, userHash, user: { name, color } | null, scope, hasCursor, anchorBlock, focusBlock, anchor, focus }]` for everyone in the document except this connection. `anchorBlock`/`focusBlock` are `{ blockId, offset }` or null; `anchor`/`focus` are Loro `Cursor` bytes (`Cursor.decode` + `doc.getCursorPos`) or null. `exceptUserHash` also leaves out your own other tabs and devices.
- `handle.editing(opts?)` → the peers with a caret in the document, i.e. someone is editing it right now.
- `handle.on('change', { added, updated, removed, by })`: peer ids; `by` is `import` (a peer sent something, leaving included) or `timeout` (an entry nobody refreshed expired).
- `handle.setLocal({ user, anchorBlock, focusBlock = anchorBlock, anchor, focus = anchor, scope })`: be seen, in Tana's entry shape (`anchor`/`focus` are Loro cursor bytes, `content.cursorAt(...).encode()`, which Tana draws an exact caret from), refreshed at half the timeout so it does not expire; `handle.clearLocal()` takes it away. Re-sent after a reconnect.
- `{ viewing: true }`: also sends the viewing heartbeat every 10 s (and after a reconnect), as Tana does for the document on screen.
- `handle.close()`: clears our entry, unsubscribes, forgets everyone.
- `userHashOf(peerId)`: the user part of a peer id (its top bits, `sync.derivePeerId`), so an entry says which user it is without a lookup; two tabs of one person share it.
- `readEntry(peerId, state)`: one raw `EphemeralStore` entry in the shape `peers()` returns.

Verified live 2026-09-22 (`platform-cli presence`, two sessions on a scratch document): the watcher saw the other session arrive with its label and caret block, and leave when it closed.

## `sdk/access.js`

These helpers are the app's verified native capability boundary. Ownership is an audience/location boundary, never a write grant; unknown ACLs fail closed.

| Function | Behaviour |
|---|---|
| `canWrite(node, userUri, ctx)` | Accepts a direct `admin`/`editor`/`attendee` participant, or recursively checks an unrestricted owner chain and the organisation membership document. Restricted or unknown access is not guessed. |
| `audienceOf(node, userUri, ctx)` | Returns a snapshot such as `only-me`, `people`, `space`, `everyone`, or `unknown`, including the boundary and sorted participants where known. |
| `capabilities(document, userUri, ctx)` | Returns `sharing`, `linkSharing` (writable `text`/`artifact` with org policy enabled), `move`, `deletable`, `archivable` (a type with write access: Tana archives types instead of deleting them), available `rules`/`roles`, current and inherited audience snapshots, and a `sharingToken` derived from the observed ACL/audience state. |
| `setSharing(document, userUri, selection, ctx)` | Supports `me`, `people`, and verified `inherit`. Inherit requires the current `sharingToken`; the helper checks that observed documents stayed stable before transacting. |
| `setLinkSharing(document, userUri, enabled, ctx)` | Sets or removes the root `linkSharing.mode: 'view'` on writable text/artifact documents when the org's `featurePolicy.linkSharing` is not `false`. Enabling also sets `data.hasBeenPublic`; disabling preserves it. |
| `previewMove(document, targetSpace, userUri, ctx)` | Checks source/target write access, space validity, cycles, type home/count constraints, audience before/after and observation stability. Returns `{ allowed, reason, audienceChanged, requiresConfirmation, token }`. |
| `moveToSpace(document, targetSpace, userUri, ctx, confirmation)` | Re-runs the preview and requires its exact token when confirmation is required (or when a confirmation was supplied). |
| `canDelete(document, userUri, ctx, restoring?)` | Checks supported, non-deleted kind, write access and calendar-event organizer rules. Restore checks a copy with `deletedAt` removed and never mutates the document. |
| `canArchive(document, userUri, ctx)` | A type (Tana's archive set is `['type']`) with write access. The same check answers archive and unarchive. |
| `canEditEvent(document, userUri, ctx)` | Whether a meeting's time, place or people may be changed: Tana's own gate (`Dk`), unrestricted or the user is an organizer (`admin`/`editor`), on top of `canWrite`; and, as Tana's `updateEvent` refuses, not a synced event whose calendar copy is not the organizer's (`externalId` with `origin` other than `'tana'` and no `ownerIsOrganizer`). |
| `everyoneOnly(graph, nodes)` | The graph nodes everyone in the org can see (#253): not restricted themselves and nothing restricted above them but the org root. One owner chain per distinct owner; an unowned (Library) node counts as open. The view filter's `audience: 'everyone'`. |
| `LIBRARY` | `{ id: null, title: 'Library' }`: the move target for "no owner". |

`main/documents.js` calls these helpers from its access IPC handlers (sharing, move) and for native document actions. The renderer's `editable` flag is only a companion UI capability and does not replace server authorization.

## `sdk/document.js` — `class Document extends EventEmitter`

| Member | Behaviour |
|---|---|
| `new Document(id, { peerId })` | LoroDoc with `setPeerId`, `setRecordTimestamp(true)`, `setChangeMergeInterval(60)`, and an `UndoManager({ mergeInterval: 0, maxUndoSteps: 200 })`. |
| `id`, `loro`, `data`, `content` | The LoroDoc and its two root maps. |
| `transact(fn)` | `fn(loro)`; commit; export ops since the last export; emit `local-update` (bytes) and `change` ({ origin: 'local' }). |
| `undo()` / `redo()` → bool, `canUndo()` / `canRedo()` | Local-only, CRDT-aware; the resulting ops flow out like any local change. |
| `applyRemote(updates: Uint8Array[])` → bool | Imports; emits `change` ({ origin: 'remote' }); true when ops are pending on missing deps. |
| `exportSince(vv?)` | Update since `vv`, or a full snapshot; marks everything exported. |
| `reset()` | Fresh LoroDoc (DISCARD_LOCAL). |
| `toJSON()` | `{ data, content, … }` plain JSON. |

## `sdk/node.js`

| Function | Behaviour |
|---|---|
| `readNode(document)` → `{ id, ...data }` | The data map as JSON plus the id. |
| `setTitle(document, title)` | Sets `title`, deletes `titleAutoGenerated` (what the web client does). |
| `setState(document, state, byUri)` | Tana's `transitionTo`. `state` ∈ `STATE_TYPES` deletes the workflow keys; `{ workflowUri, workflowStateId }` (a column of the type's board) writes `stateType: 'open'` plus `stateWorkflowUri`/`stateWorkflowStateId`, so clearing a column is setting a plain state. Always sets `stateEnteredAt` (now) and `stateChangedBy`. Throws on bad state or non-profile uri; whether the state id is in the task's workflow is the caller's (`platform-cli set-state` checks it). |
| `workflowStates(workflowDocument)` | A `tana:workflow:` document's states in board order, `[{ id, name }]`, deduped by id as Tana does. A task's workflow is its own `stateWorkflowUri`, else its type's `workflowUri`. |
| `setArchived(document, archived, byUri, now?)` | Tana's `archive(actor)`/`unarchive(actor)` on a loaded document: `archivedAt` = now or 0 (archived means `archivedAt > 0`; the key is never removed) and `archivedBy` = `byUri`. Throws on a non-profile uri. The app uses `sync.archive`/`unarchive` instead. |
| `contentText(document)` | Plain text of the content tree (blocks joined by \n, mentions as labels). |
| `taskMeta(document)` | `{ assignees, restricted, participants }` straight from the data map. |
| `setAssignees(document, uris, byUri)` | Rewrites `assignedToUris` (deduped; `[]` = unassigned) plus `assignedToUrisChangedAt/By`. Throws unless every uri is a `tana:user-profile:` and the document has a task state; a no-op change writes nothing. |
| `setEntityType(document, typeUri \| null, { workflow, byUri })` | Tana's `retype`: sets or deletes `entityTypeUri` and always deletes `stateWorkflowUri`/`stateWorkflowStateId` (a workflow state belongs to the type that is leaving). Only `tana:text:`/`tana:event:` documents carry a type; a no-op change writes nothing. `workflow: true` (the type defines one) starts an untyped-and-stateless document at `proposed`, as Tana does. Which types are allowed is the caller's (main/documents.js `typeChoices`/`setType`). |
| `editable(node, userUri)` | Companion UI capability for a plain node (not a Document): `true` for an admin/editor on text/space, `false` for viewers, profiles, events and unsupported kinds, `null` when the ACL is unknown. Never a substitute for server authorization. |
| `audienceMetadata(document, userUri, graph, sync)` | `{ audience: 'only-me' | 'people' | 'space' | 'everyone' | 'unknown', audienceSpace?: { uri, title? } }`. Direct `restricted` first, then the nearest restricted owner-chain boundary (a space names itself, the org root means everyone), then `effectivelyRestricted === false`. Guest profiles count as people; groups, empty participant sets and inaccessible boundaries stay unknown. See docs/sdk/05-gotchas.md. |
| `audience(...)` | `audienceMetadata(...).audience`, the label on its own. |
| `ulid(now?)` | 26-char lowercase Crockford ULID. |
| `initDocument(loro, title, byUri, { kind, now, entityTypeUri, ownerUri, query })` | Seeds a new document's data map like the web client (participants { byUri: admin }, restricted, sharedPinDates, attributes) plus the empty content skeleton. `kind`: `doc` (default), `task` (open state assigned to `byUri`), `meeting` (a `tana:event:` laid out like a Tana-created event: next half hour, 30 min, local timezone, origin 'tana', no content), `chat` (native `participantUris`/`messages`, no outline), `search` (a `tana:search:` document: `data{type,createdAt,title,restricted,participants}`, the `query` option written into its query root there and then — an empty query map reads as an unreadable search — and an empty `view` root, with no sharedPinDates and no content), `type` (a `tana:type:` document: `data{type,title,sharedPinDates,template}` and an empty content map only — a real type carries no createdAt, restricted or participants, and one with no `ownerUri` is a Library type that fits a document in any space; give it its fields with `fields.addField`). `entityTypeUri` sets the document's type (not on a chat), `ownerUri` its home space; both are validated. Use inside `sync.subscribe(id, init)`. |
| `setSearchQuery(document, query)` | Rewrites a saved search's `query` root container. Every key is assigned rather than patched — lists replaced whole, flags set or deleted — so a filter dropped from a save cannot linger. Objects and arrays under `workflowStates` and `attributes` are written as Loro maps and lists, the shape Tana's schema declares, so a Tana-authored search keeps it; `toJSON()` reads them back unchanged. Throws unless the document's `type` is `search`. |
| `setSearchView(document, view)` | The same for the `view` root beside it: `sortBy`, `groupBy`, `sortBy` in Tana's form (`field` ascending, `-field` descending; Orbital's newest-first Updated/Created are written `-updated`/`-created` and read back with `searchSort`), `display` (Tana's record `{ key: { shown, order } }`, read back with `searchDisplay`), `completedWithin`, which a stored query cannot hold, and `audience`, whose exact meaning (`access.everyoneOnly`) it cannot hold either: the query keeps the coarse `visibility: 'open'` prefilter, and the view keeps the exact setting. It says how the rows are arranged, not which rows the search finds. |
| `readSearch(document)` | `{ query, view }`: both roots as JSON (`view` `{}` when absent), what the two writers above stored. They are root containers of their own, so `readNode` never sees them; an empty `query` means the search is unreadable, not unconstrained. |
| `searchSort(sortBy)` / `searchDisplay(display)` | Read `setSearchView`'s values back: the sort key without its minus, and the shown display keys in order: undefined when no display is stored, `[]` for an empty legacy comma-joined string. |
| `STATE_TYPES` | `['proposed', 'open', 'closed', 'not_now']`. |
| `COMPLETED_WINDOWS` | `[3, 7, 30, 'all']`: how many days a completed task stays listed (`completedWithin`). |

The native title contract is a plain metadata string. `setTitle` cannot store mention nodes; profiles and unsupported kinds are read-only, and events currently remain read-only because the organizer/calendar write capability is outside the graph contract.

## `sdk/content.js` — outline over the content tree

Outline node: `{ id: blockId, text, kind: 'block', block?: type, heading?: level, editable?: false, type?: 'image' | 'table', image?: { uri, alt, width, height }, table?: (readTable), segments: [{ text, marks? } | { mention: { label, uri } }], hasChildren, children: OutlineNode[] }`.

`block` is the node's block type: `paragraph | heading1 | heading2 | heading3 | bullet | numbered | code | quote | divider` (absent on image and embed nodes, which carry `type` instead). `heading` still carries the level for headings. A divider is a childless `horizontalRule`, so it reads as `editable: false` with empty text.

`marks` on a text segment is `{ bold?: true, italic?: true, strike?: true, code?: true, link?: href }`. Marks live in the LoroText delta and never appear in `toJSON()`, so one text container holds several segments when its delta is split by marks. Tana stores a plain mark as `{}` and a link as its ProseMirror attrs (`{ href, title, target }`); a segment carries the href alone, and an unchanged href leaves `title`/`target` untouched. Loro needs mark styles configured before writing (`configTextStyle`): Tana derives them from its schema, where no mark declares `inclusive`, so every mark is `expand: 'none'`.

| Function | Behaviour |
|---|---|
| `readOutline(document)` | Outline nodes (`[]` for an empty content map). |
| `readTable(document, tableId)` | A table block as `{ id, rows: [[{ id, header, colspan, rowspan, colwidth, paragraph, segments, text, blocks }]], rowCount, columnCount }`: rows × cells in stored order (Tana's `readTable` counts the same way, a spanned cell is one entry), `header` for a `tableHeader`, `colwidth` null unless a column was resized, `segments`/`text` from the cell's first paragraph (`paragraph` is its id) and `blocks` every block in the cell as outline nodes. `readOutline` carries the same object as `table` on the table's row. Throws for an id that is not a table. |
| `setCellText(document, cellId, value)` | One cell's text, the way Tana's `updateCell` writes it: into the cell's first paragraph (made at the front, with a blockId, when there is none), leaving the cell's other blocks alone. `value` as for `setText`. Takes a cell id (`tableHeader`/`tableCell` blockId), never the paragraph's; the table itself stays refused by `setText`/`setBlockType`. `assignBlockIds` also names rows, cells and their blocks that arrive without an id, as Tana's editor does when it opens the document. |
| `tableOp(document, cellId, op)` → cell id | A row or column around a cell, as Tana's `manipulateTable` writes it: `rowBefore`, `rowAfter`, `deleteRow`, `columnBefore`, `columnAfter`, `deleteColumn`, `rowUp`, `rowDown`, `columnLeft`, `columnRight` (`TABLE_OPS`). New cells are `tableCell`s (`tableHeader`s in a header row) with an id and an empty paragraph; moved rows and columns keep their ids. Refuses what Tana's table menu does not offer: a row above the header row, deleting or moving the header row, the last body row, the last column, moving past an edge. Returns the cell for the caret. `insertImage(document, cellId, uri)` with a cell id appends the image to that cell. |
| `setText(document, id, value)` | `value`: a string or segments. A **string** replaces the words and leaves the existing annotations alone; **segments** state the marks exactly. Consecutive text segments share one LoroText, the way Tana stores them, and every mention is its own map. Containers are matched by position: a text container is updated in place (a diffing update keeps concurrent edits and the marks of untouched characters, then only the spans whose annotation differs are marked or unmarked), a same-uri mention is kept, anything else is replaced, trailing containers are dropped. Inside a `codeBlock` marks and mentions flatten to text, because its schema content is `text*` with `marks: ''`. |
| `setBlockType(document, id, type)` | `paragraph`, `heading1-3`, `bullet`, `numbered`, `code`, `quote`. A type is a container plus a leaf node name, and the types stay mutually exclusive the way Tana's style menu presents them: bullet/numbered live in a `listItem`, quote in a `blockquote`, the rest are bare blocks. The blockId and the inline content survive. Between the two list kinds the whole `listItem` moves, so its children and its checkbox stay with it; a conversion to heading, quote or code outdents the node's children instead of losing them, because those blocks cannot own children. Splitting a list or quote around the node keeps outline order. Rejects an unknown type and the atoms (divider, image, embed). |
| `insertDivider(document, id \| null)` → newId | Inserts Tana's `horizontalRule` after `id` (`null` appends at the end). A list holds `listItem`s only, so a rule between two items splits the list rather than landing inside it. |
| `insertImage(document, id \| null, tanaUri)` → newId | An `image` block (`blockId`, `tanaUri`, no children, no display size) where a new row after `id` would go: after a list row a `listItem` holding just the image (Tana's `listItem` is `block+`), after anything else a bare block; `null` appends. Rejects anything but a `tana:image:` uri. |
| `insertMention(document, { uri, label }, { parentId, afterId })` → newId | A document dropped into an outline cannot move there, so what lands is a reference to it: one block whose whole content is a mention. The place is named the way a drag names it (`afterId` the row it lands behind, `parentId` the row it lands inside, neither means the first row), and the row is written as a list row or as prose, whichever the destination keeps. |
| `insertAfter(document, id | null, text, before = false, asBlock = null)` → newId | Sibling after `id` (inside a listItem: a new listItem); `null` appends at the end of the doc; creates the doc skeleton if missing. A new row follows the row it comes from, so a document's own first row is plain text unless the caller says otherwise: `asBlock: 'bullet'` is how a row asked to hold sub-items opens onto a list row. |
| `insertChild(document, id, text)` → newId or null | First child (creates the nested bulletList/listItem; wraps a bare paragraph into a listItem). Null for headings/quotes/code. |
| `insertBefore(document, id, text)` → newId | Sibling before `id` (same level, same listItem rules as `insertAfter`). What Enter at the very start of a node does: the node keeps its text and children. |
| `split(document, id, before, after, asChild)` → newId | Enter inside a node: `setText(id, before)` plus the insert of `after` as the next sibling (or the first child when `asChild`) in **one** transaction, so one undo puts the node back whole. `before`/`after` are strings or segments; segments with mentions or marks are written back over the plain insert. |
| `join(document, id, intoId, value)` | Backspace at the start of a row, the reverse of `split`: `setText(intoId, value)` and `remove(id)` in one transaction. Refuses a row that has children. |
| `insertTable(document, id \| null)` → cell id | "/" Table as Tana's slash menu makes one: a header row and two body rows of three cells after `id`; returns the first header cell. |
| `remove(document, id)` | Removes the node and its children; prunes emptied lists. |
| `indent(document, id)` / `outdent(document, id)` | Under the previous sibling / after the parent. No-ops at the edges; only paragraphs and listItems can be moved. |
| `move(document, id, 'up' | 'down')` | Swap with the neighbouring sibling (lists move as a whole). |
| `moveMany(document, ids, 'up' | 'down')` | The same for a sibling range in visual order, in **one** transaction, so a multi-select is one undo step. It rejects duplicates, unknown ids and non-siblings before mutating. |
| `removeMany(document, ids)` | One transaction for the whole selection, whatever levels its rows sit on: deleting is not moving, so siblings are not required. Duplicates and unknown ids are still rejected, and a row inside another selected row needs no delete of its own — it goes with the row that holds it. |
| `moveTo(document, id, { parentId, afterId, from })` | A drag, which names the place outright: the row lands behind `afterId`, inside `parentId` when there is nothing to land behind, and at the first row of the outline when neither is given. It travels whole (children, checkbox, block ids), and `from` may be another outline of the same Loro document — a field value — so a row dragged between a page and one of its fields is one transaction. A move into itself, and a block that cannot become a list item, are refused before anything is written. |
| `indentMany(document, ids)` / `outdentMany(document, ids)` | The same for indent/outdent: one transaction, ids in visual order (indent runs first to last so each row follows the one above it, outdent last to first). The sibling checks run first; each id is then resolved inside the transaction because the previous row's move already changed the tree. |
| `toggleCheckbox(document, id)` | Paragraph or heading only. `checked` lives on the `listItem`, so a bare paragraph is wrapped first (keeping its blockId, marks and mentions); it never touches the document's own task state. |
| `assignBlockIds(document)` | Gives every block that arrived without a `blockId` one, in a single transaction and with no op at all for a document that has them all. Blocks Tana's own agent writes can have none, and a row with no id cannot be edited, split or linked. |
| `BLOCK_TYPES` | `['paragraph', 'heading1', 'heading2', 'heading3', 'bullet', 'numbered', 'code', 'quote']` — what `setBlockType` accepts. |
| `newId()` | A fresh 8-character block id (Crockford base32, Tana's alphabet). |
| `inlineGroups(value, plain?)`, `writeInline(list, groups, marked)`, `styleDoc(document)` | The two halves of `setText` and the mark-style setup before it, exported for `sdk/fields.js`, which writes a field value's paragraph the same way. Not for app code. |

All operations run inside `document.transact`, so each is one undo step and one live update. Containers are copied and deleted (Loro cannot move containers); text runs keep their marks via `toDelta/applyDelta`. A direction other than `'up'`/`'down'` throws rather than defaulting to down.

`cursorAt(document, blockId, offset)` → a Loro `Cursor` at that character offset in the block's text, counted as the outline shows it (a mention as its label, a line break as one): on the text run it falls in, or on the children list at a mention; past the end, after the last item; null for an unknown block. How presence shares an exact caret (`sdk/presence.js` `setLocal`). Offsets are Loro unicode positions, so astral characters before the caret shift it by one each.

`cursorOffset(document, cursorOrBytes)` → `{ blockId, offset }`: where a Loro cursor (or the bytes presence carries) is now, in the outline's character count. A cursor is anchored to a character, so this follows text typed since it was set, which a block offset does not; null when its container is not in this document yet.

`charOffset(document, blockId, position)` / `blockOffset(document, blockId, offset)`: convert a caret between Tana's ProseMirror position from the start of the block (presence `anchorBlock`/`focusBlock` offsets: a mention or a line break is one position) and the outline's character offset (a mention is its label). A caret inside a mention's label maps to just before it; null for an unknown block.

## `sdk/fields.js` — typed fields ("attributes")

A field value is a ProseMirror-style tree in the document's own `data.attributes` map under the key `"<type uri>?attribute=<key>"`: `{ nodeName: 'doc', attributes: {}, children: [{ nodeName: 'paragraph', attributes: { blockId }, children: [text] }] }`. The field's name lives in the *type* document's `data.template.attributes` (a MovableList of maps `{ key, title, type?, cardinality?, to?, options? }`, where `to` is a List of `{ uri, title? }` target types and `options` a List of `{ label }` choices; verified live on a scratch type). The graph node's `typeDef` carries the same list, including `to` but without `options`, and is not always readable, so read the type document.

A link, member or date value is one paragraph per reference, each holding a lone mention (a date's uri is `tana:plaindate:`). An options value is a `bulletList` with one label per item (Tana's `Nye`); an empty one is a single empty paragraph.

| Function | Behaviour |
|---|---|
| `readFields(document)` | `[{ key, typeUri, attribute, text, segments, lines }]` for every field the document carries; `lines` is the value as `[{ segments, block }]` in stored order, `text` joins those lines with newlines (mentions rendered as their label) and `segments` is the first line's. `[]` when there are none. |
| `definitions(typeDocument)` | The type's field definitions, `template.attributes` as JSON (`[{ key, title, type?, cardinality?, to?, options? }]`, `[]` without a template). Read the type document through this rather than its data map. |
| `templateTitles(typeDocument)` | `{ key: title }` for that type's fields (falls back to the key). |
| `fieldDefinition(typeDocument, attribute)` | One field's definition as JSON (`{ key, title, type?, cardinality?, to?, options? }`), or null. `attribute` is the template key, the part after `?attribute=`. |
| `setFieldText(document, key, text, { field, typeOf })` | Writes the field's value, creating the doc/paragraph shell when the field is empty. `text` is a string, one line's segments, or an array of lines — each a string, segments, or `{ segments, block }`. The runs are written by the same code a row's are, so a mention stays a mention. Words changing are patched into the blocks already there, which keeps a value's bullets, headings and block ids; a line changing shape writes the value again from the top. With `field` (from `fieldDefinition`), the value is first checked the way Tana checks it, and a failure throws with Tana's wording and writes nothing. **Options**: each non-empty line is a label, compared without regard to case; it must be declared and is written with the declared spelling as one bullet; more than one needs `cardinality: 'multiple'`; a field with no declared options takes nothing. **Link/member**: each line must be one reference and nothing else; more than one is refused only when `cardinality` is `'single'`, which is Tana's rule for links. **Link with `to`**: a reference whose type `typeOf(uri)` returns and that is not listed is refused; an unknown type passes. `typeOf` is synchronous, so the caller looks the types up first (`platform-cli setfield` does). **Date**: the link rules, and each reference must be a date uri. |
| `fieldView(document, key, { create = false })` | The field's value as a Document, so every operation in `content.js` works on it and the field editor is the page's editor rather than a second one. `create` decides what an absent value does: a write needs the shell to exist, a read must not write one. |
| `addField(typeDocument, { title, type, cardinality, options, to })` → key | Defines a field on a type: one more entry in its `template.attributes`, the MovableList of `{ key, title, type?, cardinality?, to?, options? }` maps a real type carries. Tana's schema allows `link | date | member | options`, and anything else throws; a plain text field has no type at all. `options` (strings or `{ label }`) belong only to an options field, which always gets the list, even when it is empty. Labels follow Tana's rules: trimmed, then non-empty, one line and at most 60 characters, or it throws `Invalid option label (empty | contains-separator | too-long)`; a label that repeats another in a different case is dropped. `to` (type uris or `{ uri, title? }`, where `title` is Tana's backlink title) belongs only to a link field and keeps one entry per type. |
| `setFieldOptions(typeDocument, attribute, labels)` → labels | Replaces an options field's choices, under the same label rules. This is Tana's `configureAsOptions`, which is what its add, rename, remove and reorder of an option come down to. Values already written keep their words, and one no longer declared shows as "No longer offered" in Tana. Throws on a field that is not an options field. |
| `setFieldTargets(typeDocument, attribute, targets)` → targets | Replaces a link field's target types (Tana's `configureAsLink` with targets); `[]` lets it link to anything again. Throws on a field that is not a link field. |
| `setFieldKind(typeDocument, attribute, { type, cardinality })` → definition | Changes what a field is (`type`; `null` makes it plain text) and how many values it holds. A kind keeps only what it uses: the choices go when it stops being an options field (which always gets its list), the targets when it stops being a link. Values already written are left alone. |
| `parseKey(key)` | The helper behind those. `valueLines` and `valueText` (a value's lines and its flat text) stay inside the module: `readFields` already hands out `lines` and `text`, and nothing outside it needs them raw. |
| `FIELD_ID` | The regexp for the id a field view answers to, `<document uri>\|<type uri>?attribute=<key>`; main/documents.js parses it, so the format is written once. |

## App mutation and history boundary

The SDK's `Document.undo()`/`redo()` only undo local CRDT transactions for that document. `main/documents.js` adds a global stack across documents and routes renderer Cmd+Z, Cmd+Shift+Z and Cmd+Y through it. Native delete/restore is a separate `documentAction` command: the main process checks `access.canDelete`, requires a `documentActionResponse`, and records the action so undo of delete restores and undo of restore deletes. A failed action is not removed from history. Restore visibility and document state arrive through the server's live update. Archive/unarchive go the same way, checked with `access.canArchive`; undo of one runs the other.

## `sdk/query.js`

| Function | Behaviour |
|---|---|
| `parseQuery(query)` → `{ text, tags }` | Extracts `#word` tokens. |
| `searchParams(parsed, typesByLowerTitle, limit = 20)` → ListNodes params or null | Default nodeTypes `['text', 'event', 'user-profile', 'space', 'search']`, `textQuery`, TEXT_RANK sort; `#task` → text + all four states, `#meeting` → event, `#member` → user-profile, `#space` → space, `#<Type>` → `entityTypes`; unknown type or empty query → null. |
| `needsTypes(parsed)` | True when a non-kind tag needs the type map. |
| `viewParams(filter, me, limit = 1000)` → ListNodes params | The one query behind every view (docs/VIEWS.md). A filter is `{ types, states, assignee, text, participant, window, completedWithin, fields, audience }`, all optional; `types` holds kinds and `tana:type:` uris, and null or empty means every listable kind (never an unconstrained query: `nodeTypes: []` is no filter to the graph). `states` and `assignee` are applied only while `tasks` is among the kinds, which is exactly when those pills are shown. Meetings alone sort by event start, everything else by update time; `participant: 'me'` and `window: 'recent'` are events the user is in, from 7 days ago to 7 days ahead. `fields` (`{ '<type>?attribute=<key>': { textMatches \| refs \| date \| numberRanges } }`) becomes `attributeFilters`, and only while `types` is one workspace type alone. `audience: 'everyone'` asks `restricted: false`, which the caller narrows with `access.everyoneOnly`. `completedWithin` (`COMPLETED_WINDOWS`: 3, 7, 30 or `'all'`) is asked for nowhere — the request has no field for the age of a state — so it is applied to the answer instead, by `completedInWindow`. Throws on an invalid filter. |
| `completedInWindow(node, within, now?)` / `completedWindow(within)` | Whether a graph node survives `completedWithin`: anything that is not a closed task does; a closed one only when its `state.enteredAt` is within that many days. `completedWindow` normalises the value (unset or stale → 7). |
| `validViewFilter(f)` | Shape check for a stored filter: known keys only, kinds from `VIEW_KINDS`, states from `STATE_TYPES`, assignee one of `me | anyone | unassigned | <user-profile uri>`. |
| `filterToSearchQuery(filter, me)` / `searchQueryToFilter(query, me)` | A view filter as a saved search's stored query and back, so "save as search" keeps what the pills show and the pills can edit a saved search. Lossy on purpose: `participant: 'me'` is stored as your uri, `window: 'recent'` as a concrete range, and whatever no pill can show is dropped on the way back. `completedWithin` is not in the query at all and `audience: 'everyone'` is stored as `visibility: 'open'`; neither comes back, so a caller also keeps both in the saved search's `view` (`setSearchView`), as Orbital does, and leaves `visibility: 'open'` in the query so the server narrows the rows before `everyoneOnly` does. |
| `liveTrigger(params)` | A ListNodes request cut down to what a live query can say (`livequery.LISTS`), newest change first, `limit: 100`: a superset of the search's head, used to hear when a saved search's answer may have moved. A change to a match outside the newest 100 is not heard. |
| `searchQueryParams(query, me, limit = 1000, now = Date.now(), spaces = [])` → ListNodes params | A saved search's stored `query` as the graph request, the way Tana's own runner builds it. Pass the org's space nodes as `spaces` whenever `ownerUris` names a space: a scoped space then also covers every space beneath it (`searchOwners`). |
| `searchOwners(ownerUris, spaces)` | Tana's scope widening (`C$e`/`oy`): each space becomes itself plus all its descendants at any depth; a space whose `archivedAt` is set is left out of the tree, cutting off what sits under it; non-space owners stay as they are, anything that is not a Tana uri is dropped, and every owner appears once. Pure: `spaces` are graph nodes `{ id, ownerUri, archivedAt }` the caller listed. |
| `VIEW_PRESETS`, `VIEW_KINDS` | The three presets (`inbox`, `library`, `types`) and the eleven kinds (`meetings tasks docs chats canvases agents skills searches spaces people types`). No view is a kind page any more — each one chooses what it lists, and a stored filter is used exactly as it is given — and the pages that were a fixed query over one kind are saved searches instead. Both directions come from one kind → node type table in the module (`KIND_NODE_TYPE`), so a new listable kind is one entry there; sdk-check round-trips every kind through a saved search. |
| `hideRules(patterns)` / `isHidden(title, rules)` | Hidden titles: case-insensitive whole-title match, or a prefix when the pattern ends in `*`; a bare `*` is dropped; at most 200 patterns of 200 characters. Applied to every list and search in main/views.js. |

## `sdk/pins.js` (all `async (sync, userUri, …)`)

`listSidebar` → uris in tree order · `sidebarTree` → the collection's tree `[{ id, uri?, label?, children }]`, `id` being the tree node id the section writes take · `pinSidebar(docUri)` (dedup) · `unpinSidebar(docUri)` (every node with that uri) · `dates(docUri)` → `['YYYY-MM-DD']`, sorted: Tana's effective pins, the document's shared dates plus your personal ones minus your muted ones (subscribes the document too) · `datePins` → `{ uri: dates }` and `datePinned` → uris: Tana's Today list, personal pins that are not muted, no shared ones · `pinDate(docUri, date)` (dedup, unmutes) · `unpinDate(docUri, date)` (the personal pin only) · `muteDate(docUri, date)` / `unmuteDate(docUri, date)` (hide a date for you, shared or personal, without unpinning it). They subscribe the profile, then the collection / pin-map it points to; throw if the profile has no `pinnedCollectionUri` / `pinMapUri` yet (the web client creates those lazily on first pin; we don't).

Shared date pins live on the document and take it synchronously, like `pinItem`; gate with write access: `sharedDates(doc)` → `['YYYY-MM-DD']` · `pinSharedDate(doc, date)` (dedup) · `unpinSharedDate(doc, date)`.

Sidebar sections, Tana's own writes (`J_` in the bundle of 2026-09-23, docs/PINNING.md section 3): `placePin(docUri, { section, index })` → node id: a document already in the sidebar moves (its first copy, depth first), anything else is added; `section` is a section's node id, null or absent for the top level · `addSection(label, { index })` → the new section's node id, at the top level · `renameSection(sectionId, label)` · `removeSection(sectionId)`, which removes the pins in it too, as Tana's "Remove section" does. `index` is the position among the siblings after the move; absent is the end and past the end is the end. A section id that is not a section (a pin, a missing node) throws before anything is written.

Items pinned *on* an event or a space are a different thing (docs/PINNING.md section 4) and take the document itself, synchronously: `items(doc)` → `[{ uri, mode? }]` · `pinItem(doc, uri, mode?)` (dedup on uri; a re-pin with a mode updates it in place) · `unpinItem(doc, uri)` (every copy); `items` reads a duplicate as its first copy.

## `sdk/events.js` — editing a meeting

Tana's event wrapper, write for write (bundle of 2026-09-23); gate calls with `access.canEditEvent`. `setTime(doc, start, end)` writes both epoch-ms times and deletes `allDay` · `setTimezone` / `setLocation` / `setDescription(doc, text | undefined)` set or delete the key · `lineKey(email)` → `email:<address>`, trimmed and lowercased as Tana does, undefined without an address · `addAttendees(doc, [{ email?, userUri? }], byUri)` copies a calendar event's legacy `data.attendees`/`data.organizer` into the root `attendees` roster first (Tana's `seedRosterFromLegacyAttendees`), then writes one line per person — `email:<lowercased>` when there is an email, else `tana:<ulid>` with `identityUri` — as `{ role: 'required', cutype: 'individual', source: 'tana' }` merged into any existing line, and gives a `tana:user-profile:` an `attendee` participant grant stamped `changedBy` (an existing grant is kept); a bad entry throws before anything is written · `attendees(doc)` → roster lines plus legacy entries not already on it. `data.syncStatus` (`pending | synced | failed`) and `data.syncError` are the server's report of the calendar write-back; no client writes them.

## `sdk/calls.js` — who is in a meeting, and what it left behind

`callSessions(doc)` → `{ eventUri, sessions: [{ key, userUri, joinedAt }] (oldest join first), userUris, log: [{ userUri, timestamp, event }], transcriptUri, screenShareUri }` for a subscribed `tana:call:` document · `inCall(doc, userUri)` → boolean · `joinedAt(doc, userUri)` → ms or null (earliest of that user’s live sessions, so several devices read as one) · `attended(doc)` → everyone whose join is in the log, whether or not they are still there.

`currentCalls(client, userUri, { limit = 5 })` → `[{ callUri, eventUri, title, joinedAt, otherUserUris, transcriptUri, screenShareUri }]`: lists `nodeTypes: ['call']` sorted by update time descending, subscribes to the newest `limit`, keeps those whose `sessions` hold `userUri`, and resolves every event title in one further query. A live call is touched constantly, so the newest few are the only candidates; the graph exposes no presence of its own.

`callState(doc)` → `{ summaryUri, wrapUp, offTheRecord, recordings, presentations, guests, raisedHands, reactions }` for a subscribed call: `summaryUri` is the write-up (null until there is one) and `wrapUp` its progress timestamps (`startedAt` and `summary`/`outcomes`/`sections` `StartedAt`/`CompletedAt`); `offTheRecord` is `data.transcriptionPaused`, what Tana labels "Off the Record"; `recordings` `[{ recordingId, provider, status: recording | processing | ready | failed, startedAt, startedByUri, endedAt?, videoUri?, durationSec?, error? }]` and `presentations` `[{ presentationId, documentUri, startedAt, startedByUri, endedAt? }]` oldest first, a presentation without `endedAt` being on screen now; `guests` `[{ uri: 'tana:guest-profile:…', displayName, verified?, homeOrgName?, homeOrgExternalId?, avatarCid? }]`; `raisedHands` `[{ userUri, handRaisedAt }]` in queue order (the call's own `handRaiseSeq`); `reactions` `[{ emoji, senderUri, bucketStart, count }]`. The room secret is never returned.

`readTranscript(doc)` → `{ summary, segments, sections }` for a subscribed `tana:transcript:` (a call's `transcriptUri`): `segments` `[{ id, start_sec, end_sec, speaker?, speakerUri?, text, confidence?, words, alternatives, channel? }]` as Tana's `segments` getter gives them, the first of each id sorted by `start_sec`; `sections` the wrap-up's tree `[{ title, recap?: { line, start, end }, recapTitle?, start_sec, end_sec, label, children }]`, `label` being what Tana shows (the recap's line, else `recapTitle`, else `title`). Reads `data.segments`, `data.summary` and the `sections` tree only, never the whole document.

This is the only way to tell *joined* from *invited*: see [02-data-model.md](02-data-model.md) section 5 and [../MEETINGS.md](../MEETINGS.md). What it cannot answer is whether a participant is speaking or idle — that would have to come from the transcript document.

## `sdk/inbox.js` — notifications

Tana keeps each user's notifications in one `tana:user-inbox:<user-profile ULID>` document (`inboxUri(userUri)`, Tana's `gy()`): roots `data { type: 'user-inbox', updatedAt }` and `notifications`, a map of LoroMaps `{ id, notificationType, sourceUri, createdAt, actorUri?, title?, body?, readAt?, threadUri?, due?, firedAt? }` (schema `npe`, wrapper `Ah`/`VSe` in the bundle of 2026-09-22; live: 80 items, keys as listed). Types seen in the bundle: `document-access event-access task-assignment comment-mention comment-reply comment-reminder incoming-call type-archived type-unarchived ai-usage-warning chat-message`.

A `comment-reminder` (issue #160) is written ahead of time with `due: { type: 'plain' | 'zoned', datetime: 'YYYY-MM-DDTHH:mm', timezone? }` and stays out of `items`, `unreadCount`, `markAsReadBySourceUri` and `markAllAsRead` until it is due (`markAsRead`/`markAsUnread` take an id and act on it regardless, so pass only ids `items` returned); Tana's client then writes `firedAt`, which this module leaves to Tana. `shown(n, now?)` is that rule, `when(n)` the moment a notification sits at in the list (`firedAt`, else due, else `createdAt`), and `nextDue(doc, now?)` the next moment a waiting reminder comes due (`Infinity` for none), since no live update arrives then.

`open(sync, userUri)` subscribes it (never creates it: Tana's client does that when none exists) · `items(doc)` → the shown ones, newest first · `unreadCount(doc)` · `markAsRead(doc, id)` · `markAsUnread(doc, id)` (deletes `readAt`) · `markAsReadBySourceUri(doc, uri)` · `markAllAsRead(doc)`. Each write is one transaction, sets `readAt` to now on every item it reads, bumps `data.updatedAt` only when an item changed, and returns whether one did — Tana's own rules. Live: the document's `change` events carry every write, from anywhere.

`phrase(n, actorName?, title?)` → Tana's sentence (`Wqt`) as `[{ text, emphasis? }]` ("Sam added you to **Plan**", "You were added to a meeting", anything unknown reads as a message); `title` overrides the stored one, which Tana does for `type-archived`/`type-unarchived` (`retitled(type)`) so a renamed type shows its current name. `detail(n)` → the line Tana writes after it (`Gqt`): the body (a task's title), markdown flattened, trailing punctuation dropped, `''` for calls and type changes. `scripts/platform-cli.js inbox` prints your inbox read-only.

## `sdk/proposals.js` — AI proposals

A change Tana's AI suggests from a chat waits for someone to accept it. It lives in two places (bundle of 2026-09-23: ProposalManager, the chat's proposal mutations, RootProposalsRoute). The graph's chat node carries `chat.proposals`, the latest proposal per document: `{ proposedUri, baseUri?, operation: create | update | delete, status: pending | approved | rejected, proposedAt, resolvedAt, kind }`, plus `pendingCount`. The chat document keeps every version in `data.messages[].proposals[]` (docs/CHATS.md §5), which is where the answers are written. A `create` proposes a document that already exists with `data.isProposal: true`; an `update` proposes a draft copy (`proposedUri`, owned by the chat) of a real document (`baseUri`).

`pending(graph, { limit = 500 })` → pending proposals newest first, from one `ListNodes` over every chat (`includeOwnedChats`, `includeArchived`): `{ chatUri, chatTitle, contextUri, operation, kind: regular | space | instructions | action, proposedUri, baseUri, subjectUri, proposedAt }`. `pendingOf(nodes)` is the pure half.

`approve(sync, { chatUri, proposedUri, byUri })` approves a **create** the way Tana does: `approvedAt` on the chat's entries for it, then on the document `isProposal: false`, `createdInUri: chatUri` and, for a task without them, `stateChangedBy` and `assignedToUrisChangedBy`/`At` naming the approver, then an "accepted 1 change" message from the approver with the document attached (`isStatusUpdate`, `excludeFromAIContext`; the same containers as Tana's own). It refuses, writing nothing, where Tana would do more: an update or delete (Tana merges the draft and replays its intents), a space, instructions or action proposal, any intent other than `reown-embedded-media`, that intent on a document that embeds media (Tana copies the media into the document), and a typed document whose type keeps its documents in another space (Tana moves it there). Live, 27 of 29 pending creates carried `reown-embedded-media` and none embedded media.

`reject(sync, { chatUri, proposedUri })` → `{ uri, warnings }` rejects any proposal as Tana does: its entries leave the chat, and the document it proposed (the new one, or the update's draft) is soft-deleted; a space proposal also deletes the space an earlier failed approval may have made. A cleanup that fails comes back as a warning and does not undo the rejection.

`refusal(entry)`, `entries(chat)`, `kindOf(metadata.type)` and `subjectOf(p)` are the helpers behind them. `scripts/platform-cli.js proposals [--detail] [--rows]` lists them read-only; `approve`/`reject <chat> <proposed>` write; `proposalcycle` runs both on scratch documents and deletes them.


## `sdk/dates.js` — date mentions

`parseDateUri(uri)` → `{ type: 'plaindate', date }` | `{ type: 'zoneddate', date, time?, timezone }` | undefined; `isDateUri(uri)`; `dateUri('YYYY-MM-DD')` → `tana:plaindate:…` (throws on anything else); `dateLabel(uri)` → the day in the locale's short form, Tana's label for a date mention. The documents mentioning a date: `graph.listEdges({ toNodeIds: [uri], edgeTypes: [LINKS_TO, ATTRIBUTE_LINKS_TO] })` or the same edge live query a page's backlinks use; main/related.js asks both for a day page (a document titled with its date).

## `sdk/chat.js`

`chatRows(messages, { authorName = () => undefined, aiName = 'Tana AI' })` → read-only outline rows for a chat's `data.messages` (docs/CHATS.md): one author row per message with its markdown blocks as children, `[label](tana:…)` links as mention segments, attachments and proposals as reference rows, progress text including "Waiting for your input", terminal status and error rows, and pending `askUserQuestion` prompts with their options. `authorName(uri)` names a human author. `blocks(text)`, `segments(text)` and `plain(segments)` are the markdown helpers behind it, and `hm(ms)` the `H:MM` time a message row shows. Pure and Electron-free.

## `sdk/assets.js`

`fetchImage(uri, { getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch })` → `{ mime, bytes: Buffer }`; validates `tana:image:<ulid>`, follows the 302 manually carrying the `Cloud-CDN-Cookie`, retries once on 401.

`uploadFile(bytes, { filename, mimeType, getAccessToken, baseUrl, fetch, signal })` → `{ cid, size, width, height, blurhash }`; `POST /files/upload` with the bytes as multipart field `file`, retries once on 401 (a second 401 throws `SIGNED_OUT`, Tana's "You're signed out — sign in and try again"), refuses more than `UPLOAD_LIMIT` (50 MB) before sending, passes `signal` to the request so it can be aborted, and throws the server's `message`/`error` otherwise.

`initImage(loro, { ownerUri, cid, width, height, blurhash, filename, mimeType, fileSize, now })` — the data map of a new `tana:image:` document as Tana writes it (02-data-model.md §6); pass it as the init of `sync.subscribe('tana:image:' + ulid(), …)`. Throws without `ownerUri`.

## `sdk/proto/descriptors.js`

`files.{sync, graph, search, history}` (protobuf-es file descriptors), `message(file, name)`, `SyncService`, `GraphService`, `SearchService`, `ChangeSummaryService`. Regenerate by extracting the `Mr(` base64 blobs from the current `shared-*.js` bundle (see gotchas).
