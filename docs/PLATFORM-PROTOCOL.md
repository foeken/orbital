# Tana platform sync protocol (client side, reverse-engineered)

Source: Tana web bundle `shared-CEMPyt0c.js` / `bootstrap-CrXcAx1s.js` (Sept 2026), the embedded
`tana/sync/v1alpha1/sync.proto` descriptor, and one real task snapshot decoded with `loro-crdt` 1.16.
Minified identifiers are quoted as evidence. Anything marked **unverified** could not be confirmed from the bundle.

Base URL `https://home.tana.inc/platform`, Connect protocol. The browser uses binary protobuf in production
(`useBinaryFormat:we('POLARIS_ENV')!=='emulator'`); JSON is accepted by the server. Unary RPCs are plain
`content-type: application/json` POSTs. The server-streaming `ServerSync` RPC uses Connect's enveloped streaming
format (`application/connect+json`, 5-byte frame prefix), see section 4.

## 0. Wire schema (from the descriptor; field numbers and scalar types)

```
service SyncService {
  rpc ServerSync(ServerSyncRequest) returns (stream ServerSyncResponse);
  rpc ServerSyncCommand(ServerSyncCommandRequest) returns (ServerSyncCommandResponse);
  rpc GetDocumentSnapshot(GetDocumentSnapshotRequest) returns (GetDocumentSnapshotResponse);
}
Peer { string peer_id=1; bool ephemeral=2; string storage_id=3; uint32 heartbeat_interval_ms=4; }
ServerSyncRequest { string org_id=1; Peer peer=3; }
ServerSyncResponse { oneof response_union { Peer peer=1; SyncDocument sync_document=2; DocumentUnavailable document_unavailable=3;
  EphemeralMessage ephemeral=4; IncompleteSync incomplete_sync=5; BootstrapComplete bootstrap_complete=6;
  LiveDocumentUpdate live_document_update=7; ResyncRequired resync_required=8; Heartbeat heartbeat=9; } }
ServerSyncCommandRequest { string org_id=1; string peer_id=2; oneof command_union { SyncDocument sync_document=3;
  RequestDocument request_document=4; UnsubscribeDocument unsubscribe_document=5; EphemeralMessage ephemeral=6;
  BeginDocumentSync begin_document_sync=7; ApplyBootstrapUpdates apply_bootstrap_updates=8; LiveDocumentUpdate live_document_update=9;
  SubscribeEphemeralChannel subscribe_ephemeral_channel=10; UnsubscribeEphemeralChannel unsubscribe_ephemeral_channel=11;
  DocumentAction document_action=12; ViewingHeartbeat viewing_heartbeat=13; } }
ServerSyncCommandResponse { oneof response_union { DocumentUnavailable document_unavailable=1; IncompleteSync incomplete_sync=2;
  BootstrapResponse bootstrap_response=3; DocumentActionResponse document_action_response=4; } }
BeginDocumentSync { string document_id=1; bytes client_vv=2; bool ephemeral=3; bool want_live=4; }
BootstrapResponse { string session_id=1; BootstrapStatus status=2; bytes server_vv=3; bytes server_updates=4; }
ApplyBootstrapUpdates { string document_id=1; string session_id=2; bytes base_server_vv=3; bytes updates=4; }
LiveDocumentUpdate { string document_id=1; string session_id=2; repeated bytes updates=3; }
BootstrapComplete { string document_id=1; string session_id=2; bytes barrier_vv=3; }
ResyncRequired { string document_id=1; string session_id=2; string reason=3; bytes current_vv=4; RecoveryStrategy recovery=5; }
UnsubscribeDocument { string document_id=1; string session_id=2; }
ViewingHeartbeat { string document_id=1; }   EphemeralMessage { string document_id=1; bytes data=2; }
SubscribeEphemeralChannel { string channel_id=1; }  UnsubscribeEphemeralChannel { string channel_id=1; }
DocumentAction { string document_id=1; oneof action { SoftDeleteAction soft_delete=2; RestoreAction restore=3; ArchiveAction archive=4; UnarchiveAction unarchive=5; } }
GetDocumentSnapshotRequest { string document_id=1; }  GetDocumentSnapshotResponse { bytes snapshot=1; bytes version_vector=2; }
enum BootstrapStatus { UNSPECIFIED=0; EXISTING=1; MISSING=2; UNAVAILABLE=3 }
enum RecoveryStrategy { UNSPECIFIED=0; RETRY=1; DISCARD_LOCAL=2 }
```

JSON mapping (protobuf JSON as used by Connect): lowerCamelCase field names, `bytes` as standard base64 strings, oneofs
flattened (`{"beginDocumentSync": {...}}`), enums by name (`"BOOTSTRAP_STATUS_EXISTING"`). `peer_id` is a string.
`sync_document`, `request_document`, `document_unavailable`, `incomplete_sync` exist in the schema but the current client
never sends the first two and ignores the last two on the stream (see 1.3).

## 1. ServerSync (the peer stream)

### 1.1 Request

```json
{ "orgId": "org_01EXAMPLE00000000000000000",
  "peer": { "peerId": "10444520223086053979", "ephemeral": false, "storageId": "3f0c1d6e-0000-4000-8000-000000000000" } }
```

Evidence: `this.#t.serverSync({orgId:this.#e.orgId,peer:{peerId:this.#e.peerId,ephemeral:this.#e.ephemeral??!1,storageId:this.#e.storageId??''}},{signal})`.

**orgId** is the WorkOS organisation id, i.e. the `org_id` claim of the access token (`org_01EXAMPLE00000000000000000` for this
account). It is neither the Tana ULID `01exampleorg00000000000000` nor the `tana:org:` URI; those come from the separate
`urn:tana:org:id` claim and become `orgDocUri`. Evidence: session built as `organizationId:e.activeWorkosOrgId??n('org_id')`,
`orgDocUri` from `n('urn:tana:org:id')`; the sync fetch wrapper aborts when the provider org differs from the token claim:
`let s=Ve(o);if(s&&s!==r)throw … new St(r,s)` with `Ve` = `Jae` = `To(e).org_id` (decoded JWT payload). Use `session.organizationId`
from `GET /api/auth/session`; it must equal the token's `org_id`.

**peerId** is a u64 sent as a decimal string (`bTe(e){return e.toString(10)}`). Derivation (`vTe`, `nEe`):

```
userHash = BigInt(first 8 bytes of SHA-256(userExternalId.trim().toLowerCase()), big-endian) >> 16n   // 48 bits
nonce    = random in [0, 32768) for clients (server peers use [32768, 65536))                           // 16 bits
peerId   = (userHash << 16n) | BigInt(nonce)
```

`userExternalId` is the `urn:tana:user:id` claim / `session.userExternalId` (`01examplei0000000000000000` here). Verified against
real data: every peer in the decoded task snapshot (`10444520223086053979`, `10444520223086068000`, ...) has `>> 16n ==
159370730943085`, which is exactly the SHA-256 prefix of that id. Evidence: `gTe(new Uint8Array(n).subarray(0,8))>>yv`, `yv=16n`,
`JTe={client:{min:0,size:32768},server:{min:32768,size:32768}}`, `return n<<yv|BigInt(r)`. The nonce is not persisted: the
browser picks a random one per page load and holds a Web Lock `polaris:peer-nonce:<userHash>:<nonce>` so parallel tabs of the same
user get distinct nonces (`WebLocksNonceAllocator`, falling back to plain random). The same peerId is used as the Loro peer for
every non-proposal, non-fork document (`e.setPeerId(this.#h)`). A Node client should generate one per process and use it for both
the stream and `LoroDoc.setPeerId`.

**ephemeral / storageId**: the main browser client is non-ephemeral and sends a persisted `storageId` (a `crypto.randomUUID()`
stored once under key `{type:'storage-id'}` in IndexedDB database `loro-repo-<orgId>`, object store `documents`). Ephemeral
(`ephemeral:true`, `storageId:""`) is used by the guest client and in-memory repos. Evidence:
`this.#e.ephemeral?e({…,ephemeral:!0,…}):(()=>{if(!this.#d)throw Error('Non-ephemeral peer requires storageId. Call connect(storageId).')…storageId:this.#d`,
`async id(){…await this.#e.load({type:'storage-id'})…this.#t=crypto.randomUUID()`. A Node client without a persisted Loro store
should send `ephemeral:true`; with an on-disk snapshot, a stable UUID. What the server does differently for ephemeral peers is
**unverified**.

### 1.2 First response: peer

The first frame must be `peer`; anything else is fatal: `if(n.responseUnion.case!=='peer')throw Error('Expected peer info…')`.
The handshake has a 15 s timeout (`connectTimeoutMs??15e3`, "sync connect handshake timed out", DeadlineExceeded). The only field the
client reads is `heartbeatIntervalMs`: it arms a watchdog of `heartbeatIntervalMs * 3` (`DTe=3`) that is re-armed on **every**
frame; when it fires the transport is torn down and reconnected ("Sync stream watchdog elapsed — forcing reconnect"). With
`heartbeatIntervalMs == 0` there is no watchdog. `peerId`/`storageId` in the reply are ignored.

### 1.3 Frame handling (`#y` in ConnectRPCSyncTransport)

| frame | client action |
|---|---|
| `heartbeat` | re-arm the watchdog only (`e.responseUnion.case!=='heartbeat'&&this.#t.onFrame(e)`) |
| `bootstrapComplete` | if a session exists for `documentId` **and** its `sessionId` matches: push `bootstrap-complete` (`barrierVv` is logged, never imported) |
| `liveDocumentUpdate` | same doc+session check; each element of `updates` becomes one `live-update` event and is imported with `doc.import(bytes)` |
| `resyncRequired` | same check; `recovery` DISCARD_LOCAL -> wipe the local doc and re-request; RETRY/UNSPECIFIED -> re-bootstrap with backoff |
| `ephemeral` | delivered to presence listeners (`onEphemeral(documentId,data)`) |
| `sync_document`, `document_unavailable`, `incomplete_sync` | no case in the switch, silently dropped |

Frames whose `sessionId` does not match the current session for that document are dropped, so keep the `sessionId` from the
latest `BootstrapResponse` per document.

### 1.4 Reconnect and backoff

Stream end ("closed"), watchdog, network errors (Connect `Unavailable`, or `Unknown` wrapping a fetch TypeError such as
"failed to fetch") and `Unauthenticated` mid-stream all trigger reconnect. `PermissionDenied` and org mismatch terminate the
transport for good. Backoff (`ITe`): before the first successful connection `{initialDelayMs:250,maxDelayMs:5000,factor:2}`,
afterwards `{initialDelayMs:1000,maxDelayMs:30000,factor:2}`; delay = `n=min(initial*factor^attempt,max); n/2 + n/2*random()`
(`cs`). The attempt counter resets after the connection has been up for 15 s (`stableAfterMs??15e3`). On every reconnect **all
document sessions are closed** (a `disconnected` event plus best-effort `unsubscribe_document`) and re-bootstrapped from scratch
once the transport reports `connected`; ephemeral channel subscriptions are re-sent. A unary command failing with
`FailedPrecondition` whose message contains `no active streams` or `is not assigned to this pod` also forces a reconnect (`KTe`);
after five such cycles the client only logs a warning (`terminateAfterFatalCycles` is unset).

## 2. Subscribing to a document (bootstrap -> live)

All commands are unary `ServerSyncCommand` calls with the same `orgId`/`peerId` as the stream, and they only work while that
stream is open (the server routes by peer). Default unary timeout 15 s (`commandTimeoutMs??15e3`); the two bootstrap calls use 30 s
(`pv=3e4`). connect-web sends this as the `connect-timeout-ms` header.

### 2.1 begin_document_sync

Warm start (local doc exists): `clientVv = doc.oplogVersion().encode()` (Loro `VersionVector` bytes, base64 in JSON).
Cold start (no local doc): empty `clientVv` (`beginDocumentSync(new Uint8Array)`). `ephemeral` is the *document handle's* flag
(true only for liveQuery/in-memory docs; a task is `false`). `wantLive` is never set: the identifier does not occur in any bundle
(`rg -c 'wantLive|want_live' *.js` -> 0), so live updates are evidently on by default.

```json
{ "orgId": "org_01EXAMPLE00000000000000000", "peerId": "10444520223086053979",
  "beginDocumentSync": { "documentId": "tana:text:01exampleh0000000000000000", "clientVv": "", "ephemeral": false } }
```

Evidence: `commandUnion:{case:'beginDocumentSync',value:Fr(mxe,{documentId:e,clientVv:t,ephemeral:n})}` and
`let i=t.oplogVersion(),a=i.encode();…o=await n.beginDocumentSync(a)`.

The response must be `bootstrapResponse`:
`{ "bootstrapResponse": { "sessionId": "…", "status": "BOOTSTRAP_STATUS_EXISTING", "serverVv": "<b64>", "serverUpdates": "<b64>" } }`.
`sessionId` is minted by the server per (peer, document) bootstrap and must be echoed in every later command for that document; it
is also what stream frames are matched on. A new `begin_document_sync` yields a new sessionId and frames for the old one are ignored.

Status handling (`NTe`, `rTe` warm, `aTe` cold):

* `EXISTING`: continue with 2.2.
* `MISSING`: cold start -> "unavailable": retried with backoff until 60 s have passed and at least 5 attempts were made, then the
  session pauses as `not_found`. Warm start -> "unavailable" only if the local oplog is empty and the handle is not ephemeral;
  otherwise the client treats MISSING as "server has nothing yet" and **continues**, sending its whole doc as catch-up (this is how
  new documents get created). Evidence:
  `o.status==='unavailable'||o.status==='missing'&&t.oplogVersion().length()===0&&!e.ephemeral)return{type:'unavailable'}`.
* `UNAVAILABLE` (and UNSPECIFIED): "unavailable" -> retry with backoff (session state `retrying`, reason "document unavailable").
* Connect `PermissionDenied` on this call -> `permission-denied`, no retry, doc evicted. `FailedPrecondition` containing
  `system-doc-discard-local` -> discard the local copy and re-request.

### 2.2 Import server updates, compute catch-up, apply_bootstrap_updates

1. If `serverUpdates` is non-empty: `doc.import(serverUpdates)` (a single blob; for cold start into a fresh `new LoroDoc()`). If the
   import reports pending ops (missing dependencies) the client aborts with resync/retry.
2. Catch-up bytes (`oTe`):
   * `serverVv` empty: non-ephemeral -> `doc.export({mode:'snapshot'})`; ephemeral -> `doc.export({mode:'shallow-snapshot', frontiers: doc.oplogFrontiers()})`.
   * otherwise `doc.export({mode:'update', from: VersionVector.decode(serverVv)})`; `hasCatchup = doc.oplogVersion().compare(serverVv) !== 0`.
   Cold start sends an empty catch-up.
3. Send it, always, even when empty (the server waits for it before completing the bootstrap):

```json
{ "orgId": "org_01EXAMPLE00000000000000000", "peerId": "10444520223086053979",
  "applyBootstrapUpdates": { "documentId": "tana:text:01exampleh0000000000000000", "sessionId": "<from bootstrapResponse>",
                             "baseServerVv": "", "updates": "<b64 export or empty>" } }
```

`baseServerVv` is always empty (`let t=new Uint8Array;await this.#i.sendApplyBootstrapUpdates(this.docId,this.#o,t,e)`). Errors:
`PermissionDenied` -> `write-permission-denied` (read-only doc, no retry); `FailedPrecondition` containing `no bootstrap session` or
`is not in bootstrapping state` -> `session-lost`, re-bootstrap. Local edits made during bootstrap are queued
(`#r==='queue'?this.#i.push(e)`) and the queue is cleared right after the catch-up export is computed
(`onCatchupComputed:()=>{this.#b?.clearQueue()}`) because the export already contains them.

### 2.3 bootstrap_complete

Arrives on the ServerSync stream as `{"bootstrapComplete":{"documentId","sessionId","barrierVv"}}` after the server has applied the
catch-up. Only then does the session become `live`: queued local updates are flushed (`enterLive`) and inbound `liveDocumentUpdate`
frames are imported (frames that arrive before `live` are dropped: `if(this.#h!=='live')break`). The whole bootstrap has a 30 s
timeout ("Bootstrap timeout exceeded"). Session retry backoff: `{initialDelayMs:500,maxDelayMs:5000,factor:2}` with jitter; after 6
consecutive resyncs the delay is fixed at 30 s; 15 s of healthy live resets the counters.

### 2.4 Live updates

Inbound: `{"liveDocumentUpdate":{"documentId","sessionId","updates":["<b64>","<b64>"]}}`; each entry is one Loro update blob and is
imported separately with `doc.import(bytes)` (`sp` wraps `e.import(t)`). A pending-import result triggers a resync.

Outbound: the client subscribes with `doc.subscribeLocalUpdates(bytes => …)` (Loro emits one update blob per `commit()`). In live
mode blobs are coalesced with a 5 ms trailing timer (`sTe={type:'timer',ms:5}`) and sent as one command:

```json
{ "orgId": "org_01EXAMPLE00000000000000000", "peerId": "10444520223086053979",
  "liveDocumentUpdate": { "documentId": "tana:text:01exampleh0000000000000000", "sessionId": "<sessionId>",
                          "updates": ["<b64 update>", "<b64 update>"] } }
```

Only one send is in flight per document; blobs produced meanwhile are batched into the next call (`if(this.#u){this.#d.push(...e)…}`).
In-flight bytes are capped at 256 KiB per document (`outboundBudget??262144`); exceeding it raises a local resync ("outbound buffer
overflow"). Any send failure other than cancel/permission triggers a re-bootstrap; `PermissionDenied` -> `access-revoked`. Live
updates carry no version vector: the blobs are exactly what Loro emitted, and the server's `barrierVv`/`currentVv` are informational.

### 2.5 Unsubscribe, viewing heartbeat, ephemeral, actions

* Release: `{"unsubscribeDocument":{"documentId","sessionId"}}`, best-effort, after in-flight sends finish. The browser waits a 500 ms
  grace period after the last UI reference goes away (`gracePeriodMs: 500`, 0 for `tana:liveQuery:`); `tana:user-inbox:` docs are never released.
* Viewing heartbeat: `{"viewingHeartbeat":{"documentId"}}` every 10 s (`HDe=1e4`) for the document open on screen, only while the tab
  is visible and the user was active in the last 60 s (`UDe=6e4`). Presence only; failures ignored. A background client can skip it.
* Ephemeral presence: `subscribeEphemeralChannel{channelId}`, `ephemeral{documentId,data}` (opaque bytes), `unsubscribeEphemeralChannel`. Optional.
* Document actions: `documentAction{documentId, softDelete:{}}` (or `restore`/`archive`/`unarchive`) returns `documentActionResponse`.

### 2.6 GetDocumentSnapshot

`POST …/tana.sync.v1alpha1.SyncService/GetDocumentSnapshot` with `{"documentId":"tana:text:…"}` returns
`{"snapshot":"<b64 Loro snapshot>","versionVector":"<b64>"}`; 15 s client timeout; Connect `NotFound` for unknown ids. Needs no peer
stream, so it is the cheapest way to poll a task.

## 3. How the UI mutates a task document

Container layout, verified by decoding a real `tana:text:` task snapshot with loro-crdt 1.16:

| path | Loro container / value |
|---|---|
| root `data` | `LoroMap` |
| `data.title` | plain **string** value in the map (schema `title:k().optional()`), not a LoroText |
| `data.type` | string `"text"` (tasks are `text` docs carrying task fields) |
| `data.stateType`, `stateChangedBy`, `assignedToUrisChangedBy`, `ownerUri`, `createdInUri`, `entityTypeUri`, `stateWorkflowUri`, `stateWorkflowStateId`, `subtaskOfUri` | strings |
| `data.createdAt`, `stateEnteredAt`, `assignedToUrisChangedAt`, `deletedAt`, `archivedAt` | numbers, epoch **milliseconds** (`Date.now()`) |
| `data.restricted`, `isProposal`, `titleAutoGenerated`, `hasBeenPublic` | booleans |
| `data.assignedToUris` | `LoroList` of user-profile URI strings (schema `Nc.list(ha)`, `getContainerType:()=>'List'`; the snapshot shows `cid:3@…:List`, not a MovableList) |
| `data.sharedPinDates` | `LoroList` of maps |
| `data.participants`, `attributes`, `externalIds`, `appearance` | nested `LoroMap`s (`participants[uri] = {type:'user', role:'admin'}`) |
| root `content` | `LoroMap` (`cid:root-content:Map`) holding a ProseMirror-style node `{nodeName:'doc', attributes: Map, children: List}`; the schema marks it `Nc.unmanaged()` and code reads it via `doc().getMap('content')`. It is **not** a LoroTree. |

Task schema (`gce`): `assignedToUris, assignedToUrisChangedBy, assignedToUrisChangedAt, stateType, stateEnteredAt, stateChangedBy,
stateWorkflowUri, stateWorkflowStateId, subtaskOfUri` on top of the common fields (`oce`): `type, title, titleAutoGenerated, ownerUri,
createdAt, sharedPinDates, deletedAt, retentionPurgeAfter, archivedAt, archivedBy, restricted, hasBeenPublic, participants,
createdInUri, isProposal, externalIds`.

**stateType values**: `Hc=['proposed','open','closed','not_now']` with UI labels
`Uc={proposed:'Inbox',open:'In Progress',closed:'Completed',not_now:'Later'}`. There are no `done`/`later`/`inbox` strings; the
MCP-facing names "In Progress"/"Completed" are these labels. A doc with no `stateType` is not a task (`clearState` deletes
`stateType`, `stateEnteredAt`, `stateChangedBy` and the workflow fields).

Mutations go through loro-mirror (`mirror.setState(draft => …)`), which diffs the draft against the doc and emits map set/delete and
list ops, followed by `doc.commit()` (`_commitPendingOps(){this.handle.doc().commit()}`). Docs are configured with
`setRecordTimestamp(true)` and `setChangeMergeInterval(60)` (`recordTimestamp:!0,changeMergeIntervalSeconds:60`). No `updatedAt`
field is written anywhere.

Title edit (`setTitle`): `n.title=e,delete n.titleAutoGenerated`:

```js
const data = doc.getMap('data');
data.set('title', newTitle);
data.delete('titleAutoGenerated');
doc.commit();
```

State change (`transitionTo(stateType, changedBy)`), evidence:
`typeof e=='string'?(n.data.stateType=e,n.data.stateEnteredAt=r,n.data.stateChangedBy=t,delete n.data.stateWorkflowUri,delete n.data.stateWorkflowStateId):(n.data.stateType='open',n.data.stateEnteredAt=r,n.data.stateChangedBy=t,n.data.stateWorkflowUri=e.workflowId,n.data.stateWorkflowStateId=e.workflowStateId)`
with `r=Date.now()`:

```js
data.set('stateType', 'closed');                 // 'proposed' | 'open' | 'closed' | 'not_now'
data.set('stateEnteredAt', Date.now());          // ms
data.set('stateChangedBy', 'tana:user-profile:01examplei0000000000000000'); // acting user's profile doc URI
data.delete('stateWorkflowUri');                 // plain states drop workflow fields
data.delete('stateWorkflowStateId');
doc.commit();
```

Workflow-backed states set `stateType='open'` plus `stateWorkflowUri`/`stateWorkflowStateId`. Reassignment rewrites the
`assignedToUris` list and sets `assignedToUrisChangedBy`/`assignedToUrisChangedAt`. `stateChangedBy` must be a `tana:user-profile:`
URI (`ha=k().refine(pa)`, `pa(e){return Bi(e)?.type==='user-profile'}`); for the current user it is
`tana:user-profile:<urn:tana:user:id claim>`, which matches the decoded snapshot. Whether specific UI actions touch other fields
(e.g. "Later" and `sharedPinDates`) is **not determined**.

## 4. Transport details a Node client must replicate

Headers (`cEe` interceptors plus the auth fetch wrapper in bootstrap):

| header | value |
|---|---|
| `authorization` | `Bearer <accessToken>` from `GET /api/auth/session` |
| `content-type` | `application/json` (unary) / `application/connect+json` (ServerSync stream). Browser: `application/proto` / `application/connect+proto` |
| `connect-protocol-version` | `1` |
| `connect-timeout-ms` | set by connect-web from `timeoutMs`: 15000 for commands, 30000 for begin/apply bootstrap, 15000 for GetDocumentSnapshot, none for the stream |
| `x-client-name` | `browser` (`browser-guest` for guests): `n.header.set('x-client-name',e)`. Send your own name |
| `x-request-id` | `crypto.randomUUID()` per request when absent (`sEe`) |
| `x-session-id` | only when the app has one (`l&&c.set('x-session-id',l)`): the auth session id (`session.sessionId`, from the token's `sid` claim). Optional for a third-party client; server use beyond logging is **unverified** |
| `X-Shard-Override` | dev only (`?shard=` query param); do not send |

Connect streaming envelope (needed for `ServerSync` over JSON): POST `…/tana.sync.v1alpha1.SyncService/ServerSync` with body
`0x00 + uint32BE(len) + json`. The response body is a sequence of frames `flags(1) + uint32BE(len) + payload`; flag `0x02` marks
the final EndStreamResponse (`{}` or `{"error":{"code":…,"message":…}}`). Keep the response open and parse frames incrementally.

Auth refresh: unary sync requests are retried once on HTTP 401 after `getAccessToken({forceRefresh:true})`, then the app signs out
(`shouldRetry:Ei` = `e.status===401`, `maxRetries:1`). The streaming interceptor (`vi`) retries the ServerSync call once when it
fails with Connect `Unauthenticated` before any frame arrived, after refreshing. Refresh = `GET <authBase>/auth/session?refresh=true`
with cookies (`credentials:'include'`) and `x-session-id`. The JSON carries `authenticated, accessToken, sessionId, organizationId,
orgDocUri, userExternalId, user{id,email,firstName,lastName,profilePictureUrl}, role, permissions, featureFlags`. The app refreshes
proactively at `exp - 60 s` (minimum 5 s; `Qae` with `Xae=6e4, Zae=5e3`) and caches an unauthenticated answer for 30 s (`Ao=3e4`).
A Node client should decode `exp` from the JWT, refresh a minute early, and retry a 401 once with a fresh token.

Limits and timeouts: no client-side `readMaxBytes`/`writeMaxBytes` are configured (connect-web defaults); the only size control is
the 256 KiB in-flight outbound budget per document. Server-side limits are **not determinable** from the bundle. Bootstrap must finish
within 30 s, the peer handshake within 15 s, and a stream silent for longer than 3 x `heartbeatIntervalMs` is treated as dead.

Loro settings to match the browser: `doc.setPeerId(peerId)`, `doc.setRecordTimestamp(true)`, `doc.setChangeMergeInterval(60)`,
loro-crdt 1.x (the app's exact pin is not visible; 1.16 decodes its snapshots and updates).

## 5. Minimal Node sequence (JSON)

```
1. sess = GET /api/auth/session -> accessToken, organizationId (org_…), userExternalId
2. peerId = (((sha256(userExternalId.toLowerCase())[0..8] as u64) >> 16) << 16 | rand(0..32767)).toString()
3. POST /platform/tana.sync.v1alpha1.SyncService/ServerSync  (application/connect+json, enveloped)
   {"orgId":sess.organizationId,"peer":{"peerId":peerId,"ephemeral":true,"storageId":""}}
   first frame -> {"peer":{"heartbeatIntervalMs":N}}; watchdog = 3N; ignore "heartbeat" frames
4. POST …/ServerSyncCommand {"orgId","peerId","beginDocumentSync":{"documentId":uri,"clientVv":b64(doc.oplogVersion().encode()) or "","ephemeral":false}}
   -> bootstrapResponse{sessionId,status,serverVv,serverUpdates}; if serverUpdates: doc.import(bytes)
5. catchup = serverVv ? doc.export({mode:'update',from:VersionVector.decode(serverVv)}) : doc.export({mode:'snapshot'})
   POST …/ServerSyncCommand {"orgId","peerId","applyBootstrapUpdates":{"documentId","sessionId","baseServerVv":"","updates":b64(catchup)}}
6. wait for stream frame {"bootstrapComplete":{documentId,sessionId}} -> live
7. inbound {"liveDocumentUpdate":{updates:[…]}} -> doc.import(each)
   local: doc.subscribeLocalUpdates(u => queue); flush after 5 ms ->
   POST …/ServerSyncCommand {"orgId","peerId","liveDocumentUpdate":{documentId,sessionId,updates:[b64…]}}
8. {"resyncRequired"} or stream loss -> drop the session, back to 3/4 with backoff; on exit POST {"unsubscribeDocument":{documentId,sessionId}}
```

## 6. Not determined

* Server behaviour for `ephemeral:true` peers (retention of pending updates, presence) and whether it validates peerId ranges or
  `storageId` reuse.
* Server-side maximum message size, and the semantics of `want_live`, `request_document`, `sync_document`, `incomplete_sync`
  (all unused by this client).
* Whether `x-session-id` is required; the browser sends it only when it has one.
* The internal schema of the `content` map beyond `{nodeName, attributes, children}` (editor-owned; edit bodies through the MCP API instead).

