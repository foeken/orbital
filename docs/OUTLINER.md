# Outliner contract

> How to read this file: it is the UI contract as it accumulated, one addendum per round, and older addenda are not
> rewritten when a later one replaces them. Where an addendum describes views or their filters (`api.taskFilter`,
> `api.library`, `api.inbox`, per-view loaders), [VIEWS.md](VIEWS.md) is what the code does now: one screen, one
> query, three presets plus saved searches, `api.viewList`/`api.viewFilter`/`api.setViewFilter`. The keyboard rules, the node shape and
> the palette behaviour here are current.

The app renders a Tana-Outliner-style outline. The app is generic ("Tana" companion); the first view is **Tasks**. Every visible content line is a node: top-level lines are Tana documents (task documents in the Tasks view), and a document's children are its content blocks. Editable text is changed in place where the node capability allows it (no edit mode). Editing follows the Outliner keyboard model.

## Content model (verified on a real document; loro-prosemirror layout)

`document.content` is a LoroMap { nodeName: 'doc', attributes: LoroMap, children: LoroList }. Each block is a LoroMap { nodeName, attributes: LoroMap, children: LoroList }. Inline content of a paragraph/heading is a LoroList of LoroText (plain text runs) and inline LoroMaps such as { nodeName: 'mention', attributes: { label, tanaUri } }. Block node names seen/expected: paragraph, heading (attributes.level), bulletList > listItem > (paragraph, optional nested bulletList), orderedList, blockquote, codeBlock. Blocks carry attributes.blockId (8 lowercase alphanumerics, e.g. '6s8vb70s'); generate one for blocks we create and for any block missing one when it is first written.

## Outline nodes (what the renderer sees)

```js
Node = { id: string, text: string, kind: 'document' | 'block', heading?: 1|2|3, done?: 0|1, hasChildren: boolean, children?: Node[] }
```
Outline mapping (sdk/content.js, generic): a top-level paragraph/heading is a node; a bulletList/orderedList is NOT a node, its listItems are nodes whose text is the listItem's first paragraph and whose children are the nodes of the listItem's remaining blocks (nested lists flatten the same way); blockquote/codeBlock are nodes with their text. Node id = blockId of the text-carrying block (the paragraph inside a listItem). Mentions render as their label; marks are dropped (plain text).

## Outline operations (sdk/content.js, generic, all inside document.transact)

```js
readOutline(document)                         // -> Node[] (kind 'block')
setText(document, nodeId, text)               // replace the inline content with a single text run (mentions in that paragraph are lost; documented ceiling)
insertAfter(document, nodeId | null, text)    // new paragraph as next sibling at the same level (inside a listItem: a new listItem+paragraph); null = append at the end of the doc; returns the new nodeId
insertChild(document, nodeId, text)           // new first child of nodeId (creates the nested bulletList/listItem as needed); returns the new nodeId
insertBefore(document, nodeId, text)          // new paragraph as previous sibling at the same level; returns the new nodeId
split(document, nodeId, before, after, asChild) // truncate nodeId to `before` and put `after` in a new sibling (or first child): one transaction, so one undo step
remove(document, nodeId)                      // removes the node and its children (unwrap empty lists/listItems left behind)
indent(document, nodeId)                      // becomes the last child of its previous sibling (wrapping top-level paragraphs into bulletList/listItem as needed); no-op if no previous sibling
outdent(document, nodeId)                     // becomes the next sibling of its parent; no-op at top level
moveTo(document, nodeId, { parentId, afterId, from }) // a drag: behind afterId, else at the top of parentId, else at the top of the outline; `from` is the outline it comes from (a field of the same document)
```
Keep the tree normalised: every listItem starts with a paragraph; empty bulletLists are removed. Keep helpers small; no general-purpose ProseMirror transform library.

## Renderer API (preload.js -> window.api)

```js
api.roots()                        // Promise<Node[]>  kind 'document' (Tasks view: open tasks assigned to me; done reflects stateType 'closed'), hasChildren true
api.children(docId)                // Promise<Node[]>  outline of the document's content (subscribes the document if needed)
api.setTitle(docId, title)         // Promise<void>
api.setDone(docId, done)           // Promise<void>
api.setText(docId, nodeId, text)   // Promise<void>
api.insertAfter(docId, nodeId|null, text)  // Promise<string> new nodeId
api.insertChild(docId, nodeId, text)       // Promise<string>
api.insertBefore(docId, nodeId, text)      // Promise<string>
api.split(docId, nodeId, before, after, asChild) // Promise<string> new nodeId; one undo step for both halves
api.remove(docId, nodeId)          // Promise<void>
api.indent(docId, nodeId)          // Promise<void>
api.outdent(docId, nodeId)         // Promise<void>
api.refresh()                      // Promise<void> re-query roots
api.login()                        // Promise<void>
api.status()                       // Promise<{authenticated, connected, syncing, lastSync, error}>
api.onChanged(cb)                  // cb(docId | null, info?): null = roots changed; docId = that document changed (remote or local), info.meta says whether its metadata did — assignees, audience, sharing, its type, and the values in its typed fields, all of which the zoomed page and the sidebar are read from; the renderer patches the row (and its children when open) and re-renders (addendum 18)
api.onStatus(cb)
```
IPC channels: outline:roots, outline:children, doc:setTitle, doc:setDone, block:setText, block:insertAfter, block:insertBefore, block:insertChild, block:split, block:remove, block:indent, block:outdent, sync:refresh, sync:login, sync:status; events outline:changed (payload docId|null), sync:status.

## Outliner UI/UX (renderer)

Look: old Tana Outliner: white page, system font, a page title, a filter row, then the outline. Each node line: a small bullet (•) at the left in a fixed-width gutter; on hover a chevron appears left of the bullet to collapse/expand when the node has children; children are indented ~24px with a thin vertical guide line; document nodes show a rounded checkbox before the text; heading nodes render bold/larger; collapsed nodes show a filled/ringed bullet. Editable node text uses a contenteditable span; typing edits in place (debounce 400 ms then setText/setTitle; also flush on blur, Enter, Tab and navigation). Read-only nodes render their text without an editor.

Keyboard (exactly the Outliner model):
- Enter: split at caret (one mutation, `api.split`, so one undo restores the node whole); if the node is expanded with children, the new node becomes the first child, else the next sibling; caret moves to it. Enter at the very start of a node that has text inserts an empty sibling in front instead (`api.insertBefore`): the node keeps its text and its children, and the caret moves to the new row. Undoing an Enter returns the caret to the row Enter ran on, at the offset it ran at, rather than to the nearest surviving row. Enter on an editable document node inserts a first content child; read-only nodes ignore edit keys. View-level draft document creation is defined in Addendum 8.
- Shift+Enter: newline inside the node (soft break).
- Tab / Shift+Tab: indent / outdent the node (block nodes only; document nodes ignore Tab).
- Backspace at the start of an empty block node: remove it and move the caret to the end of the previous visible node. Backspace at start of a non-empty node: its words join the previous visible row (#125, below).
- Up/Down: move caret to the previous/next visible node (keeping the horizontal offset if possible); Left/Right at node edges move across nodes.
- Cmd+Up / Cmd+Down: collapse / expand the current node. Cmd+Shift+Up/Down: move node up/down among siblings (optional; skip if it needs new ops).
- Space when the caret is in a document node and the node text is not being edited is not needed; the checkbox is clicked with the mouse or toggled with Cmd+Enter.
- Esc: blur.
Mouse: click the bullet to zoom into the node (its children become the outline, a breadcrumb "Tasks › <node title>" at the top navigates back); click the chevron to collapse/expand; click the checkbox to toggle done.
Filter: the filter box filters top-level document nodes by title substring, with "N items filtered out" underneath; Esc clears it.
Live updates: onChanged(docId) re-fetches that document's children (and roots when null) and re-renders while preserving caret position and expanded/collapsed state; if the node being edited changed remotely, keep the local text until the user's debounce flushes.
There is no footer/status bar. When not authenticated, the outline area shows a centered "Log in to Tana" button; transient errors appear under the page title. Sync is a palette/native-menu action that calls refresh.
Copy: window title "Tana"; page title "Tasks". Nothing in the UI should hard-code "Open Tasks".



## Addendum 1 (moves, references, hidden chrome, task icon)

- `Node.segments`: `Array<{ text: string } | { mention: { label: string, uri: string } }>` alongside `Node.text` (plain). readOutline fills segments from the inline runs (LoroText -> text, mention LoroMap -> mention). Renderer renders mentions as underlined links; clicking one navigates to that document (zooms into it with a breadcrumb "Tasks › <title>"). Editing a node keeps mentions: the renderer serialises the contenteditable back into segments (anchor elements -> mention segments) and calls `api.setText(docId, nodeId, segments)`; `setText` in sdk/content.js accepts a string or segments and rewrites the inline runs accordingly (existing text runs updated in place when possible).
- `api.move(docId, nodeId, 'up' | 'down')` (IPC `block:move`), backed by `move(document, nodeId, direction)` in sdk/content.js: swap with the previous/next sibling node; no-op at the edges. Renderer: Cmd+Shift+Up/Down on a block node; document nodes ignore it.
- `api.node(docId)` (IPC `doc:info`) -> `{ id, title, kind: 'document', done, icon }` for any document (subscribes it if needed), used when navigating to a referenced document that is not in roots.
- Root nodes carry `icon: 'task'` when the document has a task state. The renderer shows the original Outliner task icon (small grey checklist glyph: two short horizontal lines with a check mark) in the bullet slot of such nodes, before the checkbox; it is still the zoom/collapse target.
- No footer/status bar. When not authenticated the outline area shows a centered "Log in to Tana" button instead of the outline. Errors show as one slim red line under the page title only while an error is present. "Connected"/"refreshed" text is gone.
- The filter row is hidden by default. Cmd+F shows it (focused, same look as before); Esc in the filter clears and hides it; while it has text it stays visible.


## Addendum 2 (sections, type tags, meetings, generic sync)

- The page is one outline with **sections**: a section is a non-editable top-level heading line ("Tasks", "Meetings") rendered like Tana's Today sections (small grey icon in the bullet slot, medium-weight grey-black text, no checkbox), whose children are documents. `api.roots()` now returns `[{ id: 'tasks', title: 'Tasks', icon: 'task', nodes: Node[] }, { id: 'meetings', title: 'Meetings', icon: 'meeting', nodes: Node[] }]`. Sections are always expanded, cannot be edited, moved, indented, deleted or zoomed into; the breadcrumb root is still "Tana"-level: zooming into a document shows "‹section title› › ‹doc title›". Filter (Cmd+F) matches document titles across sections; a section with no visible documents is hidden while filtering.
- Node additions (documents): `icon: 'task' | 'meeting' | undefined`; `tags: Array<{ label: string, color: 'grey' | 'gold' }>`; `meta?: string` (short grey text after the title, e.g. "Mon 9:00–9:30" for meetings); `start?`/`end?` (ISO, **events only**, added by `toNode` only when the row has them, so every other kind keeps its shape) — the event window itself, which is what anything ordering meetings by time must read, since `meta` is a label and reads "Fri 08:20" for six days either side of today. A row restored from the SQLite cache carries no window; the cache stores the label; `kind: 'document'`; `done` only for tasks. Every document with a task state gets the tag { label: 'task', color: 'grey' }; every event gets { label: 'meeting', color: 'gold' }; a document with an entityType gets { label: <type title>, color: 'grey' } (type titles resolved with graph.listNodes({ nodeIds: [...] }) and cached per session). Tags render as chips exactly like Tana's "# todo": inline after the title (and after meta), rounded 4px, 12px text, padding 1px 6px, a "#" then a space then the label; grey = background #f1f1f1 / text #6b6b6b; gold = background #fbf3d9 / text #8a6a17. The meeting bullet icon is the calendar glyph from icons.js coloured #c99b1b (the icon set's own gold); the task bullet stays the grey task glyph; typed documents without a task state use the plain bullet.
- Meetings section: events where the user is a participant with a start time from the start of today (local) to 7 days ahead, ordered by start time (`nodeTypes: ['event'], eventStartTimeMin/Max, sortOptions SORT_FIELD_EVENT_START_TIME asc, limit 200`); meta = weekday + start–end time in local time ("Mon 9:00–9:30"; all-day events show "Mon, all day"). Their content (meeting notes) is the same Loro content layout as tasks; expanding a meeting shows it via api.children(id). Event titles are currently read-only in the companion because native calendar write capability is not exposed; no checkbox.
- Local cache (db.js): one generic table `nodes(id TEXT PRIMARY KEY, section TEXT, title TEXT, done INTEGER, icon TEXT, meta TEXT, tags TEXT /* JSON */, sortKey TEXT, updatedAt TEXT)`; `replaceSection(section, rows)` replaces one section's rows; `list()` returns rows grouped by section in sortKey order (tasks: updatedAt desc; meetings: start time asc). Old tables are dropped/migrated on open.
- Menu: the "Tasks" menu becomes "Tana" with "Sync" (Cmd+R) which refreshes every section (IPC sync:refresh unchanged). Refresh runs on start, every 60 s, and 2 s after a state change. Every listed document (tasks and meetings) is subscribed for live updates; documents no longer listed are unsubscribed.
- `api.onChanged(null)` still means "roots changed"; `api.node(docId)` returns the same Node shape (with tags/icon/meta) for documents reached through references, including events.


## Addendum 3 (command palette, top-level views)

- Tasks and Meetings are **views**, not sections on one page: the outline shows one view at a time (page title = view name, its documents as top-level nodes, no section heading line). `api.roots()` keeps returning both sections; the renderer picks the active one. Default view: Tasks; the last used view is remembered in localStorage. Zoom breadcrumbs start at the view name.
- **Cmd+K command palette** (renderer only), styled like the attached ChatGPT palette: a centered modal card (max-width ~620px, 12px radius, subtle shadow, backdrop dimmed slightly), a borderless search input at the top with placeholder "Run a command", a thin divider, then grouped rows with small grey group headings: "Views" (Tasks, Meetings; each with its grey icon from icons.js: task glyph / calendar), "Actions" (Sync, right-aligned shortcut chip "⌘R"; Log in to Tana when unauthenticated). Cmd+K lists commands only: documents are found with Cmd+S (the Search Tana action). A query that matches no command lists one row under a "No results" heading, "Search Tana for “…”", which opens Cmd+S with that query already running. Rows: 15px text, 8px vertical padding, 8px radius, the active row has a light grey background; Up/Down move, Enter runs, Esc closes, typing filters every group (case-insensitive substring; empty query shows Views and Actions). Selecting a view switches the view; Sync calls api.refresh(). Cmd+K toggles the palette; the outline keeps its state behind it.
- Sync moves out of the outline UI entirely (it is in the palette and in the native Tana menu). Cmd+F filter stays as is, scoped to the active view.


## Addendum 4 (Cmd+S search palette)

- `api.search(query)` -> `Promise<Node[]>`: live full-text search over every top-level item in Tana (tasks, meetings, typed and plain documents; graph search, relevance order, up to 20). Nodes come in the usual shape (id, title, kind 'document', icon, tags, meta, done).
- **Cmd+S** opens a search palette with the same look as the Cmd+K palette but a single result list: placeholder "Search Tana", results fetched via api.search debounced 150 ms after typing (ignore stale responses), each row showing the item's icon (task glyph / gold calendar / plain dot), title, its tag chips, and meta in grey on the right; "No results" when empty and the query is non-empty; from four characters on, the documents only Tana's semantic search found follow under a "Related" heading, in its order (issue #20); Up/Down/Enter/Esc as in Cmd+K. Enter zooms into the item (it is not necessarily in the current view: use api.node semantics, i.e. the renderer's existing goTo path with the returned Node so the breadcrumb reads "Search › <title>"). Cmd+S toggles it; opening one palette closes the other.


## Addendum 5 (undo/redo, delete node)

- `api.undo()` / `api.redo()` -> Promise<docId | null>: global undo across documents (main keeps the order; each document has a Loro UndoManager, local changes only, one step per mutation call). Renderer: Cmd+Z / Cmd+Shift+Z (and Cmd+Y) first flush any pending debounced text edit, then call undo/redo, then reload that document's children (or roots when the change touched a document's title/state) and re-render, placing the caret in the affected node when it still exists. Do not let the browser's native contenteditable undo run (preventDefault), so undo never diverges from what was sent to Tana.
- **Cmd+Shift+Backspace** removes the current block node entirely (with its children) regardless of caret position or content, via api.remove; caret moves to the previous visible node (or the next when there is none). On a document node it is ignored.


## Addendum 6 (hotkeys, @-linking, create, search filters, polish)

- **Search filters**: `api.search(query)` understands `#task`, `#meeting` and `#<type name>` tokens anywhere in the query (e.g. "sam #task"): tokens are removed from the text query and become filters (task = nodes with a task state, meeting = events, other = the type whose title matches case-insensitively; unknown type = no results). Results keep the usual Node shape; for events the meta shows the date ("Fri 9" style, i.e. weekday + day of month, plus time when not all-day) so past and future meetings are distinguishable. In the Cmd+S palette the query is shown as typed; results render as today (icon, title, chips, meta right-aligned in grey).
- **Meetings view** now spans the past 7 days through the next 7 days (main.js), oldest first; the renderer scrolls the view so today's first meeting is at the top when the view opens (a data-today marker on the first node whose start is today or later).
- **Create**: `api.createDocument(title)` -> Promise<Node>: creates a new plain Tana document (kind 'document', no state) with that title, live-synced like the others, and returns its Node.
- **@ linking**: with a non-empty text selection inside a block node, pressing "@" opens the search palette prefilled with the selected text (do not insert the "@"). The first row is always `Create "<selected text>"` with a ⌘↩ hint; below it the search results. Enter on a result (or ⌘↩ for Create, which calls api.createDocument(selectedText)) replaces the selection with a mention segment { label: <result/new title>, uri: <id> } via the existing segments path (api.setText with segments), then re-renders with the caret after the mention. Esc cancels and leaves the text as it was. "@" at a caret in a block opens the same palette empty (recently viewed first); the chosen result is inserted as a mention at the caret, and Create uses what was typed as the title. In a title (plain text in Tana) "@" just types "@". For @ linking the palette is a dropdown, not a centred popup: no scrim, a compact card (440px wide, at most 360px tall) hanging under the selection or caret at its left edge, flipped above it when there is more room there (`anchorPalette`).
- **Hotkeys**: in the Cmd+K palette, Cmd+Shift+K on the highlighted row opens a recorder modal like the attached Tana screenshot: "Recording keyboard shortcut for:" + the row's title, a large box showing the currently pressed modifiers/keys as symbols (⇧ ⌘ ⌥ ⌃ + key) with a red recording dot, buttons Reset / Cancel / Save. Save stores { itemId -> combo } in localStorage ("hotkeys"); the palette shows the combo as a kbd chip on that row; while the outline has focus (not inside a palette or the filter input) the combo triggers the row's action (switch view, sync, log in, or open that document). Reset clears the row's hotkey. Combos must include ⌘ or ⌃ to be accepted (so typing is never hijacked).
- **Sync icon**: the Sync row in Cmd+K uses window.ICONS.sync (grey) instead of no icon.
- **Chevron**: the hover expand/collapse circle becomes 14px (chevron glyph ~6px) and is vertically and horizontally centred in the gutter space left of the bullet; keep the hover-only behaviour.
- **Breadcrumb**: none any more — the header row is Home and ⌘K, and the page title says where you are (Addendum: the header row).
- **Recently viewed**: the search palette (Cmd+S, and the @ palette) with an empty query shows a group headed "RECENTLY VIEWED" (small uppercase grey heading, like the attached Tana screenshot) listing the last 20 documents the user zoomed into or opened via a palette, most recent first, rendered as normal result rows (icon, title, chips, meta). Keep the list in localStorage ("recent": [{ id, title, icon, tags, meta }]); record on every document zoom/open; dedupe by id.


## Addendum 7 (pins, custom icons, draft child)

- **Pins** (docs/PINNING.md is the source of truth): `api.pins()` -> Node[] = the user's sidebar pins in order (each resolved to the usual Node shape via the document's data map); `api.pinState(docId)` -> { sidebar: boolean, dates: ['YYYY-MM-DD'] } (personal date pins for that doc); `api.pin(docId, target, date?)` / `api.unpin(docId, target, date?)` with target 'sidebar' | 'today' and an optional local `YYYY-MM-DD` for the date target, which defaults to today in main. Renderer: Cmd+K gets a "Pinned" group (after Views) listing api.pins() rows, Enter opens the document; and, when the outline is zoomed into a document (or a document row is focused), context actions in the Actions group: "Pin to sidebar" / "Unpin from sidebar", "Pin to today" / "Unpin from today" and "Pin to tomorrow" / "Unpin from tomorrow" depending on api.pinState. The tomorrow row is the same date pin one day on: the renderer computes the day (`localDate(1)`) because its label depends on whether that day is already in `dates`, and passes it with the call. Pins refresh after each action; onChanged(null) also refreshes the Pinned group.
- **Custom icons** (app-local): `api.setIcon(docId, svg | null)` stores an SVG string per document in the local db; Node gains `iconSvg?: string` (raw SVG) which the renderer shows in the bullet slot instead of the default icon (16px, rendered as-is; still the zoom/collapse target). Cmd+K actions for the current document: "Set icon…" enters drop mode: a full-window overlay "Drop an SVG file to set the icon of <title>" (Esc cancels); dropping a .svg file (read via FileReader as text; reject anything else) calls api.setIcon(docId, text). "Remove icon" calls api.setIcon(docId, null). Also accept an SVG dropped directly onto a node line (no palette) as setting that node's icon.
- **Draft child**: expanding a node (document or block) that has no children shows one draft empty child node: rendered like a normal empty node (bullet, editable text, placeholder colour), but it does not exist in Tana until the user types the first character, at which point it is created with api.insertChild (block parent) or api.insertAfter(docId, null, text) (document parent) and becomes real (caret preserved). Collapsing, navigating away, or leaving it empty simply drops the draft. Enter/Tab/Backspace on an empty draft do nothing except Backspace which removes the draft and moves the caret to the parent.

## Standing rule: keyboard first

Every feature must be fully operable from the keyboard before any mouse affordance is added. With nothing focused, Down (or Tab from the page) focuses the first visible node and Up focuses the last; palettes, modals and overlays are keyboard-complete (arrows, Enter, Esc) and return focus to the node that had it. New UI must document its keys in this file.


## Addendum 8 (draft documents in views, doc tag)

- `api.createDocument(title, { kind })` with kind 'doc' (default) | 'task' | 'meeting'. task: data.stateType 'open' + stateEnteredAt + stateChangedBy + assignedToUris [me] (+ChangedAt/By) so it shows in the Tasks view; meeting: a 'tana:event:' document laid out like a Tana-native event (type 'event', title, startTime/endTime ms defaulting to the next half hour + 30 min, timezone, participants, restricted, createdAt; mirror the fields of a real Tana-created event, not a provider-synced one) so it shows in the Meetings view and in Tana's calendar.
- Plain documents (kind text, no task state, no type) get icon 'doc' (window.ICONS.doc, grey) and the tag { label: 'doc', color: 'grey' }; typed documents keep their type tag and the plain bullet; tasks/meetings unchanged.
- **Draft documents**: in a view (not zoomed), Enter on a collapsed top-level document node creates a draft sibling document below it (a task in Tasks, a meeting in Meetings) rendered like a real node (icon, checkbox for tasks, chip) but not stored until the first typed character, which calls api.createDocument(text, { kind }); further edits go through setTitle. The new node keeps its position in the list until the next roots refresh. Enter on an expanded document keeps creating the first content child. An empty draft is dropped on navigation away, Backspace on it removes it and focuses the previous node. Keyboard first: Enter with nothing focused in an empty view creates the first draft.

## Addendum 9 (spaces)

- Documents with ids starting with `tana:space:` are spaces: icon 'space' (window.ICONS.space, grey), tag { label: 'space', color: 'grey' }, no checkbox. `api.children(spaceId)` returns the documents the space owns as document Nodes (kind 'document', with icon/tags/meta, newest first) instead of blocks. The renderer renders document-kind children like view documents (icon in the bullet slot, chips, checkbox for tasks, title editable via setTitle), bullet click zooms into them, expanding loads their own children (blocks, or documents again for nested spaces). No draft children inside spaces; Enter on a document child inside a space does nothing yet. Spaces appear in Pinned, search and mention navigation.


## Addendum 10 (members, task filters, multi-select, caret)

- **Members**: Tana user profiles (`tana:user-profile:` ids, graph nodeTypes ['user-profile']) are searchable: they appear in Cmd+S / @ results with icon 'member' (window.ICONS.member, grey) and tag { label: 'member', color: 'grey' }; `#member` is a search filter token (sdk/query.js). `api.members()` -> Node[] of all org members (title = display name), cached per session. Opening a member shows its profile document (children may be empty). Linking a member via @ inserts a mention with the member's uri.
- **Task filters** (Tasks view): `api.taskFilter()` -> { states: string[] | null, assignee: 'me' | 'anyone' | 'unassigned' | <user-profile uri> } and `api.setTaskFilter(filter)` (persisted in the local db; default { states: ['proposed','open'], assignee: 'me' }); setting it re-runs the Tasks query (stateTypes = states or all four when null; assignedTo [uri] / unassigned true / nothing for anyone) and refreshes roots. Renderer: under the "Tasks" title a row of two pill buttons like the attached screenshots ("Status <Inbox, In Progress>" and "Assigned to <You>", light-blue pill, bold value); each opens a dropdown menu (Status: "Any status" then checkable Inbox / In Progress / Completed / Later mapping to proposed/open/closed/not_now; Assigned: "Anyone", "You (<name>)", "Unassigned", then a "Members" heading with api.members()). Keyboard first: the pills are focusable (Tab from the title, Left/Right between pills), Enter/Space opens the menu, Up/Down/Enter toggle, Esc closes and returns focus to the pill. The menu styling follows the screenshot (white card, 10px radius, shadow, highlighted active row, ✓ on checked rows).
- **Multi-select**: Shift+Down / Shift+Up extend a selection from the focused node over following/preceding visible siblings (block nodes within the same parent; documents in a view likewise); Shift+click adds a range; selected nodes get a light-blue background (#e8f1fb) and the caret leaves the text. Cmd+Shift+Backspace removes all selected block nodes (sequential api.remove, last first) and focuses the node before the range; Cmd+Shift+Up/Down moves the whole selected range up/down among siblings (sequential api.move in the right order, selection preserved); Esc or any plain arrow key clears the selection. Document nodes: delete is ignored, move is ignored.
- **Caret on empty nodes**: an empty contenteditable node (draft or emptied) must show the blinking caret immediately (render a zero-width-space placeholder or min-width/inline-block so the caret has a box; strip the placeholder when reading text).



## Addendum 11 (Library view, editable title)

- **Library view**: a third top-level view "Library" (Cmd+K Views, icon 'doc'). It is a filtered listing of the whole workspace: `api.library({ types, states, assignee, text })` -> Node[] (newest first, up to 100). types: null (any) or a subset of 'meetings' | 'tasks' | 'docs' | 'chats' | 'canvases' | 'agents' | 'skills' mapped to graph nodeTypes (event / text+stateTypes / text without state, filtered client-side / chat / canvas / agent / skill); states + assignee apply when tasks are included (same semantics as the Tasks filter); text is an optional server-side textQuery. The filter is persisted per view in the settings table (`api.libraryFilter()` / `api.setLibraryFilter(f)`, default { types: ['tasks'], states: ['proposed','open'], assignee: 'me', text: '' }). Renderer: under the "Library" title a search box ("What are you looking for?", server-side text, debounced 300 ms) and pill buttons like the attached screenshot: "<Type>" (menu: Any type, then Meetings, Tasks, Docs, Chats, a divider, Canvases, Agents, Skills with their icons and ✓ marks), and, when Tasks is among the types, the Status and Assigned pills from the Tasks view. Rows render like search results (icon, chips, meta). Chats/canvases/agents/skills open read-only (children empty) for now.
- **Editable page title**: when zoomed into an editable document, the big page title is editable in place (contenteditable, saves via setTitle with the usual debounce/flush, Enter blurs and focuses the first child node, Esc restores). Native titles are plain strings, so title editing cannot create inline mention nodes. User profiles and unsupported kinds are read-only; events are currently read-only because the native organizer/calendar write capability is not exposed. With the caret in the title, Cmd+K opens the palette with that document as the current document (so Pin/Unpin/Set icon act on it) and Cmd+S / @ work as elsewhere. Keyboard first: Up from the first child node focuses the title; Down from the title focuses the first child (or the draft child when empty).

- Cmd+K pin actions use icons: window.ICONS.pin for "Pin to sidebar"/"Unpin from sidebar" and window.ICONS.pinDate for the two date pins ("Pin to today"/"Unpin from today", "Pin to tomorrow"/"Unpin from tomorrow"); pinned rows in the Pinned group show the pin icon on the right in grey.
- **Pin to current meeting** (`id: pinToMeeting`, the id kept from when the row read "Pin to meeting", because a recorded key belongs to the id) pins the current node on the meeting this user has *joined*, which is `api.currentMeeting()` — `main/quickadd.js:currentMeeting` over `sdk/calls`, the same lookup the quick-add panel makes (docs/QUICK-ADD.md), not an event that merely starts now. The write is `api.pinTo(eventId, docId)`, the event pin the panel and the sidebar already use, and it dedups on uri, so pressing twice pins once. The row is always listed on a real node so ⇧⌘K can record a key against it, and carries its state as the hint: the meeting title, "Checking…", "No active meeting", or the reason the lookup failed — a failed lookup is never shown as no meeting. The meeting is read once per palette open and looked up again at the press, because a meeting outlives an open palette by minutes at best; a meeting that ended in between pins nothing and says so.
- **Pin to meeting …** (`id: pinToSelectedMeeting`) is the same pin against a meeting you choose rather than one you are in, so it needs no live meeting and is never disabled. It opens a page of its own (`palMode = pinMeeting`): the meetings you take part in from a week back to a week ahead — the filter `{ types: [meetings], participant: me, window: recent }` through `api.searchPreview`, which runs a filter without storing it — read once per open and matched in the renderer with the palette own `fuzzyMatch`, so typing costs no round trip. The rows are ordinary document rows, so each shows the meeting own date and time and two meetings of the same name are told apart. Enter pins and closes; Escape steps back to the command page (`backPalette`); an empty window says so on the page, a query that matches nothing falls to the palette own "No results" line, and a list that could not be read shows why. The page is ordered next-first against the clock at the moment it opens (`byNextFirst` in renderer/palette.js): meetings on now or still to come, soonest start first, then meetings that are over, most recent first — read from `start`/`end`, never from `meta`, with a stable sort so meetings sharing a start keep the order the graph gave them. The sort happens once when the list lands, so typing filters that order instead of making one of its own, and every open loads again and re-sorts against the current time. Both rows end in `pinDocToMeeting`, the one `api.pinTo` plus the two cached sidebar payloads it drops.
- **The pin mark and Edit pins**: a node that is pinned says so where its audience does — the tack (`pinned`, build/icons/pin-tack.svg) in the row's meta icons beside the lock, and a "Pinned" row in the sidebar's Details. What a row knows comes from one `api.pinIds()` read (`pinnedIds`/`isPinned`/`loadPinned` in renderer/nodes.js, main `pinnedUris` over the sidebar collection and the pin-map), kept like the sensitive marks and re-read whenever a pin is written or a global change arrives; `rowSig` carries it, so a reused row is rebuilt when it changes. That list is the *personal* pins only — a node pinned on a meeting and nowhere else carries no mark, because answering that for every row on screen is a reverse edge query per view. Pins are personal, so a node you cannot write still carries the mark. Clicking the mark — or the sidebar row, or ⌘K **Edit pins** (`id: editPins`) — opens `palMode = 'pins'`: everywhere this one document is pinned, from `api.pinState`, which answers `{ sidebar, dates, hubs }` — your sidebar, each date (today and tomorrow named), and the meetings and spaces it hangs on, read back through `main/pins.js pinHubs` as the reverse `EDGE_TYPE_HAS_PIN` edges plus one `ListNodes` for their titles. Enter takes any of them off and the page stays open: a sidebar or date pin through `pinAction` (your own documents), a hub pin through `api.unpinFrom` (`unpinFromHub`, a write to that meeting's own `pinnedItems`, which main refuses without write access there), re-reading both sidebars because the item leaves a section of the hub's page. Under the list is what can still be pinned — "Pin to sidebar", "Pin to today" and "Pin to tomorrow" when they are not already on (a day it is pinned to is a row above instead, so it is never offered twice), and "Pin to meeting" whatever else is, since a document can hang on more than one meeting; that one hands the document to the same picker ⌘K opens (`openMeetingPicker(doc, back)`, whose second argument is the page Escape returns to, so it comes back to Edit pins rather than to the command page). One query narrows both halves, and when no pin is left on screen the page says which silence that is: "No pin matches" when the query hid them, "Not pinned anywhere" when there are none.
- Chevron: the hover circle sits further left, with at least 6px of clear space between the circle and the bullet/icon (the circle centred in the gutter left of the icon slot).
- **Loading animation**: while a view has no rows yet (first boot, before roots/library resolve, or while not yet connected), and while a zoomed page's rows have not been answered (a reopened page before the connection, a page just opened), the content area shows the loading animation (renderer/loading.js) after a 300ms wait, and it fades as the rows arrive; never shown once rows exist.

## Addendum 12 (typed tags in colour, images)

- **Type colours**: a type tag carries the type's colour: tag { label: <type title>, hue: <0-360> } when the type node has appearance.hue (grey otherwise). Renderer chip: background hsl(hue 80% 92%), text hsl(hue 45% 30%), same shape as other chips. Applies everywhere tags render (outline rows, palettes, Library).
- **Images**: content image blocks appear in the outline as Node { kind: 'block', type: 'image', image: { uri, alt, width, height } } (uri = tana:image:… or cid reference as stored). `api.image(uri)` -> Promise<string> data URL, fetched by main with the session token from Tana's asset endpoint and cached in memory (and on disk under userData/images) so the renderer can render <img> without credentials. Renderer: an image node renders the image (max-width 100%, max-height 360px, rounded 6px) under a bullet, alt as title attribute; it is not editable; Backspace/Cmd+Shift+Backspace removes it like any block; Up/Down skip through it.
- api.members() marks the signed-in user with `me: true` so the Assigned menu can read "You (<name>)".
- Keys added by the Library renderer: search box Down → pills, Up from the first row → last pill, Right on the last pill (Group) → the first row, Down on a pill opens its menu.
- Zoomed task: when the zoomed document is a task, the page title shows the task checkbox before the editable title (same rounded box, green with a check when done), toggling via api.setDone; keyboard: Cmd+Enter with the caret in the title toggles it. Done tasks show the title struck through in grey like task rows.
- Member icon is circle-user (window.ICONS.member). @-linking must also work in document titles (task rows in a view and the zoomed page title): a selection inside a document title + "@" opens the palette and replaces the selection with a mention; document titles are plain strings in Tana, so the title becomes the label text (mention text) while the link is kept only where segments exist (blocks); in titles, insert the linked item's title text.

## Renderer acceptance updates (2026-09-13)

- Library has no fixed search field; Cmd+F and Cmd+S remain the search entry points.
- MCP chats is a label-only toggle: grey when excluded, blue when included, with matching aria-pressed.
- Node appearance.hue colors its icon and kind tag; custom-type tags retain their type hue. Zero is a valid hue.
- Dropdowns stop above the window edge and scroll internally. Keyboard navigation keeps the active option visible.
- Outline selections have square corners. Members is a top-level view with circle-user; chat nodes use the chat icon.
- Cmd+K shows sidebar section groups. Unsectioned pins form one Pinned group, preserving their relative order.
- Any type uses pop.svg; Edit hidden items uses eye-closed.svg (Mark as sensitive keeps eye-slash.svg). Sync remains a palette action without a default shortcut.
- Login is shown only after a completed session check confirms signed-out; an unresolved or failed check is not signed-out.

These are acceptance requirements; GitHub issues and their PRs record verification status (docs/TASKS-HISTORY.md before 2026-09-23).

## Mutation and refresh contracts

- An ordinary `onChanged(docId)` reloads that document without closing zoom or evicting its identity. `onRemoved(id)` is the deletion event and evicts the deleted document from pins, recent results and the outline. Unpinning refreshes pins; it does not delete the document.
- A plain child inside a task stays a paragraph. Only a new sibling after an explicit checkbox block inherits an unchecked checkbox. Cmd+Enter converts a plain block using Tana's native structure and toggles existing checkboxes.
- Visibility and move pickers use `accessOptions` and backend capability checks. The supported sharing rules are only me, selected people, and inherit the location audience. Sharing and move checks treat ownership as a location boundary, never as a write grant; inherited or unknown access remains unavailable. Move also verifies source/target write access, descendant cycles, typed-document home-space rules, type-instance counts, and audience before/after before enabling the action. Unsupported or unstable cases stay disabled rather than guessing permissions.
- `npm run check` includes the renderer auth and behavior checks. Integration verification must also exercise real DOM updates in an offline Electron window: helper-only tests previously missed an ordinary-update event being treated as deletion.

## Current verified backend boundaries (2026-09-13)

- **Bootstrap readiness.** `sync.subscribe(id, init)` resolves only after the matching bootstrap-complete frame and the document enters `live`. `getDocument(id)` can expose a handle earlier, so callers must await `subscribe` before reading it; the main process does this for outline operations. A cold unknown id is detached as not found after the retry window; a locally initialized warm id can become a new document during bootstrap. Reconnects reuse the `Document` object and bootstrap it again.
- **Sharing and move confirmation.** `access.capabilities` is the gate for the palette. `setSharing` accepts only the advertised `me`, `people`, and verified `inherit` rules; inherit requires the current `sharingToken`, and the backend rechecks observed documents for changes. `previewMove` returns before/after audience data and a token after checking permissions, scope, counts, and stability. `moveToSpace` previews again and requires the exact returned token whenever audience confirmation is required, so stale or missing confirmation is rejected.
- **Renderer access behavior.** The renderer disables unknown or unavailable visibility/move/delete actions, passes the current sharing token for inherit, shows move audience before/after data, and submits the move preview token. ACL-change errors clear the cached options and reload them. Title editing follows the node's explicit read-only capability; it does not authorize a server mutation.
- **Deletion and undo.** Delete is native soft-delete and restore. The main process validates the document URI, `access.canDelete` (supported kind, write access, and event organizer rule), and the server's `documentActionResponse` before updating visibility. Delete/restore actions are recorded in global history; undo/redo repeats the native action and relies on the server live update to restore document content and access state. Block and metadata edits use each document's local CRDT UndoManager, while renderer Cmd+Z/Cmd+Shift+Z/Cmd+Y go through the main-process history API. `onRemoved` means explicit deletion; an ordinary `onChanged` is a refresh.

## Addendum 15 (relationships rail)

A zoomed document shows its relationships in a right rail (#rail), fed by api.related(docId). The rail is not
part of the outline: its rows are edges, so they open on Enter or click, a task row toggles on Space, and
nothing there ever takes a caret. Rows keep the plain look of the rest of the UI (icon, link title, tag chip),
not cards.

- Four collapsible sections: Pinned (EDGE_TYPE_HAS_PIN from the node), Outcomes (documents it owns that carry
  a task state), Notes (documents it owns without one) and Backlinks (documents that mention it). Collapsed
  sections persist in localStorage.railClosed; an empty section is omitted and an empty rail is hidden.
- **Backlinks**: the zoomed node's incoming EDGE_TYPE_LINKS_TO edges (a mention in someone's text — one per
  mentioning document, carrying the label and the block ids) and its incoming EDGE_TYPE_ATTRIBUTE_LINKS_TO edges
  (this node sitting in a typed field, carrying `properties.attributeUri`, "tana:type:<id>?attribute=<key>"). They
  are the node's own, not the meeting hub's, and skip untitled drafts and anything already under Pinned.
  `api.related(docId).backlinks` is `[{ label, rows }]`, grouped the way Tana's own Backlinks panel groups them
  (read out of their bundle): one section per field, named "<Type> › <Field>", then **Mentioned in** last. A field
  whose title cannot be read joins the mentions rather than naming a section after an attribute key. Each group is
  a sidebar section of its own, so they collapse and take the keyboard like the rest.
- Opening a meeting's notes document shows the meeting's relations: related resolves an event owner as the hub.
  The open document, untitled drafts and anything already listed under Pinned never repeat.
- **Live** (#21): the backlink sections and Pinned follow Tana while the page is on screen. `watchRail` (renderer/rail.js)
  names the page to main (`api.relatedWatch(docId)`, null for none or a local draft), and `watchRelated`
  (main/related.js) opens Tana's own edge live queries for it — `{ object: page, LINKS_TO + ATTRIBUTE_LINKS_TO }`, the
  query Tana's "Mentioned in" asks, and `{ subject: hub, HAS_PIN }` when the page is a meeting, a meeting's notes or a
  space, the query Tana's EventPins asks. An edge added or taken away anywhere sends `related:changed`, and the
  renderer re-reads the sidebar through `refreshRelated`, old payload on screen until the new one lands. One page at a
  time, like the presence room: a new page closes the last one's queries. A mention edited in place (its properties
  move with the text around it) and the first answer say nothing. Outcomes, References and Changes are not edges and
  stay read once per page.
- **Changes** (sidebar, #276): the zoomed node's own history, last section, newest first. `api.related(docId).changes` is `[{ action, by?, others?, at?, title?, note? }]`. It comes from **`tana.history.v1alpha1.ChangeSummaryService.ListChanges`** (`sdk/history.js`, `{ uri, withinId?, limit }` -> `{ parent?, summaries[] }`), the same service Tana's own Changes panel uses: each `ChangeSummary` carries a written `title`, a longer `description`, `authors[]`, `startTime`/`endTime` and a `changeType` of `UPDATED`/`CREATED`/`DELETED`. `summaryChanges` reverses it (the service answers oldest first), dates an entry by when its window closed, reads a missing `changeType` as `Updated` (protobuf JSON omits the default) and counts authors beyond the first instead of dropping them. When the service answers nothing, `changesOf` falls back to the graph node `related()` already fetched: one `Updated` per person in `editors`, `Created` from `createTime`/`createdBy`, `Deleted` from `archivedAt` — and those rows have no written title, so they show the node's own. Each row shows the kind of change as a glyph (`updated` pen-writing, `created` file-plus, `trash` for a deletion — `CHANGE_ICON` in renderer/rail.js), then what the change is about with "who · when" under it (`memberName` and `agoText`, the same two helpers the outline subtext uses). The glyph carries the action instead of a word and names it in its `title`/`aria-label`, so nothing is lost to the pointer or to assistive tech; a kind with no glyph of its own falls back to saying itself in the line. A part the graph does not name is left out rather than guessed, and a deletion has no actor because the graph keeps none. The rows are display only: they open nothing and change nothing. The section collapses like the others (`railClosed`, and every sidebar head now carries `aria-expanded`). **Limits of the source**: the graph keeps no per-edit log, so two edits by the same person are one entry, and nothing says *what* changed; `updateTime` stands in as an unattributed `Updated` only when a node lists no editors at all. The rail's payload is read once per page and left alone while that page is edited: its sections are relations, and typing changes none of them (a task listed in it is patched in place by `patchCopies`). Only a metadata change — assignees, audience, participants, which main already compares to set `info.meta` — and a pin ask for it again, through `refreshRelated` (renderer/rail.js), which re-reads the document while leaving the payload on screen until the new one lands; `invalidateNode` still drops it outright, because that node is gone. What this costs is that **Changes** says what it said when the page opened rather than naming your latest edit.
- Keyboard: Cmd+Right enters the rail, Up/Down move, Enter opens, Space toggles a task, Escape or Cmd+Left
  returns the caret to the document.

## Addendum 16 (Inbox, today node, fields, the meeting write-up, Library as a move target)

The rail of addendum 15 is now a full-height **sidebar** beside the document: its own scroll, a border, row titles in
ordinary text rather than blue links, and a drag handle on its left edge (200-620 px, width persisted). The keyboard
contract is unchanged.

- **Inbox view**: `api.inbox()` -> Node[] = everything still in Tana's inbox state (`stateTypes: ['proposed']`),
  whatever kind it is, newest first, icon 'inbox'. It is the first view; the Cmd+K order is Inbox, Tasks, Meetings,
  Library, Chats, Members (what is waiting on you, then your work, the calendar, knowledge, conversations, people).
- **Today node** (Cmd+K "Today" under Views, default Ctrl+Shift+D): `api.todayNode(offset = 0)` -> the id of the document
  titled with a local date (`YYYY-MM-DD`; offset in days, 0 today and 1 tomorrow) and pinned to that date, creating and
  pinning it when it does not exist yet, so the command always lands somewhere. Matching is on the exact title; a second
  run reuses the same node. "Add to Tomorrow" is the only caller that passes an offset.
- **Fields under the title**: a zoomed node shows its typed fields (text-input icon, label, value) between the title
  and the outline, from `api.related(docId).fields` (`[{ key, label, text, lines, segments }]`, which is what the
  label and the words are read from). The value itself is **an outline**, drawn by the outline's own rows: a field
  holds what a node holds — several rows, children under them, bullets, block types, references, checkboxes — and
  it is the same code, so everything a row does a field row does, including "- ", Tab, Enter and ⌘Z — every row listener is bound to both places rows live (`onRows`, renderer/events.js), and `texts()` spans them in reading order, so Up and Down walk title → fields → outline (`caretRows()`, renderer/nodes.js). That list is for the caret only: `texts()` is the outline’s own rows and `fieldValues()` the field’s, and anything that changes what a row belongs to — removing it, merging into the row above, selecting a range — works in `rowsBeside(el)`, the list that row lives in, so Backspace at the top of the page cannot reach into the field above it. Tab on a plain line bullets it and, when the row above is already a list row, indents it under that row; a plain line above is never made a parent. Tab at the start of a plain line starts a list there, the same gesture as "- ", and ⇧Tab takes that marker off a top-level bullet. A row whose whole content is one reference stays a line with a live chip in it here rather than being drawn as the node it points at: a field is a list of names, and a row that grows a glyph and a grey subline is twice the height of the line above it. Its id is the
  document and the field together, `<document uri>|<type uri>?attribute=<key>`: `api.children` and every `block:`
  call take one, main resolves it to the field's value (`fields.fieldView`, `document()` in main/documents.js) and
  the rest of the path is unchanged. Undo belongs to the document that carries the field. A read never creates a
  value — opening a typed page would otherwise write an empty tree into every empty field it has — while a write
  creates it. A render defers while the caret is in a field row, as it does for a row in the outline.
  Fields are Tana "attributes": the value lives in the
  node's own data map, the label in its type's template (sdk/fields.js, docs/MEETINGS.md); for a field whose
  cardinality is multiple, Tana reads each block as one of its values.

- **Meetings open at their write-up**: an event has no content of its own, so zooming a meeting forwards to the
  document it owns whose title is the event's tagline (generated appearance image as the fallback), through
  `api.summaryUri(docId)`. One rule in main (`writeUpOf`) serves both the navigation and the rail, so every route --
  the Meetings list, search, pins, recents -- lands in the same place, and the write-up is never repeated under Notes.
- **Library as a move target**: the move picker offers "Library" beside the spaces. The Library is Tana's name for a
  document with no owner, so moving there removes `ownerUri` rather than setting it to null; a type still has to live
  in a space. Audience confirmation is unchanged (sdk/access.js).
- **Links in node text**: http(s) URLs inside a text run render as underlined links and open in the default browser
  via `api.openExternal(url)` (http/https only). The stored text is untouched, so the row stays editable.
- **Type nodes and typed nodes**: `tana:type:` documents are a listed kind (shapes icon, `# type` tag, their own hue);
  a typed document without its own icon draws the same generic type icon tinted with the type's hue, matching its chip.

### Addendum 16 additions from the review pass

- In the sidebar, Left collapses the section the focused row belongs to and Right expands it again; Up/Down, Enter,
  Space and Escape are unchanged.
- A palette row that cannot run is greyed and skipped by Up/Down, so Enter always has an effect.
- A focused read-only row shows a focus ring; editable rows keep the caret and no ring.
- A view with no rows and no filter says "Nothing here yet" rather than rendering blank.
- An error from an action clears as soon as the next action succeeds.
- Sharing and move never enter the undo stack: their audience disclosure and preview token are the gate, and a raw
  CRDT undo would bypass both.
- A zoomed event shows the full date form ("Fri 11 Sep 9:00-10:00"), matching search, not the short list form.

## Addendum 17 (one screen for the views, Cmd+K over selections and the current node, local marks)

What changed after addendum 16, stated once here; the details and evidence are in docs/TASKS-HISTORY.md rows 150 and up.

- **Views**: Inbox, Library and Types are one screen with three preset filters, and Tasks, Meetings, Chats and People are saved searches over the same query ([VIEWS.md](VIEWS.md)); `api.viewList(id, filter)`, `api.viewFilter(id)`, `api.setViewFilter(id, filter)`. Status and Assigned pills act only while tasks are in scope. **Sort** (Default, Updated, Created, Title; People defaults to Title, Tasks to Updated) and **Group** (None, Status, Assignee, Updated, Type; Tasks defaults to Status, showing Inbox, In Progress and Later. Updated sorts rows into Last hour, Last day, Last week, Last month and Older by `updatedAt`, newest first, a row without a time under Older) are pills too, applied to the rows already loaded and persisted per view in localStorage. "Clear filters" resets every pill to Any and empties the text.
- **Inbox checkbox**: a task in the Inbox state (`stateType` proposed) shows its unchecked box as a dashed outline (square-dashed glyph, masked, the same size as the grey box) in the outline, the page title and the sidebar; checked it is the usual green tick. Clicking that dashed box (outline row, task reference, sidebar) accepts the task first: it moves to In Progress (`api.setState` open, `acceptsFirst`) and shows the grey box; the next click completes it. In a list the clicked row stays put: it keeps its group (under Group by Status it stays under Inbox with its new box) and every row keeps its place until the view is left or its Sort or Group changes (`holdRow` / `releaseHeld` in renderer/views.js), so the row never jumps away from the pointer and reads as gone. Set status from Cmd+K does the same, and shows the new state (dashed box, grey box, tick) straight away: it writes it on the row and forces the render, because closing the palette puts the caret back in that row, where a plain render waits until the caret leaves. While rows are kept in place and the view would now draw them differently (a row that belongs in another group, an order a refresh changed), a Clean up pill (brush icon, `cleanup`) follows the other pills; clicking it, or Enter/Space on it, lets go and redraws (`needsCleanup` in renderer/views.js, `cleanupPill` in renderer/pills.js). Cmd+K carries the same action as a row under View options, after the pill rows, running the one shared `cleanupNow`. That row is always listed, unlike the pill: while nothing is being kept in place it is drawn grey with the hint "Nothing to clean up" and both a press and a recorded key do nothing, and it goes live the moment the layout diverges. Always listed because a shortcut is recorded against a row that is in the palette, and this one is wanted before it is ever needed — so Up/Down land on a disabled row that has an id (`nextPalIndex`), Cmd+Shift+K records against the fixed id `cleanup`, and `runAction` answers that key by doing nothing while the row is off rather than letting it fall through to another meaning.
- **A task's state shows everywhere at once** (#243): a status change reaches every place the task is drawn without waiting for the caret or a reload. The main process builds every row from the search index through `graphRow` and records its state in `rememberMeta`, and the index can trail a write by seconds, so a task this app holds live keeps its live state there (`liveState` in main/rows.js); otherwise the refresh two seconds after a status change put the old state back. In the renderer, a render deferred while the caret is in a row (or a selection is frozen) still updates every checkbox, the page title's and the sidebar's (`refreshRowChrome`), and a change to a task patches its copies: reference rows in open notes and sidebar rows (`patchCopies`, also on a sidebar click).
- **Hidden items**: `api.filters()/setFilters/addFilter/removeFilter` keep title patterns (whole title, or a prefix with a trailing `*`, case-insensitive) that drop matching nodes from every list and search; edited from Cmd+K "Edit hidden items". A hidden node opened directly still opens.
- **A row's facts follow the title, or the subtext** (`fitRowMeta` in renderer/render.js): who a node is for, who can see it and whether it notifies are grey facts drawn after the title. When the title fills the line the browser wraps them onto a line of their own, where they read as a second title rather than as facts about the first; there they join the `.subtext` instead, behind a `.metasep` carrying the same " · " its own parts are joined with, and its 8px lead-in comes off (`.subtext .tmeta`). One pass after every render measures every row before moving any, so the outline costs one layout rather than one per row, and a `ResizeObserver` on the outline answers the window, the sidebar drag and the text-size keys — width only, since moving the facts changes the height and would otherwise come straight back. The measurement asks how much room the line leaves (the body's right edge against the right edge of the last client rect of whatever precedes the facts — the meeting time when there is one, the title otherwise) rather than where the facts currently sit, so it gives the same answer from either side and a row cannot flip back and forth. `patchMeta` takes them out wherever they are before it rewrites the subtext, puts them back in front of the tags, and asks again.
- **Sensitive marks** (app-local, `api.sensitiveIds()/setSensitive`): marked documents render blurred on every surface (rows, title, chips, rail); Cmd+K "Toggle sensitive visibility" (and the header button) lifts the blur, and that choice is remembered on this machine (localStorage `sensitiveVisible`), so a launch opens the way you left it. It stays local rather than joining the settings that follow you: showing them on your own laptop should not unblur them on a shared one.
- **Demo mode** (issue #156): Cmd+K "Toggle demo mode" (hint On/Off, right after Toggle sensitive visibility) swaps what came from Tana for made-up words on screen, for showing the app to someone. Every word of a title, a row, a sidebar row, a table cell or a Timeline change becomes a made-up word, one for one, so a task keeps its word count: a short word from a list of short ones (`DEMO_SHORT`, so "to" and "Q4" stay small) and anything longer from a list of about 170 (`DEMO_WORDS`), each drawn on its own; a capital stays a capital, never all caps, and the same node always reads the same. People (`memberName`, member mentions, Timeline and notification actors, presence carets, attendee suggestions, the Assigned pill) get a stable fake name with as many words as the real one. The app's own words stay: view and page titles, headings, commands, types, saved searches (their titles on every surface: Cmd+K, the page title, list rows), field options, dates, and inside the rows of the app's own pages (`orbital:` ids) everything but the parts main marks `person` (a name) or `content` (a node's title); a notification's fixed sentence is marked `keep`. Nothing is saved while it is on: no text is editable (row text, the page title, table cells), checkboxes are disabled, and `tana` (renderer/state.js `readOnlyInDemo`) refuses every call that writes to Tana (`DEMO_WRITES`) with "Demo mode is on: nothing is saved to Tana", whatever asked for it — a key, Cmd+K, a drop. The day and week nodes, which are created and pinned the first time they are asked for, are only looked up (`todayNode`/`weekNode` with findOnly): Today, This week and a date link open what exists and refuse the rest. Cmd+K rows that carry Tana's words without being a document row are masked where they are built (the current meeting beside Pin to current meeting, the meetings and spaces on Edit pins, Move to space, a meeting's location), as are a space audience's name, a Changes entry's tooltip and an image's description. The quick-add panel reads the same stored choice (docs/QUICK-ADD.md). Pictures are never shown: an image is the grey box a loading one draws (a table cell's a grey block), nothing is fetched, and the full-size view does not open. A type row's grey meta (its space) is masked; a date is not. Rows main builds say which of their words are the app's: Timeline and notification rows (`person`, `content`, `keep`; a notification's own title, sdk/inbox.js `title`, is masked unless it names a type) and chat rows (sdk/chat.js: the assistant's name, "Thought for …", a message status and a proposal's state are kept, an author is a fake name, the conversation is masked). The switch reaches every outliner window at once (the storage event) and main (`app:demoMode`), which then posts no notification banner at all. The choice is remembered on this machine (localStorage `demoMode`), read before the first render, so a reload or a new window opens the way you left it and nothing real flashes up first; like sensitive visibility it does not follow you to another machine.
- **Selection and the current node in Cmd+K**: with rows selected (Cmd+click toggles, Shift+click and Shift+Up/Down extend) the palette leads with a "Selection" group — Mark/Unmark as sensitive, Add to Today, Add to Tomorrow, Add to This Week, Set status, Assign, Delete — each counting what it acts on and reporting "N skipped" for rows it cannot; with nothing selected the same rows apply to the current node (zoomed, or under the caret) under "Current node" without counts. Delete counts writable documents, or writable blocks when only blocks are selected; a read-only current node shows it disabled. Adding to a date node appends one block per document whose text is a mention of it.
- **Today and week nodes**: "Today" (`api.todayNode`, default ⌃⇧D; under Views in Cmd+K) opens the document titled `YYYY-MM-DD`, pinned to today; "This week" (`api.weekNode`) opens "Week N (YYYY)" for the ISO week. Both create the document when it is missing; they are separate documents with no link between them. Tomorrow’s node has no view row of its own: "Add to Tomorrow" creates it with api.todayNode(1), titled and pinned the same way.
- **Hotkeys**: every command row, the selection rows included, has a stable id that Cmd+Shift+K records against. The built-in keys are rows too, with a default combo in `DEFAULT_HOTKEYS` (renderer/state.js) that a recorded combo overrides and Reset restores: Search Tana ⌘S, Filter rows by text ⌘F, Go back ⌘[, Go forward ⌘], Undo ⌘Z, Redo ⇧⌘Z, Expand ⌘↓, Collapse ⌘↑, Complete/Reopen ⌘↩, Today ⌃⇧D. "Focus the sidebar" is a palette row with no default key: it fires only from one the user records. The document handler dispatches any of them by id; a key the focused node already answered to (⌘↑, ⌘↩) arrives defaultPrevented and is not run twice, and a row absent right now (no sidebar, nothing to go back to) leaves its key alone. Only ⌘K, ⇧⌘K, the text-size keys (⌘0, ⇧⌘+/-, shown as literal chips on their rows), ⇧⌘⌫ and the ⇧⌘↑/↓ moves stay fixed; the recorder refuses those, and any combo another row already has, with the reason shown (⌃ counts as ⌘, ⌥ is ignored for the fixed ones). ⌘Y is no longer a redo alias. A read-only row has no editor to defend, so it passes every ⌘ combo to the document handler and swallows only the plain keys it answers to. A command that reveals a field and then focuses it (Filter rows by text) shows the field itself rather than leaving that to the render, which is deferred while the caret is in a row: focusing a hidden field moves nothing.
- **Palette order**: groups run Selection (with a multi-selection, the page's own rows follow as Current page) or Current node, Table, Views (Work View, Timeline, Today, This week, Inbox, Notifications, Proposals, Library, Types — `VIEW_ORDER`, most used first), Searches, View options, Actions, Navigate, Window, Settings. Node rows follow `NODE_ROW_ORDER` in renderer/palette.js whichever file they come from: the focused field's rows, then Zoom in, Expand/Collapse; the task state (Complete/Reopen, Mark as read/unread, Approve/Reject proposal, Set status); who has it (Edit assignees, Assign to …, Discuss with …); a meeting's Change time / location, Add attendee; when and where it lives (the date and meeting pins, Edit pins, Add to Today / Tomorrow / This Week, Move to …, Move to Library); what it is (Set type, Classify type, Remove type, Add field, Edit fields); how it looks (Set icon, Set colour, Mark as sensitive); the agent rows (Assign to Agent, Go to / Link Agent task, Send to agent); Edit visibility, Notify on changes, Copy link, Export to PDF; and last Archive type and Delete. View options are the pills named for what they do — Filter by type, Filter by status, Filter by assignee, Sort by, Group by, each with its current value as the hint — then Clean up (always listed, grey with "Nothing to clean up" until rows are being kept in place), then Filter rows by text. Actions: Log in (when signed out), Create new …, Search Tana, Undo, Redo, Mark all as read, Sync. Navigate: Go back, Go forward, Go to Home, Set as Home, Focus the sidebar, Recently deleted, Archived types. Window: New window, Toggle split view, Go to the other half, Swap panes, Show/Hide sidebar, Reload. Settings: the three text sizes, the two theme toggles, Edit hidden items, Toggle sensitive visibility, Toggle MCP chats, Toggle demo mode, Manage Codex hosts, ChatGPT sign-in, Set OpenAI API key. A new node row gets a place in that list (an `id`, or a `rank` when it must not be recordable); a new app row goes into its group where it belongs in the push order.
- **Palette matching, ranking and folded levels**: `fuzzyMatch` in renderer/palette.js matches a row in tiers, the way Raycast ranks a title (first letters of words count for a lot): 0 the label starts with the query ("in" → **In**box), 1 the first words' initials in a row ("mtl" → **M**ove **t**o **L**ibrary), 2 the query starts a later word ("in" → Zoom **in**), 3 word-prefix chunks that skip words ("molib" → **Mo**ve to **Lib**rary), 4 a substring inside a word, 5 the letters in order with the first one starting a word ("inbx" → **Inb**o**x**). The matched letters are shown in bold. With a query, Cmd+K sorts by tier and then by where the match starts; a group moves as a whole to where its best row lands (so headings show once) and equally good groups keep the fixed order. A row that opens a second level (Move to …, Set status, Edit assignees / Assign to … / Assign N tasks to, Create new…, Edit visibility, the view option rows) carries `sub`, that level's rows; once the first two letters of the query reach such a row (as a prefix or its initials: "mo"/"mt", "as"/"at"), the level is loaded (once per palette opening) and each choice is offered as one row right below it — "Move to Foundry", "Set status to In Progress", "Assign to Robin", "Create new Task", "Sort by Title" — so one query reaches the choice without going down. "Move to …" and "Set status" (one task or a selection) are marked `subAlways`: the spaces (at most 50) and the four statuses are short lists, so they load as the palette opens and fold in for any query ("inb" → Set status to Inbox). "Move to …" (formerly Move to space) offers the spaces and Library; the Inbox is a state rather than a place, reached with Set status to Inbox. "Assign to" sets a task's assignee outright (setAssigneesMany with one document), where Edit assignees toggles them one by one.
- **A row that is only a mention chip** (`chipOnly` in renderer/render.js): this is Tana's full-reference presentation, a block whose only content is a reference. Chromium holds no caret before a non-editable inline that starts the field, nor after one that ends it, so `renderSegs` puts a zero-width space (`CARET_ANCHOR`) on each side that needs one, and every offset helper (`caretOffset`, `selectionOffsets`, `setCaret`, `textPoint`, the keydown `len`) counts it as nothing, so it is a placeholder like the trailing soft-break newline rather than content — `readSegs` strips it and `chipOnly` ignores it. The caret therefore shows both before and after the chip: without the trailing anchor it was placed after the chip correctly but painted nowhere, so the end of such a line read as having no caret at all. Typing either side prepends or appends ordinary text, which stores the block as text plus a mention: Tana's inline presentation, the same data shape Tana writes itself (verified live: a full reference and an inline one are both a `paragraph` holding a `mention`, the full one holding nothing else). Chromium still will not delete a non-editable inline from a plaintext field, so the row carries `.chiponly` and Backspace or Delete removes the row the way they remove an image or a divider. A read-only reference row, which has no caret either, is outlined when focused, and so is a lone chip whose target could not be read.
- **A full-line reference is the node it points at** (`isFullReference` in renderer/nodes.js, `.fullref`): main resolves such a block like a native embed — `resolveReferences` gives it the same `reference: { uri, label, node }` — and the renderer then builds the row from the target rather than from the block: its bullet and hue, its tag chips, its subtext and its checkbox, wired to `toggleReference`, so a task can be accepted and completed from the line that references it. The label is read from the target too, so a rename in Tana shows through; nothing is written back, because `setText` reuses a mention whose uri is unchanged. The block keeps its own identity and its editable text: the focus and the selection are drawn as a box around the whole row instead of around the chip, and the moment anything else is typed on the line the row is an ordinary one with an inline link again, since `isFullReference` reads the segments the row currently holds. That happens on the keystroke, not on the save: saves are debounced by 400 ms and the node keeps the old segments until the write comes back, so `nodeEl` asks `liveTarget(node, pending.get(item.key))` — the edit in flight, the same segments `renderSegs` draws — and the input handler redraws the row when that answer flips (`.fullref` against `chipOnly`), except mid-composition, where rebuilding the row would drop what the IME holds. Otherwise the box, the tags and the strikethrough of the other node stood on the line for the length of the round trip. Such a row's title is ordinary text, struck through and grey when the target is done, like any other node row: the blue underlined chip is for a reference **among** text, where it is what says these words live somewhere else. A lone chip whose target could not be read is still only a link, so it keeps the blue. Three rules follow from the row being the node rather than a link to it. **It cannot have children of its own**: expanding it opens the target's outline (`childHost` in renderer/render.js builds those rows against the target document, so editing one edits that document, and it is loaded on demand rather than with the page), so a block that already holds an outline is left an ordinary line with a link. It opens only when asked: `isOpen` has blocks open by default, which is right for a block's own children and wrong for another document's, so `opened` is read straight from `open` for these rows — otherwise a pasted reference arrived expanded whenever its target happened to be loaded already — `isFullReference` reads `hasChildren`, and main skips the lookup for the same reason. It does not offer a draft tail: adding to the referenced node is not something this row does. **A click selects it**, the way it already did for a native embed: the row takes the border, a second click puts the caret where you clicked, so typing beside the chip still works. The chip therefore does not navigate (`mention.closest('.fullref')` in renderer/events.js) — **the bullet is the way in**, and so is Space on the selected row. What hangs under an opened one is another document, so its guide line is dashed — the same 1px guide every other row has, only dashed: painting it as a background gradient buys a longer dash and loses the line, since a border snaps to device pixels and a 1px background column does not, so it renders wider and washed out — and the focus ring is drawn from `> .line:focus-within` rather than `:focus-within` on the row — a caret in the rows it opened is not a caret on the reference. Once the row is selected, clicking it again starts editing it, and so does Enter (`selKey` in renderer/select.js, through the same `clearSel`): the caret goes to the end, since a full reference has nothing to click into — its text is one chip.
- **Search result order** (Cmd+S and @ linking): Tana answers in its own order, which does not weigh the title, so `searchNow` re-sorts the hits by `titleHits`: the most typed words found in the title first (#type filter tokens left out), then the most of those that begin a word, then Tana's order. Only those words are bold in a result, not the looser Cmd+K letter match.
- **Links and location**: Cmd+K "Copy link" copies the home.tana.inc url of the current node; the rail's Details section carries "Show in Tana" with the same url, the meeting's call link, the assignee and the visibility (which opens the people picker directly when set to selected people, and offers "only me" and "inherit" as ways back). Sidebar tags collapse to their `#` and hue, expanding on hover without changing the row's height.

## Addendum 18 (rendering budget)

Keyboard addition: **Space** on a focused read-only row (a meeting, a member, anything without an editor) zooms into it, and on a focused reference row opens what it points at; with exactly one row selected and nothing focused it does the same. Editable rows keep Space for typing.

Measured on a 53-row Library before this addendum: 6–7 ms per full render, but 78 renders in the six seconds after opening a 56-row view (one per metadata answer), four renders and two identical graph queries per 30-second refresh tick, and every text edit throwing away the document's cached metadata and reloading all six views' rows. Now:

- `renderSoon()` coalesces metadata, members, pins and the rail into one render per animation frame; `render()` stays synchronous for user actions that need the DOM immediately after. A document live update forces the caret-preserving render after reloading its children, because a zoom parks the caret in the blank tail and an ordinary render would defer until focus left. A metadata answer patches its own rows (`patchMeta`) and renders only when the zoomed document is the one answered.
- List rows are keyed and reused: a collapsed row whose `rowSig` (text, done, icon, hue, meta, tags, editability, draft, sensitivity, metadata, member count, open state, pending edit) is unchanged keeps its element; items keep their identity across renders so the reused row's handlers see the current node.
- `onChanged(docId, { meta })` patches that row from one `doc:info` call (falling back to a roots reload only when no view lists the document) and keeps the cached metadata unless main says assignees, restriction or participants changed. `onChanged(null)` reloads roots, which now carry each view's `truncated` flag, and runs no second query.
- Main batches the per-row link-sharing lookups into one `nodeIds` query per 25 ms, writes nothing to SQLite for an unchanged row, and returns cached rows in each view's own order so a boot from the cache looks like a refresh.
- Icons are cloned from a parsed template per icon name; `docOf` caches hits per render; the renderer's image cache holds 200 entries.

After: 13 renders totalling 23 ms on opening the same view, 3 renders totalling 4 ms and one query per refresh tick, and a title edit is one render, no roots reload and no metadata refetch.

## Addendum 19 (opening a node: caret at the bottom, page at the top)

Opening a node — a bullet, a mention, search, a pin, Cmd+[ and Cmd+] — still leaves the caret in the row to
type in, which is the draft tail at the very end of the node (addendum 7). The page no longer follows it there: an open
shows the top of the node, and the caret waits out of sight until it is used.

- The caret is parked with `el.focus({ preventScroll: true })` before `setCaret(el, 0)`. Focusing the last row the
  ordinary way scrolls a long node to its bottom, which is what an open used to do; `setCaret`'s own `focus()` is then a
  no-op (already the active element) and collapsing a range into it does not scroll either. `setCaret` is unchanged for
  every other caller — arrows, splits, Enter — which do want the row brought into view.
- The zoomed render pins `outline.parentElement.scrollTop` to 0 while `caretOnOpen` is set, so both renders of an open
  land at the top: the "Loading…" one and the one the children arrive on, which grows the content. Later renders (live
  updates, refreshes, metadata) are left where the reader put them.
- The first character typed scrolls that row into view, once per open (`scrollOnType`), with
  `scrollIntoView({ block: 'nearest' })` — the smallest move that shows it, and nothing at all when the row is already
  on screen. A read-only row is not typing, so it neither scrolls nor spends the one-shot the real row is waiting on.

## Addendum 20 (a row only glows green when it really did arrive)

Addendum 18's arrival animation flashed rows that had never moved. `animView` is meant to answer "does the outline
already hold this view's rows?", but it stored only a view id, which was wrong in both directions:

- It was **set by a paint that drew nothing**. `loadView` resolves after the render that asked for it, so opening a view
  that has not been loaded paints zero rows first; that empty paint spent the first-paint guard, and the render the
  rows actually arrived on saw an empty `before` and flashed the whole view. An empty `before` is now a first paint.
- It **stayed set while the outline held someone else's rows**. The zoomed branch replaces every row without going
  through `animateRows`, and a zoomed block row is keyed `docId/nodeId` while a view row is keyed by its document id,
  so on the way back nothing matched and every row looked new (the zoomed rows flashed red as departures at the same
  time). The zoomed branch now clears `animView`, so the next view paint is a wholesale replacement, not arrivals.

`BULK = 25` is why this read as intermittent rather than constant: a list over the cap skips the animation silently, so
a 53-row Library never flashed while a short Inbox did. A row that genuinely arrives into a settled view still glows.
One consequence is deliberate: a row added to a view that was empty does not glow, because that is indistinguishable
from the view loading.

## Addendum: folding a group heading away

On any grouped page — every view and every saved search, whichever grouping is chosen — the heading is a `button.ghead`
carrying `aria-expanded`, with the disclosure triangle drawn from that attribute in CSS (down open, rotated right
folded). Clicking it, or Enter/Space with it focused, folds that section alone: the heading stays, its rows are not
drawn, and they leave `pageRows().list` too, so the keyboard never walks into rows nobody can see.
Its `mousedown` is swallowed the way a row's chevron is, so folding a section cannot take a selection away.

The folded set is `collapsedGroups` in renderer/state.js, read at load from the preferences that follow you between
machines (renderer/prefs.js), and written by `toggleGroup` the moment a caret is clicked. An entry is `page key`, `grouping` and
`section key` joined by newlines: the page key is a view id or a saved search's document id (so a renamed search keeps its folded
sections), and the section key is the heading's own words only where they are fixed — Status, Updated and
Responsibility come from tables, while an assignee section is keyed by the member uri and a type section by the type
uri, because those headings arrive late and can be renamed. Only folded sections are stored, so unfolding one drops
its entry and the list stays as short as what you left folded; a deleted saved search may leave one behind, which
costs a string and nothing else.

### The Tracking section opens short

**Tracking** — work you made and handed to somebody else, under Group by Responsibility — is the one section that does
not open on all of its rows. It opens on what has moved: the rows updated in the last three days, with the rest behind
a `button.gmore` reading "Show 19 more tasks" (singular for one). Pressing it shows the whole section for as long as
it stays open; folding the section forgets, so it opens short again, which is the point of opening short at all. A row
with no update time to read counts as part of the tail. `trimTracking` in renderer/views.js does it, inside `groupsOf`,
so the hidden rows leave `pageRows().list` exactly as a folded section's do and the keyboard order agrees with the
screen; the set of sections shown whole is session state (`trackingShown`), like holding rows in place. Every other
section is work with your name on it, where a row that has not moved in weeks is precisely the one to see, so none of
them is trimmed.

### The Pinned section

**Pinned** sits under My inbox and above Mine in Group by Responsibility and holds every task you pinned to a date,
whoever has it and whatever its state. Like Agent it decides the section on its own (Agent still wins), so a pinned
task is never listed a second time elsewhere. The dates come from one `api.pinDates()` read (main `pinnedDates` over
`sdk/pins.js datePins`, the pin-map), fetched beside `api.pinIds()` in `loadPinned` and kept as `datePinsById`. A row
in this section starts its grey line with the days it is pinned to ("Pinned to Today · 2026-09-22", `pinnedOn`), which
`rowSig` carries so a reused row picks the day up or drops it.
The section runs by the latest day each task is pinned to, latest on top (`latestPinFirst` in `groupsOf`); the sort is
stable, so tasks pinned to the same day keep the order the page's Sort gave them.
Like Tracking it opens short (`trimTracking`, `OPENS_ON`): on the tasks pinned to a day in the coming week or already
past, with a task pinned only further ahead than seven days behind the same "Show N more tasks" link.

### Pin to date

⌘K **Pin to date …** (`id: pinToDate`) opens a one-field page (`palMode = 'pinDate'`) that reads the typed words as a
day with `parseDay` (renderer/document.js) and shows the day it read before Enter: today/tomorrow, weekdays (the next
one after today), "in 3 days"/2w/1 month, next week (the coming Monday), ISO dates, day-first numbers and day + month
names, a date without a year being the next time it comes round. A fixed parser rather than a model, so the answer
is instant, needs no key and never changes between two reads of the same words. Enter is the same `api.pin(id,
'today', date)` the today and tomorrow rows write.

## Addendum: pasting a Tana node link

- **Pasting a Tana node link**: clipboard text that is exactly one Tana node link — a bare `tana:<kind>:<ulid>` or a https home.tana.inc url ending in the url-encoded uri, the link Copy link produces — is inserted into a block as a mention segment instead of as text, through the same `linkTo` path "@" uses (selection replaced, surrounding text kept, caret after the chip, one `api.setText`). `tanaNodeUri` (renderer/segments.js) is the only parser for it and rejects anything else, including prose that merely contains a link, so every other paste stays the browser's. The title is read before anything is written, so an unreadable link leaves the row untouched and shows the error. A draft row is created first, by the same `materialise` the first typed character uses, and the reference is written into the row it became: the title is read before the create, so an unresolvable link creates nothing, a failed create leaves the row a draft with nothing written, and a draft already being created is left to the ordinary paste. One create, one write, and no url text in between. Titles (plain strings in Tana), native `embed` reference rows (`setText` refuses them), images and dividers paste as text.
- **Adding images** (#28): three ways in, one queue (renderer/upload.js). **Paste**: an image file on the clipboard of a writable block row lands as an image row after that row — a list row when the row is one — several in clipboard order; pasted into the empty draft row it lands after the last real row, where the draft stands, and an empty child row takes nothing. **"/" Image** (also found by picture, photo, upload) opens the native file dialog for images, several at once; Esc there leaves the "/" row as it was, and picked files empty it and land behind it, as Divider does. **Drop from the Finder**: the drop line `renderer/drag.js` draws for rows shows for a drag carrying files, behind a writable row only (never as a first child: an image cannot be one, and `insertImage` has no such place); anything but an image in the drop is ignored. An image is a file with one of Tana's extensions (heic, heif, jpg, jpeg, png, gif, webp, avif, svg, bmp, ico, tiff, tif) or an `image/*` type; files over 50 MB are refused in the renderer before their bytes are read. Each file shows at once as a grey placeholder row with its name and "Uploading…" (not in Tana, drawn like a draft, not editable, put back by `reload` until it is done); files go one at a time, each placeholder replaced by its image row as it lands, and when the last lands the caret moves to it — so Space previews it, ⌘⇧⌫ removes it, ⌘⇧↑/↓ moves it — unless the caret has gone off to another row meanwhile. Esc on a placeholder cancels that file (`api.cancelUpload(uploadId)` aborts the request in main; nothing is written). A refusal (too large, "You're signed out — sign in and try again", the server's message) shows in the error line, writes nothing and does not stop the files behind it. `api.insertImage(docId, afterId, { bytes, filename, mimeType }, uploadId)` does the upload, the `tana:image:` document owned by the page and the block in main (main/images.js), outside the renderer's write queue so an upload does not hold up typing. An image row with no alt of its own shows the title Tana's AI gives the image document, as alt text and tooltip.

## Addendum: Home

- **Reopening where you left off.** `rememberPlace` (renderer/edit.js) stores `{ docId, nodeId, from, title, icon }`
  under `place`; the title and glyph are the page's own, taken off the row it was drawn from, so they cost nothing.
  A view with nothing zoomed (the Library, Types) is stored as `{}`: it is a place too, so a reload or a restart
  stays on it. A launch with nothing stored at all is a first launch and opens on the **Work View**: main opens the
  window split (no saved window), the left half seeds the Timeline and the right half My Tasks, which it asks main
  for once connected (`api.myTasks`: your saved search called My Tasks, or one made from the My Tasks preset with the
  Library's arrangement). Cmd+K **Work View** (`workView`, renderer/timeline.js) gets there from anywhere: it stores
  both halves' places, main opens the right half or sends the other half to its place (`window:workView`), and the
  page asking goes to its own.
  Boot seeds `extra` and `zoom` from them **before the first render**, so a launch opens on the page you were on
  with its header and the loading animation under it — it used to draw the active view first and replace it once the connection
  came up, which read as the Library flashing past. `restorePlace` then reads the real node over that stub (the stub
  is a title, not a document: state, tags and editability come from the read), and a page that is gone takes its stub
  down again and leaves the launch on the view. `ensureLoaded` asks for children only once there is a connection,
  and a page with no answer yet shows the loading animation rather than "No content". The connect edge runs
  `restorePlace().finally(() => loadView())`: the document you are looking at is fetched ahead of the view behind it.

- **Home** is where the app comes back to: the Library (the default and the fallback) or any saved search, chosen with Cmd+K "Set as Home" (`setHome`) on either of those two pages and kept in `localStorage` under `home` as the target's own id — `library` or a `tana:search:` uri — so renaming the search in Tana keeps the choice and only changes what it reads. On the page that already is Home the row stays, disabled, with the hint "Current". The row over every page's title opens with the Home button: the `home` glyph, the same size as ⌘K beside it, labelled "Go to Home: <name>" (Addendum: the header row); it is there on Home itself too, one fixed way back. Back (⌘[) with nothing to go back to lands on Home, a launch with no place to restore opens it, and Cmd+K "Go to Home" (`goHome`, recordable, hinting Home's current name) is the row for it — disabled with the hint "Current" while you are already there, so it stays discoverable. Every route Home goes through the one `goHome` helper. A Home whose saved search is gone from `api.searches()` — deleted or no longer readable — falls back to the Library and the stored preference is repaired (`repairHome` in renderer/nodes.js). Gone means missing from a list that could have named it: the boot call races the sync connect and main answers [] with no client, so `searchesLoaded` is set only by an answer that lands while connected (renderer/app.js) — trusting the boot answer repaired the choice away on every launch. Nothing is written to Tana: the search, its filters and its arrangement are untouched.

## Addendum: the ← → buttons

- Two arrows sit at the top right of the header in `.navbtns`, one flex row anchored to the right edge (absolute
  against `.titlebar`), so they stay put as the task meta and fields rows come and go. The sidebar toggle is
  the last button in that row, so where there is no sidebar it is gone and the others move up to the edge instead of
  leaving its slot empty. They run `navigate(-1)` and `navigate(1)` — the same history ⌘[ and ⌘] walk, with the same
  rule that Back with an empty stack lands on Home — so there is one history and nothing that navigates needs to know
  about them. `renderNav()` runs after `noteNavigation()` on every render and is the only thing that draws their
  state: disabled when the move does nothing, with the current recorded combo in the tooltip (`hotkeyFor`), so a key
  re-recorded with ⇧⌘K shows through. Every header button with a Cmd+K row does the same through `keyTitle`
  (renderer/state.js): its label plus its combo, read again when the pointer arrives.

## Addendum: bullets and plain text

- **A marker belongs to a list row, not to every row.** Tana draws a bullet for a `bulletList`/`orderedList` item
  and nothing for text, headings, quotes and code, and the outline now does the same: the dot is drawn for
  `.t-bullet` and the counter for `.t-numbered`, and every other block row hides it — on hover too, so a heading
  reads as a heading whatever the mouse is over. Hidden, not removed: the gutter keeps its width in every row
  state (the row-alignment rule still holds), and a collapsed row keeps its dot, because that dot on its halo is
  what says it has children, which is a state and not a hover. Document rows (a task, a doc, a space in a view)
  are unchanged: their icon or bullet is their identity.
- **The page is carried by its headings, not by its prose.** The greys are sampled from the same document in
  Tana rather than guessed: body text rgb(73,75,79), a heading and the page title rgb(28,32,36), the marker dot
  rgb(127,131,141). The dark theme takes the same step the other way up. What the check pins is the relation — a
  heading is darker than the text under it, and brighter than it in the dark theme — so the greys can be retuned
  without the rule quietly inverting.
- **A row with no marker is not indented for one either.** Its text starts where the document title starts, which
  is what makes a heading read as a heading rather than as a bullet whose dot went missing: `.scroll`'s 16px plus
  an 11px gutter plus the body's 5px is the 32px `.titlebar` reserves, and the check asserts those four numbers
  add up so moving any of them fails loudly. The gutter is narrowed, never `display: none` — that is what used to
  move rows between states — and what is left of it is still the row's zoom target, silent now. A row with
  children keeps the full gutter, since it has a chevron to show. Headings also open a section: 30/24/20px above
  h1/h2/h3 and 6px under, set on the node so a selected heading keeps its tight highlight, and the first row of a
  page takes none because the title above it is already the space.
- **Expanding a row is asking it for sub-items, so it opens onto a bullet.** The draft an expanded empty row shows
  is a list row whatever the parent is, and the write is told which kind to make (`insertAfter(…, block)`, which
  `materialise` passes the kind the draft was drawn as), so the row does not change shape on the first keystroke.
  A document's own page is a different question and still starts as plain text.
- **A new row follows the row it comes from, and a document starts as plain text.** Either side of a row, Enter
  gives a row of that row's own kind: a listItem beside a listItem (so a quote stays in its quote and a numbered
  item stays numbered), and plain text beside anything bare — a heading and a code block each continue as the
  plain text that follows one, in front of them as well as after. A document's own first row has nothing to
  follow, so it is plain text, and because every row after it inherits, a document stays plain text until a "- "
  starts a list in it. There is no setting: this was briefly a Cmd+K switch between an outliner and a text editor
  (`outlinerMode`, `opts.bullet`), and it was removed once the inheritance rule left it deciding one row. The
  list a "- " creates is built inside the same transaction as the row, so Enter and "- " are each one undo step.
- **A click that misses the words still belongs to the row, and lands where it was aimed.** A row is bigger than
  its text — the padding around it, and the blank line a soft break leaves inside it — and a click there used to
  answer with the end of the row, walking the caret past everything written after the point that was clicked.
  `caretAt` (renderer/render.js) pulls the point into the text's own box and reads the position there, asking the
  left edge of the line as a second try, since the browser may answer with something outside this text for a point
  over no words. A row it cannot read a position from still answers with its end, which is what it always did.
- **A picture is not a line of text.** An image draws a marker only where a list row would: `blockType` reports
  the list an atom sits in (a child is a list row whatever it holds) and nothing when it stands on its own, so a
  top-level image is the picture and nothing else, outdented like every other marker-less row. Space on the row or
  a click on it opens a full view (`openImage`, renderer/render.js): one overlay built when it is asked for and
  taken away again, closed by Escape, Space, Enter or a click anywhere, with the focus going back to the row it
  came from. It shows the picture the row already holds, so opening one costs no fetch. An atom is also never
  expandable now — it cannot gain children by being opened, whatever list it sits in.
- **A reference written inside a line shows what it points at.** `resolveReferences` (main/documents.js) already
  batched a `listNodes` for the reference rows and the lone mentions; every inline mention now rides in the same
  batch, deduplicated by uri, and takes its target's `icon` — the row vocabulary, so a task reads as a task, a
  typed document as its type, a member as a profile, with no new mapping to keep in step. The icon is drawn in the
  link's own colour rather than the type hue, and the label moves into `.mlabel` so the underline runs under the
  words and not under the icon. It survives the DOM round trip (`data-icon`), so typing beside a reference does
  not drop it until the next reload, and a target that cannot be read simply stays an ordinary link.
- **A node that has been deleted is drawn as gone and never opened.** Main knows first and says so three ways:
  `outline:removed` for anything it sees deleted live, `reference.deleted`/`mention.deleted` on a reference whose
  target is tombstoned (`resolveReferences`), and `Node has been deleted` from any read (`op` in
  main/documents.js, which now calls `invalidateDeleted` the first time a read finds one, since a node this app
  never subscribed has nothing else to announce it). The tombstones themselves are learned in one place —
  `listFilter` (main/views.js) already dropped deleted rows from every list and search answer, and now remembers
  their ids rather than only hiding them. In the renderer all three land in `deletedIds` (`isGone`, `markGone`,
  `noteGone` in renderer/nodes.js), because what follows is the same in every case: a mention chip takes the trash
  glyph, the strike and the plain text colour (`.mention.gone`); a reference row takes a trash bullet and a struck
  title (`.node.gone`); and `openDoc`, `goTo` and the Back stack refuse it — `openDoc` is where every route into a
  document meets, so one guard covers rows, pins, the rail, links and notifications. `loadTaskMeta` stops
  asking, which is what ends the "Error occurred in handler for 'doc:taskMeta'" once per backoff for the rest of a
  session. A read that answers again clears the tombstone (`patchDoc`), so undoing a delete brings the node back.
  Deleted is not the same as unreadable: a target that simply did not come back in a `listNodes` answer — no
  permission, an index that has not caught up — stays an ordinary link.
  Two details the first cut got wrong. `gone` is decided before the target, not after: a row still holding the
  copy of the target it was resolved with drew that copy, so the node’s own glyph sat on the line beside the trash
  on the chip, as though it were both there and not. And one glyph, not two — on a row whose whole text is the gone
  chip the bullet already carries the trash, so the chip’s is hidden there (`.node.gone > .line .text .mention.gone
  svg`); a chip among other words keeps its own, since no bullet stands for it there.
- **Only a document's own row can be plain text.** Tana keeps a node's children inside its listItem, and a bare
  paragraph there is not a row it reads back: the conversion moves the row out of the list its parent keeps its
  children in, and `holderOf` then reads it as a bullet again from the grandparent list, so the next Backspace
  repeats the damage one level deeper. `atRoot` (sdk/content.js) refuses `paragraph` for anything under a
  listItem whatever asks for it, and the refusal changes nothing — it throws inside the transaction. The renderer
  does not ask: Backspace leaves a child's bullet alone (`nestedRow`) and the style menu greys Text out for a
  child rather than offering a row that errors. Zooming does not change the answer; what counts is the row's real
  parent, not whether it looks top-level on screen.
- **Backspace at the start of a row takes its bullet off** before the old rule removes the row (`unbullet`): an
  empty bullet costs two presses, one for the bullet and one for the row, and ⌘⇧⌫ still removes in one. A row with
  children keeps its bullet — a plain paragraph cannot own an outline in Tana's schema, and the conversion would
  outdent them.
- **A row the renderer shows before the write lands is drawn as what the write will make of it** (`siblingBlock`,
  renderer/nodes.js). The pending split row Enter leaves under the caret and the draft tail both used to fall back
  to the default mode, so Enter at the end of a plain row flashed a bullet for the length of a round trip, and a
  draft tail under plain text sat there wearing a bullet it would never get. Both now ask the row they will
  follow, by the same rule the write uses: a list row and a plain row continue as what they are, a quote stays in
  its quote, a heading, a code block or a document has nothing to continue so the mode decides, and a child is
  always a bullet because a child is a listItem in Tana's schema whatever its parent is.
- **"- " typed into a row with no marker starts a list there** (`rebullet`), so the two modes are reversible from
  the keyboard both ways. The dash is the command rather than text: its pending save is dropped, not written. Like
  the "/" menu it is the whole content of the row, so a line that merely begins with a dash is left alone, and a
  code block is content rather than prose, so "- " there stays "- ".
- **Backspace at the start of a row also takes the empty row above it away** (`removeEmptyAbove`). A plain empty
  row draws nothing at all, so there is no bullet to click and no text to put a caret in: the row below is the
  only way to reach one, and removing the previous block at the start of a line is what every editor does anyway.
  The caret does not move — it stays at the start of the row being typed in, so the text does not jump. A row with
  children, an image, a divider, a reference, a draft, or a row belonging to another document (the rows an opened
  reference borrows) is not "an empty row above" and is left alone.
- **Otherwise its words join the row above** (`joinAbove`, #125), which undoes an Enter mid-text: the row above takes
  them, marks and mentions included, the row goes, and the caret lands where the two meet. It is one change in main
  (`api.join(docId, id, intoId, value)` → `sdk/content.js join`), so one ⌘Z brings the row back. Only words join
  words: a row that holds children stays (joining would have to move them), and so does a row under an image, a
  divider, a table, a reference, a draft or a row of another document.

## Addendum: Set type

Cmd+K on a document or a meeting offers **Set type** (id `setType`, so ⇧⌘K can record a key against it), hinted with
the type it has now or "No type". It opens a page of the types that document may be given, with **No type** at the top
when there is one to remove. Nothing about which types those are lives in the renderer: main answers
(`api.docTypes(id)` → `{ current, options: [{ uri, title, hue, selectable, reason }] }`) and the page draws that answer
— the current type ticked and not offerable again, a type that does not fit greyed with the space it lives in rather
than left out, so the page can answer "why is my type not here?". Choosing one is a single `api.setType(id, uri)`
(`null` for No type) and the row redraws from the live change, like every other mutation. The rules behind
`selectable` are Tana's own and are documented in docs/sdk/05-gotchas.md: a type applies to documents or to meetings,
and a space's type only goes on a document already in that space, while a Library type goes on anything.
**Remove type** (id `removeType`) is the same removal without the page: offered only on a typed document or meeting,
hinted with the type it takes off, one `api.setType(id, null)`.

### Classify type

Beside it, **Classify type** (id `classifyType`) lets the model choose from the same list. Every type document keeps
a `description` and `instructions` (the AI instructions Tana's own AI follows when it writes one of that type) in
its `data`. The graph's `typeDef` carries neither, so main reads each selectable type's own document
(`typeCandidates`, main/documents.js) and sends the types, numbered, with those words, together with the document's
title and text (a meeting's calendar description in place of its empty content) to the model (`api.classifyType(id)` →
`ai.classifyType`, main/ai.js). It first says in a few words what the document is and asks to be done, then gives the
odds of every option, **No type** among them, and they come back most likely first:
`{ current, choices: [{ uri | null, title, hue, p }] }`.

While the model reads, the page shows "Reading the document…" under the breathing sparkle. If the most likely
option is a type at 80% or more (`CLASSIFY_SURE`, renderer/palette.js), it is set at once through `api.setType`,
the palette closes, and a note says "Classified as Decision Record (91%)". If the document already has that type,
the note says "Already …" and nothing is written. Otherwise the page lists every option with its odds, the current
one ticked, and choosing one is the same write Set type makes. No type is never applied on its own: a model sure
that nothing fits still leaves the choice to you.

The model is the fast AI both AI rows share, `gpt-5.6-terra` with low reasoning (`aiModel`/`aiEffort`, defaults in
main/ai.js), chosen on 2026-09-24 against twelve of the workspace's own documents with
`node scripts/platform-cli.js classify <id...>`, which prints the odds and writes nothing. Luna, the earlier default,
gave one or two of the twelve a wrong type at 80% or more in every run, whatever the wording, and which ones moved with the wording ("Read Nadia's document" came out
a Discussion Task at 80–99%). Terra took the same time, since the wait is the round trip rather than the model, and
kept every clear case right: Nadia's at 95% No type in both runs. One borderline task ("Ask Foundry teams for
risks") moved between No type 78% and Discussion Task 85%. A type's own description and AI instructions are what
the model reads, so sharpening them in Tana is how its answers improve.

## Addendum: Set icon (a type's own glyph)

A type can be given a glyph, and every document of that type is then drawn with it: its bullet, its row in the
sidebar, and the chip an inline mention of it draws. That reach costs nothing, because all of them read
one field — the row's `icon` — and main puts the type's icon name there (`main/rows.js`; `resolveReferences` already
hands a mention the target's icon). A type with no glyph keeps the generic `type` one, and a task or a meeting keeps
its own: a checkbox and a calendar say what the row *is*, which no type should overwrite.

Cmd+K on a type offers **Set icon** (id `setIcon`), hinted with whether it has one. The page searches the Nucleo UI
set built into the app — 3503 18px outline glyphs with their search tags, `build/nucleo-ui.json.gz`, half a megabyte
gzipped and about 4 ms to unpack. The set stays in main (`main/icons.js`): the renderer asks `api.searchIcons(q)` and
receives one page of results (60), registers those glyphs by name, and draws them. **No icon** takes the choice off.

Where the choice lives: app-local, in SQLite, as a *name* (`typeIcons`, type uri → Nucleo label), never as markup.
Tana has nowhere to keep an icon — `appearance` holds an image uri and a hue — and an SVG has no business in
somebody else's CRDT. The glyphs a type wears arrive with the roots (`renderer/nodes.js loadRoots`), so a row is
never drawn before the markup its icon name refers to exists.

**Set colour** (Cmd+K on a type, beside Set icon) is the other half, and like the glyph it is this app's own: a hue
(0-360) or **grey** for the type, kept in the settings document under `typeHues` (docs/SETTINGS.md), so it follows you
between machines and leaves the hue Tana keeps on the type (`appearance.hue`) untouched — Tana has no grey, every hue
it stores is a colour, which is why the override exists. With no entry Tana's hue shows through. The picker is the
palette itself — twelve named colours, each row drawn with the glyph the type already wears in the colour it would
become, the current one ticked, **Grey** for no tint at all, and **Tana's colour** to forget the override. Typing a
name narrows the list; typing a number picks that hue exactly. The write is `doc:setTypeHue` → `setTypeHue`
(main/documents.js), which stores the setting and refreshes the rows itself; `typeHue` (main/rows.js) is the one
place the override is read, for tags, inherited hues and the type's own row. Tana's hue is written only by the CLI's
`set-hue`.

## Addendum: Discuss with …

Cmd+K on a document offers **Discuss with …** (id `discussWith`, so ⇧⌘K can record a key against it), hinted with
"Discussion Task" — the type it gives the document. It opens a page whose only row is what is being typed: the answer
is a name, and the field it lands in holds text rather than a member reference, so a team ("Heads of Technology") or
two people at once are as good an answer as one colleague. Enter writes it; with nothing typed the page says so and
there is nothing to run.

One call does both writes, because they are one decision: `api.discussWith(id, who)` → `discussWith`
(main/documents.js) finds the type titled "Discussion Task" among the workspace's types, gives the document that type
unless it has it already, and writes the words into the type's "Discuss with" field. The type and the field are
matched by title, not by id: a workspace that has never seen either has nothing else to match on, and Tana's field
keys are eight generated characters that differ per workspace. When the type is missing it is created in the Library
(no home space, so it fits a document wherever it lives) with that one field, cardinality multiple; when the type is
there but the field is not, the field is added to it rather than a second type appearing beside it. The row and the
page's fields follow main's change event, like a retype. Verified end to end against Tana on a scratch document
(2026-09-20): the index reports `entityType` and `attributes["<type>?attribute=n5e1hgxz"] = { text, listItems }`,
the same shape the nine real instances of that type carry. The type carries a workflow, so typing the document also
puts it in that workflow's first state — which is what Tana's own "Set type" does.

## Addendum: Recently deleted

Cmd+K offers **Recently deleted** (id `recentlyDeleted`, so ⇧⌘K can record a key against it), beside Undo and Redo.
It opens a page of what this app has seen deleted, newest first, each row saying how long ago it went; typing
narrows it by title and Enter restores that document and opens it. Nothing is confirmed and nothing is thrown away:
a restore is the same `doc:restore` the undo stack runs.

It exists because deletion in Tana keeps the document. A soft delete only sets `deletedAt`, so the title, content,
fields and participants are all still there and a restore by id brings it back whole — but the graph stops answering
for it, so no search, list or query can ever name it again, and the undo stack only reaches back through this
session and only in order. Which ids those are is therefore the one thing that has to be remembered locally:
`invalidateDeleted` (main/documents.js), the single point every deletion this app learns about passes through —
your own delete, an undo of a create, a deletion on another device, a read that finds a tombstone — writes the id
and the title into `deleted_nodes` (db.js) before the cached row is dropped, taking the title from the document
while it is still open. A restore takes it off that list again, wherever the restore came from, because the same
change event that clears the tombstone clears the row. The list holds a month and is capped at 25, in SQLite rather
than in the settings document: it is about this machine's history, and an id that is gone is not worth syncing.

What it cannot show is a deletion that happened while the app was not running, or one from before it recorded any:
the app has to have seen it. Tana's own trash, if it grows one, would be the better source.

### The suggestion beside it

While that page is open the document's title is read by a model, and what it makes of it is offered as a second row
under the one you are typing into: "Discuss this with Stan" suggests `Stan`, "Discuss this with the heads of tech"
suggests `Heads of Tech`, and two people become "Stan and Peter". It is never the first row — Enter is always your
own answer — so taking it is one arrow key down, and it is drawn with the sparkle glyph, which is what marks a row
the app worked out rather than one you typed or one Tana knows. While the answer is on its way the row says
"Reading the title…" under the same glyph, breathing (`.ricon.thinking`, behind the reduced-motion gate) so the
page does not look finished; the answer then replaces that row in place. A suggestion equal to what you have typed
is not offered twice, a title naming nobody adds no row at all, and a call that failed shows its message rather
than passing for a title that named nobody.

The call is main's, in `main/ai.js`, the only place this app talks to a model: `api.suggestDiscussWith(title)`
sends the title and nothing else — no content, no ids — to OpenAI, with the extraction rule as instructions so that a
title cannot become one. (Classify type, under Set type above, is the one call that also sends a document's text.)
It is asked once per open, never per keystroke. Cmd+K offers **Sign in with ChatGPT** and
**Sign out of ChatGPT**, and shows the account status. A signed-in ChatGPT account takes priority; the local OpenAI
API key is used when ChatGPT is signed out. Both credentials stay on this machine, never in Tana. ChatGPT sign-in
uses the Codex CLI app-server in its own local auth directory, separate from the user's regular Codex login. It
needs the `codex` command on PATH. Which model answers and how hard it thinks are the settings `aiModel` and
`aiEffort`, defaulting to the fast AI both AI rows share: `gpt-5.6-terra` with low reasoning, which answered a
suggestion in the same time as Luna with none (5.8 s against 5.7 s, median of six) and left the subject of the
task out of who to discuss it with where Luna put him in; they follow you between machines
like the other choices about your own content, and have no UI yet: change them in the settings document.

- **The breadcrumb location is gone** (Addendum: the header row): `api.path` still answers where a document lives, but nothing in the header draws it.

### The names that are people here

Whatever reaches the field — typed or suggested — is read for the workspace's own members before it is written, and
each one found becomes an inline reference to their profile while the rest stays words: "Stan Engbers and Ria" is a
mention of Stan followed by " and Ria", and Tana's index reports it under that field's `references` (verified on a
scratch document, 2026-09-20). The words are kept as the mention's label rather than replaced by the profile's
title, so the line reads the way it was written and the reference is the id beside it.

Three rules keep a match from being a guess (`nameSegments`, main/documents.js). A name matches whole words only,
counted in letters rather than `\\w`, so "Rekké" ends where it ends and "Stan" is not found inside "Standard". The
longest name wins, so "Stan Engbers" is one person rather than a first name and a leftover surname. A first name
shared by two members is not a name at all — with two Stans in the workspace only the full name matches — and
nobody is referenced twice in one answer, so a name repeated stays words the second time. When nobody matches, or
the member list cannot be read, the value is written as the plain string it always was.

## Addendum: dragging a row

A row is picked up by the marker it already has and dropped where a line says it will land. Three things make that
one feature rather than three, and they are the ones to keep.

**A drag names the place; the keyboard names a direction.** ⇧⌘↑/↓, Tab and ⇧Tab each move a row one step, and a
drop can reach anywhere at once, so it needed an operation of its own: `moveTo(document, id, { parentId, afterId,
from })` (sdk/content.js). `afterId` is the row it lands behind, `parentId` the row it lands inside when there is
nothing to land behind, and neither means the first row of the outline. The row travels whole — Loro cannot move a
container, so it is copied and the original deleted, which keeps its children, its checkbox and its block ids, and
the list or quote it leaves behind is pruned when it empties. `from` is the outline it came from, which is how a
row crosses between a page and one of its fields: both are roots of the same Loro document (sdk/fields.js
`fieldView`), so the whole move is one transaction and one undo step. Across two documents it is refused
(`block:moveTo` → `moveBlock`, main/documents.js): a block belongs to the node that holds it, and moving one
between documents is a different operation with a different audience question behind it.

**A list holds listItems whose first block is a paragraph, so the shape is converted at the edge.** A paragraph
dropped into a list becomes an item of it; a list row dropped among prose brings a list with it, joining the one
already beside it rather than splitting one list into two. A heading, a code block or an image standing on its own
cannot be a list row at all: beside one it splits the list and stands between the halves, which is exactly what a
divider dropped into a list does (`insertDivider`), and *inside* one it is refused before anything is written, so a
refused drag leaves the outline as it was. The renderer knows that last rule too (`dragListable`) and simply does
not offer the drop, rather than drawing a line over a write that will fail.

**One gap means several places, and the pointer's x chooses.** Between two rows, the levels that make sense run
from the level of the row below the gap (nothing may sit shallower than the row it lands in front of) up to one
level inside the row above it, offered only where that row can hold children (`canInsertChild`). `dropDepth`
counts levels from the row above, one `.children` indent each, and clamps; `dropPlan` then turns the level into
the parent and the row it lands behind by climbing the ancestors on screen. That is why the gap under a row with
children can only mean "inside it" — its first child is the row below, and the two bounds meet.

The line itself is drawn in the gap the pointer is in, indented to the level it chose and running to the right
edge of the outline, with a dot on the end the row will start at (`#dropline`, fixed, measured from the rows on
screen at every `dragover`). It is not drawn at all where nothing can land: the top level of a view (its rows are
documents, and a block is not one), a read-only row, another document, or anywhere inside the row being dragged —
which is excluded whole, subtree and all, from the rows a gap is measured against.
Nor behind a draft row: the empty row a page or a field keeps to type in is not in the document yet, so the write
could not name it (`must` would refuse an id like `draft:…`). It is left out of the rows a gap is measured
against, which makes a drop aimed at it land behind the last row that is really there — the end of that outline,
which is where it was aimed anyway. Found by dragging into an empty field in the running app.

**What carries the drag.** `nodeEl` sets `draggable` on the bullet of every writable block row, and one delegated
`dragstart` on the document picks it up, so nothing is bound per row. A row with a marker is grabbed by it. A row
without one — text, a heading, a quote, code — keeps its 11px gutter (Addendum: bullets and plain text) and would
have nothing to hold, so a small grip is drawn there while the pointer is on the row: inside the gutter it already
has, so no row moves when it appears, and only on hover, so a page of prose is not a field of dots. A collapsed row
is left alone, since its dot is back and that is the thing to grab. The dragged row dims, the drag carries our own
dataTransfer flavour so a drop on a text field elsewhere pastes nothing, and a drag that is not ours — text out of
a row, a file onto the window — is left to the browser.

After the write both outlines are re-read, the row it landed in is opened (so the node is where it was put rather
than hidden inside a closed row), and a parent left with no children closes. A drop back where the row already was
writes nothing at all.

Not covered: a multi-row selection is not dragged (⇧⌘↑/↓ and Tab still move a selection as one block), and a block
is not *moved* between two documents (a document dropped into one leaves a reference instead, below).

### What a drop writes, and where the line is drawn

- **A marker that can be picked up says so.** `cursor: grab` is on every `.bullet[draggable="true"]`, so it reads
  the same in a field as on a page; the grip a marker-less row shows on hover is the same affordance drawn where
  there is no marker to grab.
- **An empty line is nothing to pick up** (`dragEmpty`): no words, no children, nothing drawn in it, so it is not
  made draggable and shows no grip. An image and a divider have no words either and are very much things you would
  move, so neither counts as empty. A draft row was never draggable: it is not in the document yet.
- **The line starts where that level's words start**: a row's own box plus the 16px its marker occupies (11px of
  gutter and the body's 5px, the same three numbers the row-alignment rule adds up). The top level therefore lines
  up with ordinary text instead of sitting left of it where a bullet's marker hangs, and one level in is the row's
  own children box when it has one, or the indent those children would be given (33px, 23px under a list row).
- **A row keeps its kind where Tana's schema allows one.** Text dropped between two bullets at a document's own
  level stays text and the list splits around it, exactly as a divider does; only where the schema leaves no choice
  is it converted — as somebody's child, and among somebody's children, where a bare paragraph is not a row Tana
  reads back at all (it takes its bullet from the grandparent list, see `atRoot`). A heading, a code block or an
  image of its own splits a list at any level and is refused only as a child, whose first block must be a paragraph.

### Dragging a document, and why there is no modifier

A row in a view or a saved search is a document, and a document cannot move into an outline — it lives in Tana, not
inside another node. So a dragged document lands as a **reference** to itself: one block whose whole content is a
mention, which is Tana's full-reference presentation and what the renderer already draws as the node itself
(`insertMention`, sdk/content.js → `block:insertMention` → `referenceIn`). That is what makes a saved search's
rows draggable onto other nodes: the rows themselves cannot be reordered (their order is the query's, so a drop
*between* two of them is not offered), but each can be filed into another node as a link.

What was picked up decides the write, and nothing else does. An Alt-drag existed briefly and was taken out again,
because the data model leaves it almost nothing to say: a document can only ever be referenced, an ordinary block
can only ever be moved — Tana's references are node-level and there is no block-level uri for a mention to point
at (docs/sdk/02-data-model.md; no `blockUri`, no `tana:text:…#blockId` anchor anywhere in the descriptors) — so
the modifier changed the outcome in one case out of three, on a row that already pointed at a document, where it
duplicated the link. A modifier that is inert in most drags is a worse thing to learn than a rule you can read off
what you grabbed, so the rule is the one sentence above. A reference never lands in the document it points at, and
unlike a move it may cross documents, since linking is exactly what it is for.

**A task dropped on a group changes what it is** (#169). In a view grouped by Responsibility, and on the Timeline's
Today's Tasks, a drop between rows is a group rather than a place: the section under the pointer (its heading is
outlined while a task is over it, `groupAt`), or the Today block. The writes are read off the task as it stands, so
the answer does not depend on the section it left, and a task dragged from the other pane — its own renderer, which
only the dataTransfer's `application/x-orbital-task` crosses — lands the same way. `groupDropWrites` adds what the
section needs and takes away what would keep the task elsewhere, in the order `responsibilityOf` reads them:

| Drop into | Writes | Refused |
|---|---|---|
| Unassigned | Off the agent, every day pin removed, no assignees | a task you did not make |
| Tracking | Off the agent, every day pin removed, watched | unless you made it and it is someone else's |
| Agent | the Assign to Agent prompt; nothing until it is sent | — |
| My inbox, Mine, My completed, My later | Off the agent, every day pin removed, you as the only assignee, the status; a watch on a task you were not assigned is forgotten | a task you did not make |
| Pinned | Off the agent, pinned to today unless pinned to a day already; a completed task reopens | — |
| Assigned by others | — | always: it is about who made it |
| Today's Tasks | Pinned to today unless it is on Today already | anything but a task |

So watched to Pinned pins it and keeps the watch, and watched to Mine takes it over and stops watching. A drop in
its own section writes nothing. A drop inside a task — a reference to the dragged one under it — is offered only
once that task is expanded (`dropDepth`): a closed task shows no rows to land among, so beside it the drop is on
its group, which is what it looked like. The
tasks under Today's Tasks show a box where the marker would be, so their whole read-only line is what is grabbed.
A task you cannot edit is refused before anything is written wherever the drop would change its assignees or
status, so a refused drop leaves no pin behind. While a task is dragged over a pane grouped by Responsibility, its
empty sections are drawn as well (`setTaskDragging`, cleared by the drop, the drag's end, or a second without a
dragover), so the first task can land in one.

## Export to PDF

⌘K → **Export to PDF** is available for the current text document, including read-only documents. Pending edits are queued before export. The native Save dialog defaults to the document title; cancellation writes nothing. Export reads the complete main outline, including collapsed children, without expanding references into other documents or including app controls, sidebar or typed metadata fields. Electron prints a separate sandboxed page as A4 with fixed light typography, lists, headings, inline marks, images and page margins. Image loading and PDF failures surface through the normal command error path. `node scripts/pdf-check.js` checks escaping and structure; an unsandboxed `electron scripts/pdf-check.js --render` generates three synthetic visual samples under `/tmp/orbital-pdf-examples`.

Expanded documents show their type fields above their body children, using the same field renderer and editors as a zoomed page. Field rows keep their document-and-field address and write permissions. Vertical caret movement includes inline fields in reading order; structural edits stay inside the current field or body outline.


### Presence: who else is here (issue #14)

The page on screen has its presence room open (renderer/presence.js
follows the zoom after every render; main/presence.js keeps one counted room per document over sdk/presence.js), with the
viewing heartbeat. Lists show no presence. Each person has a colour of their own (from their user hash). Their caret is drawn where Tana draws it: a thin line in that colour between the characters it is on, with their full name on it,
as Tana labels one, below the caret instead when the row is too near the top of the scroll area to fit it above. The position is read from the entry's Loro cursor (content.cursorOffset), which is anchored to a character and so stays right as
text is typed: Tana only re-sends an entry when that cursor changes, so its block offset stays where the caret entered a node
(0 in a new one), and an edit to the document redraws the carets without any presence message. The block offset (ProseMirror
units, a mention is one; content.charOffset) is the fallback, and your own caret goes out in those units too (blockOffset).
In an empty row, or before its position is known, the caret stands where the row's text begins. This Orbital is never shown; your own other tabs and devices are, under your name, which is also how to try presence alone: open
the same node in Tana.

Where your caret is goes the other way: while it is in a block of this page, your presence entry says so under your name
(`user.name`, no colour, so Tana picks one as it does for anyone): the block id with the caret's anchor and focus offsets, and
the same positions as Loro cursors (content.cursorAt, on the text run the caret is in), which is what Tana draws an exact caret or
selection from. It follows every caret move, at most one message per 150 ms, and is cleared when the caret leaves the outline, the
window loses focus or the page changes. Only a block counts: the title and a draft row are not blocks yet.
The viewing heartbeat goes to the page on screen only while the window is visible and you were active (a key, the mouse, a
scroll) in the last minute, as Tana sends it.

## Addendum: Archiving a type (#36)

A type is archived, never deleted: Tana's own type page offers Archive and nothing else, and the SDK leaves types out
of soft delete (`sdk/access.js` DELETABLE). On a type — the row in the Types list, or the type's page zoomed in —
Cmd+K offers **Archive type** (id `archive`) beside Delete, which reads "Read-only" there. It asks `doc:accessOptions`
for `archivable` (a type you can write), then runs `doc:archive`, the same `documentAction` path a delete takes, so
Cmd+Z unarchives it. The type then leaves the Types list and every picker, because the graph stops listing it.

To bring one back, Cmd+K **Archived types** (id `archivedTypes`, beside Recently deleted) opens a page of the types
the graph returns with `includeArchived`, newest first, each with how long ago it was archived; Enter unarchives it
and opens it. Unlike Recently deleted it needs no local list, because an archived type stays in the graph. Tana
confirms an archive in a dialog; here nothing is asked, since Cmd+Z and this page undo it.
### Notifications (issue #18)
Tana's notifications inbox as a page of its own: **Notifications** in Cmd+K's Views (after Inbox), with the unread count as its hint ("2 unread"), opens `orbital:notifications` — an id no Tana node can have, known to the renderer from boot (renderer/inbox.js puts it in `extra` with `appPage: true`), so `goTo`, Back and Recent reach it without asking main for a node. Its rows are `outline:children` of that id: main/inbox.js reads the user's `tana:user-inbox` document (sdk/inbox.js) and hands back one read-only row per notification, newest first, as Tana's Notifications widget lists them. A row is Tana's own sentence (`phrase`): the actor named from the member list and what Tana emphasises in bold ("**Sam Okafor** added you to **Leadership sync**"), then Tana's second line when it has one (". Review the budget."); the time it came in is the row's grey meta ("3 hours ago"). A notification without an actor reads the way Tana writes it for nobody ("You were added to …"); a type archived or restored is named by the type's current title when the graph still answers for it, and Tana's "archived a type" otherwise.
Unread is Tana's blue dot, in the bullet's place (`.node.unread`). The bullet is the row action: clicking it marks the row read, or unread again. Opening a row — Enter or Space on it, or a click on its words — marks it read and goes to its source, which is what a click does in Tana (`sJt` in the bundle: `markAsRead(id)`, then navigate to `sourceUri`). A source with no page here (a type, a person) opens in Tana through the node link, as Show in Tana does. That link takes the route Tana's own resolver picks for the kind: `/t/` for a type, `/u/` for a person, `/e/` for a meeting, `/s/` for a space and `/l/` for every other document, because `/l/` shows a type as "Unknown content type" and its raw JSON (issue #88). A comment notification opens its document, since there is no thread view to scroll to. Tana opens billing for an `ai-usage-warning` where it can; Orbital has no billing page, so it follows the source like any other row, which is what Tana does without billing access. Cmd+K on the rows you are on (the selection, or the row the caret was in) offers **Mark as read** and **Mark as unread**, each only when some of them are the other way, with fixed ids (`markRead`, `markUnread`) so either can be given a key; **Mark all as read** (`markAllRead`) sits in Actions with the count as its hint and greys out at zero, as Tana's button does.
Everything is drawn before main answers; each write answers with the new count, and main subscribes the inbox once per connection and sends `inbox:changed` with the unread count on every change to it — a new notification, a read on another device — which re-reads the page when it is open. `onChange` leaves the inbox document alone: it is no row's document. The page has no pills, no filter, no draft row, no presence room and no pins, and Cmd+K offers nothing about the page as a document (`appPage`). Orbital has no navigation sidebar, so Cmd+K's Views row is where the entry and its count live.
### Proposals (issue #19)
What Tana's AI proposed from a chat and is waiting on someone to accept, as a page of its own: **Proposals** in Cmd+K's Views (after Notifications), with how many are waiting as its hint ("20 pending"), opens `orbital:proposals`, an app page like Notifications (renderer/proposals.js puts it in `extra` with `appPage: true`). Its rows are `outline:children` of that id: main/proposals.js reads the pending proposals from the chat graph nodes (sdk/proposals.js `pending`) and hands back each proposed document as the row a view draws for it (`graphRow`), newest first, so it keeps its task box, type, assignee and chevron. Rows are read-only here (Space opens the document, where it can be edited); the grey line under one says where it was proposed ("Proposed in Nedap & Slack", the chat's title or, for a meeting chat, the meeting's), and its meta says when. Two buttons end the row, the Nucleo UI `circle-check` and `circle-xmark` (the page itself is `file-sparkle`): approve and reject. Cmd+K offers the same for the rows you are on, **Approve proposal** and **Reject proposal** (`approveProposal`, `rejectProposal`).
Orbital approves a proposed new document (sdk/proposals.js `approve`); where Tana would do more than that the approve button is disabled with the reason as its title and the grey line ends "approve in Tana": a change or deletion (Tana merges it), a space, instructions or action proposal, a typed document whose type lives in another space, and a proposal whose document is gone ("its document is gone": reject clears it). Refusals only the chat or the document can show (an unknown intent, embedded media) come back from approve itself and are shown as the error. Reject works on every proposal. An answered row leaves the page at once; a refusal reads the page back. Nothing pushes proposals, so the page is read once the connection comes up (for the count) and again on every arrival, and main keeps an answered proposal off it until the graph's index stops listing it as pending.
The rows are filed in two parts (issues #104, #107) by where the chat lives (its owner, or a subagent chat's parent's owner), each drawn only when it has rows. Yours come first, with no heading: a meeting that has you among its participants (the graph's `hasParticipantUris`, what the Meetings view calls your own calendar) and a chat owned by you or by nobody. Below them, under the collapsible heading a grouped view uses, **From others** holds a meeting you were not in, which you see through its space, a chat a space owns, and a chat another person owns, such as a colleague's agent routine. From others starts folded; opening it is remembered as `orbital:proposals\nopen\nothers` in `collapsedGroups`, under the page rather than the view behind it.
When the sidebar is showing a meeting's write-up summary, its **Proposals** section (issue #106) lists the proposed documents from chats owned by that meeting. Finished meetings redirect to this summary, so proposals appear here rather than on the event page. The section uses the same rows as the Proposals page, so each row opens the proposal; it is omitted when the meeting has none. Like the page, it reads proposals on arrival and receives no live proposal updates while open.
## Addendum: tables (issue #32)
Tana's schema has `table > tableRow > (tableHeader | tableCell) > block+`. Its own writer (`shared-rlpSpfd9.js`
`Mge`/`jge`/`Fge`) puts a `blockId` on the table, each row, each cell and the paragraph inside a cell, and `colspan`/`rowspan` on
a cell; `colwidth` is a ProseMirror attribute (`null` until a column is resized, then one width per spanned column).
- **The row.** A table arrives as one read-only outline node, `{ type: 'table', editable: false, text, table }`, where `text`
  is the cells joined as before and `table` is `content.readTable`'s answer: `{ id, rows: [[{ id, header, colspan, rowspan,
  colwidth, paragraph, segments, text, blocks }]], rowCount, columnCount }`, rows and cells in stored order the way Tana's
  own `readTable` counts them. The row is atomic like an image or a divider (`isAtomic`): it focuses, moves (⌘⇧↑/↓, drag),
  selects and deletes in a writable document (`canEditStructure`), and nothing types into the row itself.
  `setText` and `setBlockType` still refuse the table, so it is never overwritten as text.
- **Drawn as a table** (renderer/table.js `tableEl`): header cells are `th`, data cells `td`, spans carry over as
  `colSpan`/`rowSpan`, and a resized column keeps its width (set through `style.setProperty`, which CSP allows). A cell's
  text is its first paragraph, drawn with `renderSegs` so marks and mentions show; anything else in the cell (a second
  paragraph, a list) shows below it in grey, read-only.
- **Cell edits.** A cell with an id is `contenteditable` only where the document is writable; in a read-only document the
  same table has no editable cell. Typing is debounced like a row (400 ms, on focus loss, and before undo/redo through
  `flushAll`) and written with `api.setCell(docId, cellId, value)` → `block:setCell` → `content.setCellText`, one undo step of
  that document. `setCellText` does what Tana's `updateCell` does: it rewrites the cell's first paragraph (one is made at
  the front, with an id, when the cell has none) and leaves the cell's other blocks, an image for instance, where they are.
  Same value as `setText` (a string, or segments with marks and mentions). A pending edit stays on screen through a
  rebuild, and the caret goes back to the same cell after one.
- **Keys** (renderer/table.js `cellKey`; the row's own keydown handler leaves cells alone): Tab/Shift+Tab walk the editable
  cells in reading order, and past the last or before the first go back to the table row. ↑/↓ on a cell's first/last
  line go to the cell above/below in the column you see, merged cells counted (`tableGrid`; a shorter row gives its last cell), or out of the table to the outline row
  beyond. ←/→ at a cell's edge go to the previous/next cell, and past the ends out of the table. Escape returns to the
  table row, where Backspace removes it and ↑/↓ step on as for an image. Enter on the table row puts the caret in its
  first cell; Enter inside a cell adds nothing, because a cell's text is one paragraph. Every ⌘ key goes on to the document
  handler.
- **Rows and columns** (⌘K with the caret in a cell, group "Table"; each row has an id, so ⇧⌘K can give it a key): Add row
  above/below, Move row up/down, Delete row, Add column left/right, Move column left/right, Delete column, written by
  `content.tableOp` as Tana's `manipulateTable` writes them, one undo step each, with the caret put in the cell the
  operation names. The limits are Tana's table menu's: no row above the header row, the header row is neither moved nor
  deleted, the last body row and the last column stay; what cannot run where the caret is shows disabled. A new cell
  is a `tableCell` (a `tableHeader` in a header row) with an empty paragraph, both with ids; a moved row or column keeps
  its ids and text.
- **Images in cells** are drawn after the cell's text (a click opens one, as on an image row). Pasting an image into a
  cell uploads it and appends it to that cell, as Tana's `addImageToCell` does. Removing one from a cell is not offered.
- **Presence:** a caret in a cell is sent as the cell's paragraph (the block Tana names for it), and one received on a
  cell's paragraph is drawn in that cell. The SDK's position helpers find a paragraph inside a cell for this, while
  `locate` still stops at tables, so no outline operation reaches into one.

## Addendum: fields that hold choices or links (issue #33)

- **Kinds reach the renderer.** `api.related(docId).fields` carries each field's `type`, `cardinality`, `options` and `to`
  (each target with its type's `name`), read from the type document on every call (main/related.js `fieldDefs`). Text and
  date fields stay the outline of addendum 16.
- **Options, link and member fields are a closed list** (renderer/fields.js): one focusable `.fchoice` line of chips with no
  editor, and a caret stop for ↑/↓ like any row. Enter, Space, a click or a typed letter opens the picker; Backspace takes
  the last value off (an options field without `cardinality: multiple`, or a link field with `single`, is cleared); ⌘K
  offers **Select value …** or **Link to …** for the focused field. A stored label the type no longer declares is struck
  through ("No longer offered") and a link to a type the field does not list carries a ⚠.
- **Options picker**: the declared labels with the current ones ticked, typing filters, **Clear value** empties. A single
  field writes and closes; a multiple one toggles and stays open. A label no longer offered is listed to be removed and is
  never written back, since Tana would refuse the whole value.
- **Link picker**: the search palette, narrowed by `api.search(q, { types })` to the field's target types (all documents
  when it has none) or `{ members: true }` for a member field, and listing what fits before anything is typed. A single
  link is replaced, anything else gets one more line.
- Every value is written by `api.setField(docId, key, lines)` → `setFieldText(…, { field, typeOf })`, so a value Tana would
  refuse is refused before it is written.
- **Defining fields.** A type has no page of its own, so its fields are listed where its row expands (the Types view): one
  row per field, its kind as a grey chip. ⌘K there offers **Set field type …**, **Number of values …**, **Edit choices …**
  (options only) and **Link to types …** (link only), and on a type or any of its fields **Add field …** (a name, then a
  kind). Edit choices: typing and Enter adds a label, Enter on a label renames it, ⌘⌫ removes and ⇧⌘↑/↓ move the highlighted
  one; at most 60 characters and no two the same, said on the row before anything is written. Writes go through
  `api.defineField(typeUri, key, change)` and `api.addField(typeUri, def)` onto the type document, one undo step each.

## Addendum: notices are a toast (#123)

A notice that reports something done ("Link copied", "Added 3 items to Today", "Classified as Project (91%)") is a
toast at the foot of the window (`showNote`, renderer/toolbar.js; `#toast`, `role="status"`). It fades after
2.5 s, a newer notice restarts that clock, and it sits above the palette. The red line under the title is for errors
only (`showError`); they stay until the next action clears them. A notice must never write into `#error`: that line
holds `#errorText` and the relogin button, and replacing them made the next `showError` throw, which stopped the
write queue behind `run()`.

### Timeline (issues #135, #150, #154)
A timeline of what happened around you, newest first, in day sections (Today, Yesterday, then the date): **Timeline** in Cmd+K's Views opens `orbital:timeline`, an app page like Notifications. main/timeline.js rebuilds it from Tana on every arrival (about a second): the change summaries of every node you watch (the watch rule plus your own choices, less what you silenced; sdk/history.js, twelve at a time), and the tasks assigned to you in the last two weeks with the chat each was created in (`EDGE_TYPE_CREATED_IN`). Its first row is pinned to the top, stamped **Now**, and labeled **Today's Tasks** with the tasks-2 icon; it lists incomplete tasks pinned to today or an earlier date and completed tasks pinned to today. Future pins are excluded. With none, an indented line reads "All done - Add more". The indented **Add more** link (shown beside "All done" when empty) opens a search of open tasks assigned to you and pins a selection to today. A horizontal rule separates this block from the event timeline, with 16px between the end of the vertical rail and the rule above it, 8px below. It is drawn as a timeline: the time in a column on the left (**Now** for today's tasks, 24-hour for history), a rail, a marker on it per entry (20px circles: a filled green one with a white check for finished work, a grey pen for an edit, Nucleo's grey outline circles for the other moves; only finished work is ever a filled marker, the rest are grey lines with no fill), then what happened. What changed and what finished come first. Every entry reads as who, in plain text, what they did, in bold, and the node: "Kevin Favier **completed** ~~Plan the offsite~~" (a green check), "**accepted**" (Inbox to In Progress, a grey plus), "**moved to Later**" / "**moved back to Inbox**" (a grey arrow), and "Peter Leppers **edited** Risk register" (a grey pen), whose change is quoted under it: Tana's one line for it in bold ("Added a document link") and its longer words ("A link to the Risk Register document on Slite was appended to the task."); an edit's banner, once Tana has written its summary, says the same two things as subtitle and body. The latest status move comes from the node's state (`state.type`, `enteredAt`, `changedBy`), older ones from summaries that name the state they went to. New Inbox tasks matter least: a run of them from one source on one day is one quiet line, marked by who put them there in light grey (a robot for an agent, Tana's prism for Tana's AI, a dotted ring for a person) ("An AI agent added 6 tasks to your Inbox", "Tana's AI added a task…", or a colleague by name), with the tasks listed under it, each opening as itself. Meetings you are in show at their start time once they have started, the meeting's name beside a grey calendar, opening the meeting (and so its write-up); all-day ones and meetings still to come stay out, and they are never marked new. They stay current while the app runs: a read leaves a live query open over your meetings to the end of today (main/timeline.js `watchMeetings`), and a meeting added or gone, renamed or moved re-reads the page where it is on screen; nothing else about a meeting counts, and it never becomes an entry of its own. Changes only you made, tasks you made by hand and anything older than two weeks stay out. A blue dot beside the marker marks what came after your last visit, and opening an entry (click, Enter, Space) goes to its node. It opens on the last seven days; "Show the week before …" at its end reaches one week further back per click (main/timeline.js `setWeeks`), and coming back to the page starts at one week again. No filters: it is one timeline. Like Notifications and Proposals it is a place the app remembers, so Cmd+R on it reloads onto it.

### Windows (issue #137)
File › New Window, Cmd+N or **New window** in Cmd+K (a built-in row, so its key can be re-recorded; the menu shows ⌘N without taking it) opens another outliner window, 24px down and right of the one in front, so one can keep your tasks and another the Timeline. Each window has its own view and page; a new one starts where you last were (the stored view and place are shared, the last one navigated wins at the next launch). What main pushes is shared state and reaches every window (main/state.js `send`): live row changes, status, the Inbox count, settings. Each window's view is refreshed by the 30 s loop and its rows stay subscribed while any window shows them (main/views.js `openViews`); each window keeps its own sidebar live watch (main/related.js `watchRelated(id, window)`). A command meant for one window goes to the one used last: a notification click opens its node there. Closing the last window quits, as before.

**Split view** (issue #159): **Toggle split panes** in Cmd+K (⌥⌘N) puts a second page beside the one you are in, in the same window, and pressed again goes back to the page you are in alone. The two halves share the window's width evenly, with a hairline between them in the sidebar's border colour for the page's theme (main.js `SPLIT_LINE`, reported by renderer/theme.js), and move, resize and close as one window. Each half is a whole outliner — its own view, page, history, filter and sidebar — which is what a window already was: an outliner window is a `BaseWindow` holding one `WebContentsView` per page (main.js `addPane`/`removePane`), and main keys a page's view and sidebar watch by its webContents id, so a page beside another is to main what a page in another window is, and `send` reaches every page. The new page opens on the view and place of the one that asked (the row stores them first, since the stored place is whichever page navigated last) and takes the keyboard. **Go to the other half** (Cmd+K, ⌘\) moves the keyboard to the other page; ⌥⌘←/→ were left alone because the outline reads a plain arrow at a row's edge whatever the modifiers. **Swap panes** (Cmd+K) trades the halves' sides; each takes the other's side marker (`window:side`), so a restart or a Reload keeps them where they now are. Cmd+W closes the page you are in when there are two, and the window when there is one; the right half also has an X at the far right of its header, after every other button, that closes it (main.js `window:closePane`). Like the rest of the header row, it shows only while the mouse is over that half. A notification click opens its node in the page used last. A restart brings the split back with the window, each half on its own view and place: the right half learns its side from main when it loads (`api.side`, asked again on a Reload) and stores them under `view:2` and `place:2` (renderer/state.js `SIDE`), and when it is left alone main tells it to take over the plain keys. A launch with nothing stored for a half opens the Work View (Addendum: Home). The line between the halves is dragged from a 5px grip on the right half's left edge (renderer/app.js `splitGrip`, main.js `window:splitDrag`): main reads the cursor from the screen, since the page moves under the pointer as it is dragged, keeps each half at least 320px, and saves the left half's share as `splitAt` with the window, so a restart draws the same line; a double click evens them out. Swap panes keeps each half's width.

## Addendum: the header row (issue #200)

The row over the page title is two buttons and nothing else: **Home**, then **⌘K**. Both are `.navbtn`s like the
buttons at the top right — 24px, an 18px glyph at .4 opacity — so the header has one kind of button. Home is the
`home` glyph with no word (`homeCrumb`, labelled "Go to Home: <name>"), and ⌘K opens the command palette
(`togglePalette('cmd')`) for whoever has not met the key. `renderCrumbs` puts the two in that order on every render
and the row is never hidden. There are no breadcrumbs: the page title says where you are, Back walks the history, and
this replaces every earlier addendum that describes a crumb, a Home anchor link or a location path in the header.
The first glyph lines up with the title's left edge, and both sit level with the buttons at the top right (measured).
The row is part of the title bar's drag area; the buttons opt out of it, and so does the command palette's backdrop,
which covers the drag areas while it is open — otherwise Electron takes a click there as a window drag, and the
backdrop never hears the click that should close it.
