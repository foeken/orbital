# VIEWS.md — one screen, one query, six presets

Inbox, Tasks, Meetings, Library, Chats and People are **the same view**: one list of graph rows
with a filter on it. A view is a preset filter plus a persisted copy of whatever the user changed.
There is one query builder, one fetch path, one cache, one loader and one set of pills.

This file is the contract between the main process (`sdk/query.js`, `main.js`, `preload.js`) and the
renderer. It replaces the per-view paths: `taskParams`/`libraryQueries`/`MEETINGS_QUERY`/`inbox()`/
`chats()`/`library()` on one side and `loadLibrary`/`loadChats`/`loadInbox`/`loadMembers`-as-a-view,
`taskF`/`libF` on the other.

## 1. Filter

```js
{ types, states, assignee, text, participant, window, mcp }
```

| key | values | meaning |
|-----|--------|---------|
| `types` | array of kinds, or `null` | kinds: `meetings tasks docs chats canvases agents skills spaces people`. `null` = every kind **except people and spaces** (a person is a member and a space a container, not library content; both are listed when asked for by name). |
| `states` | array of `proposed open closed not_now`, or `null` | `null` = any state. Like the assignee, in effect only when tasks are in scope: no other kind carries a state, so a stored "Inbox, In Progress" must not empty a People or Docs listing. |
| `assignee` | `me` \| `anyone` \| `unassigned` \| user-profile uri | in effect only when tasks are in scope (`types` is null or contains `tasks`). |
| `text` | string | server-side `textQuery`. |
| `participant` | `me` or null | events the user is a participant of (`hasParticipantUris`). |
| `window` | `recent` or null | events from 7 days ago to 7 days ahead. |
| `mcp` | bool | include MCP chats. Applied after the query, on the node, as today. |

## 2. Presets

```js
inbox:    { types: null,          states: ['proposed'],          assignee: 'anyone' }
tasks:    { types: ['tasks'],     states: ['proposed', 'open'],  assignee: 'me' }
meetings: { types: ['meetings'],  participant: 'me', window: 'recent' }
library:  { types: ['tasks'],     states: ['proposed', 'open'],  assignee: 'me', text: '' }
chats:    { types: ['chats'],     mcp: false }
people:   { types: ['people'] }
```

Each view persists its own filter under the setting key `viewFilter:<id>`; a stored filter that is not
a valid query falls back to the preset, like the stored task/library filters do today. The People view
is titled "People" (the id is `people`; it was `members`).

## 3. One query

One `graph.listNodes` call per fetch, built by `viewParams(filter, meUri, limit = 1000)`:

- `nodeTypes` = the selected kinds mapped (`tasks`/`docs` → `text`, `meetings` → `event`,
  `people` → `user-profile`, `spaces` → `space`, the rest are their own node type). `types: null` =
  every listable node type except `user-profile` and `space`, listed explicitly (never `nodeTypes: []`,
  which is no filter at all to the graph).
- `stateTypes` and `assignedTo`/`unassigned` only while tasks are among the kinds; `textQuery`
  when `text`; `hasParticipantUris` when `participant`; `eventStartTimeMin/Max` when `window`.
- `sortOptions`: event start ascending when meetings are the only kind, else update time descending.
- `mode: 'LIST_NODES_MODE_WITH_COUNT'`; `truncated` comes from the response.
- `docs` selected without `tasks`: text nodes that carry a state are dropped after the query (today's rule).

Accepted change: "any type" is now one query rather than one per kind, so a busy graph fills the
first 1000 rows by recency across kinds instead of per kind. Fewer requests, same cap, and the
truncation note the Library already shows still tells the user when there is more.

## 4. Rows, cache, refresh

- Rows are mapped by the existing `graphRow`/`toNode` pair. Member rows keep `editable: false`,
  meeting rows keep their `meta` (weekday and time), hidden-title rules apply to every view.
- Every view caches its rows in SQLite under its own id (`db.replaceSection(viewId, rows)`), so any
  view opens instantly from cache and stays readable while auth or sync reconnect. Today only tasks
  and meetings do.
- `outline:roots` returns `[{ id, title, icon, nodes }]` for the six views from that cache.
- The refresh loop refreshes the **active** view (the last one listed) and subscribes its rows, with
  the undo-history retention from #178 unchanged.

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

## 6. Renderer

- One `views` list (was `sections`), one `filters` map keyed by view id, one `loadView(id)`.
- Pills are built from the filter for every view: Type, Status and Assigned to (when tasks are in
  scope), MCP chats (when chats are), Sort and Group. They stay Cmd+K reachable as they are now.
- "Clear filters" resets to `{ types: null, states: null, assignee: 'anyone', text: '' }` and keeps
  `participant`/`window`, so clearing Meetings still means the user's own calendar. A view offers
  the link only when its filter differs from that.
- Keep: the today marker and date meta in Meetings, `DRAFT_KIND` (Enter drafts a task in Tasks and a
  meeting in Meetings), read-only member rows, sensitive redaction, the row enter/leave animation,
  drafts surviving a refresh, and every keyboard rule in OUTLINER.md.
