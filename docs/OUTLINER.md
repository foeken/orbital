# Outliner contract

The app renders a Tana-Outliner-style outline. The app is generic ("Tana" companion); the first view is **Tasks**. Every visible line is a node: top-level nodes are Tana documents (task documents in the Tasks view), and a document's children are its content blocks. Text is always editable in place (no edit mode). Editing follows the Outliner keyboard model.

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

Look: old Tana Outliner (docs/outliner-list.png, docs/outliner-filter.png): white page, system font, a page title, a filter row, then the outline. Each node line: a small bullet (•) at the left in a fixed-width gutter; on hover a chevron appears left of the bullet to collapse/expand when the node has children; children are indented ~24px with a thin vertical guide line; document nodes show a rounded checkbox before the text; heading nodes render bold/larger; collapsed nodes show a filled/ringed bullet. The text of every node is a contenteditable span; typing edits in place (debounce 400 ms then setText/setTitle; also flush on blur, Enter, Tab and navigation).

Keyboard (exactly the Outliner model):
- Enter: split at caret; if the node is expanded with children, the new node becomes the first child, else the next sibling; caret moves to it. Enter on a document node inserts a first content child (documents cannot be created yet).
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
Status line at the bottom: connected/last-refresh/error and a "Log in to Tana" button when not authenticated (no Sync button; Tasks > Sync with Tana in the menu calls refresh).
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
- Meetings section: events where the user is a participant with a start time from the start of today (local) to 7 days ahead, ordered by start time (`nodeTypes: ['event'], eventStartTimeMin/Max, sortOptions SORT_FIELD_EVENT_START_TIME asc, limit 200`); meta = weekday + start–end time in local time ("Mon 9:00–9:30"; all-day events show "Mon, all day"). Their content (meeting notes) is the same Loro content layout as tasks; expanding a meeting shows it via api.children(id). Editing a meeting title is allowed (setTitle); no checkbox.
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
