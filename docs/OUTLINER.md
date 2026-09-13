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
