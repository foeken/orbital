# Pinning in the new Tana (home.tana.inc)

Reverse-engineered from `/tmp/tana-bundles/shared-CEMPyt0c.js` (Sept 2026), the graph.proto descriptor, and live read-only probes
of this account's documents on 2026-09-13. Minified identifiers are quoted as evidence. Nothing here required an RPC other than
the normal document sync (`begin_document_sync` / `apply_bootstrap_updates` / `live_document_update`, see PLATFORM-PROTOCOL.md).

## TL;DR

| pin target | document written | container / key | element shape |
|---|---|---|---|
| user's sidebar | `tana:collection:<id>` referenced by `userProfile.data.pinnedCollectionUri` | root `tree` (LoroTree) | tree node whose `data` map is `{uri}` (or `{label}` for a section folder) |
| a date (Today view), personal | `tana:pin-map:<id>` referenced by `userProfile.data.pinMapUri` | root `entries` (LoroMap) → `entries[docUri].pins` (LoroList) | `{type:'plain', datetime:'YYYY-MM-DD', pinnedAt:<ms>}` |
| a date, shared with everyone | the pinned document itself | `data.sharedPinDates` (LoroList) | same shape as above |
| an event or a space | the event / space document | root `pinnedItems` (LoroMovableList) | `{uri, mode?: 'document'|'embed'}` |

Sidebar and date pins are private per-user state and never appear in the graph service. `EDGE_TYPE_HAS_PIN` edges exist only for
event/space `pinnedItems` (from = event/space, to = pinned doc) and are derived server-side; nothing writes them.

## 1. Sidebar pins

The user-profile document (`tana:user-profile:<urn:tana:user:id>`, the `userUri` from `whoami`) carries two pointers in its `data` map.
Schema `due`:

    data:Nc.map({name, displayName, role, profileImageUri, versionIndexUri, pinMapUri:Wi.optional(), pinnedCollectionUri:Wi.optional(), calendarSubscriptionUris, ...})

Live (this account):

    pinnedCollectionUri: "tana:collection:01example80000000000000000"
    pinMapUri:           "tana:pin-map:01example90000000000000000"

The sidebar is that `collection` document. Schema `Ade`:

    kde=Nc.map({uri:Wi.optional(),label:k().optional()})
    Ade=Nc.schema(Ic({data:Nc.map(Fc({description:k().optional()})), tree:Nc.tree(kde,{required:!1})}))

so root container `tree` is a **LoroTree**; each tree node's `data` (Loro node meta map) holds either `uri` (a pin) or `label` (a section
folder; pins can be children of a folder). The mutation the web client and the `pinItem` MCP tool use (`ixe` = collection mutations):

    addNode(e,t){this.mutate(n=>{n.tree||=[];let r={id:"",data:{uri:e},children:[]};t===void 0?n.tree.push(r):n.tree.splice(t,0,r)})}
    addChildNode(e,t,n){... let a={id:"",data:{uri:t},children:[]}; ... i.node.children.push(a) ...}
    removeNode(e){this.mutate(t=>{if(!t.tree)return;let n=fh(t.tree,e);n&&n.parent.splice(n.index,1)})}
    addFolder(e,t,n){... let i={id:"",data:{label:e},children:[]} ...}

loro-mirror turns `id:""` into `tree.createNode(parent, index)` and writes `data.uri` on the new node. Sidebar pin (`Xmt`, target = sidebar):

    async function Xmt(e,t){let n=await e.userProfile(t),r=n.pinnedCollectionUri,i=r?await e.collection(r):void 0;
      return{where:"your sidebar",alreadyPinned:()=>new Set(i?Vh(i.tree??[]):[]),
        pin:async n=>{let r=i??await Lh(e,t),a=new Set(Vh(r.tree??[])),o=n.filter(e=>!a.has(e));
          return o.length>0&&r.change(e=>{for(let t of o)e.addNode(t)}),{changed:o,newPins:o,unmuted:[]}},
        unpin:async t=>{... zh(r.tree??[],t) ... r.change(e=>e.removeNode(i.id)) ...}}}
    function Vh(e,t=[]){for(let n of e)n.data.uri!=null&&t.push(n.data.uri),Vh(n.children,t);return t}   // all pinned uris, recursive
    function zh(e,t){for(let n of e){if(n.data.uri===t)return n;let e=zh(n.children,t);if(e)return e}}  // find node by uri

Pin = append a root tree node with `data.uri` (dedup by uri first, `Vh`). Unpin = find the node whose `data.uri` matches (anywhere in the tree) and delete it.
The UI's drag/drop pin path (`U_` = `useUserPinnedCollection`) is the same: `i?r.moveNode(i.id,t??void 0,n):t?r.addChildNode(t,e,n):r.addNode(e,n)`.

If the profile has no `pinnedCollectionUri` yet, the client creates one and stores the pointer (`Lh`):

    function Ih(e,t){return e.createCollection({ownerUri:t,acl:{restricted:!0,participants:[{uri:t,role:"admin"}]}})}
    async function Lh(e,t){let n=await e.userProfile(t),r=n.pinnedCollectionUri;if(r)return e.collection(r);let i=Ih(e,t);return n.change(e=>e.setPinnedCollectionUri(i.uri)),i}

Live tree of this account's sidebar collection (after the user pinned "Test Pin"):

    tree[0]  meta {uri:"tana:text:01examplea0000000000000000"}   <- "Test Pin"   (id 0@10444520223086040176, fractional_index "80")
    tree[1]  meta {uri:"tana:text:01exampleb0000000000000000"}                    (fractional_index "817C80")
    tree[2]  meta {label:"Studio"}  children: five {uri:"tana:space:..."} nodes  (section folder)

Ordering is Loro's fractional index (loro-crdt 1.16 has it on by default; the bundle never calls `enableFractionalIndex`). Deleted nodes remain
in `tree.nodes()` under the Loro deleted root `2147483647@18446744073709551615`; use `tree.toJSON()` / `roots()` which skip them. Spaces, agents,
types and skills may be sidebar-pinned; the MCP tool refuses them for dates/events/spaces (`qmt`, "Spaces, agents, types, and skills can only be pinned to the sidebar").

## 2. Date pins (Today view)

Two layers, both keyed by `YYYY-MM-DD` strings:

**Personal** (what "pin to date" / the `pinItem` tool with `target:'date'` writes): the user's `pin-map` document. Schema `mue`:

    Pc=Nc.map({type:o(["plain","zoned","floating","fixed"]),datetime:k(),timezone:k().optional(),pinnedAt:m().optional()})
    pue=Nc.map({pins:Nc.list(Pc),mutedPins:Nc.list(Pc)})
    mue=Nc.schema({data:Nc.map({restricted:_().optional(),participants:Nc.record(ace,{required:!1})}),entries:Nc.record(pue)})

Mutations (`Gbe`, wrapped by `qm` = PinMap):

    addPersonalPin(e,t){this.mutate(n=>{n.entries[e]||(n.entries[e]={pins:[],mutedPins:[]});let r=n.entries[e];
      if(r.pins||=[],!r.pins.some(e=>Am(e,t))){let e=Date.now();
        t.type==="zoned"?r.pins.push({type:t.type,datetime:t.datetime,timezone:t.timezone,pinnedAt:e}):r.pins.push({type:t.type,datetime:t.datetime,pinnedAt:e})}})}
    removePersonalPin(e,t){... let i=r.pins.findIndex(e=>Am(e,t));i!==-1&&r.pins.splice(i,1) ...}
    mutePin / unmutePin: same on r.mutedPins            // "hide on this date" without removing a shared pin
    function Am(e,t){if(e.type!==t.type)return!1;if(e.type==="plain")return e.datetime===t.datetime; ...}
    function Qp(e){return{type:"plain",datetime:e.toString()}}   // e = Temporal.PlainDate -> "YYYY-MM-DD"

The MCP router validates `/^\d{4}-\d{2}-\d{2}$/` and `Temporal.PlainDate.from` (`Kmt`), then (`Ymt`): `r={type:'plain',datetime:n}`; pin = for each uri
`unmutePin(uri,r)` if muted else `addPersonalPin(uri,r)`; unpin = `removePersonalPin(uri,r)`. The pin-map is created on demand (`Fh`) as
`createPinMap({ownerUri})` with ACL `{restricted:true, participants:{[owner]:{type:'user',role:'admin'}}}` and `entries={}`, then `userProfile.setPinMapUri(uri)`.
Only `type:'plain'` is ever written by the UI; the other types exist in the schema only.

Live pin-map of this account:

    entries["tana:text:01examplea0000000000000000"] = { pins:[{type:"plain",datetime:"2026-09-13",pinnedAt:1789305626389}], mutedPins:[] }
    entries["tana:text:01exampleb0000000000000000"] = { pins:[{type:"plain",datetime:"2026-09-13",pinnedAt:1789305739115}], mutedPins:[] }
    entries["tana:text:01examplec0000000000000000"] = { pins:[{type:"plain",datetime:"2026-09-09",pinnedAt:1788964763565}], mutedPins:[] }

"Test Pin" has `createdAt:1789305626382` and its date pin `pinnedAt:1789305626389` (7 ms later): creating a document from the Today view pins it to that day automatically.
`pinnedAt` is epoch ms; `datetime` is the calendar day in the user's local zone, no timezone field.

**Shared** (visible to everyone with access): `data.sharedPinDates` on the pinned document itself, same element shape. Every `create` initialises it to `[]`:

    addPinDate(e){this.mutate(t=>{t.data.sharedPinDates||(t.data.sharedPinDates=[]),
      t.data.sharedPinDates.some(t=>t.type==="plain"&&t.datetime===e)||t.data.sharedPinDates.push({type:"plain",datetime:e,pinnedAt:Date.now()})})}
    removePinDate(e){... findIndex(t=>t.type==="plain"&&t.datetime===e) ... splice ...}

The Today view merges both (`getEffectivePins`): shared dates from the doc, personal dates from the pin-map, minus `mutedPins`
(`l.set(e,{date:e,isShared:!0,isMuted:c.has(e)})` ... `{date:e,isShared:!1,...}`). The `pinItem` tool and the pin context menu (`sA`) write the personal layer;
"Test Pin" has `sharedPinDates: []` live. Listing "what is pinned to day D" = `getEntitiesWithPinsInRange`: scan `entries` for plain pins whose `datetime` is in the range
and not muted; there is no per-user daily document.

## 3. Listing the current sidebar pins

Subscribe `tana:user-profile:<id>`, read `data.pinnedCollectionUri`, subscribe that `tana:collection:` doc and walk `getTree('tree').toJSON()`: nodes with `meta.uri` are
pins (in sidebar order, folders are nodes with `meta.label` and `children`). Both docs stream live updates, so a subscription is enough to keep the list current.
If `pinnedCollectionUri` is missing the user has no pins yet (the web client creates the collection lazily). The web client keeps the profile subscribed for the
session and the collection via `useUserPinnedCollection`; the same for `pinMapUri` (`rwe`, with a stale-reference recovery that clears `pinMapUri` when the pin-map doc is unavailable).

The SDK's read-only `sidebarTree(sync, userUri)` preserves this as `[{ uri?, label?, children }]` in LoroTree order. A `label` is evidence of a folder node, not an access rule; the schema allows `uri` and `label` independently, so consumers must retain both if present. `listSidebar` is only the legacy depth-first URI projection. We have observed labelled root folders with child pins and unsectioned root pins, but not a nested-folder or combined URI/label node in a live collection.

"Is this document pinned at all", for a whole list of rows, is the same two documents read once rather than a `pinState` per row: `listSidebar` plus `datePinned(sync, userUri)`, which walks the pin-map's `entries` and keeps the keys that still hold a `plain` pin — an entry survives its last unpin as an empty `pins` list, so the key being there is not a pin. Main exposes the union as `pinnedUris()` / `api.pinIds()` for the pin mark the outliner draws on a row.

The other direction — "which meetings and spaces is *this* document pinned on" — is the derived edge read backwards: `ListEdges({ toNodeIds: [doc], edgeTypes: ['EDGE_TYPE_HAS_PIN'] })` answers with one edge per hub (verified live on 2026-09-21: `tana:event:…` → a task pinned on it), and one `ListNodes` over those ids gives their titles. `main/pins.js pinHubs` is that pair, and `pinState(id)` returns it as `hubs: [{ id, title, kind }]` beside `sidebar` and `dates`. It is a server-derived view of the hub's own `pinnedItems`, so a pin this app has just written is in the hub document before the edge exists — which is why `related()` reads the list itself as well (section 6).

## 4. Events and spaces

Different container, same document-sync mechanism. Event (`ode`) and space (`Lle`) docs have a root **MovableList** `pinnedItems`:

    Nle=o(["document","embed"]), Ple=Nc.map({uri:Wi,mode:Nle.optional()}), Fle=()=>Nc.movableList(Ple,e=>e.$cid,{required:!1})
    jm: a re-pin of a uri already there sets its mode (when one is given) and leaves it in place; otherwise push or splice at the index
    Mm: pinnedItems.filter(e=>e.uri!==t)    (every copy goes)
    Tue: reading dedups on uri, the first copy wins

(Named `wm`/`Tm` in builds before 2026-09-22; the behaviour is the same.)

`eK` (the MCP path for target event/space) calls `e.pinItem(uri)` / `e.unpinItem(uri)` and dedups on `pinnedItems.map(e=>e.uri)`. Live example
(`tana:event:01exampled0000000000000000`): `pinnedItems:[{mode:"embed",uri:"tana:chat:01examplee0000000000000000"}]`, and `ListEdges({fromNodeIds:[event],edgeTypes:['EDGE_TYPE_HAS_PIN']})`
returns `{fromNodeId:event, toNodeId:that chat, type:'EDGE_TYPE_HAS_PIN'}`. The UI reads those edges (`ny({predicate:{edgeTypes:[ag.HAS_PIN]},subject:{uris:events}})`) to show
meeting outputs; `HAS_PIN` is derived from `pinnedItems` by the server. No HAS_PIN edge exists for "Test Pin" (sidebar + date pinned), for the user profile, or from the collection.
A space without pins has no `pinnedItems` container at all (`tana:space:01examplef0000000000000000` root keys: `data, appearance`).

## 5. SDK recipe (matches the web client byte-for-byte in shape)

Everything is ordinary Loro mutations on subscribed documents, sent as `live_document_update`. Docs need the same setup as any other
(`setPeerId`, `setRecordTimestamp(true)`, `setChangeMergeInterval(60)`), which `sdk/document.js` already does.

    const { LoroMap, LoroList } = require('loro-crdt');
    const me = (await session.info()).userUri;                 // 'tana:user-profile:...'
    await client.sync.connect();
    const profile = await client.sync.subscribe(me);
    const { pinnedCollectionUri, pinMapUri } = profile.data.toJSON();

    // --- sidebar ---
    const col = await client.sync.subscribe(pinnedCollectionUri);   // tana:collection:...
    const tree = col.loro.getTree('tree');
    const pins = () => tree.toJSON().flatMap(function f(n) { return [...(n.meta.uri ? [n.meta.uri] : []), ...n.children.flatMap(f)]; });
    // pin (append at the end, as pinItem does; pass an index to createNode(undefined, i) to place it)
    if (!pins().includes(uri)) col.transact((loro) => { loro.getTree('tree').createNode().data.set('uri', uri); });
    // unpin
    col.transact((loro) => { const t = loro.getTree('tree'); const n = t.nodes().find((n) => !n.isDeleted() && n.data.get('uri') === uri); if (n) t.delete(n.id); });

    // --- date (personal) ---
    const pm = await client.sync.subscribe(pinMapUri);               // tana:pin-map:...
    const date = '2026-09-13';                                       // YYYY-MM-DD, user's local day
    pm.transact((loro) => {
      const entries = loro.getMap('entries');
      let entry = entries.get(uri);
      if (!entry) { entry = entries.setContainer(uri, new LoroMap()); entry.setContainer('pins', new LoroList()); entry.setContainer('mutedPins', new LoroList()); }
      const list = entry.get('pins');
      if (!list.toArray().some((p) => p.type === 'plain' && p.datetime === date)) list.push({ type: 'plain', datetime: date, pinnedAt: Date.now() });
      const muted = entry.get('mutedPins'); const mi = muted.toArray().findIndex((p) => p.type === 'plain' && p.datetime === date); if (mi >= 0) muted.delete(mi, 1);
    });
    // unpin from date: delete the matching element from entry.get('pins')

    // --- date (shared, on the document itself) ---
    doc.transact((loro) => { const l = loro.getMap('data').get('sharedPinDates'); if (!l.toArray().some((p) => p.type === 'plain' && p.datetime === date)) l.push({ type: 'plain', datetime: date, pinnedAt: Date.now() }); });

    // --- event / space ---
    ev.transact((loro) => { const l = loro.getMovableList('pinnedItems'); if (!l.toArray().some((p) => p.uri === uri)) l.push({ uri /*, mode: 'embed' */ }); });

Expectation: after the `live_document_update` for the collection is acked, the item appears in the open Tana tab's sidebar immediately (the sidebar is a live
subscription of the same collection doc); the date pin appears in the Today view for that day; an event pin shows under the meeting and gets a
server-derived `HAS_PIN` edge. First-time users: if `pinnedCollectionUri`/`pinMapUri` is absent, create `tana:collection:<ulid>` / `tana:pin-map:<ulid>` with
`data.type`, `data.createdAt`, `data.ownerUri=me`, `data.restricted=true`, `data.participants[me]={type:'user',role:'admin'}` (pin-map: `entries` map, no `ownerUri`; collection: also
`sharedPinDates=[]`), subscribe them (cold-start create as in `platform-cli create`), then set the pointer on the profile doc. Untested here (this account already has both).

## 6. Event pins, written and read back (verified 2026-09-14)

The event branch of section 4 is no longer only an expectation. On a throwaway meeting (`create --kind meeting`, deleted afterwards) the app's own path
(`sdk/pins.js pinItem` -> `main nodePin` -> an ordinary `live_document_update`, no new RPC) produced, read back in a fresh process that bootstrapped the
document from the server:

    pinnedItems: @MovableList [ @Map { uri: "tana:text:01exampleg0000000000000000" } ]
    ListEdges(fromNodeIds:[event], edgeTypes:['EDGE_TYPE_HAS_PIN']) -> { fromNodeId: event, toNodeId: that text doc, type: 'EDGE_TYPE_HAS_PIN' }

So the element is a map container (as the schema says, and as the pin-map entries above are written), the server keeps it, and it derives `HAS_PIN` within
seconds. `main related()` therefore reads `pinnedItems` off the hub as well as the edges: a pin this app just wrote is in the document before the edge exists.
The gate on writing one is `access.canWrite` on the hub, never `sdk/node.js editable()`, which answers about the title and is `false` for every event.
Unverified in the other direction: `unpinItem` was only exercised offline (mirror convergence in `scripts/sdk-check.js`), because the scratch event was gone
before it could be undone live. Note that `create --kind meeting` puts a real entry in the connected calendar; that scratch event acquired an `externalId`
and then a `deletedAt` about 30 seconds later, from outside this app.

Not verified: whether the server enforces that only the profile owner may edit the collection/pin-map (ACLs say `restricted:true`, owner admin), and
what the UI does with `pinnedAt` beyond dedup (it is written but never read in the bundle paths above).
