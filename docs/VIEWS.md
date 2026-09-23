# VIEWS.md — one screen, one query, three presets

Inbox, Library and Types are **the same view**: one list of graph rows with a filter on it. A view
is a preset filter plus a persisted copy of whatever the user changed. There is one query builder,
one fetch path, one cache, one loader and one set of pills. Tasks, Meetings, Chats and People were
views too until each turned out to be what a saved search already is — a fixed query over one kind —
and moved there (section 6).

On a **saved search** that one set of pills folds away behind a button beside back and forward
(`pillsOpen`, a preference; renderer/pills.js): its query is already its title, and the pills are
wanted while it is being re-aimed rather than every time it is read. A view keeps its pills in front
of it, an unsaved edit holds the row open — Save is one of the pills in it — and Cmd+K lists every
pill either way. **Refresh** is a header button beside that one rather than a pill: it asks the query
rather than describing it, so folding the pills away must not take it with them.

This file is the contract between the main process (`sdk/query.js`, `main.js`, `preload.js`) and the
renderer. It replaces the per-view paths: `taskParams`/`libraryQueries`/`MEETINGS_QUERY`/`inbox()`/
`chats()`/`library()` on one side and `loadLibrary`/`loadChats`/`loadInbox`/`loadMembers`-as-a-view,
`taskF`/`libF` on the other.

## 1. Filter

```js
{ types, states, assignee, text, participant, window, completedWithin }
```

| key | values | meaning |
|-----|--------|---------|
| `types` | array of kinds, or `null` | kinds: `meetings tasks docs chats canvases agents skills searches spaces people types`. `null` = every kind **except people, spaces and types** (a person is a member, a space a container and a type is schema, not library content; each is listed when asked for by name). `searches` are saved searches (`tana:search:`), documents that store a search definition. `types` are the workspace's own types (`tana:type:`). |
| `states` | array of `proposed open closed not_now`, or `null` | `null` = any state. Like the assignee, in effect only when tasks are in scope: no other kind carries a state, so a stored "Inbox, In Progress" must not empty a People or Docs listing. |
| `assignee` | `me` \| `anyone` \| `unassigned` \| user-profile uri | in effect only when tasks are in scope (`types` is null or contains `tasks`). |
| `text` | string | server-side `textQuery`. |
| `participant` | `me` or null | events the user is a participant of (`hasParticipantUris`). |
| `window` | `recent` or null | events from 7 days ago to 7 days ahead. |
| `completedWithin` | `3` | `7` | `30` | `'all'` | how old a **completed** task may be and still be listed. Not a way to hide them — `states` alone decides whether they are asked for — so it has no "off", and its value is kept while Completed is out of `states`. Unset reads as `7`. |

## 2. Presets

```js
inbox:    { types: null,          states: ['proposed'],          assignee: 'anyone' }
library:  { types: ['tasks'],     states: ['proposed', 'open'],  assignee: 'me', text: '' }
types:    { types: ['types'] }                                                                    // the workspace's schema, each row showing its space
```

Each view persists its own filter under the setting key `viewFilter:<id>`; a stored filter that is not
a valid query falls back to the preset. The kinds those retired views listed are still in `VIEW_KINDS`,
so each of them remains one search away rather than being lost with the page.

## 3. One query

One `graph.listNodes` call per fetch, built by `viewParams(filter, meUri, limit = 1000)`:

- `nodeTypes` = the selected kinds mapped (`tasks`/`docs` → `text`, `meetings` → `event`,
  `people` → `user-profile`, `spaces` → `space`, the rest are their own node type). `types: null` =
  every listable node type except `user-profile` and `space`, listed explicitly (never `nodeTypes: []`,
  which is no filter at all to the graph).
- `stateTypes` and `assignedTo`/`unassigned` only while tasks are among the kinds; `textQuery`
  when `text`; `hasParticipantUris` when `participant`; `eventStartTimeMin/Max` when `window`.
- `completedWithin` is asked for **nowhere**: `ListNodesRequest` has no field for the age of a state
  (checked against the descriptors — there is `event_start_time_min/max` and nothing for `state.entered_at`,
  and no sort field for it either). It is applied to the answer instead, in `viewRows`, `searchChildren` and
  `searchPreview`, by `completedInWindow` (sdk/query.js) reading each node's `state.enteredAt` — the time the
  task entered the state it is in, which for a closed one is when it was completed, and which the index carries
  on every node it lists. The window is rolling and absolute (exactly N×24h back from now), the boundary is
  inclusive, and a completed task with no readable `enteredAt` is left out of 7/30 and kept by All.
  **Consequence:** the limit applies before the window, so a graph answer full of old completed tasks can come
  back thin. A saved search stores its window in its `view` map beside the sort and grouping, never inside
  Tana's query vocabulary.
- `sortOptions`: event start ascending when meetings are the only kind, else update time descending.
- `mode: 'LIST_NODES_MODE_WITH_COUNT'`; `truncated` comes from the response.
- `docs` selected without `tasks`: text nodes that carry a state are dropped after the query (today's rule).

Accepted change: "any type" is now one query rather than one per kind, so a busy graph fills the
first 1000 rows by recency across kinds instead of per kind. Fewer requests, same cap, and the
truncation note the Library already shows still tells the user when there is more.

## 4. Rows, cache, refresh

- Rows are mapped by the existing `graphRow`/`toNode` pair. Member rows keep `editable: false`,
  meeting rows keep their `meta` (weekday and time), hidden-title rules apply to every view.
- A type row keeps the space it lives in as its `meta`, read from the graph node's own `spaceUri` and resolved to a
  title by the `nodeIds` lookup `resolveTypes` already makes; a type with no space reads as `Library`.
- Every view caches its rows in SQLite under its own id (`db.replaceSection(viewId, rows)`), so any
  view opens instantly from cache and stays readable while auth or sync reconnect. Today only tasks
  and meetings do.
- `outline:roots` returns `[{ id, title, icon, nodes }]` for the views from that cache.
- The refresh loop refreshes the **active** view (the last one listed) and subscribes the first
  `LIVE_ROWS` (100, main/state.js) of its rows, with the undo-history retention from #178 unchanged.
  Not the whole list: a subscription is a bootstrap RPC and a LoroDoc each, and every bootstrap reaches
  the renderer as a change, so a Library of several hundred rows opened with a subscription storm on the
  one sync connection — the page lagged and the read for whatever was opened next queued behind it. The
  tail keeps its cached row and is re-read by the 30 s refresh. `searchChildren` (main/related.js) caps
  its rows the same way.

## 5. IPC

```js
roots()                       // [{ id, title, icon, nodes }] from the cache, as today
viewList(id, filter?)         // { nodes, truncated } — fetch, cache and return one view
viewFilter(id)                // the stored filter, or the preset
setViewFilter(id, filter)     // validated, stored, returns the stored filter
members()                     // unchanged: the assignee pill's member list
```

Gone: `library:list`, `library:filter`, `library:setFilter`, `chats:list`, `inbox:list`,
`tasks:filter`, `tasks:setFilter` and their `window.api` methods. The renderer's in-file mock
implements the new surface too.

## 6. Saved searches are not a view

A saved search (`tana:search:…`) is a document, not a fourth preset: it has no filter, no `viewFilter`/
`setViewFilter`, and no row cache (`search:list` never calls `db.replaceSection`, so it does not touch
`S.activeView` or the refresh loop). `search:list` (`tana.searches()`) lists them read-only, newest first,
for Cmd+K's `Searches` group; opening one goes through `outline:children` → `searchChildren(id)`, which
reads the document's own stored `query` container and runs it through `graph.listNodes` directly —
bypassing `viewParams`, the presets and the cache entirely. Saving one is an explicit press rather than
a write per keystroke: the pills' filter goes through `filterToSearchQuery` into `setSearchQuery`, and
the arrangement — sort, grouping, the facts a row shows and the completed window — into `setSearchView`
in the same action (`main.js`).

## 7. Renderer

- One `views` list (was `sections`), one `filters` map keyed by view id, one `loadView(id)`.
- Pills are built from the filter for every view: Type, Status and Assigned to (when tasks are in
  scope), Sort and Group. They stay Cmd+K reachable as they are now.
- "Clear filters" resets to `{ types: null, states: null, assignee: 'anyone', text: '' }` and keeps
  `participant`/`window`, so clearing Meetings still means the user's own calendar. A view offers
  the link only when its filter differs from that.
- Keep: the today marker and date meta in Meetings, `DRAFT_KIND` (Enter drafts a task in Tasks and a
  meeting in Meetings), read-only member rows, sensitive redaction, the row enter/leave animation,
  drafts surviving a refresh, and every keyboard rule in OUTLINER.md.
