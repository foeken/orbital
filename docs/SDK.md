# tana-tasks SDK design (platform sync, no MCP)

> **Historical.** This is the original design brief, kept for the layering contract and the reasoning behind it.
> Where it disagrees with the code it is the doc that is stale (it still shows `tasks:list` IPC, a `'done'` state
> and `Document.version()`, none of which exist). The current API is docs/sdk/01-overview.md → 05-gotchas.md.

The app talks to the new Tana exactly like the web client does: a cookie session on home.tana.inc, a bearer token from `GET /api/auth/session`, and the Connect-RPC services under `https://home.tana.inc/platform`. Everything Tana-specific lives in `sdk/` and is generic over documents/nodes; "tasks" are only a query and a view on top.

Runtime: Electron 44 (Node 24) main process, CommonJS, no bundler. Dependencies (installed): `@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-web`, `loro-crdt`. The MCP SDK is removed. Protocol details are in docs/PLATFORM-PROTOCOL.md; proto descriptors are loaded at runtime from sdk/proto/descriptors.js (already written; exports `files`, `message(file, name)`, `SyncService`, `GraphService`, `SearchService`).

## Layers and files

```
sdk/
  index.js              createTanaClient(options) -> TanaClient { graph, sync, close() }
  proto/descriptors.js  (done) runtime-loaded protobuf descriptors
  transport.js          Connect transport with auth + one retry after token refresh
  graph.js              GraphClient: generic node queries (ListNodes, ListEdges, Traverse, GetOwnerChain)
  sync.js               SyncConnection: the ServerSync stream, document subscriptions, live updates in/out, reconnect
  document.js           Document: a subscribed Loro document (generic), change events, transact()
  node.js               Node helpers: typed accessors for the common 'data' map (title, stateType, assignedToUris...) and content text
tana-session.js         Electron-only auth: login window on home.tana.inc, cookie session, access token, refresh
scripts/platform-cli.js Electron-run CLI for testing the SDK without the UI
```

Dependency direction: sdk/* never imports electron. The Electron side (tana-session.js, main.js) injects `getAccessToken` into the SDK.

## sdk/index.js

```js
const client = createTanaClient({
  baseUrl: 'https://home.tana.inc/platform',   // default
  getAccessToken: async ({ refresh } = {}) => string,   // injected; refresh=true after a 401
  orgId: string,        // format per PLATFORM-PROTOCOL.md
  peerId: string,       // stable per install (persisted by the caller), format per protocol doc
  storageId: string,    // stable per install if the protocol needs a non-ephemeral peer; else omit and ephemeral=true
  logger: console,      // optional
});
client.graph   // GraphClient
client.sync    // SyncConnection (not connected until client.sync.connect())
await client.close();
```

## sdk/transport.js

`createTransport({ baseUrl, getAccessToken })` returns a Connect transport from @connectrpc/connect-web with `useBinaryFormat: true` and a custom `fetch` that sets `Authorization: Bearer <token>`, `connect-protocol-version: 1` (the library does this), `x-request-id` (random UUID), and any headers the protocol doc lists. On a 401 it calls `getAccessToken({ refresh: true })` once and retries. Streaming responses must pass through untouched.

## sdk/graph.js

```js
const graph = new GraphClient(transport);
await graph.listNodes({ nodeTypes, entityTypes, assignedTo, stateTypes, ownerIds, textQuery, limit, sortOptions, includeProposals, ... })
  // -> { nodes: Node[], totalCount } where Node is the plain JSON form (toJson) of tana.graph.v1alpha1.Node:
  // { id, title, createTime, updateTime, state: { type, enteredAt, changedBy }, assignedTo: [], ownerUri, entityType, restricted, ... }
await graph.listEdges({ fromNodeIds, toNodeIds, edgeTypes })
await graph.getOwnerChain(nodeId)
graph.traverse({ startNodeId, maxDepth, edgeTypes, direction })   // async iterator
```
Enum values are passed as their proto JSON names (e.g. sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }]). Keep this a thin, generic wrapper; no task logic here. Verified live: `listNodes({ nodeTypes: ['text'], assignedTo: [me], stateTypes: ['open'], limit: 500, sortOptions: [updateTime desc] })` returns the user's 48 open tasks.

## sdk/sync.js

```js
const sync = client.sync;               // EventEmitter
await sync.connect();                   // opens ServerSync, waits for the server 'peer' message, starts heartbeats/reconnect
const doc = await sync.subscribe(docId) // -> Document; performs the bootstrap sequence from the protocol doc (begin_document_sync with want_live, apply bootstrap updates, wait for bootstrap_complete); idempotent per id
await sync.unsubscribe(docId)
sync.getDocument(docId)                 // Document | undefined
sync.on('connected' | 'disconnected' | 'error', ...)
sync.on('change', (docId, { origin: 'remote' | 'local' }) => ...)
await sync.close()
```
Internals: one ServerSync stream (async iterator over the Connect server stream); a command() helper for ServerSyncCommand; a map docId -> { document, sessionId, state }. Server `live_document_update` -> `document.applyRemote(updates)`. `resync_required` -> re-bootstrap that document per the protocol doc. Stream end/error -> exponential backoff reconnect (1s..30s) and re-subscribe all documents. Local changes: Document emits 'local-update' with exported update bytes -> `live_document_update` command with the document's sessionId. Never throw out of event handlers; emit 'error'.

## sdk/document.js

```js
class Document extends EventEmitter {
  id            // 'tana:text:...'
  loro          // the LoroDoc (loro-crdt)
  data          // loro.getMap('data')
  content       // the content container (per protocol doc, tree or map)
  toJSON()      // loro.toJSON()
  transact(fn)  // fn(loro) runs local mutations; then commit, export the update since the last sent version, emit 'local-update' (bytes) and 'change'
  applyRemote(updates)   // import bytes[]; emit 'change' with origin 'remote'
  version()     // current version vector bytes (for begin_document_sync / resync)
}
```

## sdk/node.js (generic accessors, no UI knowledge)

```js
const { readNode, setTitle, setState, contentText } = require('./node');
readNode(document)      // -> { id, title, stateType, stateEnteredAt, stateChangedBy, assignedToUris, createdAt, type, ... } from data map
setTitle(document, title)            // document.transact(...) writing exactly what the web client writes (protocol doc §3)
setState(document, stateType, byUri) // writes stateType + stateEnteredAt + stateChangedBy (+ anything the web client writes)
contentText(document)   // plain text rendering of the content tree: paragraphs/headings joined by newlines, mentions rendered as their label
```
State values: use the exact stateType strings from the protocol doc (e.g. 'open', 'done'). The app maps done <-> the "completed" state type.

## tana-session.js (Electron only)

```js
const s = createTanaSession({ partition: 'persist:tana', origin: 'https://home.tana.inc' });
await s.isAuthenticated()            // GET /api/auth/session with the partition's cookies -> authenticated
await s.login()                      // opens a BrowserWindow on origin (login page), resolves when /api/auth/session reports authenticated, then closes the window
await s.getAccessToken({ refresh })  // session.fetch(origin + '/api/auth/session' + (refresh ? '?refresh=true' : '')) -> accessToken; cache until near exp (decode JWT exp)
await s.info()                       // { userUri (tana:user-profile:...), orgId, orgDocUri, organizationId, user }
await s.logout()                     // clear the partition's storage
```
Uses Electron's session.fromPartition(...).fetch so cookies are sent; Node's global fetch does not carry them. The session JSON contains at least: authenticated, user, accessToken, sessionId, organizationId, orgDocUri ('tana:org:<ulid>'), userExternalId, role, permissions. The user's profile URI: look in `user` (verify field name; it is 'tana:user-profile:<ulid>').

## main.js wiring (app level, task-specific)

Boot: db.open; session = createTanaSession(); if not authenticated -> status.authenticated=false (renderer shows "Log in to Tana"). When authenticated: info = session.info(); client = createTanaClient({ getAccessToken: session.getAccessToken, orgId, peerId (persist a UUID in userData/peer.json), ... }); refresh() = graph.listNodes(open tasks assigned to me) -> db.replaceFromTana(rows from Node JSON: id, title, done:0, space: null, updatedAt) -> subscribe each id via sync.subscribe -> send tasks:changed; unsubscribe ids no longer listed. Re-run refresh() every 60s (new/removed tasks) and immediately after a local state change settles. sync 'change' for a doc -> readNode(document) -> db upsert title/done (done = stateType is the completed type) -> tasks:changed. Renderer edits: tasks:update -> setTitle/setState on the Document (optimistic; db updated from the resulting 'change'). tasks:content -> contentText(document) (cached in db.content). Menu: Tasks > Sync with Tana (Cmd+R) runs refresh(). Keep the existing IPC contract for the renderer unchanged (tasks:list, tasks:update, tasks:content, sync:status, sync:login; events tasks:changed, sync:status). dirty/markClean in db.js become unused; delete them and the dirty column.
