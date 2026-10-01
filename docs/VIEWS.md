# VIEWS.md — one screen, one query, three presets

Inbox, Library and Types are **the same view**: one list of graph rows with a filter on it. A view
is a preset filter plus a persisted copy of whatever the user changed. There is one query builder,
one fetch path, one cache, one loader and one set of pills. Tasks, Meetings, Chats and People were
views too until each turned out to be what a saved search already is — a fixed query over one kind —
and moved there (section 6).

On **every page with pills** that one set folds away behind a settings button beside back and forward
(`openPills`, a preference keyed by page; renderer/pills.js). A view (Library, Inbox) opens with them
shown; a saved search and a type page open with them folded, because their title already says what
they list and the pills are wanted while re-aiming rather than every time they are read. Each page
keeps its own choice, an unsaved edit holds the row open — Save is one of the pills in it — and Cmd+K
lists every pill either way. **Refresh** is a header button beside that one rather than a pill: it asks
the query rather than describing it, so folding the pills away must not take it with them.

This file is the contract between the main process and the renderer. In main, `sdk/query.js` holds the filter
vocabulary, the presets and the query builder, `main/views.js` runs, caches and refreshes a view, and `main.js`
and `preload.js` expose it (§5). In the renderer, `renderer/nodes.js` loads a view, `renderer/views.js` groups
and sorts its rows and `renderer/pills.js` draws the pills.

## 1. Filter

```js
{ types, states, assignee, text, participant, window, completedWithin, audience }
```

| key | values | meaning |
|-----|--------|---------|
| `types` | array of kinds, or `null` | kinds: `meetings tasks docs chats canvases agents skills searches spaces people types`. `null` = every kind **except people, spaces and types** (a person is a member, a space a container and a type is schema, not library content; each is listed when asked for by name). `searches` are saved searches (`tana:search:`), documents that store a search definition. `types` are the workspace's own types (`tana:type:`) as documents. The list may also hold **type uris** (`tana:type:…`, #139): the nodes of those types, sent as `entityTypes` (ORed among themselves, ANDed with any kinds, so the Type pill never mixes the two) and stored in a saved search as `entityTypeUris`. With only type uris, tasks are not in scope: no state or assignee is applied or stored, and the Responsibility grouping is off, since it keeps only your own work and would hide everybody else's risks. |
| `states` | array of `proposed open closed not_now`, or `null` | `null` = any state. Like the assignee, in effect only when tasks are in scope: no other kind carries a state, so a stored "Inbox, In Progress" must not empty a People or Docs listing. |
| `assignee` | `me` \| `anyone` \| `unassigned` \| user-profile uri | in effect only when tasks are in scope (`types` is null or contains `tasks`). |
| `text` | string | server-side `textQuery`. |
| `participant` | `me` or null | events the user is a participant of (`hasParticipantUris`). |
| `window` | `recent` \| `today` \| `upcoming` \| `past` \| `week` \| null | when meetings take place, in effect only while meetings are the only kind (like a state for tasks). The first four are Tana's presets (`timeRange` in sdk/query.js, on local days): Recent runs to the end of tomorrow, Today is today, Upcoming starts now and Past ends now. The When pill offers them (#492). `week` is a week either side of today, the range ⌘K's meeting picker asks for, and what a saved search holding a fixed range reads back as. A saved search stores a preset as Tana does (`eventTime: { preset }`), so Tana's client lists the same, and `week` as its range. |
| `completedWithin` | `3` | `7` | `30` | `'all'` | how old a **completed** task may be and still be listed. Not a way to hide them — `states` alone decides whether they are asked for — so it has no "off", and its value is kept while Completed is out of `states`. Unset reads as `7`. |
| `audience` | `'everyone'` or null | what everyone in the org can see (#253), the "Visible to" pill. The graph can only ask Tana's "Open" (`restricted: false`: the node's own flag, so it also lists what a restricted space or meeting holds — live 286 against 51), so that is the query, and `everyoneOnly` (sdk/access.js) keeps the rows with no restricted owner above them, one `GetOwnerChain` per distinct owner. A saved search stores it in its `view` map, like `completedWithin`, and `visibility: 'open'` in its query, so Tana's client lists the superset. |

## 2. Presets

```js
inbox:    { types: null,          states: ['proposed'],          assignee: 'anyone' }
library:  { types: ['tasks'],     states: ['proposed', 'open', 'closed', 'not_now'], assignee: 'anyone', text: '', completedWithin: 3 }
types:    { types: ['types'] }                                                                    // the workspace's schema, each row showing its space
```

Each view persists its own filter under the setting key `viewFilter:<id>`; a stored filter that is not
a valid query falls back to the preset. The kinds those retired views listed are still in `VIEW_KINDS`,
so each of them remains one search away rather than being lost with the page.

Library is the My Tasks saved search as a view (#113): besides the filter it starts grouped by Responsibility,
sorted by Updated and showing Status and Assigned (`VIEW_ARRANGEMENT` in `renderer/views.js`), until the user
picks another grouping, sort or set of facts for it.

## 3. One query

One `graph.listNodes` call per fetch, built by `viewParams(filter, meUri, limit)`:

- `limit` is the filter's own (issue #626): one of 50, 100, 200, 500 and 1,000 (`ROW_LIMITS`, sdk/node.js), 200 when
  it names none, chosen with the Limit pill. Tana sorts before it cuts, so the limit keeps the most recently changed
  rows (a list of meetings: the nearest), and Sort and Group work on those. A cut answer says so under the rows
  ("Showing the 200 most recently changed · raise Limit to see more"). A saved search stores its limit in its `view`
  map beside the window and asks for it when it opens; a type page, whose pills keep only its fields, asks for 1,000,
  and so do the app's own lookups through `searchPreview` (skills, chats, link targets).
- `nodeTypes` = the selected kinds mapped (`tasks`/`docs` → `text`, `meetings` → `event`,
  `people` → `user-profile`, `spaces` → `space`, the rest are their own node type). `types: null` =
  every listable node type except `user-profile` and `space`, listed explicitly (never `nodeTypes: []`,
  which is no filter at all to the graph).
- `stateTypes` and `assignedTo`/`unassigned` only while tasks are among the kinds; `textQuery`
  when `text`; `hasParticipantUris` when `participant`; `eventStartTimeMin/Max` when `window` and meetings are the only kind.
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
- `sortOptions`: when meetings are the only kind, event start, soonest first for Upcoming and Today and latest first
  otherwise (Tana's own order, which the limit then cuts at the far end); else update time descending.
- `mode: 'LIST_NODES_MODE_WITH_COUNT'`; `truncated` comes from the response.
- `docs` selected without `tasks`: text nodes that carry a state are dropped after the query (today's rule).

Accepted change: "any type" is now one query rather than one per kind, so a busy graph fills the
first rows by recency across kinds instead of per kind, up to the limit. Fewer requests, same cap, and the
truncation note the Library already shows still tells the user when there is more.

## 4. Rows, cache, refresh

- Rows are mapped by the existing `graphRow`/`toNode` pair. Member rows keep `editable: false`,
  meeting rows keep their `meta` (weekday and time), hidden-title rules apply to every view.
- A type row keeps the space it lives in as its `meta`, read from the graph node's own `spaceUri` and resolved to a
  title by the `nodeIds` lookup `resolveTypes` already makes; a type with no space reads as `Library`.
- Every view caches its rows in SQLite under its own id (`db.replaceSection(viewId, rows)`), so any
  view opens instantly from cache and stays readable while auth or sync reconnect.
- `outline:roots` returns `[{ id, title, icon, nodes }]` for the views from that cache.
- A refresh reads **every open view** — one per window or split half (`openViews`, main/views.js) — and
  subscribes the first `LIVE_ROWS` (100, main/state.js) of each one's rows. Its sweep unsubscribes what no
  open view, watch, undo step (#178), pending read or page on screen still holds.
  Not the whole list: a subscription is a bootstrap RPC and a LoroDoc each, and every bootstrap reaches
  the renderer as a change, so a Library of several hundred rows opened with a subscription storm on the
  one sync connection — the page lagged and the read for whatever was opened next queued behind it. The
  tail keeps its cached row and is re-read by the next refresh. `searchChildren` (main/related.js) caps
  its rows the same way. A document a read subscribed on its own (a zoom, `doc:info`, a row's task metadata
  as it scrolls into view) is capped at the same number and let go oldest first (main/documents.js
  `onDemand`, #269); a read still waiting on its bootstrap holds the document, so no sweep drops it.
- **Nothing polls** (#148): what runs a refresh is a push. Each open view has a live query (sdk/livequery.js,
  `watchViews` in main/views.js, opened and closed whenever a view is read, so a changed filter moves it at once), built from the view's own
  ListNodes params by `liveTrigger` (sdk/query.js): the same kinds, types, states and people, less what a live
  query cannot say, so it is a superset of the view. Its answers only schedule the refresh; ListNodes still
  decides the rows. Two more live queries do their own work rather than wake the refresh: `watchMine` (the
  tasks you made for others, the watch rule) re-reads the watch set through `refreshWatched`, and `watchInbox`
  announces new Inbox tasks and updates the badge. An open saved search gets one from `watchRelated`
  (main/related.js), rebuilt when its stored query changes, and a type page one over its instances; each
  re-reads that page. A timer still refreshes every 5 minutes (main.js) as the backstop for a push
  that never came, and a window gaining focus refreshes unless the last refresh finished within
  `FOCUS_FRESH_MS` (30 s, main.js). A live query that matches nothing stays pending instead of answering
  empty, which is why every trigger counts its first answer too.

## 5. IPC

```js
roots()                       // [{ id, title, icon, nodes }] from the cache, as today
viewList(id, filter?)         // { nodes, truncated } — fetch, cache and return one view
viewFilter(id)                // the stored filter, or the preset
setViewFilter(id, filter)     // validated, stored, returns the stored filter
members()                     // unchanged: the assignee pill's member list
```

The renderer's in-file mock implements the same surface.

## 6. Saved searches are not a view

A saved search (`tana:search:…`) is a document, not a fourth preset: it has no filter, no `viewFilter`/
`setViewFilter`, and no row cache (`search:list` never calls `db.replaceSection`, so it does not touch
`S.activeView` or the refresh loop). `search:list` (`tana.searches()`) lists them read-only, newest first,
for Cmd+K's `Searches` group; opening one goes through `outline:children` → `searchChildren(id)`, which
reads the document's own stored `query` container (`readSearch`, sdk/node.js) and runs it through `graph.listNodes` directly —
bypassing `viewParams`, the presets and the cache entirely. Saving one is an explicit press rather than
a write per keystroke: the pills' filter goes through `filterToSearchQuery` into `setSearchQuery`, and
the arrangement — sort, grouping, the facts a row shows and the completed window — into `setSearchView`
in the same action (`main.js`).

## 7. Renderer

- One `views` list, one `filters` map keyed by view id, one `loadView(id)` (renderer/nodes.js).
- Pills are built from the filter for every view: Type, Status and Assigned to (when tasks are in
  scope), Sort and Group. They stay Cmd+K reachable as they are now.
- "Clear filters" (`clearFilter`, renderer/nodes.js) resets to `{ types: null, states: null, assignee:
  'anyone', text: '', fields: null, audience: null }` and keeps `participant`/`window`, so a filter that asks
  for your own meetings still does after it. A view offers the link only when its filter differs from that.
- Enter on a collapsed, editable document row in a view (a type row opens its type page instead, and a read-only
  row ignores it), or with nothing focused in an empty view, drafts a plain document below it (`draftDoc`,
  renderer/render.js): every view drafts a doc. Drafts survive a refresh and are dropped when you
  navigate away empty. Member rows stay read-only, sensitive rows stay redacted, rows animate in and out, and
  every keyboard rule in OUTLINER.md holds.

## 8. Type pages and tables

A **type's page** (`tana:type:…`, opened from the Types view or anywhere else) is the list of that type's instances,
drawn like a saved search: the same pills, sort, grouping, Display and ⌘F. Its rows are `searchPreview({ types: [type],
fields })`, and `fields` is Tana's stored `attributes` shape (`{ '<type>?attribute=<key>': { textMatches | refs | date } }`),
which `filterToSearchQuery` passes on as `attributes` and `searchQueryParams` sends as `attributeFilters`. Every options,
link (with target types), member and date field gets a pill: options by label (several ORed), links and members by the
node they point at, dates by Tana's presets (today, upcoming, past); verified live 2026-09-25 on Goal (Status "On track"
3 of 6, "On track" or "Unknown" 4). A change applies at once and is kept per type in the `typeFields` preference; nothing
is written to Tana. A link or member pill's menu opens with a search line on top ("Search Sources…"): typing narrows its
rows, the same keys every pill menu already answers to, since a link can point at hundreds of nodes.
Display lists every field the type defines and starts on the ones with pills plus Updated; the values
come on the row itself (`fields`, from the graph node's `attributes`), written on its grey line as plain text, one · between
each, the way a saved search's row reads. The field
definitions are not drawn there (a list, not the type's edit view): ⌘K Edit fields shows them under the title. An open type page is kept current by a live query over its instances
(`watchRelated`), as a saved search is.

**One type picked elsewhere.** A saved search or the Library whose Type pill holds one workspace type and nothing else
lists that type's instances too, so it gets the same field pills, field groupings, Display fields and editable choice
cells (`fieldType` in renderer/views.js). Display keeps the page's own starting choice rather than the type page's.
The field filter is part of the filter (`fields`): the Library sends it as `attributeFilters` (`viewParams`), a saved
search stores it as the query's `attributes` and reads it back on load (`searchQueryToFilter`), so Save keeps it and
changing it marks the search unsaved. Any change of the Type pill clears them.
In such a saved search, Enter at the end of a row drafts a new row of that type below it (renderer/render.js
`searchDraft`, issue #537), created with every field the filter pins to one value: a link or a person, or one option.
A field it leaves open, a choice of several or a date range is left for you.

**A mixed list** (Tasks, the Library, a saved search over several types, #617) gives the fields of the types on its
page filter pills as well, and of a type a field filter names while none of its rows is on screen; two fields of one
name on different types say which type each is. The filter is the typed field, so choosing a value narrows the list
to that type's rows with it: the graph applies it without a type named (verified live 2026-09-30: Tasks with
Project = Orbital, 5 of 397, all Project Task). A list naming workspace types counts only their fields (`typeFields`
in sdk/query.js), and shows pills only for those. The definitions come through the lite read a type page uses, one per
type on the page.

**Outliner or Table.** Every page with pills — a view, a saved search, a type's page — can be drawn as a table: the
switch at the top right of the header, or ⌘K Switch to table / Switch to outliner (one row, id `tableView`, so a
recorded key keeps working). The rows stay the outline's rows, laid out as a grid with a column per fact Display
shows (a type's fields, Type, Lives in, Status, Assigned and the times). The choice is kept per page key in the
synced `tables` preference, which starts from the older type-only `typeTables` list. A document's own outline and the
Notifications, Proposals and Timeline pages have no pills and no table.

In a table a row's title opens the node (click, Enter or Space; the title is renamed on the node's page), and its task
box ticks without opening it. A field column is plain text, comma-joined, cut with an ellipsis and whole in the hover
tooltip (none while the row is hidden as sensitive). On a type's page an options column can be changed in place: a click
on the cell (without ⌘ or ⇧, which select) or ⌘K **Set <field> …** on the focused row opens the options picker of
docs/OUTLINER.md §12 (Fields) for that row. Every fact column can be resized: drag the grip on its header's right
edge, double-click it to reset; from the keyboard, ⌘K **Column widths …** (View options, while the page is a table) lists
the columns, ←/→ make the highlighted one 20px narrower or wider while nothing is typed, ↩ resets it. Widths are kept per
page key and column in the synced `tableWidths` preference; Title takes what the others leave, and the icons column and
the agent badge's slot are only there when a row on the page has them.

**At every width.** A table holds at any pane width the way Alvish Baldha's tables "split, stretch, and snap into
place" (x.com/alvishbaldha/status/2105538797970809133). A column is its dragged width or 160px. When the page has no
room for all of them beside a 200px title, the first columns fold onto the title's line: their values follow the
title in grey, in column order, each cut on its own. As the page widens they split back out, the last column first,
so the facts never change order. With every column folded the header goes, as a plain list has none; otherwise Title
heads the title's line and each column still split out keeps its own header and grip. Where it snaps depends only on
the widths and the page's width (renderer/views.js `foldFor`), so it snaps at the same width both ways, and it is
checked on every width change (the window, a pane, the sidebar, the text size) and every column resize
(`fitTable`). A snap a hand caused plays the cells on screen in from the left; reduced motion snaps without it.

## 9. Notifications, Proposals and Timeline are pages, not views

Notifications (issue #18, docs/OUTLINER.md) is listed with the views in Cmd+K but is a page, like a saved search: it has no
filter, no pills and no row cache. Its rows are `outline:children('orbital:notifications')` — Tana's `tana:user-inbox`
document read by main/inbox.js — and it never touches `S.activeView` or the refresh loop; the inbox is live by subscription.

Proposals (issue #19) is the same kind of page: `outline:children('orbital:proposals')` is the AI proposals still pending,
read from the chat graph nodes by main/proposals.js on every arrival, with no filter, pills or row cache.

The Timeline (issue #135) is a third: `outline:children('orbital:timeline')` is rebuilt by main/timeline.js from
Tana on every read, sent in parts on `timeline:part` while the rest is read, and kept current by its own live
query over your meetings. Each of the three is an `orbital:` id the renderer knows from boot (`extra` with
`appPage: true`), so `goTo`, Back and Recent reach it without asking main for a node.
