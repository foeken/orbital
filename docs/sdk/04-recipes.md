# SDK recipes

Every recipe has a CLI twin: `node scripts/platform-cli.js <cmd>` — run it with node, never with `./node_modules/.bin/electron`, which aborts in AppKit inside an agent sandbox instead of refusing cleanly (docs/ELECTRON-SANDBOX.md); the file re-execs Electron itself for the cookie session and shares userData with the app. Run it with no command for the full list, grouped by what it touches and marking every command that writes: that list is the only one kept up to date, so it is not copied here.

Read-only diagnostics for questions about what the app shows, all safe against real data:

| Command | Answers |
|---|---|
| `inspect <id…>` | The graph node, owner chain, data map and resolved audience for one document: the whole input to a visibility label and a tag colour. |
| `audiences [--limit n] [--mine 0] [--kind text\|event]` | The visibility label the app would show for a whole set of documents, with a count per label. Use it to find every remaining `unknown`. |
| `refs <id>` | Embed blocks of a document resolved through the app's real `outlineWithReferences` (main/documents.js). |
| `rows <query>` | Search results as the Nodes the renderer receives (icon, hue, tags). |
| `pinrows` | The sidebar pin tree as the renderer receives it: the only path where a space becomes a row. |
| `graphnode <id>` | The raw graph Node JSON for one id: attributes, typeDef, calendarEvent, appearance — everything `inspect` summarises away. |
| `edges <id>` | Raw `ListEdges` in both directions, for learning how Tana links things (pins, outcomes, recordings). See ../MEETINGS.md. |
| `fields [<type uri>]` | Every type that defines fields with their keys and titles; with a type uri, that type's instances and their values. |
| `boot [--settle ms]` | Runs the app's real startup path (session → client → sync → first refresh) and reports elapsed time, final status and every warning or error logged. Nothing is written: bootstrap and catch-up carry no local ops. |

## Get a token (outside Electron)

The SDK only needs `getAccessToken({ refresh })`. In the app it comes from `tana-session.js` (cookie partition + `GET /api/auth/session`). Outside Electron you need a logged-in cookie jar for home.tana.inc; there is no API-key path. The token's `org_id` claim is the `orgId` to pass; `userExternalId` from the session JSON feeds `derivePeerId`.

## Bootstrap a client

```js
const { createTanaClient, derivePeerId } = require('./sdk');
const client = createTanaClient({ getAccessToken, orgId, peerId: derivePeerId(userExternalId), storageId });
await client.sync.connect();            // needed for subscribe/create/delete/pins; graph works without it
```

## List my open tasks / this week's meetings

```js
const { nodes } = await client.graph.listNodes({ nodeTypes: ['text'], assignedTo: [me], stateTypes: ['open'], limit: 500,
  sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
const { nodes: events } = await client.graph.listNodes({ nodeTypes: ['event'], hasParticipantUris: [me],
  eventStartTimeMin: startISO, eventStartTimeMax: endISO, limit: 300,
  sortOptions: [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] });
```
Or via the view builder: `viewParams({ types: ['tasks'], states: ['proposed', 'open'], assignee: 'me' }, me)` asks for my open tasks (the Library preset is `VIEW_PRESETS.library`: every state, anyone, completed within 3 days), and `viewParams({ types: ['meetings'], participant: 'me', window: 'recent' }, me)` the one a meetings search stores (docs/VIEWS.md).

## Read and edit a document live

```js
const { readNode, setTitle, setState } = require('./sdk/node');
const content = require('./sdk/content');
const doc = await client.sync.subscribe('tana:text:…');       // resolves after bootstrap_complete, when live
readNode(doc).title; content.readOutline(doc);
client.sync.on('change', (id, { origin }) => { /* re-read */ });
setTitle(doc, 'New title');                                    // one undo step, sent within 5 ms
setState(doc, 'closed', me);                                   // complete a task
const id = content.insertAfter(doc, null, 'A new paragraph'); content.indent(doc, id);
doc.undo();
```

## Create and delete a document

```js
const { ulid, initDocument } = require('./sdk/node');
const id = 'tana:text:' + ulid();                              // 'tana:event:' for a meeting
const doc = await client.sync.subscribe(id, (loro) => initDocument(loro, 'Title', me, { kind: 'task' }));
await client.sync.softDelete(id);                              // graph queries stop returning it
await client.sync.restore(id);                                 // native restore; needs the stream open
```
The low-level sync commands require an open stream and do not perform the app's capability check. The app path checks `access.canDelete` and the server action response first, then records delete/restore in global history. The server adopts Tana-created events as real calendar events (adds organizer, externalId, a "Tana Meeting" action).

## Search with filters

```js
const { parseQuery, searchParams, needsTypes } = require('./sdk/query');
const parsed = parseQuery('sam #task');
const params = searchParams(parsed, needsTypes(parsed) ? typesByLowerTitle : new Map());
const { nodes } = await client.graph.listNodes({ ...params, limit: 40 });
```
There is no server-side title match: rank exact/prefix/contains title hits above full-text hits yourself (main/views.js `search` does).

## Where does a document live?

```js
const { entries } = await client.graph.getOwnerChain(id);      // nearest-first, includes self
const owners = entries.map((e) => e.uri).filter((u) => u !== id).reverse(); // root first; [] = Library
const { nodes } = await client.graph.listNodes({ nodeIds: owners, limit: owners.length }); // titles
```

## Pins

```js
const pins = require('./sdk/pins');
await pins.listSidebar(client.sync, me);
await pins.pinSidebar(client.sync, me, docUri); await pins.pinDate(client.sync, me, docUri, '2026-09-13');
const section = await pins.addSection(client.sync, me, 'This week');          // a node id
await pins.placePin(client.sync, me, docUri, { section, index: 0 });          // added, or moved when already pinned
```

## Which meeting am I in right now?

```js
const calls = require('./sdk/calls');
const [live] = await calls.currentCalls(client, me);   // [] when not in a call
// live = { callUri, eventUri, title, joinedAt, otherUserUris, transcriptUri, screenShareUri }
```
An event with `startTime` around now and me in `calendarEvent.roster` proves I was invited, never that I turned up.
Attendance is the call document (02-data-model.md section 5): `calls.inCall(doc, me)` for one meeting I already have,
`calls.attended(doc)` for who was there earlier. `node scripts/platform-cli.js incall` is the same call from the CLI.

## What did a call leave behind?

```js
const call = await client.sync.subscribe(callUri);
const { summaryUri, recordings, presentations, guests } = calls.callState(call);
const { transcriptUri } = calls.callSessions(call);
const { segments, sections } = calls.readTranscript(await client.sync.subscribe(transcriptUri));
```
`node scripts/platform-cli.js callstate <call id>` prints both, the transcript as counts and section labels.

## Images in content

```js
const { fetchImage } = require('./sdk/assets');
for (const n of content.readOutline(doc)) if (n.type === 'image') { const { mime, bytes } = await fetchImage(n.image.uri, { getAccessToken }); }
```

Adding one, in Tana's order — bytes, then the image document, then the block — so no block names an image that does not exist:

```js
const { uploadFile, initImage } = require('./sdk/assets');
const up = await uploadFile(bytes, { filename: 'shot.png', mimeType: 'image/png', getAccessToken });
const uri = 'tana:image:' + ulid();
await client.sync.subscribe(uri, (loro) => initImage(loro, { ownerUri: doc.id, cid: up.cid, width: up.width, height: up.height, blurhash: up.blurhash, filename: 'shot.png', mimeType: 'image/png', fileSize: bytes.length }));
content.insertImage(doc, afterBlockId, uri);
```

## Testing without Tana

`scripts/sdk-check.js` shows the patterns: two `Document`s wired `local-update → applyRemote` converge without a server; a fake `SyncService` built with `createRouterTransport` from `@connectrpc/connect` exercises connect/bootstrap/live/resync/create/close; `scripts/fixtures/task-snapshot.b64` is a synthetic task snapshot with a real one's shape (`LoroDoc.fromSnapshot`; rebuilt by `scripts/fixtures/make-task-snapshot.js`). `scripts/livequery-check.js` and `scripts/presence-check.js` do the same for live queries and presence.
