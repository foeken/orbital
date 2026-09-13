# Outliner contract

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
remove(document, nodeId)                      // removes the node and its children (unwrap empty lists/listItems left behind)
indent(document, nodeId)                      // becomes the last child of its previous sibling (wrapping top-level paragraphs into bulletList/listItem as needed); no-op if no previous sibling
outdent(document, nodeId)                     // becomes the next sibling of its parent; no-op at top level
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
api.remove(docId, nodeId)          // Promise<void>
api.indent(docId, nodeId)          // Promise<void>
api.outdent(docId, nodeId)         // Promise<void>
api.refresh()                      // Promise<void> re-query roots
api.login()                        // Promise<void>
api.status()                       // Promise<{authenticated, connected, syncing, lastSync, error}>
api.onChanged(cb)                  // cb(docId | null): null = roots changed; docId = that document's content/title/state changed (remote or local)
api.onStatus(cb)
```
IPC channels: outline:roots, outline:children, doc:setTitle, doc:setDone, block:setText, block:insertAfter, block:insertChild, block:remove, block:indent, block:outdent, sync:refresh, sync:login, sync:status; events outline:changed (payload docId|null), sync:status.

## Outliner UI/UX (renderer)

Look: old Tana Outliner (docs/outliner-list.png, docs/outliner-filter.png): white page, system font, a page title, a filter row, then the outline. Each node line: a small bullet (•) at the left in a fixed-width gutter; on hover a chevron appears left of the bullet to collapse/expand when the node has children; children are indented ~24px with a thin vertical guide line; document nodes show a rounded checkbox before the text; heading nodes render bold/larger; collapsed nodes show a filled/ringed bullet. Editable node text uses a contenteditable span; typing edits in place (debounce 400 ms then setText/setTitle; also flush on blur, Enter, Tab and navigation). Read-only nodes render their text without an editor.

Keyboard (exactly the Outliner model):
- Enter: split at caret; if the node is expanded with children, the new node becomes the first child, else the next sibling; caret moves to it. Enter on an editable document node inserts a first content child; read-only nodes ignore edit keys. View-level draft document creation is defined in Addendum 8.
- Shift+Enter: newline inside the node (soft break).
- Tab / Shift+Tab: indent / outdent the node (block nodes only; document nodes ignore Tab).
- Backspace at the start of an empty block node: remove it and move the caret to the end of the previous visible node. Backspace at start of a non-empty node: no-op.
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
- Root nodes carry `icon: 'task'` when the document has a task state. The renderer shows the original Outliner task icon (small grey checklist glyph: two short horizontal lines with a check mark, as in docs/outliner-list.png) in the bullet slot of such nodes, before the checkbox; it is still the zoom/collapse target.
- No footer/status bar. When not authenticated the outline area shows a centered "Log in to Tana" button instead of the outline. Errors show as one slim red line under the page title only while an error is present. "Connected"/"refreshed" text is gone.
- The filter row is hidden by default. Cmd+F shows it (focused, same look as before); Esc in the filter clears and hides it; while it has text it stays visible.


## Addendum 2 (sections, type tags, meetings, generic sync)

- The page is one outline with **sections**: a section is a non-editable top-level heading line ("Tasks", "Meetings") rendered like Tana's Today sections (small grey icon in the bullet slot, medium-weight grey-black text, no checkbox), whose children are documents. `api.roots()` now returns `[{ id: 'tasks', title: 'Tasks', icon: 'task', nodes: Node[] }, { id: 'meetings', title: 'Meetings', icon: 'meeting', nodes: Node[] }]`. Sections are always expanded, cannot be edited, moved, indented, deleted or zoomed into; the breadcrumb root is still "Tana"-level: zooming into a document shows "‹section title› › ‹doc title›". Filter (Cmd+F) matches document titles across sections; a section with no visible documents is hidden while filtering.
- Node additions (documents): `icon: 'task' | 'meeting' | undefined`; `tags: Array<{ label: string, color: 'grey' | 'gold' }>`; `meta?: string` (short grey text after the title, e.g. "Mon 9:00–9:30" for meetings); `kind: 'document'`; `done` only for tasks. Every document with a task state gets the tag { label: 'task', color: 'grey' }; every event gets { label: 'meeting', color: 'gold' }; a document with an entityType gets { label: <type title>, color: 'grey' } (type titles resolved with graph.listNodes({ nodeIds: [...] }) and cached per session). Tags render as chips exactly like Tana's "# todo": inline after the title (and after meta), rounded 4px, 12px text, padding 1px 6px, a "#" then a space then the label; grey = background #f1f1f1 / text #6b6b6b; gold = background #fbf3d9 / text #8a6a17. The meeting bullet icon is the calendar glyph from icons.js coloured #c99b1b (the icon set's own gold); the task bullet stays the grey task glyph; typed documents without a task state use the plain bullet.
- Meetings section: events where the user is a participant with a start time from the start of today (local) to 7 days ahead, ordered by start time (`nodeTypes: ['event'], eventStartTimeMin/Max, sortOptions SORT_FIELD_EVENT_START_TIME asc, limit 200`); meta = weekday + start–end time in local time ("Mon 9:00–9:30"; all-day events show "Mon, all day"). Their content (meeting notes) is the same Loro content layout as tasks; expanding a meeting shows it via api.children(id). Event titles are currently read-only in the companion because native calendar write capability is not exposed; no checkbox.
- Local cache (db.js): one generic table `nodes(id TEXT PRIMARY KEY, section TEXT, title TEXT, done INTEGER, icon TEXT, meta TEXT, tags TEXT /* JSON */, sortKey TEXT, updatedAt TEXT)`; `replaceSection(section, rows)` replaces one section's rows; `list()` returns rows grouped by section in sortKey order (tasks: updatedAt desc; meetings: start time asc). Old tables are dropped/migrated on open.
- Menu: the "Tasks" menu becomes "Tana" with "Sync" (Cmd+R) which refreshes every section (IPC sync:refresh unchanged). Refresh runs on start, every 60 s, and 2 s after a state change. Every listed document (tasks and meetings) is subscribed for live updates; documents no longer listed are unsubscribed.
- `api.onChanged(null)` still means "roots changed"; `api.node(docId)` returns the same Node shape (with tags/icon/meta) for documents reached through references, including events.


## Addendum 3 (command palette, top-level views)

- Tasks and Meetings are **views**, not sections on one page: the outline shows one view at a time (page title = view name, its documents as top-level nodes, no section heading line). `api.roots()` keeps returning both sections; the renderer picks the active one. Default view: Tasks; the last used view is remembered in localStorage. Zoom breadcrumbs start at the view name.
- **Cmd+K command palette** (renderer only), styled like the attached ChatGPT palette: a centered modal card (max-width ~620px, 12px radius, subtle shadow, backdrop dimmed slightly), a borderless search input at the top with placeholder "Search or run a command", a thin divider, then grouped rows with small grey group headings: "Views" (Tasks, Meetings; each with its grey icon from icons.js: task glyph / calendar), "Actions" (Sync, right-aligned shortcut chip "⌘R"; Log in to Tana when unauthenticated), and, when the query is non-empty, "Documents": up to 8 documents from all loaded sections whose title matches (row shows the document's icon and title, right side shows its view name in grey). Rows: 15px text, 8px vertical padding, 8px radius, the active row has a light grey background; Up/Down move, Enter runs, Esc closes, typing filters every group (case-insensitive substring; empty query shows Views and Actions). Selecting a view switches the view; Sync calls api.refresh(); a document zooms into it (switching view first if needed). Cmd+K toggles the palette; the outline keeps its state behind it.
- Sync moves out of the outline UI entirely (it is in the palette and in the native Tana menu). Cmd+F filter stays as is, scoped to the active view.


## Addendum 4 (Cmd+S search palette)

- `api.search(query)` -> `Promise<Node[]>`: live full-text search over every top-level item in Tana (tasks, meetings, typed and plain documents; graph search, relevance order, up to 20). Nodes come in the usual shape (id, title, kind 'document', icon, tags, meta, done).
- **Cmd+S** opens a search palette with the same look as the Cmd+K palette but a single result list: placeholder "Search Tana", results fetched via api.search debounced 150 ms after typing (ignore stale responses), each row showing the item's icon (task glyph / gold calendar / plain dot), title, its tag chips, and meta in grey on the right; "No results" when empty and the query is non-empty; Up/Down/Enter/Esc as in Cmd+K. Enter zooms into the item (it is not necessarily in the current view: use api.node semantics, i.e. the renderer's existing goTo path with the returned Node so the breadcrumb reads "Search › <title>"). Cmd+S toggles it; opening one palette closes the other.


## Addendum 5 (undo/redo, delete node)

- `api.undo()` / `api.redo()` -> Promise<docId | null>: global undo across documents (main keeps the order; each document has a Loro UndoManager, local changes only, one step per mutation call). Renderer: Cmd+Z / Cmd+Shift+Z (and Cmd+Y) first flush any pending debounced text edit, then call undo/redo, then reload that document's children (or roots when the change touched a document's title/state) and re-render, placing the caret in the affected node when it still exists. Do not let the browser's native contenteditable undo run (preventDefault), so undo never diverges from what was sent to Tana.
- **Cmd+Shift+Backspace** removes the current block node entirely (with its children) regardless of caret position or content, via api.remove; caret moves to the previous visible node (or the next when there is none). On a document node it is ignored.


## Addendum 6 (hotkeys, @-linking, create, search filters, polish)

- **Search filters**: `api.search(query)` understands `#task`, `#meeting` and `#<type name>` tokens anywhere in the query (e.g. "lex #task"): tokens are removed from the text query and become filters (task = nodes with a task state, meeting = events, other = the type whose title matches case-insensitively; unknown type = no results). Results keep the usual Node shape; for events the meta shows the date ("Fri 9" style, i.e. weekday + day of month, plus time when not all-day) so past and future meetings are distinguishable. In the Cmd+S palette the query is shown as typed; results render as today (icon, title, chips, meta right-aligned in grey).
- **Meetings view** now spans the past 7 days through the next 7 days (main.js), oldest first; the renderer scrolls the view so today's first meeting is at the top when the view opens (a data-today marker on the first node whose start is today or later).
- **Create**: `api.createDocument(title)` -> Promise<Node>: creates a new plain Tana document (kind 'document', no state) with that title, live-synced like the others, and returns its Node.
- **@ linking**: with a non-empty text selection inside a block node, pressing "@" opens the search palette prefilled with the selected text (do not insert the "@"). The first row is always `Create "<selected text>"` with a ⌘↩ hint; below it the search results. Enter on a result (or ⌘↩ for Create, which calls api.createDocument(selectedText)) replaces the selection with a mention segment { label: <result/new title>, uri: <id> } via the existing segments path (api.setText with segments), then re-renders with the caret after the mention. Esc cancels and leaves the text as it was. "@" without a selection just types "@".
- **Hotkeys**: in the Cmd+K palette, Cmd+Shift+K on the highlighted row opens a recorder modal like the attached Tana screenshot: "Recording keyboard shortcut for:" + the row's title, a large box showing the currently pressed modifiers/keys as symbols (⇧ ⌘ ⌥ ⌃ + key) with a red recording dot, buttons Reset / Cancel / Save. Save stores { itemId -> combo } in localStorage ("hotkeys"); the palette shows the combo as a kbd chip on that row; while the outline has focus (not inside a palette or the filter input) the combo triggers the row's action (switch view, sync, log in, or open that document). Reset clears the row's hotkey. Combos must include ⌘ or ⌃ to be accepted (so typing is never hijacked).
- **Sync icon**: the Sync row in Cmd+K uses window.ICONS.sync (grey) instead of no icon.
- **Chevron**: the hover expand/collapse circle becomes 14px (chevron glyph ~6px) and is vertically and horizontally centred in the gutter space left of the bullet; keep the hover-only behaviour.
- **Breadcrumb**: never repeats the current node's title: when zoomed into a document the crumb shows only the ancestors (e.g. "Search" or "Tasks" or "Tasks › Parent doc"), the page title already shows the current node.
- **Recently viewed**: the search palette (Cmd+S, and the @ palette) with an empty query shows a group headed "RECENTLY VIEWED" (small uppercase grey heading, like the attached Tana screenshot) listing the last 20 documents the user zoomed into or opened via a palette, most recent first, rendered as normal result rows (icon, title, chips, meta). Keep the list in localStorage ("recent": [{ id, title, icon, tags, meta }]); record on every document zoom/open; dedupe by id.


## Addendum 7 (pins, custom icons, draft child)

- **Pins** (docs/PINNING.md is the source of truth): `api.pins()` -> Node[] = the user's sidebar pins in order (each resolved to the usual Node shape via the document's data map); `api.pinState(docId)` -> { sidebar: boolean, dates: ['YYYY-MM-DD'] } (personal date pins for that doc); `api.pin(docId, target)` / `api.unpin(docId, target)` with target 'sidebar' | 'today' (today = local date YYYY-MM-DD). Renderer: Cmd+K gets a "Pinned" group (after Views) listing api.pins() rows, Enter opens the document; and, when the outline is zoomed into a document (or a document row is focused), context actions in the Actions group: "Pin to sidebar" / "Unpin from sidebar" and "Pin to today" / "Unpin from today" depending on api.pinState. Pins refresh after each action; onChanged(null) also refreshes the Pinned group.
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

- Cmd+K pin actions use icons: window.ICONS.pin for "Pin to sidebar"/"Unpin from sidebar" and window.ICONS.pinDate for "Pin to today"/"Unpin from today"; pinned rows in the Pinned group show the pin icon on the right in grey.
- Chevron: the hover circle sits further left, with at least 6px of clear space between the circle and the bullet/icon (the circle centred in the gutter left of the icon slot).
- **Loading skeleton**: while a view has no rows yet (first boot, before roots/library resolve, or while not yet connected), the outline shows 6 skeleton lines (bullet dot + grey bar of varying width, 14px high, light-grey #eee with a slow left-to-right shimmer, respects prefers-reduced-motion) that fade out when the real rows arrive; never shown once rows exist.

## Addendum 12 (typed tags in colour, images)

- **Type colours**: a type tag carries the type's colour: tag { label: <type title>, hue: <0-360> } when the type node has appearance.hue (grey otherwise). Renderer chip: background hsl(hue 80% 92%), text hsl(hue 45% 30%), same shape as other chips. Applies everywhere tags render (outline rows, palettes, Library).
- **Images**: content image blocks appear in the outline as Node { kind: 'block', type: 'image', image: { uri, alt, width, height } } (uri = tana:image:… or cid reference as stored). `api.image(uri)` -> Promise<string> data URL, fetched by main with the session token from Tana's asset endpoint and cached in memory (and on disk under userData/images) so the renderer can render <img> without credentials. Renderer: an image node renders the image (max-width 100%, max-height 360px, rounded 6px) under a bullet, alt as title attribute; it is not editable; Backspace/Cmd+Shift+Backspace removes it like any block; Up/Down skip through it.
- api.members() marks the signed-in user with `me: true` so the Assigned menu can read "You (<name>)".
- Keys added by the Library renderer: search box Down → pills, Up from the first row → last pill, Down on a pill opens its menu.
- Zoomed task: when the zoomed document is a task, the page title shows the task checkbox before the editable title (same rounded box, green with a check when done), toggling via api.setDone; keyboard: Cmd+Enter with the caret in the title toggles it. Done tasks show the title struck through in grey like task rows.
- Member icon is circle-user (window.ICONS.member). @-linking must also work in document titles (task rows in a view and the zoomed page title): a selection inside a document title + "@" opens the palette and replaces the selection with a mention; document titles are plain strings in Tana, so the title becomes the label text (mention text) while the link is kept only where segments exist (blocks); in titles, insert the linked item's title text.

## Renderer acceptance updates (2026-09-13)

- Library has no fixed search field; Cmd+F and Cmd+S remain the search entry points.
- MCP chats is a label-only toggle: grey when excluded, blue when included, with matching aria-pressed.
- Node appearance.hue colors its icon and kind tag; custom-type tags retain their type hue. Zero is a valid hue.
- Dropdowns stop above the window edge and scroll internally. Keyboard navigation keeps the active option visible.
- Outline selections have square corners. Members is a top-level view with circle-user; chat nodes use the chat icon.
- Cmd+K shows sidebar section groups. Unsectioned pins form one Pinned group, preserving their relative order.
- Any type uses pop.svg; Set Image uses images-3.svg. Sync remains a palette action without a default shortcut.
- Login is shown only after a completed session check confirms signed-out; an unresolved or failed check is not signed-out.

These are acceptance requirements; TASKS.md records verification status.

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

- Three collapsible sections: Pinned (EDGE_TYPE_HAS_PIN from the node), Outcomes (documents it owns that carry
  a task state) and Notes (documents it owns without one). Collapsed sections persist in localStorage.railClosed;
  an empty section is omitted and an empty rail is hidden.
- Opening a meeting's notes document shows the meeting's relations: related resolves an event owner as the hub.
  The open document, untitled drafts and anything already listed under Pinned never repeat.
- Keyboard: Cmd+Right enters the rail, Up/Down move, Enter opens, Space toggles a task, Escape or Cmd+Left
  returns the caret to the document.
