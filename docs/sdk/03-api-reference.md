# SDK API reference

All modules are CommonJS. "Node" below means the plain graph JSON node; "Document" means `sdk/document.js`'s class. Errors are thrown (or rejected) as plain `Error`s; Connect failures are `ConnectError`s with a `code`.

## `sdk/index.js`

```js
createTanaClient({ baseUrl?, getAccessToken, orgId, peerId, storageId?, logger?, clientName? })
  → { transport, graph: GraphClient, history: HistoryClient, sync: SyncConnection, close(): Promise }
```
Also re-exports `createTransport`, `GraphClient`, `HistoryClient`, `SyncConnection`, `Document`, `derivePeerId` and everything in `node.js`. `access` (`capabilities`, `setSharing`, `previewMove`, `moveToSpace`, `canWrite`, `canDelete`, `audienceOf`) and `calls` (`callSessions`, `inCall`, `joinedAt`, `attended`, `currentCalls`) are required from their own modules (`sdk/access`, `sdk/calls`), which is what every caller does.

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

## `sdk/history.js` — `class HistoryClient(transport)`

`listChanges({ uri, withinId?, limit? })` → `{ parent?, summaries: [{ id, level, title, description, authors, sources, startTime, endTime, expandable, changeType }] }`: the change summaries Tana's own Changes panel shows for a node, `summaries` always an array. `withinId` asks for the summaries inside an expandable one; nothing here writes.

## `sdk/livequery.js` — a query the server keeps answering

`openLiveQuery(sync, query, { label })` → handle, once the server has taken the query. It creates a throwaway `tana:liveQuery:<ulid>` document holding the query, subscribes it as ephemeral (as Tana's own client does), and the server writes the answer into `data.result.nodes` and rewrites it whenever the answer changes, as ordinary live updates on the stream already open.

- `query`: lists `uris types ownerUris entityTypeUris stateTypes chatInvocationIntents stateChangedBy stateWorkflowUris stateWorkflowStateIds assignedTo createdBy recurrenceIds occurrenceKeys orderBy exactParticipantUris hasParticipantUris useFields` and scalars `stateEnteredAtMin/Max createdAtMin/Max eventStartTimeMin/Max eventEndTimeMin/Max unassigned limit includeProposals includeArchived archivedOnly modifiedByUserHash uniqueByParticipants restricted linkShared`. Times are epoch ms; `orderBy` entries are field names, `-createdAt` for descending. Any other key throws before anything is subscribed. `externalIds` and `attributeFilters` are always written empty.
- `handle.state()` → `{ status: 'pending' | 'ready' | 'stale' | 'error', nodes, error }`: pending while `resultForVersion` is 0, stale while it trails `queryVersion` (Tana's rule).
- `handle.on('rows', { added, removed, changed, initial })`: every time the answer moves; `initial` marks the first answer, `removed` is uris, `changed` means a row's title, state, state entry time, type, assignees or archive changed.
- `handle.on('error', e)`: the server refused the query (emitted only when something listens).
- `handle.close()`: unsubscribes. `handle.id` is the query document's uri.

A row: `{ uri, type, title, entityType, createdAt, updatedAt, ownerUri, state: { type, enteredAt, changedBy }, assignedTo, participants, calendarEvent, archivedAt, … }`. Verified live 2026-09-22 (`platform-cli livequery`): a task created elsewhere arrived as an `added` row within seconds, and left as `removed` when deleted.

## `sdk/sync.js` — `class SyncConnection extends EventEmitter`

Constructed by `createTanaClient`; `{ transport, orgId, peerId, storageId, logger }`.

| Member | Behaviour |
|---|---|
| `connect(): Promise<void>` | Opens `ServerSync`; resolves after the server's `peer` frame. Keeps reconnecting in the background (backoff 250 ms→5 s before the first success, 1 s→30 s after; watchdog = 3× heartbeat interval). Rejects and stays closed on PermissionDenied / Unauthenticated-before-first-frame. |
| `subscribe(id, init?): Promise<Document>` | Creates (or returns) the Document for `id` and bootstraps it (begin_document_sync → import server updates → apply_bootstrap_updates catch-up → bootstrap_complete). Resolves once live. `init(loro)` runs in a transact *before* bootstrap: for an unknown id this turns the server's MISSING into a create (the full snapshot is the catch-up). Without `init`, an unknown id rejects with `document not found` after ~60 s / 5 attempts. Idempotent per id. |
| `getDocument(id)` | Document or undefined. A handle can exist before bootstrap is ready; await `subscribe` before reading it. |
| `unsubscribe(id): Promise` | Sends `unsubscribeDocument` when live; detaches listeners. |
| `softDelete(id): Promise` | `documentAction.softDelete`; the doc disappears from graph queries. Needs the stream open. |
| `restore(id): Promise` | `documentAction.restore`, the inverse of `softDelete`. Needs the stream open. |
| `subscribeEphemeralChannel(channelId)`, `unsubscribeEphemeralChannel(channelId)`, `sendEphemeral(documentId, bytes)`, `viewingHeartbeat(documentId)` | Presence plumbing: channels are counted per id (two holders, one subscription) and resent after every reconnect; sends are best effort, resolve to whether they went and send nothing while disconnected. Incoming frames are the `ephemeral` event. Use `sdk/presence.js` rather than these directly. |
| `close(): Promise` | Unsubscribes everything, aborts the stream, stops reconnecting. |
| `connected`, `docs` | State; `docs` maps id → session entry (`state`: new / bootstrapping / retrying / live / resyncing / disconnected / closed). |

Events: `connected` `({ heartbeatIntervalMs })`, `disconnected`, `heartbeat`, `change` `(docId, { origin: 'local' | 'remote' })`, `ephemeral` `(docId, bytes)`, `error` `(err)` (only emitted if a listener exists; always logged).

Outbound: local ops are batched 5 ms, one in-flight `liveDocumentUpdate` per document, 256 KiB budget (overflow → re-bootstrap). Inbound frames for a stale `sessionId` are dropped. `resync_required` re-bootstraps; `DISCARD_LOCAL` resets the Document first. After a reconnect every document is re-bootstrapped with the same Document object. Per-document resync backoff is 500 ms→5 s, fixed at 30 s after six consecutive resyncs, and the counter is reset by 15 s of healthy live (checked when the next resync starts, so a document nobody edits is counted too).

`derivePeerId(userExternalId)` → decimal u64 string: `(sha256(lowercased id)[0..8] >> 16) << 16 | nonce`, where the nonce is 15 random bits (only the top 48 bits matter: the server records them as `peerUserHash`). New nonce per process; keep `storageId` (a UUID you persist) for a non-ephemeral peer.

## `sdk/presence.js` — who is in a document, and where

`openPresence(sync, documentId, { timeout = 30000, viewing = false })` → handle, once the document's presence channel is subscribed. Tana's editor shares carets over an ephemeral channel named by the document uri: every peer keeps one entry in a Loro `EphemeralStore` keyed by its peer id, and changes travel as that store's own update bytes. Nothing is stored anywhere.

- `handle.peers({ exceptUserHash }?)` → `[{ peer, userHash, user: { name, color } | null, scope, hasCursor, anchorBlock, focusBlock, anchor, focus }]` for everyone in the document except this connection. `anchorBlock`/`focusBlock` are `{ blockId, offset }` or null; `anchor`/`focus` are Loro `Cursor` bytes (`Cursor.decode` + `doc.getCursorPos`) or null. `exceptUserHash` also leaves out your own other tabs and devices.
- `handle.editing(opts?)` → the peers with a caret in the document, i.e. someone is editing it right now.
- `handle.on('change', { added, updated, removed, by })`: peer ids; `by` is `import` (a peer sent something, leaving included) or `timeout` (an entry nobody refreshed expired).
- `handle.setLocal({ user, anchorBlock, focusBlock = anchorBlock, anchor, focus = anchor, scope })`: be seen, in Tana's entry shape (`anchor`/`focus` are Loro cursor bytes, `content.cursorAt(...).encode()`, which Tana draws an exact caret from), refreshed at half the timeout so it does not expire; `handle.clearLocal()` takes it away. Re-sent after a reconnect.
- `{ viewing: true }`: also sends the viewing heartbeat every 10 s (and after a reconnect), as Tana does for the document on screen.
- `handle.close()`: clears our entry, unsubscribes, forgets everyone.
- `userHashOf(peerId)`: the user part of a peer id (its top bits, `sync.derivePeerId`), so an entry says which user it is without a lookup; two tabs of one person share it.

Verified live 2026-09-22 (`platform-cli presence`, two sessions on a scratch document): the watcher saw the other session arrive with its label and caret block, and leave when it closed.

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
| `setAssignees(document, uris, byUri)` | Rewrites `assignedToUris` (deduped; `[]` = unassigned) plus `assignedToUrisChangedAt/By`. Throws unless every uri is a `tana:user-profile:` and the document has a task state; a no-op change writes nothing. |
| `setEntityType(document, typeUri \| null, { workflow, byUri })` | Tana's `retype`: sets or deletes `entityTypeUri` and always deletes `stateWorkflowUri`/`stateWorkflowStateId` (a workflow state belongs to the type that is leaving). Only `tana:text:`/`tana:event:` documents carry a type; a no-op change writes nothing. `workflow: true` (the type defines one) starts an untyped-and-stateless document at `proposed`, as Tana does. Which types are allowed is the caller's (main/documents.js `typeChoices`/`setType`). |
| `editable(node, userUri)` | Companion UI capability for a plain node (not a Document): `true` for an admin/editor on text/space, `false` for viewers, profiles, events and unsupported kinds, `null` when the ACL is unknown. Never a substitute for server authorization. |
| `audienceMetadata(document, userUri, graph, sync)` | `{ audience: 'only-me' | 'people' | 'space' | 'everyone' | 'unknown', audienceSpace?: { uri, title? } }`. Direct `restricted` first, then the nearest restricted owner-chain boundary (a space names itself, the org root means everyone), then `effectivelyRestricted === false`. Guest profiles count as people; groups, empty participant sets and inaccessible boundaries stay unknown. See docs/sdk/05-gotchas.md. |
| `audience(...)` | `audienceMetadata(...).audience`, the label on its own. |
| `ulid(now?)` | 26-char lowercase Crockford ULID. |
| `initDocument(loro, title, byUri, { kind, now, entityTypeUri, ownerUri, query })` | Seeds a new document's data map like the web client (participants { byUri: admin }, restricted, sharedPinDates, attributes) plus the empty content skeleton. `kind`: `doc` (default), `task` (open state assigned to `byUri`), `meeting` (a `tana:event:` laid out like a Tana-created event: next half hour, 30 min, local timezone, origin 'tana', no content), `chat` (native `participantUris`/`messages`, no outline), `search` (a `tana:search:` document: `data{type,createdAt,title,restricted,participants}`, the `query` option written into its query root there and then — an empty query map reads as an unreadable search — and an empty `view` root, with no sharedPinDates and no content), `type` (a `tana:type:` document: `data{type,title,sharedPinDates,template}` and an empty content map only — a real type carries no createdAt, restricted or participants, and one with no `ownerUri` is a Library type that fits a document in any space; give it its fields with `fields.addField`). `entityTypeUri` sets the document's type (not on a chat), `ownerUri` its home space; both are validated. Use inside `sync.subscribe(id, init)`. |
| `setSearchQuery(document, query)` | Rewrites a saved search's `query` root container. Every key is assigned rather than patched — lists replaced whole, flags set or deleted — so a filter dropped from a save cannot linger. Throws unless the document's `type` is `search`. |
| `setSearchView(document, view)` | The same for the `view` root beside it: `sortBy`, `groupBy`, `display` (the row's facts, comma-joined, since a Loro map holds scalars) and `completedWithin`. It says how the rows are arranged, not which rows the search finds. |
| `STATE_TYPES` | `['proposed', 'open', 'closed', 'not_now']`. |

The native title contract is a plain metadata string. `setTitle` cannot store mention nodes; profiles and unsupported kinds are read-only, and events currently remain read-only because the organizer/calendar write capability is outside the graph contract.

## `sdk/content.js` — outline over the content tree

Outline node: `{ id: blockId, text, kind: 'block', block?: type, heading?: level, editable?: false, type?: 'image', image?: { uri, alt, width, height }, segments: [{ text, marks? } | { mention: { label, uri } }], hasChildren, children: OutlineNode[] }`.

`block` is the node's block type: `paragraph | heading1 | heading2 | heading3 | bullet | numbered | code | quote | divider` (absent on image and embed nodes, which carry `type` instead). `heading` still carries the level for headings. A divider is a childless `horizontalRule`, so it reads as `editable: false` with empty text.

`marks` on a text segment is `{ bold?: true, italic?: true, strike?: true, code?: true, link?: href }`. Marks live in the LoroText delta and never appear in `toJSON()`, so one text container holds several segments when its delta is split by marks. Tana stores a plain mark as `{}` and a link as its ProseMirror attrs (`{ href, title, target }`); a segment carries the href alone, and an unchanged href leaves `title`/`target` untouched. Loro needs mark styles configured before writing (`configTextStyle`): Tana derives them from its schema, where no mark declares `inclusive`, so every mark is `expand: 'none'`.

| Function | Behaviour |
|---|---|
| `readOutline(document)` | Outline nodes (`[]` for an empty content map). |
| `setText(document, id, value)` | `value`: a string or segments. A **string** replaces the words and leaves the existing annotations alone; **segments** state the marks exactly. Consecutive text segments share one LoroText, the way Tana stores them, and every mention is its own map. Containers are matched by position: a text container is updated in place (a diffing update keeps concurrent edits and the marks of untouched characters, then only the spans whose annotation differs are marked or unmarked), a same-uri mention is kept, anything else is replaced, trailing containers are dropped. Inside a `codeBlock` marks and mentions flatten to text, because its schema content is `text*` with `marks: ''`. |
| `setBlockType(document, id, type)` | `paragraph`, `heading1-3`, `bullet`, `numbered`, `code`, `quote`. A type is a container plus a leaf node name, and the types stay mutually exclusive the way Tana's style menu presents them: bullet/numbered live in a `listItem`, quote in a `blockquote`, the rest are bare blocks. The blockId and the inline content survive. Between the two list kinds the whole `listItem` moves, so its children and its checkbox stay with it; a conversion to heading, quote or code outdents the node's children instead of losing them, because those blocks cannot own children. Splitting a list or quote around the node keeps outline order. Rejects an unknown type and the atoms (divider, image, embed). |
| `insertDivider(document, id \| null)` → newId | Inserts Tana's `horizontalRule` after `id` (`null` appends at the end). A list holds `listItem`s only, so a rule between two items splits the list rather than landing inside it. |
| `insertMention(document, { uri, label }, { parentId, afterId })` → newId | A document dropped into an outline cannot move there, so what lands is a reference to it: one block whose whole content is a mention. The place is named the way a drag names it (`afterId` the row it lands behind, `parentId` the row it lands inside, neither means the first row), and the row is written as a list row or as prose, whichever the destination keeps. |
| `insertAfter(document, id | null, text, before = false, asBlock = null)` → newId | Sibling after `id` (inside a listItem: a new listItem); `null` appends at the end of the doc; creates the doc skeleton if missing. A new row follows the row it comes from, so a document's own first row is plain text unless the caller says otherwise: `asBlock: 'bullet'` is how a row asked to hold sub-items opens onto a list row. |
| `insertChild(document, id, text)` → newId or null | First child (creates the nested bulletList/listItem; wraps a bare paragraph into a listItem). Null for headings/quotes/code. |
| `insertBefore(document, id, text)` → newId | Sibling before `id` (same level, same listItem rules as `insertAfter`). What Enter at the very start of a node does: the node keeps its text and children. |
| `split(document, id, before, after, asChild)` → newId | Enter inside a node: `setText(id, before)` plus the insert of `after` as the next sibling (or the first child when `asChild`) in **one** transaction, so one undo puts the node back whole. `before`/`after` are strings or segments; segments with mentions or marks are written back over the plain insert. |
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

All operations run inside `document.transact`, so each is one undo step and one live update. Containers are copied and deleted (Loro cannot move containers); text runs keep their marks via `toDelta/applyDelta`. A direction other than `'up'`/`'down'` throws rather than defaulting to down.

`cursorAt(document, blockId, offset)` → a Loro `Cursor` at that character offset in the block's text, counted as the outline shows it (a mention as its label, a line break as one): on the text run it falls in, or on the children list at a mention; past the end, after the last item; null for an unknown block. How presence shares an exact caret (`sdk/presence.js` `setLocal`). Offsets are Loro unicode positions, so astral characters before the caret shift it by one each.

`charOffset(document, blockId, position)` / `blockOffset(document, blockId, offset)`: convert a caret between Tana's ProseMirror position from the start of the block (presence `anchorBlock`/`focusBlock` offsets: a mention or a line break is one position) and the outline's character offset (a mention is its label). A caret inside a mention's label maps to just before it; null for an unknown block.

## `sdk/fields.js` — typed fields ("attributes")

A field value is a ProseMirror-style tree in the document's own `data.attributes` map under the key `"<type uri>?attribute=<key>"`: `{ nodeName: 'doc', attributes: {}, children: [{ nodeName: 'paragraph', attributes: { blockId }, children: [text] }] }`. The field's name lives in the *type* document's `data.template.attributes` (`[{ key, title, type?, cardinality?, to? }]`); the graph node's `typeDef` carries the same list but is not always readable, so read the type document.

| Function | Behaviour |
|---|---|
| `readFields(document)` | `[{ key, typeUri, attribute, text, segments, lines }]` for every field the document carries; `lines` is the value as `[{ segments, block }]` in stored order, `text` joins those lines with newlines (mentions rendered as their label) and `segments` is the first line's. `[]` when there are none. |
| `templateTitles(typeDocument)` | `{ key: title }` for that type's fields (falls back to the key). |
| `setFieldText(document, key, text)` | Writes the field's value, creating the doc/paragraph shell when the field is empty. `text` is a string, one line's segments, or an array of lines — each a string, segments, or `{ segments, block }`. The runs are written by the same code a row's are, so a mention stays a mention. Words changing are patched into the blocks already there, which keeps a value's bullets, headings and block ids; a line changing shape writes the value again from the top. |
| `fieldView(document, key, { create = false })` | The field's value as a Document, so every operation in `content.js` works on it and the field editor is the page's editor rather than a second one. `create` decides what an absent value does: a write needs the shell to exist, a read must not write one. |
| `addField(typeDocument, { title, type, cardinality })` → key | Defines a field on a type: one more entry in its `template.attributes`, the MovableList of `{ key, title, type?, cardinality? }` maps a real type carries. Types seen on the wire: member, date, link; a plain text field has no type at all. |
| `parseKey(key)` | The helper behind those. `valueLines` and `valueText` (a value's lines and its flat text) stay inside the module: `readFields` already hands out `lines` and `text`, and nothing outside it needs them raw. |

## App mutation and history boundary

The SDK's `Document.undo()`/`redo()` only undo local CRDT transactions for that document. `main.js` adds a global stack across documents and routes renderer Cmd+Z, Cmd+Shift+Z and Cmd+Y through it. Native delete/restore is a separate `documentAction` command: the main process checks `access.canDelete`, requires a `documentActionResponse`, and records the action so undo of delete restores and undo of restore deletes. A failed action is not removed from history. Restore visibility and document state arrive through the server's live update.

## `sdk/query.js`

| Function | Behaviour |
|---|---|
| `parseQuery(query)` → `{ text, tags }` | Extracts `#word` tokens. |
| `searchParams(parsed, typesByLowerTitle, limit = 20)` → ListNodes params or null | Default nodeTypes `['text', 'event', 'user-profile', 'space', 'search']`, `textQuery`, TEXT_RANK sort; `#task` → text + all four states, `#meeting` → event, `#member` → user-profile, `#space` → space, `#<Type>` → `entityTypes`; unknown type or empty query → null. |
| `needsTypes(parsed)` | True when a non-kind tag needs the type map. |
| `viewParams(filter, me, limit = 1000)` → ListNodes params | The one query behind every view (docs/VIEWS.md). A filter is `{ types, states, assignee, text, participant, window, completedWithin }`, all optional; `types` null or empty means every listable kind (never an unconstrained query: `nodeTypes: []` is no filter to the graph). `states` and `assignee` are applied only while `tasks` is among the kinds, which is exactly when those pills are shown. Meetings alone sort by event start, everything else by update time; `participant: 'me'` and `window: 'recent'` are events the user is in, from 7 days ago to 7 days ahead. `completedWithin` (7, 30 or `'all'`) is asked for nowhere — the request has no field for the age of a state — so it is applied to the answer instead, by `completedInWindow`. Throws on an invalid filter. |
| `validViewFilter(f)` | Shape check for a stored filter: known keys only, kinds from `VIEW_KINDS`, states from `STATE_TYPES`, assignee one of `me | anyone | unassigned | <user-profile uri>`. |
| `VIEW_PRESETS`, `VIEW_KINDS` | The three presets (`inbox`, `library`, `types`) and the eleven kinds (`meetings tasks docs chats canvases agents skills searches spaces people types`). No view is a kind page any more — each one chooses what it lists, and a stored filter is used exactly as it is given — and the pages that were a fixed query over one kind are saved searches instead. |
| `hideRules(patterns)` / `isHidden(title, rules)` | Hidden titles: case-insensitive whole-title match, or a prefix when the pattern ends in `*`; a bare `*` is dropped; at most 200 patterns of 200 characters. Applied to every list and search in main.js. |

## `sdk/pins.js` (all `async (sync, userUri, …)`)

`listSidebar` → uris in tree order · `sidebarTree` → the collection's tree with its section labels · `pinSidebar(docUri)` (dedup) · `unpinSidebar(docUri)` · `dates(docUri)` → `['YYYY-MM-DD']` · `datePinned` → the doc uris that still hold a plain date pin, for "is this row pinned at all" over a whole list · `pinDate(docUri, date)` (dedup, unmutes) · `unpinDate(docUri, date)`. They subscribe the profile, then the collection / pin-map it points to; throw if the profile has no `pinnedCollectionUri` / `pinMapUri` yet (the web client creates those lazily on first pin; we don't).

Items pinned *on* an event or a space are a different thing (docs/PINNING.md section 4) and take the document itself, synchronously: `items(doc)` → `[{ uri, mode? }]` · `pinItem(doc, uri, mode?)` (dedup on uri) · `unpinItem(doc, uri)`.

## `sdk/calls.js` — who is in a meeting

`callSessions(doc)` → `{ eventUri, sessions: [{ key, userUri, joinedAt }] (oldest join first), userUris, log: [{ userUri, timestamp, event }], transcriptUri, screenShareUri }` for a subscribed `tana:call:` document · `inCall(doc, userUri)` → boolean · `joinedAt(doc, userUri)` → ms or null (earliest of that user’s live sessions, so several devices read as one) · `attended(doc)` → everyone whose join is in the log, whether or not they are still there.

`currentCalls(client, userUri, { limit = 5 })` → `[{ callUri, eventUri, title, joinedAt, otherUserUris, transcriptUri, screenShareUri }]`: lists `nodeTypes: ['call']` sorted by update time descending, subscribes to the newest `limit`, keeps those whose `sessions` hold `userUri`, and resolves every event title in one further query. A live call is touched constantly, so the newest few are the only candidates; the graph exposes no presence of its own.

This is the only way to tell *joined* from *invited*: see [02-data-model.md](02-data-model.md) section 5 and [../MEETINGS.md](../MEETINGS.md). What it cannot answer is whether a participant is speaking or idle — that would have to come from the transcript document.

## `sdk/chat.js`

`chatRows(messages, { authorName, aiName = 'Tana AI' })` → read-only outline rows for a chat's `data.messages` (docs/CHATS.md): one author row per message with its markdown blocks as children, `[label](tana:…)` links as mention segments, attachments and proposals as reference rows, and "Thought for N seconds" from `completedAt - sentAt`. `blocks(text)`, `segments(text)` and `plain(segments)` are the markdown helpers behind it. Pure and Electron-free.

## `sdk/assets.js`

`fetchImage(uri, { getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch })` → `{ mime, bytes: Buffer }`; validates `tana:image:<ulid>`, follows the 302 manually carrying the `Cloud-CDN-Cookie`, retries once on 401.

## `sdk/proto/descriptors.js`

`files.{sync, graph, search, history}` (protobuf-es file descriptors), `message(file, name)`, `SyncService`, `GraphService`, `SearchService`, `ChangeSummaryService`. Regenerate by extracting the `Mr(` base64 blobs from the current `shared-*.js` bundle (see gotchas).
