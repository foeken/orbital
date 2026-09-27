# Outliner contract

What the outliner does, by area. This file is the UI contract between the renderer (`renderer/`, `index.html`,
`styles.css`) and the main process: every rule here is true of the code, and a change that moves one updates it in
the same PR. It describes behaviour, not history; the history is in git and, before 2026-09-23, in
docs/TASKS-HISTORY.md. Where a topic has its own doc, this file keeps the UI rules and links there:
[VIEWS.md](VIEWS.md) (views, filters, saved searches, type pages, tables of rows), [PINNING.md](PINNING.md) (how pins are
stored), [MEETINGS.md](MEETINGS.md) (meeting structure, the write-up, editing a meeting), [SETTINGS.md](SETTINGS.md)
(what follows you), [CHATS.md](CHATS.md) (chat rows), and docs/sdk/ for Tana's data model. To add a feature, see
[EXTENDING.md](EXTENDING.md).

## 1. Principles

- **Keyboard first.** Every feature is fully operable from the keyboard before any mouse affordance is added. With
  nothing focused, Down (or Tab from the page) focuses the first visible row and Up the last. Palettes, pages and
  overlays are keyboard-complete (arrows, Enter, Escape) and give focus back to the row that had it. New UI documents
  its keys here.
- **Tana Outliner's look.** A page title, a filter row when asked for, then the outline: a marker in a fixed-width
  gutter, children indented under a thin guide line, a chevron on hover for a row with children. There is no footer
  or status bar.
- **Every visible line is a node.** Top-level lines of a view are Tana documents; a document's children are its
  content blocks. Editable text is edited in place (no edit mode), where the node's capability allows it. A row with
  `editable === false` (a member profile, a chat message, a meeting title, anything read-only) never gets an editor,
  and main refuses the same writes.
- **Errors and notices.** In the outliner, a failed action is a red toast at the foot of the window (`showError`,
  renderer/nodes.js), up for 6 s; `run()` sends every error it catches there. A notice that reports something done
  ("Link copied", "Added 3 items to Today") is the same toast, not red (`showNote`; `#toast`, `role="status"`): it
  fades after 2.5 s, restarts on a newer notice and sits above the palette. The line under the title (`#error`) is the
  session's alone: it shows when Tana needs a new login, with the relogin button (renderer/app.js `showStatus`). The
  Create task card (task.html) keeps a failed create on the card, so the press can be repeated.
- **Signed out.** The login button shows only after a completed session check says signed-out; an unresolved or
  failed check is not signed-out. Signed out, the outline area is a centred "Log in to Tana" button, and a split window
  shows its left page alone until login (issue #244).

## 2. Content model and outline operations

`document.content` is a LoroMap `{ nodeName: 'doc', attributes, children }` in loro-prosemirror layout. Each block is
a LoroMap `{ nodeName, attributes, children }`; inline content of a paragraph or heading is a LoroList of LoroText runs
and inline maps such as `{ nodeName: 'mention', attributes: { label, tanaUri } }`. Block names: paragraph, heading
(`attributes.level`), bulletList > listItem > (paragraph, optional nested list), orderedList, blockquote, codeBlock,
horizontalRule (a divider), image, embed (a native reference), table (§12), and the atoms video, audio and
unsupportedBlock. A checkbox is `checked` on a listItem's attributes, never on the paragraph. Blocks carry
`attributes.blockId` (8 lowercase alphanumerics); every block we create gets one, and `assignBlockIds` gives one,
once, to blocks that arrive without.

Outline mapping (`readOutline`, sdk/content.js): a top-level paragraph or heading is a node; a list is not a node,
its listItems are, with the listItem's first paragraph as their text and its remaining blocks as children; a
blockquote is transparent (its blocks are the nodes); a code block, an image, a divider, a table and an embed are
nodes of their own, and a divider, a table and an unknown block are never editable as text. A node's id is the
blockId of its text-carrying block. The tree stays normalised: every listItem starts with a paragraph, and an empty
list is removed. Only a document's own top level can hold a bare paragraph: under a listItem a paragraph is not a
row Tana reads back, so `atRoot` refuses to make one there, whatever asks.

The operations (sdk/content.js, each inside one `document.transact`, so each is one undo step): `setText` (a string
or segments; text runs updated in place where possible, a mention whose uri is unchanged reused), `insertAfter`,
`insertBefore`, `insertChild`, `split` (truncate and put the rest in a new sibling or first child), `join` (a row's
words into the row above), `remove`/`removeMany`, `indent`/`indentMany`, `outdent`/`outdentMany`,
`move`/`moveMany` (one step among siblings), `moveTo` (a drag: behind `afterId`, else at the top of `parentId`,
else at the top of the outline; `from` is the outline it comes from), `insertMention`, `setBlockType`,
`insertDivider`, `insertImage`, `insertTable`, `toggleCheckbox`, and for tables `readTable`, `setCellText` and
`tableOp`. No general ProseMirror transform library.

## 3. Nodes and the api

The renderer sees nodes:

```js
Node = { id, text, segments?, kind: 'document' | 'block', editable?, hasChildren, children?,
  // blocks:    block? (one of BLOCK_TYPES — 'paragraph', 'heading1'..'heading3', 'bullet', 'numbered', 'code', 'quote' —
  //            or 'divider'), heading?, done? (a checkbox item), type? ('image' | 'table' | 'reference'),
  //            image?, table?, reference?
  // documents: icon, hue?, tags [{ label, color } | { label, hue }], meta?, subtext?, done? (tasks), stateType?,
  //            start?/end? (events only), updatedAt?, createdAt?, createdBy?, fields?, draft?, appPage? }
```

`segments` is `Array<{ text, marks? } | { mention: { label, uri } }>`; `text` is its plain rendering. A document row
comes from main's `toNode` (main/rows.js). `start`/`end` are the event window itself, added only for events; anything
ordering meetings by time reads them, never `meta`, which is a label ("Fri 08:20") and says nothing about which Friday.
A row restored from the SQLite cache carries no window.

`window.api` is defined in preload.js, which is the list of calls and the shape of each answer (one comment per
method). The renderer calls it as `tana` (renderer/state.js), the copy demo mode guards (§17). Every IPC channel is
`<area>:<verb>`, answered by the owning `main/` module's `ipc` table (or by main.js for what is not yet moved, and
Electron's own), and main.js registers them all. The live events are `onChanged`, `onRemoved` and `onStatus` (§15), plus
one per page or feature (`onInbox`, `onRelatedChanged`, `onTimelinePart`, `onSettings`, …).

## 4. The page

- **Header row** (issue #200): over the page title, **Home**, **⌘K** and **?**, in that order (`renderCrumbs`), all
  `.navbtn`s like the buttons at the top right — 24px, an 18px glyph at .4 opacity. Home is the `home` glyph
  (`homeCrumb`, labelled "Go to Home: <name>"), ⌘K opens the command palette (`togglePalette('cmd')`), ? opens the Help
  tour (§16). The row is never hidden and there are no breadcrumbs: the title says where you are and Back walks the
  history. The first glyph lines
  up with the title's left edge, and both sit level with the buttons at the top right. The row is part of the title
  bar's drag area; the buttons opt out of it, and so does the palette's backdrop while it is open (otherwise Electron
  takes a click there as a window drag and the backdrop never hears the click that closes it).
- **Buttons at the top right** (`.navbtns`, one flex row anchored to the right edge of `.titlebar`, so they stay put as
  the rows under the title come and go): Back and Forward, the sensitive toggle, the pills toggle, the Outliner/Table
  switch, Clean up, Refresh, the sidebar toggle and, on the right half of a split, the X that closes it. A button that
  does not apply is gone rather than empty, and the others move up to the edge. Back and Forward run `navigate(-1)` and
  `navigate(1)`, the history ⌘[ and ⌘] walk; `renderNav()` runs after `noteNavigation()` on every render, disables
  them when the move does nothing and puts the current combo in the tooltip. Every header button with a Cmd+K row
  names its key the same way through `keyTitle` (renderer/state.js), read again when the pointer arrives, so a key
  re-recorded with ⇧⌘K shows through. The header row shows only while the pointer is over that page.
- **Title.** The view's name, or the zoomed node's title. Zoomed into an editable document the title is editable in
  place (the usual debounce and flush; Enter blurs and focuses the first child; Escape restores). Titles are plain
  strings in Tana, so "@" in a title inserts the linked item's title as text. User profiles, meetings and unsupported
  kinds are read-only. With the caret in the title, Cmd+K takes that document as the current node. Up from the first
  child focuses the title, Down from the title the first child (or the draft child). A zoomed task shows its checkbox
  before the title (⌘↩ in the title toggles it), struck through and grey when done. A zoomed event shows the full date
  form ("Fri 11 Sep 9:00-10:00").
- **Pills and the filter row.** On a page with pills (a view, a saved search, a type page) they sit under the title,
  folded behind the pills toggle per page ([VIEWS.md](VIEWS.md)); Cmd+K lists every pill either way. ⌘F shows the
  filter row, focused: it filters the rows on the page by title substring, with "N items filtered out" under it;
  Escape clears and hides it, and while it has text it stays visible. A page with no rows and no filter says
  "Nothing here yet". A pill's menu stops above the window's edge and scrolls inside, and the keyboard keeps its
  active option in view; a toggle carries `aria-pressed`.
- **Loading.** On a launch or a Reload only (`booted`), while the first page has no rows yet, the page builds itself
  after a 300 ms wait (renderer/loading.js): the header and title, then rows of small outlined glyphs and rounded text
  bars growing in one by one, a highlight sweeping through each, fading toward the bottom; slow on the Timeline, 2.2
  times faster elsewhere. When the rows land it fades and they rise in top to bottom. The Timeline lands in parts
  (`timeline:part`), each drawn at once, and the loader keeps building below the last real row (`.tail`) until the
  whole page is in. A page opened later, or a reconnect, waits blank for its rows; the loader never shows once rows
  exist.
- **Rows arriving.** A row that arrives in a settled view glows once; a row that leaves flashes as it goes. A first
  paint is not an arrival (an empty `before` is a first paint, and so is a row added to a view that was empty), the
  zoomed branch clears `animView` so returning to a view is a wholesale replacement, and a change of more than
  `BULK` (25) rows is not animated.

## 5. Rows

- **Document rows.** A document draws its icon in the gutter: a task its checkbox, a meeting the calendar glyph in
  gold, a space, a chat, a member, a saved search or a type its kind's glyph, a plain document the doc glyph, a typed
  document its type's glyph (§11, Set icon) tinted with the type's hue. After the title come its tag chips — `#
  task`, `# meeting` (gold), `# doc`, `# space`, `# member`, or the type's name in the type's colour (background
  `hsl(hue 80% 92%)`, text `hsl(hue 45% 30%)`; zero is a valid hue) — and its facts. Node `appearance.hue` colours
  its icon and kind tag; a type's own colour override (§11, Set colour) wins where it is set.
- **A task's box is its state** (#243). A task in the Inbox (`proposed`) draws a dashed box; In Progress a grey box;
  completed a green tick, with the title struck through and grey. Clicking a dashed box accepts the task first (In
  Progress, `acceptsFirst`); the next click completes it. A status change reaches every copy of the task at once: a
  render deferred for the caret still updates every checkbox, the title's and the sidebar's (`refreshRowChrome`), and
  a change patches the task's reference rows and sidebar rows (`patchCopies`). Main keeps a task it holds live at its
  live state (`liveState`, main/rows.js), since the search index can trail a write by seconds.
- **Rows stay put while you work on them.** A row you change keeps its place and group until you leave the view or
  change its Sort or Group (`holdRow`/`releaseHeld`, renderer/views.js), and a live update under Sort or Group by
  Updated holds the row too. While held rows would now be drawn differently, a **Clean up** button (brush) follows the
  pills; it, or Cmd+K Clean up (`cleanup`, always listed, grey with "Nothing to clean up" while nothing is held), lets
  go and redraws (`cleanupNow`).
- **Facts and subtext.** Who a node is for, who can see it (the lock), whether it notifies (the bell), whether it is
  pinned (the tack, §9) are grey facts after the title; the Display pill chooses which facts a row shows. When the title
  fills the line they join the grey subtext line under it behind a " · " (`fitRowMeta`): one pass after every render
  measures every row before moving any, a `ResizeObserver` on the outline re-measures on width changes only, and the
  measure is the room the line leaves, so a row cannot flip back and forth. `patchMeta` takes them out before
  rewriting the subtext and asks again.
- **Block rows: a marker belongs to a list row.** The dot is drawn for `.t-bullet` and the counter for
  `.t-numbered`; text, headings, quotes and code have none, on hover too. A collapsed row keeps its dot, on its halo,
  because that says it has children. A row with no marker is not indented for one: its text starts where the title
  starts (`.scroll`'s 16px + an 11px gutter + the body's 5px = the 32px `.titlebar` reserves; renderer-check asserts
  the sum). The gutter is narrowed, never `display: none`, and stays the row's zoom target; a row with children keeps
  the full gutter for its chevron. Headings are darker than body text (brighter in the dark theme) and open a section:
  30/24/20px above h1/h2/h3 and 6px under, set on the node; the first row of a page takes none.
- **Chevron.** On hover a 14px circle with a ~6px chevron, centred in the gutter left of the marker with at least 6px
  clear of it, collapses and expands a row with children.
- **Focus.** A focused read-only row shows a focus ring; an editable row shows the caret and no ring.
- **Caret on an empty row.** An empty editable row shows the caret at once (a zero-width placeholder gives it a box
  and is stripped when the text is read). A click anywhere on a row lands the caret where it was aimed (`caretAt` pulls
  the point into the text's own box); a row that cannot answer a position takes the end.
- **Links.** http(s) URLs in a text run render as links and open in the default browser (`api.openExternal`, http and
  https only); the stored text is untouched and the row stays editable.
- **Mentions.** A mention renders as a link chip that opens its target; it carries its target's icon (`resolveReferences`,
  main/documents.js, batches every mention's target into one `listNodes`), drawn in the link's colour, with the label
  in `.mlabel` so the underline runs under the words. The icon survives the DOM round trip (`data-icon`). A target
  that cannot be read stays an ordinary link.
- **A row that is only a chip** (`chipOnly`, renderer/render.js) is Tana's full-reference presentation. Chromium keeps
  no caret before a non-editable inline that starts a field or after one that ends it, so `renderSegs` puts a
  zero-width `CARET_ANCHOR` on each side that needs one, and every offset helper counts it as nothing; `readSegs`
  strips it. Typing either side makes it text plus a mention (Tana's inline presentation, the same data shape). The
  row carries `.chiponly`, and Backspace or Delete removes it as they remove an image. A read-only reference row, and
  a lone chip whose target could not be read, is outlined when focused.
- **A full-line reference is the node it points at** (`isFullReference`, renderer/nodes.js; `.fullref`). Main resolves
  it like a native embed (`reference: { uri, label, node }`), and the row is built from the target: its bullet and
  hue, tags, subtext and checkbox (`toggleReference`), and its label, so a rename shows through (nothing is written
  back). The title reads as ordinary text; the blue chip is for a reference among text. The block keeps its own
  identity and editable text, and the moment anything else is typed on the line it is an ordinary row again — decided
  on the keystroke from the edit in flight (`liveTarget(node, pending.get(item.key))`), except mid-composition. Such a
  row cannot have children of its own: expanding it opens the target's outline (`childHost`, loaded on demand,
  editing edits that document, drawn under a dashed guide), and it opens only when asked. It offers no draft tail. A
  click selects it and a second click places the caret; the chip does not navigate — the bullet and Space do. Enter on
  the selected row starts editing at the end. The focus ring is drawn from `> .line:focus-within`, so a caret in the
  rows it opened is not a caret on the reference. A block that already holds an outline stays a line with a link.
  Inside a field a lone reference stays a line with a chip: a field is a list of names.
- **Deleted nodes are drawn as gone and never opened.** Main learns it three ways — `outline:removed` for a live
  deletion, `reference.deleted`/`mention.deleted` for a tombstoned target, and "Node has been deleted" from a read
  (`op` calls `invalidateDeleted`); `listFilter` remembers the tombstones it drops. In the renderer all three land in
  `deletedIds` (`isGone`, `markGone`, `noteGone`): a chip takes the trash glyph and a strike (`.mention.gone`), a
  reference row a trash bullet and a struck title (`.node.gone`, and the chip's own glyph hidden there), and
  `openDoc`, `goTo` and the Back stack refuse it. `gone` is decided before the target is drawn. A read that answers
  again clears it (`patchDoc`), so undoing a delete brings it back. Unreadable is not deleted: a target missing from a
  `listNodes` answer stays an ordinary link.
- **Images.** An image block is `{ type: 'image', image: { uri, alt, width, height } }`. `api.image(uri)` answers a data
  URL, which main fetches with the session token and caches on disk under userData/images; the renderer keeps its own
  cache of 200. An image row with no alt shows the title Tana's AI gives the image document, as alt and tooltip. An
  image draws a marker only where a list row would (`blockType` reports the list an atom sits in) and is never
  expandable. Space or a click opens a full view (`openImage`): one overlay, closed by Escape, Space, Enter or a click,
  focus back to the row. Backspace and ⇧⌘⌫ remove it; Up and Down step over it.
- **Spaces.** A `tana:space:` document's children are the documents it owns (`spaceChildren`), drawn as document rows,
  newest first; expanding one loads its own children. There is no draft inside a space, and Enter on a document
  child there does nothing.

## 6. Editing

Typing edits in place: text is saved 400 ms after the last keystroke (`setText`/`setTitle`) and flushed on blur,
Enter, Tab, navigation and before undo. A render is deferred while the caret is in a row (or a selection is frozen),
so the DOM under the caret is not rebuilt; a live change to the row being edited keeps the local text until the
debounce flushes it. Read-only rows ignore every edit key.

### Keys in a row

| Key | Does |
|---|---|
| Enter | Split at the caret (`api.split`, one undo step). The new row is the first child when the row is expanded with children, else the next sibling. At the very start of a row with text, an empty row goes in front instead (`api.insertBefore`) and the caret moves to it. On an editable document row, a first content child. Undoing an Enter puts the caret back where Enter ran. |
| ⇧Enter | A soft line break inside the row. |
| Tab / ⇧Tab | Indent under the previous sibling / outdent to after the parent (block rows; document rows ignore them). On a plain line Tab makes it a bullet, and indents it under the row above when that is a list row (a plain line is never made a parent); at the start of a plain line it starts a list there, as "- " does. ⇧Tab takes the marker off a top-level bullet. |
| Backspace at the start | First takes the row's bullet off (`unbullet`); a row with children keeps it, and so does a child (`nestedRow`), because a paragraph cannot own an outline or sit under a listItem. Then, if the row above is an empty plain row, that row goes and the caret stays (`removeEmptyAbove`). Otherwise the row's words join the row above, marks and mentions included, the caret where they meet (`joinAbove`, `api.join`, one undo step, #125). An empty row is removed and the caret goes to the end of the row above. None of this reaches past a row with children, an image, a divider, a table, a reference, a draft or a row of another document. |
| ↑ / ↓ | The previous / next row, keeping the horizontal offset where possible. The caret walks title → fields → outline (`caretRows()`); anything that changes what a row belongs to works in `rowsBeside(el)`, the list that row lives in. |
| ← / → at an edge | The previous / next row. |
| ⌘↑ / ⌘↓ | Collapse / expand (built-in keys, §8). |
| ⇧⌘↑ / ⇧⌘↓ | Move the row, or the selection, one step among its siblings. |
| ⇧⌘⌫ | Remove the current block with its children, wherever the caret is; the caret goes to the row before (or after). Document rows ignore it. |
| ⌘↩ | Toggle done on a task, or a checkbox; a plain block becomes an unchecked checkbox in Tana's native structure. |
| Space on a read-only row | Zoom into it; on a reference row, open what it points at. With exactly one row selected and nothing focused, the same. Editable rows keep Space for typing. |
| Escape | Blur. |

A new row follows the row it comes from (`siblingBlock`, renderer/nodes.js): a listItem beside a listItem (a quote
stays a quote, a numbered item numbered), plain text beside anything bare; a heading and a code block continue as
plain text, in front of them as well as after; a child is always a listItem. A document's own first row is plain
text, so a document stays plain text until "- " starts a list. The row the renderer shows before the write lands (the
pending split, the draft tail) is drawn as what the write will make of it. In a task, a plain child stays a
paragraph; only a new sibling after a checkbox item inherits an unchecked checkbox.

**"- "** typed as the whole content of a row with no marker starts a list there (`rebullet`); its pending save is
dropped. A code block keeps "- " as text. The list is built inside the same transaction as the row, so Enter and "- "
are each one undo step.

Mouse: a click on the bullet zooms into the row, on the chevron toggles it, on the checkbox toggles done.

### Toolbar, "/" and marks

Selecting text in a row shows a floating toolbar of marks and block styles (renderer/toolbar.js); the style menu
greys Text out for a child rather than offering a row that errors. "/" at the start of an empty row opens the "/"
menu (`slashRows`): the block types, Divider, Table and Image (also found by picture, photo, upload), then Create Doc,
Task and the rest of what Create new … offers, workspace types under their own heading.

### @ linking

With text selected in a block, "@" opens the search palette with the selection as the query (the "@" is not typed).
The first row is always `Create "<selected text>"` (⌘↩); below it the results. Enter on a result, or ⌘↩ to create a
document with that title, replaces the selection with a mention (`api.setText` with segments) and puts the caret
after it; Escape leaves the text as it was. "@" at a caret opens the same palette empty (recently viewed first) and
inserts the chosen mention at the caret. For @ linking the palette is a dropdown (`anchorPalette`): no scrim, a
440px card at most 360px tall, hanging under the selection or caret, flipped above when there is more room there. An
Enter pressed while results are still loading is kept and applied when they land.

### Pasting a Tana link

Clipboard text that is exactly one Tana node link — a bare `tana:<kind>:<ulid>` or a home.tana.inc url ending in the
url-encoded uri, as Copy link produces — is inserted into a block as a mention through the same `linkTo` path "@"
uses. `tanaNodeUri` (renderer/segments.js) is its only parser and rejects prose that merely contains a link, so every
other paste stays the browser's. The title is read before anything is written, so an unreadable link leaves the row
untouched and shows the error. Pasted into a draft row, the row is created first by the same `materialise` the first
typed character uses, then the reference written into it; a failed create writes nothing. Titles, native embed rows,
images and dividers paste as text.

### Adding images (#28)

Three ways in, one queue (renderer/upload.js): an image file **pasted** into a writable block row lands after that row
(a list row when the row is one; several in clipboard order; into the empty draft row, after the last real row);
**"/" Image** (also found by picture, photo, upload) opens the native file dialog, several at once, and the files land
behind the "/" row, which Escape leaves as it was; **a drop from the Finder** shows the drop line (§13) for a drag
carrying files, behind a writable row only, never as a first child. An image is a file with one of Tana's extensions
(heic, heif, jpg, jpeg, png, gif, webp, avif, svg, bmp, ico, tiff, tif) or an `image/*` type; files over 50 MB are
refused before their bytes are read, and anything else in a drop is ignored. Each file shows at once as a grey
placeholder with its name and "Uploading…"; files go one at a time, each placeholder replaced by its image row as it
lands, and when the last lands the caret moves to it unless it has gone elsewhere meanwhile. Escape on a placeholder
cancels that file (`api.cancelUpload`). A refusal shows as the red toast (`showError`) and does not stop the files
behind it.
`api.insertImage(docId, afterId, { bytes, filename, mimeType }, uploadId)` uploads, creates the `tana:image:` document
owned by the page and the block (main/images.js), outside the renderer's write queue so typing is not held up.

### Drafts

- **The draft tail.** An expanded row with no children, and a zoomed page, show one empty draft row at the end, drawn
  as what it will become (a list row under a row; plain text at a document's top level). It exists in Tana only once
  the first character is typed (`materialise`: `api.insertChild` or `api.insertAfter`, told which kind to make). An
  empty draft is dropped on collapse or navigation; Enter, Tab and Backspace on it do nothing except Backspace, which
  removes it and moves the caret to the parent.
- **Draft documents in a view.** Enter on a collapsed document row in a view, or with nothing focused in an empty
  view, drafts a plain document below it (`draftDoc`), stored on the first typed character (`api.createDocument`) and
  kept in place until the next refresh. Backspace on an empty one removes it.
- **`api.createDocument(title, { kind, typeUri? })`** makes a `doc` (plain, the default), a `task` (`stateType: 'open'`,
  assigned to you, with a workflow type when `typeUri` names one), a `meeting` (a `tana:event:` laid out like a
  Tana-native event, the next half hour by default, so it shows in Tana's calendar), a `chat`, a `search` (which must
  carry a `query`) or an instance of a workspace type (`custom`, with its `typeUri`), and answers its Node.

### Undo and redo

⌘Z and ⇧⌘Z (built-in keys) first flush any pending text, then ask main (`api.undo`/`api.redo`): main keeps one
history across documents, each document a Loro UndoManager of local changes with one step per mutation call. The
browser's own contenteditable undo never runs (preventDefault), so undo never diverges from what was sent to Tana. The
affected document is reloaded and the caret placed in the affected row when it still exists. Delete and restore are
recorded in the same history and undone by repeating the native action. Sharing and move never enter it: their
audience disclosure and preview token are the gate (§14).

### Selection

⌘-click toggles a row in the selection; ⇧-click and ⇧↑/⇧↓ extend one anchored range over siblings (blocks within one
parent, or documents in a view). Selected rows take a square-cornered highlight and the caret leaves the text.
⇧⌘⌫ removes the selected blocks and focuses the row before the range; ⇧⌘↑/↓ and Tab/⇧Tab move the whole range, the
selection kept; Escape or a plain arrow clears it. Documents in a selection are not deleted or moved by these keys.
Cmd+K leads with a Selection group for it (§8).

## 7. Navigation

- **Opening a node** — a bullet, a mention, a search result, a pin, a notification — goes through `openDoc`, where
  every route meets (and where a deleted node is refused). The page shows the top of the node and the caret waits in
  the draft tail out of sight: it is parked with `focus({ preventScroll: true })`, the render pins the scroll to 0 while
  `caretOnOpen` is set, and the first character typed scrolls that row into view once (`scrollOnType`,
  `block: 'nearest'`). A read-only row neither scrolls nor spends that one-shot.
- **A meeting opens at its write-up.** An event has no content of its own, so zooming one forwards to the document it
  owns whose title is the event's tagline (`api.summaryUri`, `writeUpOf` in sdk/events.js), from every route; the write-up is
  never repeated in the sidebar ([MEETINGS.md](MEETINGS.md)).
- **Back and Forward** (⌘[ and ⌘], the arrows at the top right) walk one history per page. Back with nothing to go back
  to lands on Home.
- **Home** is the **Work View** by default (§16), the Library, or any saved search: Cmd+K "Set as Home" (`setHome`) on
  the Library or a saved search, "Set Work View as Home" (`setHomeWorkView`) anywhere, stored as the target's id
  (`workView`, `library` or a `tana:search:` uri) in the synced `home` preference, so renaming the search keeps the
  choice. Every route Home goes through `goHome`; Cmd+K "Go to Home" names it, and like Set as Home stays listed,
  disabled with "Current", where you already are. A Home whose saved search is gone from `api.searches()` falls back
  to the Library and the preference is repaired (`repairHome`), but only from a list that could have named it:
  `searchesLoaded` is set only by an answer that lands while connected.
- **Reopening where you left off.** `rememberPlace` stores `{ docId, nodeId, from, title, icon }` under `place` (per
  split side) in localStorage; a view with nothing zoomed is stored as `{}`, a place too. Boot seeds the page from it
  before the first render, so a launch opens on that page with its header and the loader; `restorePlace` then reads
  the real node, and a page that is gone leaves the launch on the view. Children are asked for only once connected,
  and the page you were on is fetched before the view behind it. A launch with nothing stored opens the Work View.
- **Recently viewed**: the last 20 documents opened, most recent first, in localStorage `recent`; the search palette
  shows them under "RECENTLY VIEWED" with an empty query.

## 8. Palettes

### Cmd+K

A centred card over a slightly dimmed page: a borderless field ("Run a command"), then rows under small grey group
headings. ↑/↓ move, Enter runs, Escape closes (or steps back a level), typing filters; ⌘K toggles it and the page
keeps its state behind it. A row that cannot run is greyed and skipped by ↑/↓, so Enter always acts. Cmd+K lists
commands, never documents: a query that matches no command gives one row, "Search Tana for “…”", which opens Cmd+S
with the query running.

**In a split window** (issue #409) the card and its scrim cover the whole window, centred over both halves, and
everything the palette does stays with the half that opened it: its rows, the node it acts on, its keys and where the
caret goes back to. That holds for every page opened through `showPage` (⌘K and its pages, ⌘S, the key recorder); the
@ link search and the "/" menu belong to their spot in the half and stay in it. How it is drawn: Split view below.

**Groups**, in order: Selection (with a multi-selection; the page's own rows follow as Current page) or Current node,
Table, Views (`VIEW_ORDER`: Work View, Timeline, Today, This week, Inbox, Notifications, Proposals, Library, Types),
Searches, Types, View options, Actions, Navigate, Window, Settings, Help.

- **Current node** is the zoomed node or the row under the caret (with a selection, the Selection group counts what
  each row acts on and says "N skipped" for rows it cannot). Its rows follow `NODE_ROW_ORDER` (renderer/palette.js)
  whichever file builds them: the focused field's rows; Zoom in, Expand, Collapse; the task state (Complete/Reopen,
  Mark as read/unread, Approve/Reject proposal, Set status); who has it (Edit assignees, Assign to …, Discuss with …);
  a meeting's Change time / location, Add attendee; when and where it lives (Pin to today / tomorrow / date …, Pin to
  current meeting, Pin to meeting …, Edit pins, Add to Today / Tomorrow / This Week, Move to …, Move to Library); what
  it is (Set type, Classify type, Remove type, Add field, Edit fields); how it looks (Set icon, Set colour, Mark as
  sensitive); the agent (Assign to Agent, Go to / Link Agent task, Send to agent); Edit visibility, Notify on changes,
  Copy link, Export to PDF; last Archive type and Delete. A read-only node shows Delete disabled.
- **View options**: the pills by what they do — Filter by type, Filter by status, Filter by assignee, Sort by, Group
  by, each hinting its value — then Clean up, Filter rows by text, Switch to table/outliner and Column widths ….
- **Actions**: Log in (signed out), Create new …, Create task, Search Tana, Undo, Redo, Mark all as read, Sync.
- **Navigate**: Go back, Go forward, Go to Home, Set as Home, Set Work View as Home, Focus the sidebar, Recently
  deleted, Archived types.
- **Window**: New window, Toggle split panes, Go to the other half, Swap panes, Show/Hide sidebar, Reload.
- **Settings**: Larger / Smaller / Reset text size, Toggle dark mode, Toggle system dark/light mode, Edit hidden items,
  Toggle sensitive visibility, Toggle MCP chats, Toggle demo mode, Manage Codex hosts, ChatGPT sign-in, Set OpenAI API
  key. **Help**: Help.

**Matching** (`fuzzyMatch`): tiers, the way Raycast ranks a title — 0 the label starts with the query ("in" → Inbox),
1 the first words' initials ("mtl" → Move to Library), 2 the query starts a later word ("in" → Zoom in), 3
word-prefix chunks that skip words ("molib"), 4 a substring inside a word, 5 the letters in order with the first
starting a word ("inbx"). Matched letters are bold. With a query rows sort by tier, then the shorter label, then
where the match starts; a group moves as a whole to where its best row lands and equally good groups keep the fixed
order.

**Folded levels.** A row that opens a second level (Move to …, Set status, Edit assignees / Assign to …, Create new …,
Edit visibility, the view option rows) carries `sub`, that level's rows. Once the first two letters of the query
reach the row (as a prefix or its initials: "mo"/"mt", "as"/"at"), the level is loaded, once per opening, and each
choice is offered as a row of its own right below it ("Move to Foundry", "Set status to In Progress", "Assign to
Robin", "Sort by Title"). "Move to …" and "Set status" are `subAlways`: their short lists load as the palette opens
and fold in for any query ("inb" → Set status to Inbox). Move to … offers the spaces and the Library; the Inbox is a
state, reached with Set status to Inbox. Assign to sets the assignee outright; Edit assignees toggles them one by
one.

**Pages.** A row that opens a page of its own (`keepOpen`) goes through `openPage`/`showPage`, which lets go of what
the last page left behind and takes the new page's rows and back step; Escape (`backPalette`) goes where the page says:
the command page, or for a page opened from elsewhere, the page that opened it. The pages are described with their features: Set type, Classify type, Set icon, Set colour,
Discuss with (§11); Edit pins, Pin to date, Pin to meeting (§9); Recently deleted, Archived types (§14); Change time /
location, Add attendee ([MEETINGS.md](MEETINGS.md)); the agent pages (renderer/agent.js, §11).

### Built-in keys and the recorder

Every command row has a stable `id`, and a key is a row with a combo. The built-in keys are rows with a default in
`DEFAULT_HOTKEYS` (renderer/state.js), which a recorded combo overrides and Reset restores:

| Row | Default |
|---|---|
| Create task | ⇧⌘Space |
| Search Tana | ⌘S |
| Filter rows by text | ⌘F |
| Copy link | ⌘C |
| Go back / Go forward | ⌘[ / ⌘] |
| Undo / Redo | ⌘Z / ⇧⌘Z |
| Expand / Collapse | ⌘↓ / ⌘↑ |
| Complete / Reopen | ⌘↩ |
| Today | ⌃⇧D |
| Reload | ⌘R |
| New window | ⌘N |
| Toggle split panes | ⌥⌘N |
| Go to the other half | ⌘\\ |

The document keydown handler finds the row by combo (`hotkeyFor`/`hotkeyIds`) and runs it through `runAction`; with
the palette closed the current node is whatever is focused, and a row that opens a folded level asks for its choices
at the press. A key the focused row already answered (⌘↑, ⌘↩) arrives defaultPrevented and is not run twice; a row
absent right now leaves its key alone, and a disabled one answers it by doing nothing. A read-only row passes every ⌘
combo to the document handler. A command that reveals a field and focuses it (Filter rows by text) shows the field
itself, since a render is deferred while the caret is in a row.

⇧⌘K on the highlighted row opens the recorder: "Recording keyboard shortcut for: <row>", the pressed keys as symbols
with a red dot, Reset / Cancel / Save. Combos are stored in the synced `hotkeys` preference (row id → combo) and shown
as a chip on the row. A combo must include ⌘ or ⌃. Fixed and refused: ⌘K, ⇧⌘K, the text-size keys (⌘0, ⇧⌘+/-,
shown as literal chips), ⇧⌘⌫ and ⇧⌘↑/↓ (`RESERVED`, renderer/palette.js), and any combo another row has; the reason
is shown (⌃ counts as ⌘, ⌥ is ignored for the fixed ones). Sync has no default key.

### Cmd+S search

The same card with one list: "Search Tana", `api.search` debounced 150 ms (stale answers ignored), rows with icon,
title, chips and grey meta; "No results" for an empty answer. From four characters on, documents only Tana's semantic
search found follow under "Related" in its order (issue #20). `#task`, `#meeting`, `#member` and `#<type name>`
tokens anywhere in the query become filters (an unknown type gives no results); an event's meta shows its date.
Tana's order does not weigh the title, so `searchNow` re-sorts by `titleHits`: most typed words in the title first
(filter tokens left out), then most that begin a word, then Tana's order; only those words are bold. Enter opens the
result wherever it lives. ⌘S toggles it and opening one palette closes the other. An empty query shows Recently
viewed.

## 9. Pins and dates

Pins are stored as [PINNING.md](PINNING.md) describes; this is what the outliner does with them.

- **The pin mark.** A pinned node carries the tack in its facts (`pinned`, build/icons/pin-tack.svg) and a "Pinned" row
  in the sidebar's Details. What a row knows comes from one `api.pinIds()` read (`pinnedIds`/`isPinned`/`loadPinned`,
  renderer/nodes.js; main `pinnedUris` over the sidebar collection and the pin-map), re-read whenever a pin is written
  or a global change arrives, and `rowSig` carries it. That is the personal pins only: a node pinned on a meeting and
  nowhere else has no mark (answering that per row is a reverse edge query per view). Pins are personal, so a
  read-only node can carry the mark.
- **Pin rows** on every real node, so a recorded key works wherever it is pressed: Pin to today / Unpin from today and
  Pin to tomorrow / Unpin from tomorrow (the renderer computes tomorrow, `localDate(1)`, and passes it); the label
  follows `api.pinState` when Cmd+K has read it, and a press reads it again (`toggleDatePin`). Unpinning a date removes
  your personal pin and, when the document still shares that date, mutes it for you.
- **Pin to date …** (`pinToDate`) opens a one-field page that reads the typed words as a day (`parseDay`,
  renderer/document.js) and shows the day before Enter: today/tomorrow, weekdays (the next one), "in 3 days"/2w/1
  month, next week (the coming Monday), ISO dates, day-first numbers and day + month names, a date without a year
  being its next occurrence. A fixed parser, instant and deterministic. Enter is `api.pin(id, 'today', date)`.
- **Pin to current meeting** (`pinToMeeting`) pins the node on the meeting you have *joined* (`api.currentMeeting()`,
  main/meetings.js over sdk/calls), through `api.pinTo(eventId, docId)`, which dedups on uri. Always listed on a real
  node, its hint says the state: the meeting's title, "Checking…", "No active meeting", or why the lookup failed (a
  failure is never shown as no meeting). The meeting is read once per open and again at the press; a meeting that
  ended in between pins nothing and says so. With the palette closed the press does its own lookup.
- **Pin to meeting …** (`pinToSelectedMeeting`) pins on a meeting you choose: a page of your meetings from a week back
  to a week ahead (`{ types: [meetings], participant: me, window: recent }` through `api.searchPreview`), read once per
  open and matched with `fuzzyMatch`. Rows are document rows, so each shows its date and time. The page is ordered
  next-first at the moment it opens (`byNextFirst`: meetings on now or to come, soonest first, then those over, most
  recent first, from `start`/`end`, a stable sort). Enter pins and closes; an empty window, no match and a failed read
  each say so. Both meeting rows end in `pinDocToMeeting`.
- **Edit pins** (`editPins`; also a click on the tack or the sidebar's Pinned row) opens `palMode = 'pins'`: everywhere
  this document is pinned, from `api.pinState` → `{ sidebar, dates, hubs }` (hubs read back through `pinHubs`: the
  reverse `EDGE_TYPE_HAS_PIN` edges plus one `ListNodes` for titles). Enter takes one off and the page stays open: a
  sidebar or date pin through `pinAction`, a hub pin through `api.unpinFrom` (a write to that meeting's own
  `pinnedItems`, refused without write access there), re-reading both sidebars. Under the list, what can still be
  pinned: Pin to sidebar, Pin to today and Pin to tomorrow when not already on, and Pin to meeting always (it opens
  the picker with Edit pins as the page Escape returns to, `openMeetingPicker(doc, back)`). One query narrows both
  halves; with nothing left the page says "No pin matches" or "Not pinned anywhere".
- **Today and This week.** "Today" (`api.todayNode`, ⌃⇧D, under Views) opens the document titled `YYYY-MM-DD` pinned
  to today; "This week" (`api.weekNode`) opens "Week N (YYYY)" for the ISO week. Both create the document when it is
  missing (matched on the exact title); they are not linked to each other. Add to Tomorrow creates tomorrow's with
  `api.todayNode(1)`. Add to Today / Tomorrow / This Week append one block per document, a mention of it.

## 10. Grouped pages

Sort, Group and Display are pills on every page with pills ([VIEWS.md](VIEWS.md)): Sort Default, Status, Updated,
Created, Title; Group None, Status, Assignee, Responsibility, Updated, Type (and a type's fields on a one-type page);
Display chooses the facts a row shows. Each is kept per page key in the synced `groupBy`, `sortBy` and `display`
preferences; a saved search keeps its own in its document. Group by Updated sorts rows into Last hour, Last day, Last
week, Last month and Older.

- **Folding a section.** On any grouped page the heading is a `button.ghead` with `aria-expanded` and a disclosure
  triangle drawn from it in CSS. A click, or Enter/Space on it, folds that section alone; its rows leave
  `pageRows().list`, so the keyboard never walks into rows nobody can see, and its `mousedown` is swallowed so folding
  cannot take a selection away. The folded set is `collapsedGroups` (renderer/state.js), the synced
  `collapsedGroups` preference written by `toggleGroup`: each entry is page key, grouping and section key joined by
  newlines — the page key a view id or a saved search's id, the section key the heading's words only where they are
  fixed (Status, Updated, Responsibility), a member uri or a type uri otherwise. Only folded sections are stored.
- **Responsibility sections** run Unassigned, Agent, My inbox, Pinned, Mine, Tracking, My later, My completed,
  Assigned by others (`RESPONSIBILITY`, renderer/views.js).
- **Tracking** — work you made and handed to somebody else — opens short: on the rows updated in the last three days,
  with the rest behind `button.gmore` ("Show 19 more tasks"). Pressing it shows the whole section while it stays open;
  folding forgets (`trackingShown`, session state). A row with no update time counts as tail. `trimTracking` does it
  inside `groupsOf`, so the hidden rows leave `pageRows().list` too.
- **Pinned** holds every task you pinned to a date, whoever has it and whatever its state (Agent still wins; a
  completed one goes to My completed). The dates come from one `api.pinDates()` read beside `api.pinIds()`
  (`datePinsById`); a row's grey line starts with its days ("Pinned to Today · 2026-09-22", `pinnedOn`), carried in
  `rowSig`. The section runs by latest pin date, latest first (`latestPinFirst`, stable), and opens short like
  Tracking on what is pinned within the coming week or already past.

## 11. Types, AI and the agent

- **Set type** (`setType`, on a document or a meeting; hinted with its type or "No type") opens a page of the types
  it may be given, **No type** first when there is one to remove. Main decides which (`api.docTypes(id)` →
  `{ current, options: [{ uri, title, hue, selectable, reason }] }`): the current type ticked and not offered again, a
  type that does not fit greyed with the space it lives in, so the page answers "why is my type not here?". Choosing is
  one `api.setType(id, uri)` (`null` for No type). The rules behind `selectable` are Tana's (docs/sdk/05-gotchas.md):
  a type applies to documents or to meetings; a space's type only goes on a document in that space, a Library type on
  anything. Its choices also fold into Cmd+K as "Set type to …" (`subAlways`). **Remove type** (`removeType`, only on a
  typed node, hinted with the type) is the removal without the page.
- **Classify type** (`classifyType`) lets the model choose from the same list. Main reads each selectable type's own
  document for its `description` and `instructions` (`typeCandidates`, main/documents.js) and sends them, numbered,
  with the document's title and text (a meeting's calendar description in place of its empty content) to
  `ai.classifyType` (main/ai.js), which answers the odds of every option, No type among them, most likely first:
  `{ current, choices: [{ uri | null, title, hue, p }] }`. While it reads the page says "Reading the document…" under
  the breathing sparkle. At 80% or more (`CLASSIFY_SURE`) for a type, it is set at once, the palette closes and a note
  says "Classified as Decision Record (91%)" ("Already …" and no write when it has it). Otherwise the page lists every
  option with its odds. No type is never applied on its own. `node scripts/platform-cli.js classify <id...>` prints the
  odds and writes nothing; a type's description and AI instructions in Tana are how its answers improve.
- **Set icon** (`setIcon`, on a type) gives the type a glyph that every document of that type is then drawn with —
  its bullet, its sidebar row, the chip a mention of it draws — because all of them read the row's `icon`, which main
  fills with the type's icon name (main/rows.js). A task and a meeting keep their own. The page searches the Nucleo UI
  set in the app (`build/nucleo-ui.json.gz`, 3503 glyphs with tags), which stays in main (main/icons.js): the renderer
  asks `api.searchIcons(q)` for a page of 60, registers those glyphs by name and draws them; **No icon** takes it off.
  The choice is this app's own, kept as a name in the synced `typeIcons` setting (type uri → Nucleo label, so it
  follows you, docs/SETTINGS.md), never as markup in Tana, and the glyphs a
  type wears arrive with the roots, so a row is never drawn before its markup exists. On each start, and when a
  ChatGPT sign-in completes or an API key is saved, the fast AI picks one for every titled type with no choice yet
  (`autoTypeIcons` in main.js, `pickTypeIcons` in main/ai.js, `icons.fillTypeIcons` keeping only names in the set); a
  pick is stored like a choice and asked once, **No icon** is stored as `null` and left alone, and without a sign-in
  or key nothing is asked. A failure is logged, never shown.
- **Set colour** (`setHue`, on a type) is this app's own hue (0-360) or grey for the type, kept in the synced
  `typeHues` setting and leaving Tana's `appearance.hue` untouched (Tana has no grey). With no entry Tana's hue shows
  through. The picker is the palette: twelve named colours, each drawn with the type's glyph in that colour, the current
  one ticked, **Grey**, and **Tana's colour** to forget the override; typing a name narrows, a number picks that hue.
  The write is `doc:setTypeHue` → `setTypeHue` (main/documents.js); `typeHue` (main/rows.js) is the one place the
  override is read.
- **Discuss with …** (`discussWith`, on a document; hinted "Discussion Task") opens a page whose only row is what you
  type, because the answer is a name and the field holds text: a team or two people are as good as one colleague.
  Enter writes it through `api.discussWith(id, who)` → `discussWith` (main/documents.js), which gives the document the
  type titled "Discussion Task" and writes the words into its "Discuss with" field, matched by title since field keys
  differ per workspace. A missing type is created in the Library with that one field (cardinality multiple); a
  missing field is added to the existing type. The type carries a workflow, so typing the document also puts it in
  the workflow's first state. While the page is open the title is read by a model (`api.suggestDiscussWith(title)`,
  the title and nothing else, once per open) and the answer is offered as a second row with the sparkle glyph ("Reading
  the title…" breathing while it comes); never the first row, never repeated when it equals what you typed, no row
  when the title names nobody, the message when the call failed. Whatever reaches the field is read for the
  workspace's members (`nameSegments`): each member found becomes a mention of their profile, keeping the words as the
  label. Whole words only, counted in letters; the longest name wins; a first name two members share is not a match;
  nobody is referenced twice; no match or no member list writes the plain string.
- **The model.** `main/ai.js` is the only place the app talks to a model. A signed-in ChatGPT account (Cmd+K Sign in
  with ChatGPT / Sign out of ChatGPT, with the account status) takes priority; the local OpenAI API key (Set OpenAI API
  key) is the fallback. Both stay on this machine. ChatGPT sign-in uses the Codex app-server in its own auth directory
  under userData, separate from the user's Codex login, from this Mac's `codex` (`codexBin` in main/agent.js) or,
  failing that, a standalone `codex-app-server` downloaded on first sign-in and kept only when `codesign` shows
  OpenAI's Developer ID. The model and effort are the synced settings `aiModel` and `aiEffort`, defaulting to
  `gpt-5.6-terra` with low reasoning (main/ai.js), with no UI.
- **The agent** (main/agent.js, renderer/agent.js). **Assign to Agent** asks what the agent should do (a prompt page)
  and hands the node to a new Codex task through Codex's deep link; the task registers itself back with
  scripts/agent-link.js, so the node is pending until it does. The node then carries the agent badge, which says what
  the task is doing, read every 30 s while anything is assigned. **Unassign from Agent** takes it back at once. **Go to
  Agent task** opens it (or says which machine it is on, from the synced `codexTask` record), **Link Agent task…**
  links a task that already exists, **Send to agent** opens a new Codex task with the node's link, and **Manage Codex
  hosts** lists the machines a task can run on. Assign to Agent and Send to agent need a real Codex install.

## 12. Fields and tables

### Fields

A zoomed node shows its typed fields between the title and the outline (`#fields` in `main.scroll`, so they scroll
with the content), from `api.related(docId).fields` (`[{ key, label, text, lines, segments, type, cardinality,
options, to }]`, read from the type document on every call, main/related.js `fieldDefs`). Fields are Tana
attributes: the value lives in the node's data map, the label in its type's template (sdk/fields.js). An expanded
document shows its fields above its body children too.

- **A text or date field is an outline**, drawn by the outline's own rows, so a field row does everything a row does
  ("- ", Tab, Enter, ⌘Z; every row listener is bound to both places rows live, `onRows`). Its id is the document and
  the field together, `<document uri>|<type uri>?attribute=<key>`: `api.children` and every `block:` call take it,
  and main resolves it to the field's value (`fields.fieldView`, `document()` in main/documents.js). Undo belongs to
  the document that carries the field. A read never creates a value; a write does. For a multiple field, each block is
  one value. Structural edits stay inside the field (`rowsBeside`), so Backspace at the top of the page cannot reach
  into the field above.
- **An options, link or member field is a closed list** (renderer/fields.js): one focusable `.fchoice` line of chips
  with no editor, a caret stop for ↑/↓. Enter, Space, a click or a typed letter opens the picker; Backspace takes the
  last value off (a single field is cleared); ⌘K offers Select value … or Link to … for the focused field. A stored
  label the type no longer declares is struck through ("No longer offered"); a link to a type the field does not list
  carries a ⚠. The options picker lists the declared labels, current ones ticked, typing filters, **Clear value**
  empties; a single field writes and closes, a multiple one toggles and stays open, and a label no longer offered is
  only ever removed. The link picker is the search palette narrowed by `api.search(q, { types })` (or `{ members:
  true }`), listing what fits before anything is typed; a single link is replaced, anything else gets one more line.
  Every value is written by `api.setField(docId, key, lines)`, which refuses what Tana would refuse.
- **Defining fields.** A type's fields are listed where its row expands (the Types view), one row per field with its
  kind as a grey chip. ⌘K there offers Set field type …, Number of values …, Edit choices … (options), Link to types …
  (link), and on a type or any of its fields Add field … (a name, then a kind). In Edit choices typing and Enter adds a
  label, Enter on a label renames it, ⌘⌫ removes, ⇧⌘↑/↓ move; at most 60 characters and no duplicates, said before
  anything is written. Writes are `api.defineField(typeUri, key, change)` and `api.addField(typeUri, def)`, one undo
  step each. ⌘K Edit fields shows a type's field definitions under the title.
- On a type's page drawn as a table, an options column is the same closed list for one row (`openCellChooser`,
  [VIEWS.md](VIEWS.md) §8).

### Tables (issue #32)

Tana's schema is `table > tableRow > (tableHeader | tableCell) > block+`, with a `blockId` on the table, each row,
cell and cell paragraph, `colspan`/`rowspan` on a cell and `colwidth` once a column is resized.

- **The row.** A table is one read-only outline node `{ type: 'table', editable: false, text, table }`, `table` being
  `content.readTable`'s `{ id, rows: [[{ id, header, colspan, rowspan, colwidth, paragraph, segments, text, blocks }]],
  rowCount, columnCount }` in stored order. It is atomic like an image (`isAtomic`): it focuses, moves (⇧⌘↑/↓, drag),
  selects and deletes in a writable document, and nothing types into the row. `setText` and `setBlockType` refuse it.
- **Drawn as a table** (`tableEl`, renderer/table.js): `th` and `td`, spans carried over, a resized column's width
  kept (through `style.setProperty`). A cell's text is its first paragraph, drawn with `renderSegs`; anything else in
  the cell shows below it in grey, read-only.
- **Cell edits.** A cell with an id is `contenteditable` only in a writable document. Typing is debounced like a row
  and written with `api.setCell(docId, cellId, value)` → `content.setCellText`, which rewrites the cell's first
  paragraph (making one when there is none) and leaves the cell's other blocks where they are. A pending edit stays
  through a rebuild, and the caret goes back to the same cell.
- **Keys** (`cellKey`): Tab/⇧Tab walk the editable cells in reading order and past the ends go back to the table row;
  ↑/↓ on a cell's first/last line go to the cell above/below in the column you see, merged cells counted (`tableGrid`),
  or out of the table; ←/→ at a cell's edge go to the previous/next cell and past the ends out. Escape returns to the
  table row, where Backspace removes it and ↑/↓ step on. Enter on the table row puts the caret in its first cell;
  Enter inside a cell adds nothing. Every ⌘ key goes to the document handler.
- **Rows and columns** (⌘K with the caret in a cell, group Table; each has an id): Add row above/below, Move row
  up/down, Delete row, Add column left/right, Move column left/right, Delete column, written by `content.tableOp` as
  Tana's `manipulateTable` does, one undo step each, the caret in the cell the operation names. Tana's limits hold: no
  row above the header row, the header row neither moved nor deleted, the last body row and the last column stay;
  what cannot run shows disabled.
- **Images in cells** are drawn after the cell's text (a click opens one). Pasting an image into a cell uploads it and
  appends it to that cell. Removing one from a cell is not offered.
- **Presence**: a caret in a cell is sent as the cell's paragraph, and one received there is drawn in that cell;
  `locate` still stops at tables, so no outline operation reaches into one.

## 13. Drag and drop

A row is picked up by its marker and dropped where a line says it will land (renderer/drag.js).

- **What can be picked up.** `nodeEl` sets `draggable` on the bullet of every writable block row, with `cursor: grab`,
  and one delegated `dragstart` on the document picks it up. A row without a marker (text, a heading, a quote, code)
  shows a small grip inside its 11px gutter while the pointer is on it, so nothing moves when it appears; a collapsed
  row's dot is the thing to grab. An empty line is nothing to pick up (`dragEmpty`); an image and a divider are. A
  draft row never is. The dragged row dims; the drag carries our own dataTransfer flavour, so a drop on a text field
  elsewhere pastes nothing, and a drag that is not ours (text out of a row, a file) is left to the browser.
- **A drag names the place.** `moveTo(document, id, { parentId, afterId, from })` (sdk/content.js) moves the row whole,
  children, checkbox and block ids included (Loro cannot move a container, so it is copied and the original deleted,
  and a list or quote it leaves empty is pruned). `from` is the outline it came from, so a row crosses between a page
  and one of its fields in one transaction and one undo step, both being roots of the same document. Across two
  documents a block is refused (`block:moveTo` → `moveBlock`).
- **Shape at the edge.** A paragraph dropped into a list becomes an item of it; a list row dropped among prose brings
  a list with it, joining the one beside it. Text dropped between two bullets at a document's own level stays text and
  the list splits around it, as a divider does; as somebody's child, where Tana's schema leaves no choice, it becomes a
  list row. A heading, a code block or an image of its own splits a list at any level and is refused as a child (a
  listItem's first block must be a paragraph); the renderer knows that rule too (`dragListable`) and does not offer
  the drop.
- **One gap, several places; the pointer's x chooses.** Between two rows the levels on offer run from the level of the
  row below the gap up to one level inside the row above it, where that row can hold children (`canInsertChild`).
  `dropDepth` counts levels from the row above and clamps; `dropPlan` turns the level into the parent and the row it
  lands behind. The gap under a row with children can only mean "inside it".
- **The line** (`#dropline`, measured at every `dragover`) is drawn in the gap, indented to the chosen level where that
  level's words start (a row's box plus 16px) and running to the right edge, with a dot on the start. It is not drawn
  where nothing can land: the top level of a view, a read-only row, another document, anywhere inside the row being
  dragged, or behind a draft row (a drop aimed there lands behind the last real row).
- After the write both outlines are re-read, the row it landed in is opened, and a parent left with no children
  closes. A drop back where the row was writes nothing. A multi-row selection is not dragged (⇧⌘↑/↓ and Tab move it).
- **A dragged document leaves a reference.** A row in a view or a saved search is a document, which cannot move into an
  outline, so it lands as one block whose whole content is a mention of it (`insertMention` → `block:insertMention` →
  `referenceIn`), drawn as the node itself (§5). The rows of a view cannot be reordered (their order is the query's),
  so a drop between them is not offered. A reference may cross documents, never lands in the document it points at,
  and what was picked up decides the write: a document is always referenced and a block always moved, with no
  modifier key.
- **A task dropped on a group changes what it is** (#169). In a view grouped by Responsibility, and on the Timeline's
  Today's Tasks, a drop between rows is a drop on the section under the pointer (its heading outlined, `groupAt`) or
  the Today block. The writes are read off the task as it stands (`groupDropWrites`, in the order `responsibilityOf`
  reads them), and a task dragged from the other half of a split, whose dataTransfer carries
  `application/x-orbital-task`, lands the same way:

  | Drop into | Writes | Refused |
  |---|---|---|
  | Unassigned | Off the agent, every day pin removed, no assignees | a task you did not make |
  | Tracking | Off the agent, every day pin removed, watched | unless you made it and it is someone else's |
  | Agent | the Assign to Agent prompt; nothing until it is sent | — |
  | My inbox, Mine, My completed, My later | Off the agent, every day pin removed, you as the only assignee, the status; a watch on a task you were not assigned is forgotten | a task you did not make |
  | Pinned | Off the agent, pinned to today unless pinned to a day already; a completed task reopens | — |
  | Assigned by others | — | always: it is about who made it |
  | Today's Tasks | Pinned to today unless it is on Today already | anything but a task |

  A drop in its own section writes nothing. A drop inside a task is offered only once that task is expanded. A task
  you cannot edit is refused before anything is written wherever the drop would change its assignees or status. While
  a task is dragged over a pane grouped by Responsibility its empty sections are drawn too (`setTaskDragging`, cleared
  by the drop, the drag's end, or a second without a dragover).

## 14. Delete, archive, access

- **Delete** is Tana's soft delete and restore. Main validates the uri, `access.canDelete` (a supported kind, write
  access, and the event organizer rule) and the server's `documentActionResponse` before hiding the document. Delete is
  offered for writable documents (or writable blocks, when only blocks are selected); ⇧⌘⌫ removes blocks (§6).
- **Recently deleted** (`recentlyDeleted`, Navigate) lists what this app has seen deleted, newest first, with how long
  ago; typing narrows by title, and Enter restores (`doc:restore`, the same call undo makes) and opens it. A soft
  delete keeps the whole document but the graph stops answering for it, so the ids are the one thing kept locally:
  `invalidateDeleted` (main/documents.js), which every deletion this app learns of passes through, writes the id and
  title into `deleted_nodes` (db.js), a month and at most 25, on this machine only. A restore takes it off the list
  wherever it came from. A deletion that happened while the app was not running is not there.
- **Archive a type** (#36). A type is archived, never deleted (`sdk/access.js` `DELETABLE` leaves types out). On a
  type Cmd+K offers **Archive type** (`archive`) when `doc:accessOptions` says `archivable`, and Delete reads
  "Read-only"; `doc:archive` is the same `documentAction` path, so ⌘Z unarchives. **Archived types**
  (`archivedTypes`) lists what the graph returns with `includeArchived`, newest first; Enter unarchives and opens it.
  Nothing is confirmed, since ⌘Z and this page undo it.
- **Sharing and move** (sdk/access.js implements the verified subset; do not extend it by guessing CRDT keys).
  `access.capabilities` gates the palette. Edit visibility offers only me, selected people, and inherit the location's
  audience (inherit needs the current `sharingToken`), and opens the people picker directly when set to selected people.
  Move to … checks source and target write access, descendant cycles, typed-document home-space rules, type-instance
  counts and the audience before and after, and `moveToSpace` requires the exact preview token whenever the audience
  would change. Ownership is a location boundary, never a write grant; unknown or inherited access stays unavailable,
  and unsupported cases stay disabled rather than guessed. The Library is a move target: moving there removes
  `ownerUri`; a type still has to live in a space. An ACL-change error clears the cached options and reloads them.
  Neither enters the undo stack.
- **Copy link** (`copyLink`) copies the node's home.tana.inc url, which takes the route Tana's own resolver picks for
  the kind: `/t/` a type, `/u/` a person, `/e/` a meeting, `/s/` a space, `/l/` every other document (issue #88).
  The sidebar's Details carries the same link as "Show in Tana".

## 15. Live updates and rendering

- **`onChanged(docId, info)`** is one document's change. The renderer patches that row from one `doc:info` call
  (`patchDoc`) wherever it is listed — views, zoomed lists in `kids`, the extras — and its copies (`patchCopies`:
  reference rows and sidebar rows of any document; reading an outline subscribes the targets of its references as
  on-demand reads, so a rename reaches them, #413), and
  reloads its page and fields when open. It keeps the row's cached metadata unless `info.meta` is true (main compares
  assignees, restriction, participants, type and field values), and re-reads the sidebar only then (or for a type).
  **`own: true`** is the echo of text this page typed (`sendChanged` sends it to the writing page only, #265): the
  words are on screen, so only the row copies are patched and nothing is re-read or force-rendered; every other page,
  the other half of a split included, hears a plain change. A document no view lists reloads the roots.
- **`onChanged(null)`** is a global change: the refresh wrote every open view's rows into the cache before sending it,
  so the renderer reloads the roots (which carry each view's `truncated` flag) and the pins, and runs no second query.
- **`onRemoved(id)`** is an explicit deletion: the node is marked gone and leaves pins, recent results, Cmd+K searches
  and the outline, and a Home pointing at it is repaired. Unpin is not deletion, and an ordinary change is never read as
  one.
- **Rendering.** `render()` is synchronous for user actions that need the DOM right after; anything that arrives on
  its own (metadata, members, pins, the sidebar, live updates) calls `renderSoon()`, one render per frame, and a live
  update to an open document forces the caret-preserving render. A metadata answer patches its own rows (`patchMeta`)
  and renders only when the zoomed document is the one answered. List rows are keyed and reused while `rowSig` is
  unchanged, so whatever a row is built from belongs in `rowSig`. Icons are cloned from a parsed template per name
  (`iconNode`), never `innerHTML`; `docOf` caches per render.
- **Main side.** Per-row link-sharing lookups are batched into one `nodeIds` query per 25 ms, an unchanged row is not
  written to SQLite, and cached rows come back in each view's own order. How the refresh is triggered and what stays
  subscribed is in [VIEWS.md](VIEWS.md) §4.
- **Bootstrap readiness.** `sync.subscribe(id, init)` resolves only after the matching bootstrap-complete frame, and
  callers await it before reading (`getDocument` can hand out a handle earlier). A cold unknown id is detached as not
  found after the retry window; a locally initialised warm id becomes a new document. Reconnects reuse the `Document`
  object and bootstrap it again.

## 16. Pages, windows and overlays

### App pages

Notifications, Proposals and the Timeline are pages of the app's own: an `orbital:` id no Tana node can have, known to
the renderer from boot (`extra` with `appPage: true`), so `goTo`, Back and Recent reach them without asking main. Their
rows are `outline:children` of that id. They have no pills, filter, draft row, presence room or pins, and Cmd+K offers
nothing about them as documents. Each is a place the app remembers, so ⌘R on one reloads onto it.

- **Notifications** (issue #18; `orbital:notifications`, Views after Inbox, hinted "2 unread"). main/inbox.js reads the
  user's `tana:user-inbox` document (sdk/inbox.js) into one read-only row per notification, newest first. A row is
  Tana's own sentence: the actor from the member list and what Tana emphasises in bold ("**Sam Okafor** added you to
  **Leadership sync**"), then Tana's second line, with the time as grey meta; without an actor it reads as Tana writes
  it ("You were added to …"), and an archived or restored type is named by its current title when the graph still
  answers. Unread is Tana's blue dot in the bullet's place (`.node.unread`); clicking the bullet toggles read. Opening a
  row (Enter, Space, a click on its words) marks it read and goes to its source; a source with no page here opens in
  Tana through its node link (§14). A comment opens its document; an `ai-usage-warning` follows its source. Cmd+K on
  the rows you are on offers **Mark as read** / **Mark as unread** (`markRead`, `markUnread`) when some are the other
  way, and **Mark all as read** (`markAllRead`, Actions) with the count, grey at zero. Everything is drawn before main
  answers; each write answers with the new count; main subscribes the inbox once per connection and sends
  `inbox:changed` with the count on every change, which re-reads the page when it is open.
- **Proposals** (issue #19; `orbital:proposals`, after Notifications, hinted "20 pending"). main/proposals.js reads the
  pending proposals from the chat graph nodes (sdk/proposals.js `pending`) and hands back each proposed document as the
  row a view draws for it (`graphRow`), newest first, read-only here (Space opens it), its grey line saying where it
  was proposed ("Proposed in Nedap & Slack") and its meta when. Two buttons end the row, `circle-check` and
  `circle-xmark`: approve and reject; Cmd+K offers the same (`approveProposal`, `rejectProposal`). Orbital approves a
  proposed new document; where Tana would do more (a change or deletion, a space, instructions or action proposal, a
  typed document whose type lives in another space, a proposal whose document is gone) approve is disabled with the
  reason and the grey line ends "approve in Tana". Refusals only the chat can show come back as the error. Reject
  works on every proposal. An answered row leaves at once and main keeps it off until the index stops listing it;
  nothing pushes proposals, so the page is read on connect (for the count) and on every arrival. Rows are filed in two
  parts by where the chat lives (#104, #107): yours first with no heading (a meeting with you among its participants,
  a chat owned by you or nobody), then **From others** under a collapsible heading (a meeting you were not in, a chat a
  space or another person owns), which starts folded and remembers opening as `orbital:proposals\nopen\nothers` in
  `collapsedGroups`. A meeting's write-up shows its own proposals in the sidebar (§18).
- **Timeline** (issues #135, #150, #154; `orbital:timeline`). main/timeline.js rebuilds it from Tana on every read
  (about a second): the change summaries of every node you watch (the watch rule plus your choices, less what you
  silenced; sdk/history.js, twelve at a time), and the tasks assigned to you in the last two weeks with the chat each
  came from (`EDGE_TYPE_CREATED_IN`). It reads in parts and sends them on `timeline:part`.
  - **Now**: first **Today's Tasks** (tasks-2 icon): incomplete tasks pinned to today or earlier and completed ones
    pinned to today, future pins excluded; with none, "All done - Add more", where Add more opens a search of your
    open tasks and pins the choice to today. Then, when any are left, **Upcoming meetings**: today's meetings still to
    start, earliest first, each with its time and who else is on it ("14:00–15:00 · Jeroen Oostewechel"), opening the
    meeting. A meeting still to come, or under way on the timeline, has the Tana glyph after its title ("Join in
    Tana"), which opens it in Tana (`row.join` through `doc:link`). One timer per read, a second after the next start
    or end (`startTimer`), re-reads the page. A rule separates these blocks from the history (16px above, 8px below).
  - **History**, newest first in day sections (Today, Yesterday, the date): the time in a column (24-hour), a rail, a
    20px marker per entry (a filled green circle with a white check for finished work, a grey pen for an edit, grey
    outline circles for other moves), then who, in plain text, what they did in bold, and the node: "Kevin Favier
    **completed** ~~Plan the offsite~~", "**accepted**", "**moved to Later**", "**moved back to Inbox**", "Peter
    Leppers **edited** Risk register" with Tana's summary quoted under it (title in bold, then its description). The
    latest status move comes from the node's state, older ones from summaries that name the state. A run of new Inbox
    tasks from one source on one day is one quiet line marked by who put them there (a robot for an agent, Tana's
    prism for Tana's AI, a dotted ring for a person), the tasks listed under it. Meetings you are in show at their
    start once started, with their length and others on the grey line ("45 min · …", four names then an ellipsis);
    all-day and future ones stay out; one over with no summary is drawn quiet (`faint`); the summary is Tana's own on
    the event (`calendarEvent.tagline`/`.summary`), part of the live signature. A live query over your meetings to the
    end of today (`watchMeetings`) re-reads the page when one is added, gone, renamed or moved. Changes only you made,
    tasks you made by hand and anything older than the page's days stay out.
  - A blue dot marks what came after your last visit; opening an entry goes to its node. The page opens on today and
    the two days before, and reads three days further back when its end comes within a screen (an
    IntersectionObserver on "Show three more days", which also works pressed and reads "Loading…"), up to 120 pages
    (`setPages`); a page too short to scroll keeps reading until it fills the screen. Watched nodes last updated before
    the window are not asked for history. No filters.

### Chats

An open `tana:chat:` is a conversation in the Codex app's style, drawn by renderer/chat.js from the rows sdk/chat.js
`chatRows` makes (docs/CHATS.md §8), in list order with the newest at the bottom: yours (`row.chat.mine`) in a light
blue bubble on the right (a deep blue in dark mode), Tana's and anyone else's as plain text across the page. The
conversation fades out at the top, under the header, and into the composer at the bottom (a mask on the scroll area). With more than one other author,
their name heads each of their runs. The markdown blocks keep their kind (headings, bullets, numbered items, quotes,
code), mentions and attachments are links that open their node, the thinking line or an error sits in grey above the
answer, and hovering a message shows when it was sent. The page opens at its end and follows new messages while you
are within 80 px of it; a short conversation sits at the bottom of the window.

Under it is the composer (`#composer`, a rounded card whose textarea grows with its text and whose round blue button
sends), the window's last row outside the scroll, so it stays at the bottom whatever the conversation's length or
scroll: Enter sends (`chat:send`, main/documents.js `sendChat`), Shift+Enter is a new line, and Escape leaves it.
**@** opens the link search as a dropdown at the caret and puts the node picked (or created) in as a chip, with
**Tana** offered first while what is typed fits it: mentioned, Tana answers in a chat with other people in it, where a
message is otherwise only for them; **/** as the
first thing typed opens a page of the workspace's skills (`searchPreview` over the skills kind), and the one picked sits
as a pill in front of the text (Backspace at the start or a click drops it) and goes with the message as its
attachment. Chips are sent as `[label](tana:…)` links. A label at the card's bottom left says where the message goes, **To Tana** (Tana is asked to
answer) or **To the chat** (a message for the people in it); it starts at what the chat does by itself, and Tab in an
empty message or a click on it switches it. Picking a skill switches to To Tana, and it stays there while the skill is attached. The field is a `contenteditable` of plain text and chips
(renderSegs/readSegs); ⌘Z and the other editing keys stay its own rather than reaching the outline. What is typed and not sent is kept per chat while the window is open.
Opening a chat puts the caret in it. After a send, three dots stand where the answer will be until Tana's answer begins (two minutes
at most); the answer streams in as live changes to the chat, and a message Tana is still writing with no words yet
shows the dots in its place. A failed send puts the words back. **New chat** (Cmd+K, Actions) makes a chat with
Tana that is yours alone (`chat:new`) and opens it.

### Work View, windows and split view

- **Work View** (`workView`, renderer/timeline.js; the default Home): the Timeline on the left and My Tasks on the
  right (`api.myTasks`: the search the synced `myTasks` setting names, so a rename in Tana keeps it; else your own
  saved search called My Tasks, the oldest if two machines each made one, hidden title or not; else one made from the My
  Tasks preset with the Library's arrangement, and remembered. Only a deletion in Tana makes a fresh one). Cmd+K Work View stores both halves' places and main opens the right half or sends the other half to
  its place (`window:workView`). A first launch opens it split.
  On a new account both halves are empty, so an empty page says what would fill it (`emptyText`, renderer/render.js):
  the Timeline what shows up there, Notifications and Proposals that there are none, a saved search or a type's page
  "Nothing matches.", with the Create task key after it when the search lists tasks, so an empty My Tasks is where the
  first task starts. Only a document says "No content".
- **Windows** (issue #137). File › New Window, ⌘N or Cmd+K New window opens another outliner window 24px down and right
  of the front one. Each window has its own view and page; a new one starts where you last were. What main pushes
  (`send`) reaches every page of every window; each window's view is refreshed and kept live while any window shows it
  (`openViews`), and each page keeps its own sidebar watch (`watchRelated(id, key)`). A command for one page goes to the
  page used last (`S.pane`): a notification click opens its node there. Closing the last window keeps the app in the
  Dock (issue #246): ⌘Q quits, the Dock icon opens a window when none is open, and a notification click opens one.
- **Split view** (issue #159). **Toggle split panes** (⌥⌘N) puts a second page beside yours in the same window, or goes
  back to one. An outliner window is a `BaseWindow` with one `WebContentsView` per page (main.js `addPane`/
  `removePane`), and main keys a page by its webContents id, so a half is to main what another window is: each half
  has its own view, page, history, filter and sidebar. The new half opens on the view and place of the one that asked
  and takes the keyboard. **Go to the other half** (⌘\\) moves the keyboard. **Swap panes** (Cmd+K, or a click on the pill
  on the line) trades sides; each half takes the other's side marker (`window:side`) and stores its view and place
  under its side's keys (`view:2`, `place:2`; renderer/state.js `SIDE`), so a restart or Reload keeps them. ⌘W closes the
  half you are in, or the window when there is one; the right half's header ends with an X that closes it
  (`window:closePane`). The halves share the width evenly with a hairline between them (`.splitgrip`, drawn by the
  right half); a 5px grip on each inner edge drags the line (`splitGrip`, `window:splitDrag`: main reads the cursor
  from the screen, keeps each half at least 320px and saves `splitAt` with the window), a double click evens it out,
  and over either grip both halves draw their half of the swap pill (`window:splitHover`). A restart brings the split
  back, each half on its own view and place; a half with nothing stored opens the Work View.
- **The palette over both halves** (issue #409). The palette is the opener's own page: while it is open, main lays that
  page over the whole window, above the other half (main.js `coverWindow`, `window:cover`, synchronous so the first
  frame knows the half), and tells it its half, `{ x, width }`, again on every layout (a resize) until it lets go.
  The page keeps drawing itself in its half (styles.css `html.cover`: the body offset and sized to the half, the split
  line and the toast at the half's edges) and is see-through beside it (panes have a transparent background), so the
  other half shows under the scrim and keeps drawing live updates. The class follows the page's own width, on once it
  is wider than its half and off once it is back, so no frame shows the page out of place while main resizes it. A
  click on the scrim over the other half is a click on the opener's scrim and closes the palette; the page lets go
  once the scrim has faded (`MOTION.quick`). A page alone in its window is answered null and nothing changes. A Help
  tour or Create task stays above it.

### Overlays

main lays two pages over the whole window, both halves of a split included, as a transparent view (main.js
`openOverlay`), asked for by renderer/overlays.js; each is its own scope outside the outliner. The page that asked
keeps its caret and gets the keys back when the overlay closes, with what it had to say (`onOverlayClosed`).

- **Help** (help.html): six pages of the basics, each with a CSS loop of the keys at work. Opened by Cmd+K Help, the ?
  in the header row, and once by itself on a first start (`helpOnce`, the `helpSeen` preference): after login, once
  the connection is up and the page the launch came back to is drawn. Main opens it (`api.claimHelp`, main.js
  `help:claim`): only after this session read the settings document (a failed read declines), over the first page asking
  in a window nothing covers, and marks `helpSeen` in the same step; a window Create task was covering gets it from main the
  moment that closes (`firstHelp`, `helpPending`), whichever half opened Create task. So it neither covers the login, nor
  shows again on a new machine, nor opens in every window, nor is spent
  unseen. ⌘K closes it and opens the palette.
- **Create task** (task.html; `createTask`, ⇧⌘Space, issues #232, #237, #241): the palette's card with a title field
  and, under it, the type — plain Task first, then the workflow types main offers (`api.taskTypes`: types with a board
  of states, `data.workflowUri`, that this user may create in); ↑/↓ choose. A line under the field says what the task
  will be and for whom ("Bug · Assigned to Me"); ⇥ or a click there turns the field into "Assign to…" over the members
  (`api.members`, you first), where ↑/↓ choose, Enter picks and brings the title back, and Escape or ⇥ go back
  unchanged. Enter creates the trimmed text through `api.createDocument(title, { kind: 'task', typeUri? })`, open and
  assigned to you, then `api.setAssignees` when someone else was picked; a refused assignment leaves the task and says
  why in the note, which the asking page shows as a toast. Enter on nothing does nothing, a refusal stays on the card
  with the text kept, Escape closes, ⌘K closes and opens the palette. Demo mode refuses it before it opens. The key
  works in Orbital's windows only.

### Presence (issue #14)

The page on screen has its presence room open (renderer/presence.js follows the zoom after every render;
main/presence.js keeps one counted room per document over sdk/presence.js). Lists show no presence.

- **Others.** Avatars beside the title, and each person's caret drawn where Tana draws it: a thin line in their colour
  (from their user hash) between the characters it is on, their full name on it, below the caret when the row is too
  near the top. The position is read from the entry's Loro cursor (`content.cursorOffset`), which stays right as text is
  typed, so an edit redraws the carets without a presence message; the block offset (`content.charOffset`, ProseMirror
  units, a mention is one) is the fallback. In an empty row, or before the position is known, the caret stands where
  the text begins. This Orbital is never shown; your other tabs and devices are, under your name.
- **You.** While the caret is in a block of this page, your entry says so under `user.name` (no colour, so Tana picks
  one): the block id with anchor and focus offsets, and the same positions as Loro cursors (`content.cursorAt`), at most
  one message per 150 ms, cleared when the caret leaves the outline, the window loses focus or the page changes. The
  title and a draft row are not blocks. The viewing heartbeat goes to the page on screen only while the window is
  visible and you were active in the last minute.

### Export to PDF

⌘K **Export to PDF** (`exportPdf`) on the current text document, read-only ones included. Pending edits are flushed
first; the native Save dialog defaults to the title, and cancelling writes nothing. It reads the whole main outline,
collapsed children included, without expanding references or including app controls, the sidebar or typed fields,
and prints a separate sandboxed page as A4 with fixed light typography, lists, headings, inline marks, images and
margins (main/pdf.js). Failures surface through the normal error path. `node scripts/pdf-check.js` checks escaping and
structure; an unsandboxed `electron scripts/pdf-check.js --render` writes three samples to `/tmp/orbital-pdf-examples`.

## 17. Sensitive marks, demo mode, hidden items

- **Sensitive marks** (`api.sensitiveIds()`/`setSensitive`; Cmd+K Mark as sensitive, and for a selection): marked
  documents render blurred on every surface (rows, title, chips, sidebar, tooltips). Cmd+K Toggle sensitive visibility
  (and the header button) lifts the blur, remembered on this machine only (localStorage `sensitiveVisible`): showing
  them on your laptop should not unblur them on a shared one. The marks themselves follow you (docs/SETTINGS.md).
- **Demo mode** (issue #156; Cmd+K Toggle demo mode, hint On/Off) swaps what came from Tana for made-up words on screen,
  for showing the app to someone. Every word of a title, row, sidebar row, table cell or Timeline change becomes a
  made-up word, one for one (a short word from `DEMO_SHORT` for short ones, the rest from `DEMO_WORDS`), capitals kept,
  the same node always reading the same. People (`memberName`, member mentions, Timeline and notification actors,
  presence carets, attendee suggestions, the Assigned pill) get a stable fake name with as many words. The app's own
  words stay: view and page titles, headings, commands, types, saved search titles, field options, dates, and inside
  the rows of `orbital:` pages everything but the parts main marks `person` or `content` (`keep` marks a
  notification's fixed sentence; a notification's own title is masked unless it names a type; chat rows mark theirs,
  docs/CHATS.md). Cmd+K rows that carry Tana's words without being document rows are masked where they are built (the
  current meeting beside Pin to current meeting, Edit pins' meetings and spaces, Move to space, a meeting's location),
  as are a space audience's name, a Changes tooltip and an image's description; a type row's grey meta is masked, a
  date is not. Pictures are never shown: an image is the grey box of a loading one, nothing is fetched, the full view
  does not open. **Nothing is saved while it is on**: no text is editable, checkboxes are disabled, and `tana`
  (`readOnlyInDemo`, renderer/state.js) refuses every call in `DEMO_WRITES` with "Demo mode is on: nothing is saved to
  Tana", whatever asked; the day and week nodes are only looked up (`findOnly`). The switch reaches every window at
  once (the storage event) and main (`app:demoMode`), which then posts no notification banner. It is remembered on this
  machine (localStorage `demoMode`), read before the first render.
- **Hidden items** (`api.filters()`/`addFilter`/`removeFilter`; Cmd+K Edit hidden items): title patterns
  (the whole title, or a prefix with a trailing `*`, case-insensitive) that drop matching nodes from every list and
  search. A hidden node opened directly still opens. **Toggle MCP chats** hides MCP chats the same way (docs/CHATS.md).

## 18. The sidebar

A zoomed document shows its relationships in a full-height sidebar beside it (`#rail`, renderer/rail.js), fed by
`api.related(docId)`: its own scroll, a border, a drag handle on its left edge (200-620px, width in localStorage
`railWidth`), and a toggle at the top right (Cmd+K Show/Hide sidebar). Its rows are edges, not nodes: they open on
Enter or a click, a task row toggles on Space, and nothing there takes a caret. An empty section is omitted and an
empty sidebar hidden; a collapsed section is remembered (`railClosed`), and every head carries `aria-expanded`.

- Tags on sidebar rows collapse to their `#` and hue and show their label on hover or focus, without changing the
  row's height.
- **Details** first: Show in Tana, the meeting's call link, the assignee, the visibility (which opens the people picker
  directly when set to selected people), Pinned when it is (§9).
- **Sections**: Pinned (a meeting's or space's `EDGE_TYPE_HAS_PIN` items, read from the hub's own `pinnedItems` too,
  since a pin just written is there before its edge), Outcomes (documents it owns that carry a task state), Proposals
  (on a meeting's write-up: the proposed documents from chats the meeting owns, #106), References (documents it owns
  without one), the backlink sections, and Changes. Opening a meeting's notes shows the meeting's relations (an event
  owner is resolved as the hub, `related().pinHub` names it); the open document, untitled drafts and anything already
  under Pinned never repeat, and the write-up is never listed.
- **Backlinks**: the node's incoming `EDGE_TYPE_LINKS_TO` (a mention, one per mentioning document) and
  `EDGE_TYPE_ATTRIBUTE_LINKS_TO` (this node in a typed field, `properties.attributeUri`) edges, grouped as Tana's own
  Backlinks panel groups them: one section per field, "<Type> › <Field>", then **Mentioned in** last; a field whose title
  cannot be read joins the mentions.
- **Live** (#21). `watchRail` names the page to main (`api.relatedWatch(docId)`, null for none or a draft) and
  `watchRelated` (main/related.js) opens Tana's own edge live queries for it — the page's LINKS_TO and
  ATTRIBUTE_LINKS_TO, and the hub's HAS_PIN when the page is a meeting, a meeting's notes or a space. An edge added or
  taken away sends `related:changed` and the renderer re-reads through `refreshRelated`, keeping the old payload on
  screen until the new one lands. One page at a time per window page: a new page closes the last one's queries.
  Outcomes, References, Proposals and Changes are read once per page, and again on a metadata change or a pin.
- **Changes** (#276): the node's own history, newest first, from `ChangeSummaryService.ListChanges` (sdk/history.js),
  the service Tana's Changes panel uses: a written title, authors, times and a `changeType`. `summaryChanges` reverses
  it, dates an entry by when its window closed, reads a missing `changeType` as Updated and counts extra authors. When
  the service answers nothing, `changesOf` falls back to the graph node: one Updated per editor, Created, Deleted.
  Each row shows the kind as a glyph (`CHANGE_ICON`: pen, file-plus, trash; named in its `title`/`aria-label`), what the
  change is about, and "who · when" (`memberName`, `agoText`). Display only. The payload is left alone while the page
  is edited, so Changes says what it said when the page opened.
- **Keys**: Cmd+K **Focus the sidebar** (`rail`, no default key; record one with ⇧⌘K) enters it, ↑/↓ move, Enter opens, Space toggles a task, ← folds
  the focused row's section and → unfolds it, Escape or ⌘← returns the caret to the document.
