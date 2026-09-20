# SDK API reference

All modules are CommonJS. "Node" below means the plain graph JSON node; "Document" means `sdk/document.js`'s class. Errors are thrown (or rejected) as plain `Error`s; Connect failures are `ConnectError`s with a `code`.

## `sdk/index.js`

```js
createTanaClient({ baseUrl?, getAccessToken, orgId, peerId, storageId?, logger?, clientName? })
  → { transport, graph: GraphClient, sync: SyncConnection, close(): Promise }
```
Also re-exports `createTransport`, `GraphClient`, `SyncConnection`, `Document`, `derivePeerId`, everything in `node.js`, `access` (`capabilities`, `setSharing`, `previewMove`, `moveToSpace`, `canWrite`, `canDelete`, `audienceOf`) and `calls` (`callSessions`, `inCall`, `joinedAt`, `attended`, `currentCalls`).

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
| `restore(id): Promise` | `documentAction.restore`, the inverse of `softDelete`. Needs the stream open. |
| `close(): Promise` | Unsubscribes everything, aborts the stream, stops reconnecting. |
| `connected`, `docs` | State; `docs` maps id → session entry (`state`: new / bootstrapping / retrying / live / resyncing / disconnected / closed). |

Events: `connected` `({ heartbeatIntervalMs })`, `disconnected`, `heartbeat`, `change` `(docId, { origin: 'local' | 'remote' })`, `ephemeral` `(docId, bytes)`, `error` `(err)` (only emitted if a listener exists; always logged).

Outbound: local ops are batched 5 ms, one in-flight `liveDocumentUpdate` per document, 256 KiB budget (overflow → re-bootstrap). Inbound frames for a stale `sessionId` are dropped. `resync_required` re-bootstraps; `DISCARD_LOCAL` resets the Document first. After a reconnect every document is re-bootstrapped with the same Document object. Per-document resync backoff is 500 ms→5 s, fixed at 30 s after six consecutive resyncs, and the counter is reset by 15 s of healthy live (checked when the next resync starts, so a document nobody edits is counted too).

`derivePeerId(userExternalId)` → decimal u64 string: `(sha256(lowercased id)[0..8] >> 16) << 16 | nonce`, where the nonce is 15 random bits (only the top 48 bits matter: the server records them as `peerUserHash`). New nonce per process; keep `storageId` (a UUID you persist) for a non-ephemeral peer.

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
| `initDocument(loro, title, byUri, { kind, now, entityTypeUri, ownerUri })` | Seeds a new document's data map like the web client (participants { byUri: admin }, restricted, sharedPinDates, attributes) plus the empty content skeleton. `kind`: `doc` (default), `task` (open state assigned to `byUri`), `meeting` (a `tana:event:` laid out like a Tana-created event: next half hour, 30 min, local timezone, origin 'tana', no content), `chat` (native `participantUris`/`messages`, no outline). `entityTypeUri` sets the document's type (not on a chat), `ownerUri` its home space; both are validated. Use inside `sync.subscribe(id, init)`. |
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
| `insertAfter(document, id | null, text)` → newId | Sibling after `id` (inside a listItem: a new listItem); `null` appends at the end of the doc; creates the doc skeleton if missing. |
| `insertChild(document, id, text)` → newId or null | First child (creates the nested bulletList/listItem; wraps a bare paragraph into a listItem). Null for headings/quotes/code. |
| `insertBefore(document, id, text)` → newId | Sibling before `id` (same level, same listItem rules as `insertAfter`). What Enter at the very start of a node does: the node keeps its text and children. |
| `split(document, id, before, after, asChild)` → newId | Enter inside a node: `setText(id, before)` plus the insert of `after` as the next sibling (or the first child when `asChild`) in **one** transaction, so one undo puts the node back whole. `before`/`after` are strings or segments; segments with mentions or marks are written back over the plain insert. |
| `remove(document, id)` | Removes the node and its children; prunes emptied lists. |
| `indent(document, id)` / `outdent(document, id)` | Under the previous sibling / after the parent. No-ops at the edges; only paragraphs and listItems can be moved. |
| `move(document, id, 'up' | 'down')` | Swap with the neighbouring sibling (lists move as a whole). |
| `moveMany(document, ids, 'up' | 'down')` / `removeMany(document, ids)` | The same for a sibling range in visual order, in **one** transaction, so a multi-select is one undo step. Both reject duplicates, unknown ids and non-siblings before mutating. |
| `indentMany(document, ids)` / `outdentMany(document, ids)` | The same for indent/outdent: one transaction, ids in visual order (indent runs first to last so each row follows the one above it, outdent last to first). The sibling checks run first; each id is then resolved inside the transaction because the previous row's move already changed the tree. |
| `toggleCheckbox(document, id)` | Paragraph or heading only. `checked` lives on the `listItem`, so a bare paragraph is wrapped first (keeping its blockId, marks and mentions); it never touches the document's own task state. |

All operations run inside `document.transact`, so each is one undo step and one live update. Containers are copied and deleted (Loro cannot move containers); text runs keep their marks via `toDelta/applyDelta`. A direction other than `'up'`/`'down'` throws rather than defaulting to down.

## `sdk/fields.js` — typed fields ("attributes")

A field value is a ProseMirror-style tree in the document's own `data.attributes` map under the key `"<type uri>?attribute=<key>"`: `{ nodeName: 'doc', attributes: {}, children: [{ nodeName: 'paragraph', attributes: { blockId }, children: [text] }] }`. The field's name lives in the *type* document's `data.template.attributes` (`[{ key, title, type?, cardinality?, to? }]`); the graph node's `typeDef` carries the same list but is not always readable, so read the type document.

| Function | Behaviour |
|---|---|
| `readFields(document)` | `[{ key, typeUri, attribute, text }]` for every field the document carries; `text` is the flattened value with mentions rendered as their label. `[]` when there are none. |
| `templateTitles(typeDocument)` | `{ key: title }` for that type's fields (falls back to the key). |
| `setFieldText(document, key, text)` | Replaces the field's text in place, creating the doc/paragraph shell when the field is empty and dropping any extra runs. One plain text run: it cannot write a mention, so editing a reference field flattens it to text. |
| `valueText(value)`, `parseKey(key)` | The helpers behind those two. |

## App mutation and history boundary

The SDK's `Document.undo()`/`redo()` only undo local CRDT transactions for that document. `main.js` adds a global stack across documents and routes renderer Cmd+Z, Cmd+Shift+Z and Cmd+Y through it. Native delete/restore is a separate `documentAction` command: the main process checks `access.canDelete`, requires a `documentActionResponse`, and records the action so undo of delete restores and undo of restore deletes. A failed action is not removed from history. Restore visibility and document state arrive through the server's live update.

## `sdk/query.js`

| Function | Behaviour |
|---|---|
| `parseQuery(query)` → `{ text, tags }` | Extracts `#word` tokens. |
| `searchParams(parsed, typesByLowerTitle, limit = 20)` → ListNodes params or null | Default nodeTypes `['text', 'event', 'user-profile']`, `textQuery`, TEXT_RANK sort; `#task` → text + all four states, `#meeting` → event, `#member` → user-profile, `#space` → space, `#<Type>` → `entityTypes`; unknown type or empty query → null. |
| `needsTypes(parsed)` | True when a non-kind tag needs the type map. |
| `viewParams(filter, me, limit = 1000)` → ListNodes params | The one query behind every view (docs/VIEWS.md). A filter is `{ types, states, assignee, text, participant, window, mcp }`, all optional; `types` null or empty means every listable kind (never an unconstrained query: `nodeTypes: []` is no filter to the graph). `states` and `assignee` are applied only while `tasks` is among the kinds, which is exactly when those pills are shown. Meetings alone sort by event start, everything else by update time; `participant: 'me'` and `window: 'recent'` (last 7 days, next 7) are what the Meetings preset uses. Throws on an invalid filter. |
| `validViewFilter(f)` | Shape check for a stored filter: known keys only, kinds from `VIEW_KINDS`, states from `STATE_TYPES`, assignee one of `me | anyone | unassigned | <user-profile uri>`. |
| `viewTypes(id, f)` | A kind page (`KIND_VIEWS`: tasks, meetings, chats, people) keeps its own `types` whatever the stored filter says; Library and Inbox choose theirs. |
| `VIEW_PRESETS`, `VIEW_KINDS`, `KIND_VIEWS` | The six presets, the nine kinds (`meetings tasks docs chats canvases agents skills spaces people`), and the kind pages. |
| `hideRules(patterns)` / `isHidden(rules, title)` | Hidden titles: case-insensitive whole-title match, or a prefix when the pattern ends in `*`; a bare `*` is dropped; at most 200 patterns of 200 characters. Applied to every list and search in main.js. |

## `sdk/pins.js` (all `async (sync, userUri, …)`)

`listSidebar` → uris in tree order · `sidebarTree` → the collection's tree with its section labels · `pinSidebar(docUri)` (dedup) · `unpinSidebar(docUri)` · `dates(docUri)` → `['YYYY-MM-DD']` · `pinDate(docUri, date)` (dedup, unmutes) · `unpinDate(docUri, date)`. They subscribe the profile, then the collection / pin-map it points to; throw if the profile has no `pinnedCollectionUri` / `pinMapUri` yet (the web client creates those lazily on first pin; we don't).

Items pinned *on* an event or a space are a different thing (docs/PINNING.md section 4) and take the document itself, synchronously: `items(doc)` → `[{ uri, mode? }]` · `pinItem(doc, uri, mode?)` (dedup on uri) · `unpinItem(doc, uri)`.

## `sdk/calls.js` — who is in a meeting

`callSessions(doc)` → `{ eventUri, sessions: [{ key, userUri, joinedAt }] (oldest join first), userUris, log: [{ userUri, timestamp, event }], transcriptUri, screenShareUri }` for a subscribed `tana:call:` document · `inCall(doc, userUri)` → boolean · `joinedAt(doc, userUri)` → ms or null (earliest of that user’s live sessions, so several devices read as one) · `attended(doc)` → everyone whose join is in the log, whether or not they are still there.

`currentCalls(client, userUri, { limit = 5 })` → `[{ callUri, eventUri, title, joinedAt, otherUserUris, transcriptUri, screenShareUri }]`: lists `nodeTypes: ['call']` sorted by update time descending, subscribes to the newest `limit`, keeps those whose `sessions` hold `userUri`, and resolves every event title in one further query. A live call is touched constantly, so the newest few are the only candidates; the graph exposes no presence of its own.

This is the only way to tell *joined* from *invited*: see [02-data-model.md](02-data-model.md) section 5 and [../MEETINGS.md](../MEETINGS.md). What it cannot answer is whether a participant is speaking or idle — that would have to come from the transcript document.

## `sdk/chat.js`

`chatRows(messages, { authorName, aiName = 'Tana AI' })` → read-only outline rows for a chat's `data.messages` (docs/CHATS.md): one author row per message with its markdown blocks as children, `[label](tana:…)` links as mention segments, attachments and proposals as reference rows, and "Thought for N seconds" from `completedAt - sentAt`. `blocks(text)`, `segments(text)` and `plain(segments)` are the markdown helpers behind it. Pure and Electron-free.

## `sdk/assets.js`

`fetchImage(uri, { getAccessToken, baseUrl = 'https://home.tana.inc/api/general', fetch })` → `{ mime, bytes: Buffer }`; validates `tana:image:<ulid>`, follows the 302 manually carrying the `Cloud-CDN-Cookie`, retries once on 401. `IMAGE_URI` regex exported.

## `sdk/proto/descriptors.js`

`files.{sync, graph, search, history}` (protobuf-es file descriptors), `message(file, name)`, `SyncService`, `GraphService`, `SearchService`. Regenerate by extracting the `Mr(` base64 blobs from the current `shared-*.js` bundle (see gotchas).
