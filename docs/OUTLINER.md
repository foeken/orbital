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
  fades after 2.5 s, restarts on a newer notice and sits above the palette. A notice about one node (the task Quick Add
  Task made, the meeting a drop pinned to) opens that node when clicked (`showNote(note, false, id)`, issue #532): it shows a
  pointer and stays 5 s. The line under the title (`#error`) is the
  session's alone: it shows when Tana needs a new login, with the relogin button (renderer/app.js `showStatus`). The
  Quick Add Task card (task.html) keeps a failed create on the card, so the press can be repeated.
- **Signed out.** The login button shows only after a completed session check says signed-out; an unresolved or
  failed check is not signed-out. Signed out, the outline area is a welcome that teaches ⌘K: two big ⌘ and K keycaps
  as a planet, with Tasks, Meetings, Notes, People and Inbox orbiting them as chips; the keycaps go down under the keys
  held (renderer/app.js `loginKeys`), and two steps say ⌘K, then ↩, because the palette lists "Log in to Tana" first while signed out. A "Log in to Tana" button for the mouse fades in after 15 s
  (styles.css Login). A window of several panes shows its first page alone until login (issue #244).
  ⌘K "Log out of Tana" (Settings) asks once more on a page of its own, then closes the stream and clears the session
  (main.js `sync:logout`), which signs out every window.

## 2. Content model and outline operations

`document.content` is a LoroMap `{ nodeName: 'doc', attributes, children }` in loro-prosemirror layout. Each block is
a LoroMap `{ nodeName, attributes, children }`; inline content of a paragraph or heading is a LoroList of LoroText runs
and inline maps such as `{ nodeName: 'mention', attributes: { label, tanaUri } }`. Block names: paragraph, heading
(`attributes.level`), bulletList > listItem > (paragraph, optional nested list), orderedList, blockquote, codeBlock,
horizontalRule (a divider), image, embed (a native reference), table (§12), and the atoms video, audio and
unsupportedBlock. A checkbox is `checked` on a listItem's attributes, never on the paragraph, and a checkbox row always
draws its bullet beside the box (#602). Blocks carry
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

- **Window header** (shell.html): a 38px band over the panes, with no line under it: the traffic lights, and on the
  right the app's own switches, **sensitive items** (the eye), **⌘K** and **?**. It drags the window, and each button
  acts in the page in front, which takes the keys first (shell.js posts `sensitive`, `palette` or `help`;
  renderer/app.js runs `toggleSensitiveVisibility`, `togglePalette('cmd')` or `openHelp`). The eye is drawn from the
  pages' `sensitiveVisible` storage and follows a switch from any page. The panes sit below it, so every tab bar has the
  full width. The house before the eye opens the **Work View** (issue #529): it runs Cmd+K's Work View row (Saved views)
  in the page in front, whatever Home is set to; Home itself stays Cmd+K Go to Home (⇧⌘H), which the Help tour teaches (issue
  #444). There are no breadcrumbs: the title says where you are and Back walks the history.
- **Create new** (shell.html `#create`, issue #499): a round button in the window's bottom-right corner with the
  text-plus glyph; on hover the words "Create new" slide out beside it. A click runs Cmd+K Create new … in the page in
  front (shell.js posts `action` `create`, renderer/palette.js `runAction`). It sits under a covering palette's scrim
  and is gone while signed out.
  **Process image** (issue #507): a file dragged over it swaps the glyph for image-sparkle and the words for "Process
  image". Dropped, the file goes to the page in front (`processImage`, renderer/upload.js), which sends it to main
  (`ai:processImage`): the fast AI (main/ai.js `readImage`, PNG, JPEG, WebP or GIF) answers with a task or a note,
  its title and the lines worth keeping, and main makes it with those lines and the image under them. The page opens
  it; the button says "Processing image …" until then, and a failure is the red toast. With Auto-translate on, the model writes
  the title and lines in that language, translating the image's words (names, dates, amounts and links kept); off, in
  the image's own language.
  Cmd+K offers the same under **Image**, and only there (the rows have no id, so no key can be recorded on them):
  **Process image** while the caret or the selection is on an image row (main reads that image, main/images.js
  `image`), and **Process image from clipboard** while the clipboard holds an image (`clipboard:hasImage`, asked
  each time ⌘K opens; main reads it with Electron's clipboard as PNG: Chromium's image/png, or macOS's own PNG type,
  which is all a copied image file offers, from Finder or CleanShot). Pasting an image still inserts it as before.
  Cmd+K's **Create new …** row wears the corner button's text-plus glyph. With an image on the clipboard its page (from
  Cmd+K or the corner button's click) leads with Process image from clipboard, above the choices. That row is on the page
  only, never among the folded Create new rows, so no key can be recorded on it either. Quick Add Task (⇧⌘Space) shows it
  too, under **Clipboard**: ↩ with no title typed runs it, and the page that opened Quick Add processes the image as
  Cmd+K's row does. Every page of the palette opens as the centred card: closing it drops an "@" dropdown's place and
  size, so a page opened next without ⌘K (Create new from the corner button) does not wear them.
- **Header row**: over the page title, the empty line the buttons at the top right sit on, while the page is alone in
  its window. It is part of the title
  bar's drag area; the buttons opt out of it, and so does the palette's backdrop while it is open (otherwise Electron
  takes a click there as a window drag and the backdrop never hears the click that closes it).
- **Buttons at the top right** (`.navbtns`, one flex row anchored to the right edge of `.titlebar`, so they stay put as
  the rows under the title come and go): Back and Forward, the sensitive toggle, the pills toggle, the Outliner/Table
  switch, Clean up, the page's meeting and the Graph switch on a page with a document (a page among others closes from its tab, Panes
  below; the links are a pane, §18). A button that
  The meeting button (`navMeeting`, renderer/rail.js `drawMeetingBtn`, issue #630) is there when the page belongs to a
  meeting — a task Tana's AI filed under it, a note written in it — and never on the meeting's own write-up: main names
  it with the page's read (main/related.js `meeting`), its tooltip reads as the meeting glyph on a task's row does
  ("From Studio LT weekly · Wed 30 Sep"), and a click opens the meeting, which forwards to its write-up.
  does not apply is gone rather than empty, and the others move up to the edge. Back and Forward run `navigate(-1)` and
  `navigate(1)`, the history ⌘[ and ⌘] walk; `renderNav()` runs after `noteNavigation()` on every render, disables
  them when the move does nothing and puts the current combo in the tooltip. Every header button with a Cmd+K row
  names its key the same way through `keyTitle` (renderer/state.js), read again when the pointer arrives, so a key
  re-recorded with ⇧⌘K shows through. The header row shows only while the pointer is over that page.
  Among other pages (`html.tabbed`) the row and its line go, and the buttons are drawn in the page's tab bar beside
  its ⋯, in the Trellis accessory that shows while the page is the selected tab: the page sends the row's markup on
  every change (renderer/app.js `tellNav`), the shell draws it (shell.js `drawNav`) and sends a press back as a click
  on the page's own button, which stays laid out but unseen so its animations still end. There they show while the
  pointer is over the page or the tab bar, and a tooltip names the key as of the page's last render.
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
  More than four field pills fold the ones filtering nothing behind an **Add filter** pill (the filter glyph with a plus; its tooltip names the folded fields) (`foldFields`, renderer/pills.js,
  issue #624): its menu lists them under "Type fields" with a search line, and picking one puts its pill back on the
  bar, open, for the rest of the session. A field that filters something always keeps its pill, and Cmd+K lists every
  field either way.
- **Loading.** On a launch or a Reload only (`booted`), while the first page has no rows yet, the page builds itself
  after a 300 ms wait (renderer/loading.js): the header and title, then rows of small outlined glyphs and rounded text
  bars growing in one by one, a highlight sweeping through each, fading toward the bottom; slow on the Timeline, 2.2
  times faster elsewhere. When the rows land it fades and they rise in top to bottom. The Timeline lands in parts
  (`timeline:part`), each drawn at once (main builds it once for every pane asking at the same time, and once more
  after it for whatever asked meanwhile, #579), and the loader keeps building below the last real row (`.tail`) until the
  whole page is in. A page opened later, or a reconnect, waits blank for its rows; the loader never shows once rows
  exist.
- **Rows arriving.** A row that arrives in a settled view glows once; a row that leaves flashes as it goes. A first
  paint is not an arrival (an empty `before` is a first paint, and so is a row added to a view that was empty), the
  zoomed branch clears `animView` so returning to a view is a wholesale replacement, and a change of more than
  `BULK` (25) rows is not animated. A row whose words or state change while it stays (someone else's edit, a live update) is patched
  in place without a flash: the blue tint it used to get was distracting.

## 5. Rows

- **Document rows.** A document draws its icon in the gutter: a task its checkbox, a meeting the calendar glyph in
  gold, a space, a chat, a member, a saved search or a type its kind's glyph, a plain document the doc glyph, a typed
  document its type's glyph (§11, Set icon) tinted with the type's hue. After the title come its tag chips — `#
  task`, `# meeting` (gold), `# doc`, `# space`, `# member`, or the type's name in the type's colour (background
  `hsl(hue 80% 92%)`, text `hsl(hue 45% 30%)`; zero is a valid hue) — and its facts. Node `appearance.hue` colours
  its icon and kind tag; a type's own colour override (§11, Set colour) wins where it is set.
- **A task from a meeting links back to it.** Tana's AI files the tasks it takes from a meeting under that event
  (`ownerUri`), so such a row carries `meeting: { id, title, start }` (main/rows.js `meetingOf`; the names come from
  one lookup per list, `resolveMeetings`, next to `resolveTypes`). A meeting glyph sits among the row's facts, a fact icon the size of Pinned and just
  after it (renderer/tasks.js `taskMetaEl`), or 2px after the title on a row that shows no facts, quiet as every row
  icon is (renderer/meeting.js `meetingLinkEl`); its tooltip "From <meeting> · <day>"
  (masked in demo mode); a click opens the meeting and the caret stays.
- **Row icons are quiet until you are on the row.** The small glyphs a row carries — its facts' icons (assignee,
  audience, bell, pin: `.ticon`), the Timeline's Join glyph and the meeting link — are drawn at .45 opacity, and in full
  on the row under the pointer or with the caret, fading between the two (styles.css). None of them gets a background
  on hover, only its own colour darkens. The visibility icon (`.audience`) and a warning (assigned to someone who cannot see it,
  `.hiddenfrom`) stay in full. That warning is "Not visible to …" in the subtext after who can see the row, in a soft
  rose rather than the error red, the audience glyph left grey beside it (`peopleEl`, issue #622); where the row shows
  only the glyph, the glyph itself takes the rose. In a table's Visible to column the words are a rose `userAlert` glyph
  after who can see the row, "Not visible to …" in its tooltip.
- **A task's box is its state** (#243). A task in the Inbox (`proposed`) draws a dashed box; In Progress a grey box;
  completed a green tick, with the title struck through and grey, and a short pop (`popSound`, renderer/motion.js;
  a checkbox block pops too, unchecking is silent; it sounds as the mouse button goes down on a box the
  click will tick, from a context made on the first press, and the click then leaves it). Clicking a dashed box accepts the task first (In
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
- **Who can see it** (#461). When the audience names its people (`audienceMetadata` returns them for only me,
  selected people and a space, and the organization's membership for everyone), the subtext leads with the audience
  glyph and a bubble of initials for each of the first four people, then the rest as a "+n" bubble up to nine people or as "and n others" past nine, with no count after them (the line's tooltip says how many; `peopleEl`; `doc:taskMeta`
  sends those four and `peopleCount`, and reads the owners on demand, so they are let go like any read). Each bubble is
  an image named after its person; a guest, whose profile Tana does not let us read, is "Guest". The glyph then leaves
  the facts after the title. A table row, whose subtext is its cells, draws the same line (glyph, bubbles, the rest in
  words) in its icons at the end, whose column widens to 190px when any row has one, and the bare glyph for a row that names nobody. It is Display's Visible to fact, on unless switched off (a Display choice stored before it was its own fact shows it; off is stored as `novisibility`, views.js `withVisibility`), and never on the Timeline, which shows neither the glyph nor the faces (`displayKeys`).
  Everyone, only you and a space are the exception: the glyph and **Everyone**, **Private** or the space's name
  ("Space members" when Tana gives no title), no bubbles, since a bubble per member or your own face tells you nothing
  (`AUDIENCES` `word`, `audienceInfo`); the page's Visible to field says the same, and Lives in leaves the space out
  of a line that already leads with it.
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
  the point into the text's own box); a row that cannot answer a position takes the end. A list's own rows go through a
  selection first (below).
- **A list's own rows: select, then go in** (`topListRow`, `timelineRow`, renderer/nodes.js; render.js). A top-level
  row of a view (Inbox, Library, Types), a saved search or a type's page is a whole node, and so is a Timeline row
  about a node and a task or meeting listed under one, so a first click selects it (no caret; the
  blue ring a focused read-only row has, editable or not, in place of the selection's band, `.picked`; a ⇧ range made
  from it is a band again; ⌘K acts on it) and a click on the selected row goes in: on a row whose title can be typed in
  (`typesInto`) the caret lands where it was clicked, on one that cannot (read-only, a type, a canvas, every Timeline
  row) what it opens opens (`openSelectedRow`, renderer/select.js: a Timeline row the node it is about, a task under
  one the task itself). ↩ on the selected row does the same, Space opens it, and the bullet opens it at once (on the
  Timeline what the row is about, with ⌘/⇧/⌥ elsewhere). ⌘- and ⌥-click on a Timeline row still open it in a tab or
  floating at once. The box, the chevron, a chip, a link and a row's buttons answer their own clicks, and a row already
  being typed in takes clicks as text does. Notifications and Proposals keep their own click (it opens the row), and
  rows inside a document are typed into on the first click.
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
| ⌘↩ | Toggle done on a task, or a checkbox; a plain block becomes an unchecked checkbox in Tana's native structure, drawn with its bullet. |
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

**Markdown** (#598) becomes Tana's own structure and marks, never markdown characters in the text. Typed at the very
start of a row, the way "- " is: "* " a bullet, "# " to "### " a heading, "1. " numbered, "> " a quote, "\`\`\`" a code
block, "[] " or "[ ] " a checkbox, and "---" on a row with nothing else a divider after it (`lineMarker`, `restyle`);
the marker goes, the words stay, and a row already of that kind or a code block types it as text. Typed inline, the
mark lands the moment its closing delimiter does: \*\*bold\*\*, \*italic\*, ~~strike~~, \`code\`, [label](https://…) a
link (`typedMark`, `markTyped`), and the caret stays just past the marked words, outside them. A paste with more than
one line, a line marker or an inline mark (`looksMarkdown`) goes to main in one call (`api.pasteMarkdown`,
sdk/content.js `insertBlocks`): a row per line with words (a blank line only separates), headings, bullets and
numbered items nested by their indentation, "- [ ]" and "- [x]" checkboxes (and no other line gets one), quotes,
fenced code, dividers, the inline marks, and [label](tana:…) as a mention. Plain lines take the kind of the row pasted
into: in a list or quote they stay list or quote rows, in prose they are plain text, a plain line after a pasted list
included. "- " and "* " typed at the start of a
numbered row make it a bullet, as "1. " makes a bullet numbered. The
first line continues the row at the caret, what stood after the caret ends the last line, and one undo takes it all
back. A plain line, a draft row and a code block paste as text.

Mouse: a click on the bullet zooms into the row at once, on the chevron toggles it, on the checkbox toggles done. A
list's own rows are selected by a first click and gone into by the next (Rows, above).

### Toolbar, "/" and marks

Selecting text in a row shows a floating toolbar of marks and block styles (renderer/toolbar.js); the style menu
greys Text out for a child rather than offering a row that errors. "/" at the start of an empty row opens the "/"
menu (`slashRows`): the block types with Checklist after the lists (the checkbox ⌘↩ gives, #602), Divider, Table and
Image (also found by picture, photo, upload), then Doc, Task and the rest of what Create new … offers, workspace
types under their own heading. Task (`taskFromSlash`, #602) asks the task's name on a page of its own and the row
becomes a reference to the new task, as Tana's own "/" Task embeds one; Escape goes back to the menu. Choosing one
of the others opens a page that asks its name (“Name the new Project Task…”, issue #535): Enter creates it and opens
it, Escape goes back to the choices. The “/” menu in a row keeps drafting in place instead.

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
- **Draft documents in a list.** Enter on a collapsed document row in a view, or with nothing focused in an empty
  view, drafts a plain document below it (`draftDoc`); in a saved search of one type, a row of that type (issue #537); in a
  list grouped by Responsibility, a task in that row's section (below). A document drafted in a list is typed first and
  created once, with all its words, when it is left or Enter is pressed (`api.createDocument`): created on the first
  key, a saved search re-read and re-sorted around it mid-word and what followed was lost (issue #549). Escape or
  Backspace on an empty one throws it away; it stays right under the row it was drafted from whatever the sort
  (views.js `keepDrafts`).
- **A new task in a Responsibility section** (issue #548). Enter at the end of a task in My Tasks (or any list grouped
  by Responsibility) drafts a task under it in the same section (drag.js `groupDraft`), and creates it with what puts a
  task there: the same writes as a task dropped on that heading (`groupDropWrites`, #169) read off a new task, which
  starts open and yours. Unassigned takes you off, My inbox / Waiting / My later / My completed set the state, Pinned pins it to
  today. Agent opens the Assign to Agent prompt once it exists, and Tracking takes you off, watches it and opens the
  assignee picker for who you are waiting on. Assigned by others drafts nothing: only somebody else puts a task there.
- **`api.createDocument(title, { kind, typeUri? })`** makes a `doc` (plain, the default), a `task` (`stateType: 'open'`,
  assigned to you, with a workflow type when `typeUri` names one), a `meeting` (a `tana:event:` laid out like a
  Tana-native event, the next half hour by default, so it shows in Tana's calendar), a `chat`, a `search` (which must
  carry a `query`) or an instance of a workspace type (`custom`, with its `typeUri`; a type with a workflow makes an open task of yours, as
  Quick Add Task does, and its draft has a box, issue #534), and answers its Node.

### Undo and redo

⌘Z and ⇧⌘Z (built-in keys) first flush any pending text, then ask main (`api.undo`/`api.redo`): main keeps one
history across documents, each document a Loro UndoManager of local changes with one step per mutation call. The
browser's own contenteditable undo never runs (preventDefault), so undo never diverges from what was sent to Tana. The
affected document is reloaded and the caret placed in the affected row when it still exists. Delete and restore are
recorded in the same history and undone by repeating the native action. Sharing and move never enter it: their
audience disclosure and preview token are the gate (§14).

**Opening elsewhere** (issues #443, #608): ⌘ opens a place as a new tab in this pane (as browsers and Obsidian do), ⇧ in
a new pane beside this one (as Roam's and Logseq's sidebar), ⌥ in a new floating pane (renderer/palette.js `elsewhere` and
`openElsewhere`, which stores the place under the id main gives the new page, as ⇧⌘N does). In Cmd+K
and Cmd+S that is ⌘↩ / ⇧↩ / ⌥↩, or ⌘- / ⇧- / ⌥-click, on a row that opens a place (search results, saved searches, types, Today and This week:
rows with `opens`, an id or a function finding it), also when pressed before the search has answered; while an @ link
is being made ⌘↩ still creates. On the outline it is ⌘-click / ⇧-click / ⌥-click on a bullet, and ⌥-click on a
row that opens on a click (⌘- and ⇧-click there keep selecting rows; a Timeline row opens on ⌘-click too).

### Selection

⌘-click toggles a row in the selection; ⇧-click and ⇧↑/⇧↓ extend one anchored range over siblings (blocks within one
parent, or documents in a view). Selected rows take a square-cornered highlight and the caret leaves the text.
⇧↑ past the first sibling selects the parent row, which carries all its children; ⇧↓ with no sibling below selects the
row itself, children and all. ⇧↓ on a parent ⇧↑ climbed to gives back the selection it climbed from, so ⇧↓ undoes ⇧↑
step by step.
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
- **A canvas opens in a window of its own** (issue #611). A canvas is a tldraw board with no outline, and tldraw needs a
  licence Orbital does not have, so `openDoc` and `zoomTo` hand a `tana:canvas:` id to main (`api.openCanvas`,
  main.js `canvas:open`): a window on Tana's own page for it (`doc:link`), in the `persist:tana` session, with
  everything but tldraw's `.tl-container` hidden once the board is there. The page that asked stays where it was; the
  same canvas again brings its window forward. ⌘/⇧/⌥ on a canvas (`openElsewhere`) opens that window too rather than a
  pane, and signing out closes every canvas window. A canvas row's title cannot be typed in, so a click on it (or Enter)
  opens the window as a type row's does (`opensOnClick`), in a list, the Library and search alike.
  A new one comes from Cmd+K (issue #620): **New canvas** makes it at once under the name Tana gives one ("Canvas Sep
  30, 2026, 2:05 PM"), and **Canvas** under Create new … asks its name first; either writes what Tana's own create
  writes (sdk/node.js `initDocument`, kind `canvas`) and opens its window. The "/" menu leaves Canvas out: it drafts
  on the page, and a canvas has no page.
- **Back and Forward** (⌘[ and ⌘], the arrows at the top right) walk one history per page. Back with nothing to go back
  to does nothing: Home is the whole window, which one pane's Back does not replace (issue #444).
  When the page on screen is deleted or archived (here, in another pane or in Tana), the pane goes back to the page
  before it in its history, and the deleted page leaves both stacks; with nothing to go back to, it shows the Library
  (renderer/edit.js `leaveGonePage`).
- **Home** is the **Work View** by default (§16), or the window as it was when you chose Cmd+K "Set as Home"
  (`setHome`): its panes and what each shows, kept as the saved view "Home" (`HOME_VIEW`, listed under Saved views, where
  it is removed or, saved again under that name, replaced) and stored as `homeView` in the synced `home` preference. A
  page is at Home on the place that view keeps for it; removed, Home is the Work View again. A Library or saved search
  chosen as Home before still works, stored as its id (`library` or a `tana:search:` uri), and opens as a window of one
  pane on it, like every Home. Every route Home goes through
  `goHome`; Cmd+K "Go to Home" names it, and stays listed, disabled with "Current", where you already are. A Home whose saved search is gone from `api.searches()` falls back
  to the Library and the preference is repaired (`repairHome`), but only from a list that could have named it:
  `searchesLoaded` is set only by an answer that lands while connected.
- **Reopening where you left off.** `rememberPlace` stores `{ docId, nodeId, from, title, icon }` under `place` (per
  split side) in localStorage; a view with nothing zoomed is stored as `{}`, a place too. Main keeps a copy of each
  page's `view` and `place` in SQLite beside the layout (`page:place`), and preload fills a key localStorage no longer
  has from it: Chromium has lost a profile's localStorage whole, and every tab then opened on My Tasks (#636). Boot seeds the page from it
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

**Right-click** (or ⌃-click) on a row opens Cmd+K on that row: the caret goes where it was clicked and the row is the
Current node; on a row of a multi-selection the selection stays and Cmd+K acts on it (renderer/events.js `contextmenu`).

**In a window of several panes** (issue #409) the card and its scrim cover the whole window, centred over every pane,
and everything the palette does stays with the pane that opened it: its rows, the node it acts on, its keys and where the
caret goes back to. That holds for every page opened through `showPage` (⌘K and its pages, ⌘S, the key recorder); the
@ link search and the "/" menu belong to their spot in the pane and stay in it. How it is drawn: Panes below.

**Groups**, in order: Selection (with a multi-selection; the page's own rows follow as Current page) or Current node,
Table, Views (`VIEW_ORDER`: Timeline, Today, This week, Inbox, Notifications, Proposals, Library, Types),
Searches, Types, View options, Actions, Navigate, Window, Saved views, Settings, Help.

- **Current node** is the zoomed node or the row under the caret (with a selection, the Selection group counts what
  each row acts on and says "N skipped" for rows it cannot). Its rows follow `NODE_ROW_ORDER` (renderer/palette.js)
  whichever file builds them: the focused field's rows; Open node (the row under the caret, or the one selected row, opened as the mouse opens it: zoomed into, a reference's target, what a Timeline row or notification opens; absent on the page you are in and for a selection of several), Expand, Collapse; the task state (Complete/Reopen,
  Mark as read/unread, Approve/Reject proposal, Set status); who has it (Edit assignees, Assign to …, Discuss with …,
  Add to chat …);
  a meeting's Change time / location, Add attendee; when and where it lives (Pin to today / tomorrow / date …, Pin to
  current meeting, Pin to meeting …, Edit pins, Add to Today / Tomorrow / This Week, Move to …, Move to Library); what
  it is (Set type, Auto-pick type, Remove type, Add field, Edit fields); how it looks (Set icon, Set field icon, Set colour, Mark as
  sensitive); the agents (Assign to Agent, Go to <agent> task, Link <agent> task …, Open in <agent>, one of each for every agent that is on); Edit visibility, Add participants … (Edit
  visibility at its Select people step when the document may be shared with people, renderer/access.js `addParticipants`), Notify on changes,
  Copy link, Export to PDF; last Archive type and Delete. A read-only node shows Delete disabled.
- **View options**: the pills by what they do — Filter by type, Filter by meeting time (the When pill, meetings alone), Filter by status, Filter by assignee, Sort by, Group
  by, each hinting its value — then Clean up, Save as new search (a view with pills, as its Save as search pill; issue #538),
  Filter rows by text, Switch to table/outliner and Column widths ….
- **Actions**: Log in (signed out), Create new …, Quick Add Task, New canvas, Search Tana, Undo, Redo, Mark all as read, Sync.
- **Navigate**: Go back, Go forward, Go to Home, Set as Home, Focus graph (with a Graph pane, §18), Recently
  deleted, Archived types.
- **Window**: New window, New pane, New tab, New floating pane; with more than one page Next / Previous pane, Next / Previous
  tab, Maximize or restore pane, Show all panes, Zoom back / forward and Close pane (its chip ⌘W, the File menu's Close;
  panes change places by dragging a tab); Show/Hide graph (§18), Reload (the window: every pane), Save view…, Remove saved view (its choices also found from the command page).
- **Saved views** (issue #442): one row per view, the Work View first. A view is the window's layout (Trellis's
  document, `window:layout`, without its zoom: a view opens with every pane shown) and each page's view and place (`view`/`place`, `view:2`/`place:2`, …), under a name,
  in the synced `savedViews` preference. Save view… names the current one, or updates a saved view listed under
  it (narrowed by what is typed; its name and id kept, so Home and a recorded key still find it); choosing a row writes the places back and hands main the layout (`window:setLayout`), which saves it and reloads
  the window, so every page opens where it was saved. Remove saved view takes one off the list, any but the Work View, which is always listed (replaced, never removed).
  A page on your day node for today or your node for this week (known by id, found at Save view and never made: renderer/palette.js
  `saveView`) is saved as that (`{ today: true }`, `{ week: true }`) and opens on the day and week the view is opened in, the node found
  or made then as Cmd+K Today and This week do; Home counts such a page as Home on the page titled with today's date or this week (issue #639).
- **Settings**: Open settings (⌘,, the Settings window: §16), Larger / Smaller / Reset text size, Toggle dark mode, Toggle system dark/light mode (on out of the box, until a theme is chosen: #632), Edit hidden items,
  Toggle sensitive visibility, Toggle MCP chats, Toggle demo mode, Choose agents …, Connect to your OpenAI Dot …, ChatGPT sign-in, Set OpenAI API
  key (only while a key is stored). **Help**: Help, Install mobile app (hint "iPhone from TestFlight, Android coming soon": the Help tour opened on its last page, the
  choice of phone: the one place the phone apps are installed from), Open Manual (https://orbital.md/manual in the browser, in the page's theme: manual/, published there at each
  release), Check for updates (the app menu's Check for Updates…: a newer release opens the update card below, a dialog says up to date), and About Orbital: a page with the website and the licence as links, the big dependencies
  (Trellis, Electron, Loro) each opening its licence, then Good to know: the licence's main points and that Orbital is
  not affiliated with Tana (renderer/palette.js `openAboutPalette`, the same words as the README's License section).

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
the command page, or for a page opened from elsewhere, the page that opened it. The pages are described with their features: Set type, Auto-pick type, Set icon, Set colour,
Discuss with (§11); Edit pins, Pin to date, Pin to meeting (§9); Recently deleted, Archived types (§14); Change time /
location, Add attendee ([MEETINGS.md](MEETINGS.md)); the agent pages (renderer/agent.js, §11).

### Built-in keys and the recorder

Every command row has a stable `id`, and a key is a row with a combo. The built-in keys are rows with a default in
`DEFAULT_HOTKEYS` (renderer/state.js), which a recorded combo overrides and Reset restores:

| Row | Default |
|---|---|
| Quick Add Task | ⇧⌘Space |
| Search Tana | ⌘S |
| Filter rows by text | ⌘F |
| Copy link | ⌘C |
| Go back / Go forward | ⌘[ / ⌘] |
| Undo / Redo | ⌘Z / ⇧⌘Z |
| Expand / Collapse | ⌘↓ / ⌘↑ |
| Complete / Reopen | ⌘↩ |
| Today | ⌃⇧D |
| Reload (the window, every pane) | ⌘R |
| Go to Home | ⇧⌘H |
| New window | ⌃⌘N |
| New tab / New pane (to the right) / New floating pane | ⌘N / ⇧⌘N / ⌥⌘N (the modifiers that open a link there) |
| Next / Previous pane | ⌘/ / ⇧⌘/ |
| Next / Previous tab | ⇧⌘] / ⇧⌘[ |
| Maximize or restore pane | ⌥⌘↓ |
| Show all panes | ⌥⌘↑ |
| Zoom back / forward | ⌥⌘[ / ⌥⌘] |
| Close pane | ⌘W (the File menu) |

The pane keys are Orbital's own, kept off what a row types (Trellis's defaults, ⌥⌘←/→ and ⇧⌘↩, move the caret or
break the line there). While a window has more than one page they are taken before a row's own keydown (a capture
listener in renderer/palette.js), so a recorded one wins too; a page alone leaves them to the row. A function key (F6)
is a valid combo on its own.

The document keydown handler finds the row by combo (`hotkeyFor`/`hotkeyIds`) and runs it through `runAction`; with
the palette closed the current node is whatever is focused, and a row that opens a folded level asks for its choices
at the press. A key the focused row already answered (⌘↑, ⌘↩) arrives defaultPrevented and is not run twice; a row
absent right now leaves its key alone, and a disabled one answers it by doing nothing. A read-only row passes every ⌘
combo to the document handler. A command that reveals a field and focuses it (Filter rows by text) shows the field
itself, since a render is deferred while the caret is in a row.
The pane keys are Trellis's commands, run by the shell (Panes below); their defaults stay off what a row's own
keydown answers to (⌥⌘←/→ move the caret at a line's edge, ⇧⌘↩ breaks the line), and a bracket or \\ is read by the
key pressed (`comboOf`'s `KEYCODES`), since ⌥ and ⇧ change the character it types.

⇧⌘K on the highlighted row opens the recorder: "Recording keyboard shortcut for: <row>", the pressed keys as symbols
with a red dot, Reset / Cancel / Save. Combos are stored in the synced `hotkeys` preference (row id → combo) and shown
as a chip on the row. A combo must include ⌘ or ⌃. Fixed and refused: ⌘K, ⇧⌘K, the text-size keys (⌘0, ⇧⌘+/-,
shown as literal chips), ⇧⌘⌫ and ⇧⌘↑/↓ (`RESERVED`, renderer/palette.js), and any combo another row has; the reason
is shown (⌃ counts as ⌘, ⌥ is ignored for the fixed ones). Sync has no default key.
While the highlighted Cmd+K row is one ⇧⌘K can record for (it has an id), the field's right end says "⇧⌘K Set key" in
muted grey (renderer/palette.js `keyHint`); on any other row, and on every other page, it is not drawn.

### Cmd+S search

The same card with one list: "Search Tana", `api.search` debounced 150 ms (stale answers ignored), rows with icon,
title, chips and grey meta; "No results" for an empty answer. From four characters on, documents only Tana's semantic
search found follow under "Related" in its order (issue #20). `#task`, `#meeting`, `#member` and `#<type name>`
tokens anywhere in the query become filters (an unknown type gives no results); an event's meta shows its date. A
query with a filter lists newest first: `#meeting` by the meeting's start time, any other by when the node was made
(sdk/query.js `searchParams`), and the title re-sort below keeps that order among equals.
Tana's order does not weigh the title, so `searchNow` re-sorts by `titleHits`: most typed words in the title first
(filter tokens left out), then most that begin a word, then Tana's order; only those words are bold. Enter opens the
result wherever it lives. ⌘S toggles it and opening one palette closes the other. An empty query shows Recently
viewed.

## 9. Pins and dates

Pins are stored as [PINNING.md](PINNING.md) describes; this is what the outliner does with them.

- **The pin mark.** A pinned node carries the tack in its facts (`pinned`, build/icons/pin-tack.svg); Cmd+K Edit pins
  says where it is pinned. What a row knows comes from one `api.pinIds()` read (`pinnedIds`/`isPinned`/`loadPinned`,
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
Created, Title, and Meeting time where meetings are the only kind (the event's start, running the way the When pill's
window does: soonest first for Upcoming and Today, latest first otherwise); Group None, Status, Assignee, Responsibility, Updated, Type;
Display chooses the facts a row shows. Each is kept per page key in the synced `groupBy`, `sortBy` and `display`
preferences; a saved search keeps its own in its document. Group by Updated sorts rows into Last hour, Last day, Last
week, Last month and Older.
Each also offers the page's fields (issue #624): a one-type page its type's own, a mixed list those of the types on
it, one per name as Group has them (`pageFieldDefs`), under a small "Type fields" heading (`fieldSection`); Group
only the ones with a closed set of values. Sort on a field goes by its first value: a date by its day, anything else
as words with numbers read as numbers (`fieldSortKey`), rows without a value last. All three menus have a search
line, as a link field's has; typing narrows them.
A saved search or a type’s page draws its rows twenty at a time (`capRows`, renderer/views.js): the first twenty in
the order shown, sorted and grouped over the whole answer, then twenty more each time “Show 20 more” at its end comes within a
screen of view (or is clicked). Only a drawn row asks for its metadata, translation and fields. The list itself is
still one query: Tana’s list takes no sort and returns no next page, so fetching twenty at a time would draw the
wrong twenty.

- **Folding a section.** On any grouped page the heading is a `button.ghead` with `aria-expanded` and a disclosure
  triangle drawn from it in CSS. A click, or Enter/Space on it, folds that section alone; its rows leave
  `pageRows().list`, so the keyboard never walks into rows nobody can see, and its `mousedown` is swallowed so folding
  cannot take a selection away. The folded set is `collapsedGroups` (renderer/state.js), the synced
  `collapsedGroups` preference written by `toggleGroup`: each entry is page key, grouping and section key joined by
  newlines — the page key a view id or a saved search's id, the section key the heading's words only where they are
  fixed (Status, Updated, Responsibility), a member uri or a type uri otherwise. Only folded sections are stored.
- **Responsibility sections** run Pinned, Unassigned, Agent, My inbox, Mine, Waiting, Tracking, My later, My completed,
  Assigned by others (`RESPONSIBILITY`, renderer/views.js; the phone's ios/engine/arrange.js keeps the same order).
  Waiting holds your own tasks set to Waiting — your part done, the next step someone else's — and takes a waiting
  task from Pinned too, since it is not today's to do.
- **Waiting** is the app's fifth status (Set status to Waiting, the Waiting section, a drop on it). Tana has only its
  four, so a waiting task is Tana's In Progress in the workspace's one Waiting workflow, with the one state "Waiting"
  (main/settings.js `waitingWorkflow`: its id computed from the workspace's, its state's id fixed, so every Orbital user
  in the workspace shares it; main/documents.js `waitingState` makes it in the Library the first time the index has
  none; `stateName` reads a task back for the Mac and the phone). Tana keeps it, but its web app
  shows such a task as In Progress and offers only its four (2026-10-02); choosing one there clears Waiting. The Status
  filter leaves it out (to a search it is In Progress), and Today's Tasks leaves waiting tasks out.
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
- **Auto-pick type** (`classifyType`) lets the model choose from the same list. Main reads each selectable type's own
  document for its `description` and `instructions` (`typeCandidates`, main/documents.js) and sends them, numbered,
  with the document's title and text (a meeting's calendar description in place of its empty content) to
  `ai.classifyType` (main/ai.js), which answers the odds of every option, No type among them, most likely first:
  `{ current, choices: [{ uri | null, title, hue, p }] }`. While it reads the page says "Reading the document…" under
  the breathing sparkle. At 80% or more (`CLASSIFY_SURE`) for a type, it is set at once, the palette closes and a note
  says "Type set to Decision Record (91%)" ("Already …" and no write when it has it). Otherwise the page lists every
  option with its odds. No type is never applied on its own. `node scripts/platform-cli.js classify <id...>` prints the
  odds and writes nothing; a type's description and AI instructions in Tana are how its answers improve.
- **Set icon** (`setIcon`, on a type, a saved search (#521) or a document that is not a task) gives a document its own glyph,
  worn instead of its type's (main/rows.js `plainRow`, renderer/nodes.js `iconOf`), gives a saved search a glyph of its own (its row, its page,
  its line under Searches in Cmd+K; No icon puts the magnifier back), and gives the type a glyph that every document of that type is then drawn with —
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
- **Set field icon** (`setFieldIcon`, #606) is Set icon for one field of a type, offered with the caret on the field:
  a choice value, a row of a text or date value, or its definition on the type's page (renderer/fields.js
  `palFieldKey`). The same page and the same write, stored in `typeIcons` under the field's own key
  (`<type uri>?attribute=<key>`), so it belongs to the type and every document of it shows the field with that glyph:
  the field row under the title, the definition under Edit fields and the field's filter pill (`fieldGlyph`,
  renderer/nodes.js). The boot AI pick fills fields as it fills types: every titled field with no choice yet goes to
  the model as "Type › Field" in the same one call (`autoTypeIcons`, main.js), and **No icon** is kept the same way.
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
- **The model.** `main/ai.js` is the only place the app talks to a model. Sign in with ChatGPT (Cmd+K Sign in
  with ChatGPT / Sign out of ChatGPT, with the account status) is the way in (issue #669). An OpenAI API key stored before
  then still works as the fallback, and Cmd+K offers **Set OpenAI API key** only while one is stored: an empty field on
  that page clears it, and the row goes. Both stay on this machine. ChatGPT sign-in uses the Codex app-server in its own auth directory
  under userData, separate from the user's Codex login, from this Mac's `codex` (`codexBin` in main/agents/codex.js) or,
  failing that, a standalone `codex-app-server` downloaded on first sign-in and kept only when `codesign` shows
  OpenAI's Developer ID. Two synced choices, each a model and an effort (main/settings.js AI_KEYS): the Quick AI (`aiQuickModel`,
  `aiQuickEffort`) for Auto-translate, Discuss with, Auto-pick type and the icon pick, and the Regular AI (`aiModel`,
  `aiEffort`) for reading an image, starting on `gpt-6-luna` at low and `gpt-5.6-terra` at low (main/ai.js QUICK_MODEL, DEFAULT_MODEL), set in the Settings window.
- **The agents** (main/agent.js, main/agents/, renderer/agent.js, issue #669). Each agent is a plugin in main/agents/:
  **Tana** (always on, and the default on a fresh install: a task is a new Tana chat with the request and the node
  attached, answered by Tana's AI, and its badge opens the chat here), **Codex** (a Codex task on this Mac, through
  Codex's app-server), **Claude** (a `claude -p` session of the user's own Claude Code, with its own sign-in;
  Orbital never signs in to Anthropic) and every agent linked through orbital.md/mcp, your Dot among them (below). Codex and
  Claude are offered only once this Mac has them. **Choose agents …** (Settings) lists them, greyed with what to install
  when missing: ↩ switches one on or off; **Set default agent …** picks the **default agent** on a page of its own. Both
  follow you (`agents`, `defaultAgent`); unset is Tana and Codex on, Tana the default.
  **Connect to your OpenAI Dot …** (Settings, and under the linked agents in Choose agents) links your Dot through the MCP
  server orbital.md/mcp: where to add it and Tana's in ChatGPT (Open ChatGPT plugins, then each server's name with its
  URL, ↩ copies it), then a message carrying a one-time code that links it by its own name (Dot if it has none), makes it the default
  agent, and subscribes it to the task.assigned
  event (a node handed to it is that event: the node's id, the request and how to handle it, nothing of the request
  written into the node, which the Dot reads as content; its badge follows the node's last line, "Agent status: Assigned |
  Working | Completed | Failed": Orbital writes Assigned, grey until the Dot changes it to Working as it starts); each linked agent is one more agent,
  listed with the other agents in Choose agents, with a page of its own (Rename …, Switch off, Unlink); **Set default agent …** picks the default on a page of its own, and **Reset agent link key** makes a new key for your Orbital at orbital.md (docs/AGENT-RELAY.md).
  **Assign to Agent** asks what the agent should do (a prompt page, with the agents that are on listed under it and the
  default ticked; beside it **Assign to <agent> …** for each agent that is on, Assign to Codex …, Assign to Echo …, opens
  the same page with that agent picked) and hands the node over; the agent's own default model does the work. The node then carries the agent
  badge, which says what the task is doing, read every 30 s while anything is assigned; a Claude task, whose session
  lives only on the Mac that ran it, names that Mac in its link and reads **Agent on another Mac** (grey, not a button)
  anywhere else, where assigning starts a new one (main/agent.js `elsewhere`). Assign to Agent stays offered on a node an agent already has:
  handing it over again replaces the request in its Agent context block. **Unassign from Agent** takes it back at once,
  and takes the Agent context block (with its status line) out of the node again. **Go to <agent> task** opens it (Codex
  in Codex, Claude in Terminal on `claude --resume`, Tana's chat here; not offered for a Dot, whose task lives in ChatGPT, and its
  badge is no button). The Timeline's task rows carry the badge too, in line after the title; its lines about what happened do not, **Link <agent> task …** links a task that already exists, and **Open in <agent>** opens a new task with the
  node's link and tracks nothing. Codex and Claude tasks run on this Mac, Tana's in Tana, and a Dot's in ChatGPT.

- **Auto-translate** (issue #547): off until Cmd+K **Auto-translate …** (Settings) picks the language notes are shown in
  (English, Dutch, German, French or Spanish; a synced preference, `translateTo`). Then a note in another language is
  shown translated, on screen only. Which language a text is in is decided on this Mac, not by the model: Apple's
  NaturalLanguage (main/ai.js `detectLanguages`, through osascript, about 0.3 s for a whole page and no tokens); only a
  text it is at least 60% sure is in another language goes to the model, and the rest is kept as having nothing to
  translate (a names-only title like "Martijn - Andre" is too unsure to send). Only titles of top-level nodes are
  translated, never a node's content: a zoomed document's title, and a document's title as a row in a list; its blocks
  and children stay as written. Everything a render wants is asked in one question (`api.translate`, main/ai.js
  `translate`, up to ~20k characters, with 90 s to answer). A translated page title has one grey line under it, a
  sparkle and "Translated from Dutch · Show original", which switches it back and forth. In a list, a document whose title is in another language shows the
  translated title and "Translated from Dutch" as the first fact of its grey line; a click there switches that row.
  Cmd+K **Replace with translation** (Current node, where the title may be edited) writes the translation the title
  is shown in as its title (`setTitle`), for good (renderer/translate.js `replaceWithTranslation`).
  Cmd+K **Translate into …** (the Auto-translate language, English while that is off) writes a translation for good into
  the selection, else the row the caret is in, else the zoomed page: a document's title (`setTitle`) and a block's text
  (`setText`), in one question (`api.translate`, cache and on-device detection included). Only plain text that may be
  edited is offered (a mention, link or mark would not survive); what is in the language already is left alone, and a
  note says how many were translated (renderer/translate.js `translateNodes`).
  A row of the app's own that names a node (a Timeline meeting, "Kevin completed <task>", a notification's title: the
  one segment marked `content`) has only that name translated, the sentence around it kept, and says so the same way.
  Nothing is written: the caret going into a translated row or title shows its own words first, so an edit is made in,
  and saves, the original — only where it can be typed in: a read-only row (the Timeline, a notification, a reference)
  keeps its translation when clicked, so the first click opens it (renderer/translate.js focusin). Leaving an edited row
  While a title is typed in, its notice says so: the page line reads "Original, in Dutch · Show translation" (the
  button leaves the title, which shows the translation again) and a list row's first fact "Original, in Dutch".
  shows the translation again (an edited text is asked for, and lands in the row
  when the answer does, wherever the caret is by then). Turning it on or changing the language takes effect at once,
  in every pane. Only plain text is asked (a mention, a link or a mark would not survive), never a sensitive
  node's words; demo mode translates as well and masks the translated words like any other, so its "Translated from …" notices stay; the model answers null for what is in the language already, and an answer that hands the text back unchanged counts as null
  too, whatever language it names. Answers are kept
  on this machine under a SHA-256 of the language and the exact text (db.js `translations`), so a note seen before shows
  translated at once, in any pane or launch, and an edited text is a new key: asked again. An answer lasts a month from
  when it was last shown; one not shown for 30 days is asked again and is cleaned out on the next save or start (at
  most 5000 kept, least recently shown out first). A batch is asked in two steps: this Mac's answers first (`{ local: true }`: kept
  answers and what it finds already in the language, which settles most of a page at once), then the model for the rest.
  While the model has a text the page line (or a list row's first fact) says "Translating…" with the sparkle at
  work, shown only after 0.4 s and taking no room until then, so an answer from the cache or a text found already in the language never moves the row (renderer/translate.js, styles.css). Measured 2026-09-28 through a
  ChatGPT sign-in: about 4.5 s for a first question, well under 1 ms once kept.
  Push notifications are translated the same way before they are shown (main.js `S.notify`: title, subtitle and body
  in one question, never a sensitive node's, and the banner as written when no answer comes within 15 s).

## 12. Fields and tables

### Fields

A zoomed node shows its typed fields between the title and the outline (`#fields` in `main.scroll`, so they scroll
with the content), from `api.related(docId).fields` (`[{ key, label, text, lines, segments, type, cardinality,
options, to }]`, read from the type document on every call, main/related.js `fieldDefs`). Fields are Tana
attributes: the value lives in the node's data map, the label in its type's template (sdk/fields.js). An expanded
document shows its fields above its body children too, read with `api.related(docId, { lite: true })`: its fields,
a type's definitions, its meeting and call link, none of the sidebar's pins, backlinks or history, which the page on
screen reads whole over it (#579: a list opening sixty rows asked ~120 ListEdges in a second).

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
- **A list's or the Timeline's row is picked up anywhere on it** (`.selectfirst`, render.js; styles.css). Until it is
  selected such a row is one thing to press (Rows, above), so its whole line is `draggable` and its words take no
  press of their own (`pointer-events: none`, a link or chip in them excepted): a press neither focuses them nor
  puts a caret in them, and is left undefaulted so Chromium can start the drag from it. Selected and editable, or typed
  in, the line stops being draggable on the next press, and a drag across the words selects them.
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
  closes. A drop back where the row was writes nothing. A multi-row selection is not moved by a drag (⇧⌘↑/↓ and Tab
  move it); it travels whole only to a chat's composer (below).
- **A drop on a chat's composer** (renderer/chat.js) writes nothing: it puts the dragged rows into the message where
  they are dropped. A document, or a row that references one, becomes a chip; any other row, which has no uri to
  point at, is pasted as its words (marks dropped, its mentions kept as chips). Grabbing a row that is part of a
  selection brings the whole selection, in outline order. The rows ride in their own dataTransfer flavour
  (`application/x-orbital-nodes`, drag.js `dragSegs`), so the composer of another pane takes them too.
- **A drop on a meeting pins to it** (issue #520): a meeting's row (on the Timeline, under Upcoming meetings, in a view)
  takes the dragged nodes as pins, the write ⌘K Pin to meeting … makes, and says "Pinned to …". The row is ringed while a
  drop there would pin. Only rows that are a node (a document, or a reference to one) are pinned, from either pane, and
  only where no outline place is under the pointer, so a meeting's row inside a page stays a place to land beside.
- **A dragged document leaves a reference.** A row in a view or a saved search is a document, which cannot move into an
  outline, so it lands as one block whose whole content is a mention of it (`insertMention` → `block:insertMention` →
  `referenceIn`), drawn as the node itself (§5). The rows of a view cannot be reordered (their order is the query's),
  so a drop between them is not offered. A reference may cross documents, never lands in the document it points at,
  and what was picked up decides the write: a document is always referenced and a block always moved, with no
  modifier key.
- **A task dropped on a group changes what it is** (#169). In a view grouped by Responsibility, and on the Timeline's
  Today's Tasks, a drop between rows is a drop on the section under the pointer (its heading outlined, `groupAt`) or
  the Today block. The writes are read off the task as it stands (`groupDropWrites`, in the order `responsibilityOf`
  reads them), and a task dragged from another pane, whose dataTransfer carries
  `application/x-orbital-task`, lands the same way:

  | Drop into | Writes | Refused |
  |---|---|---|
  | Unassigned | Off the agent, every day pin removed, no assignees | a task you did not make |
  | Tracking | Off the agent, every day pin removed, watched | unless you made it and it is someone else's |
  | Agent | the Assign to Agent prompt; nothing until it is sent | — |
  | My inbox, Mine, Waiting, My completed, My later | Off the agent, every day pin removed, you as the only assignee, the status; a watch on a task you were not assigned is forgotten | a task you did not make |
  | Pinned | Off the agent, pinned to today unless pinned to a day already; a completed task reopens, one in the Inbox or Waiting is In Progress | — |
  | Assigned by others | — | always: it is about who made it |
  | Today's Tasks | Pinned to today unless it is on Today already; one in the Inbox or Waiting is In Progress, where its status may be changed (a read-only one is pinned only) | anything but a task |

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
  audience (inherit needs the current `sharingToken`), and opens the people picker directly when set to selected people. The people who can already see the node lead that picker, in the order it opened with, so ticking a row does not move it.
  Move to … checks source and target write access, descendant cycles, typed-document home-space rules, type-instance
  counts and the audience before and after, and `moveToSpace` requires the exact preview token whenever the audience
  would change. Ownership is a location boundary, never a write grant; unknown or inherited access stays unavailable,
  and unsupported cases stay disabled rather than guessed. The Library is a move target: moving there removes
  `ownerUri`; a type still has to live in a space. An ACL-change error clears the cached options and reloads them.
  Neither enters the undo stack.
- **Copy link** (`copyLink`) copies the node's home.tana.inc url, which takes the route Tana's own resolver picks for
  the kind: `/t/` a type, `/u/` a person, `/e/` a meeting, `/s/` a space, `/l/` every other document (issue #88).
  On a Timeline row (under the caret, right-clicked, or the one selected) it is the link of the node the row is
  about — the meeting, the task someone completed — since the row is the Timeline's own (renderer/timeline.js
  `timelineUriAt`).
  **Open in Tana** (`openInTana`, the Tana glyph) opens that url in Tana's web app, and on a meeting or its write-up
  **Join call** (`joinCall`, `callRow`) opens its call link, the readable link as the row's hint.

## 15. Live updates and rendering

- **`onChanged(docId, info)`** is one document's change. The renderer patches that row from one `doc:info` call
  (`patchDoc`) wherever it is listed — views, zoomed lists in `kids`, the extras — and its copies (`patchCopies`:
  reference rows and sidebar rows of any document; reading an outline subscribes the targets of its references as
  on-demand reads, so a rename reaches them, #413), and
  reloads its page and fields when open. It keeps the row's cached metadata unless `info.meta` is true (main compares
  assignees, restriction, participants, type and field values), and re-reads the sidebar only then (or for a type).
  **`own: true`** is the echo of text this page typed (`sendChanged` sends it to the writing page only, #265): the
  words are on screen, so only the row copies are patched and nothing is re-read or force-rendered; every other page,
  another pane of the window included, hears a plain change. A document no view lists reloads the roots.
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
nothing about them as documents. Each is a place the app remembers, so ⌘R on one reloads onto it. Settings is not one:
it is a window of its own (below), and a pane or Recent that an older version left on `orbital:settings` lets go of it
at load (renderer/edit.js), so nothing asks Tana for that id.

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
  Its task rows show their box and assignee and nothing else, whatever any view's Display chose (`displayKeys`): the
  page has no Display pill, and borrowing the last list view's made them change with it.
  - **Now**: first **Today's Tasks** (tasks-2 icon): incomplete tasks pinned to today or earlier, except those set to
    Waiting (one set to Waiting while the page is open reads the page again, renderer/app.js `patchDoc`, so it leaves
    at once), and completed ones
    pinned to today, future pins excluded, then the tasks on today's node (the `YYYY-MM-DD` document, found and never
    made here: the tasks its outline references, as a full reference (Tana's `embed` block or a line that is one
    mention) or among words, done ones included; reading it keeps it live, so a change to it reads the page again); with none, "All done - Add more", where Add more opens a search of your
    open tasks and pins the choice to today. Then the **free time** before the next meeting (a content face, eyes closed): "No meetings
    for **44 more minutes**" ("1 hour and 20 more minutes", "2 more hours"), or during a meeting the gap after it ("No meetings for **30 minutes**
    after this one"), counted down every 15
    seconds in the renderer and gone when the meetings touch or overlap. Then, when any are left, **Upcoming meetings**: today's meetings still to
    start, earliest first, each with its time and who else is on it ("14:00–15:00 · Jeroen Oostewechel"), opening the
    meeting. A meeting still to come, or under way on the timeline, has the Tana glyph after its title ("Join in
    Tana"), which opens it in Tana (`row.join` through `doc:link`). One timer per read, a second after the next start
    or end (`startTimer`), re-reads the page. A meeting under way whose call is on the record has a blue marker with a
    blue ring pulsing out of it (`.tl-recording`; the ring stays still under reduced motion): somebody is in the call and it
    is transcribed (`data.transcriptionPaused` not set), or a video recording runs (Tana's activeRecording, an entry in the call's
    `recordings` with status `recording`; a Tana Meet call is transcribed without one), read from the `tana:call:` documents those meetings own, which a live query
    finds and main keeps live, so the mark comes and goes as people join and leave and the call goes on or off the record (main/timeline.js
    `watchCalls`). A rule separates these blocks from the history (16px above, 8px below).
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
    end of today (`watchMeetings`) re-reads the page when one is added, gone, renamed or moved. The tasks you add yourself
    for yourself are one such line too, "You added 2 tasks" (no "to your Inbox": a task made by hand is usually In
    Progress already), never marked new; a task you add for someone else is not listed as added (only tasks assigned to
    you are), though what they do with it still shows. Changes only you made and anything older than the page's days stay out.
  - A blue dot marks what came after your last visit; opening an entry goes to its node. The page opens on today and
    the two days before, and reads three days further back when its end comes within a screen (an
    IntersectionObserver on "Show three more days", which also works pressed and reads "Loading…"), up to 120 pages
    (`setPages`); a page too short to scroll keeps reading until it fills the screen. Watched nodes last updated before
- **Settings** (issue #672; settings.html, settings.js, settings.css). A window of its own, as a Mac app's settings
  are (main.js `openSettings`): opened by Cmd+K **Open settings** (first under Settings), its key ⌘, (`DEFAULT_HOTKEYS`,
  recordable; renderer/settings.js asks main over `settings:open`) and the app menu's **Settings…** (main.js `createMenu`,
  which shows ⌘, and opens the window itself). One at a time: asked again, the open one comes forward. 600px wide, not
  resizable, minimisable or zoomable, closed with ⌘W; the window takes the height of the tab it shows (`settings:size`,
  from its own page only, animated once it is on screen). The title bar is the page's (`hiddenInset`, the traffic lights
  inset at 18,13): the tab's name as the title, then a toolbar of four tabs, a grey glyph over a label, the one you are on
  tinted with the accent and remembered on this Mac (localStorage `settingsTab`). Under it, groups of rows, each a grey
  glyph, a label with a grey line under it, and its control at the right, in macOS's sizes: a segmented control, pop-up
  buttons (their menu is macOS's own), push buttons and switches.
  - **General**: Theme (Light, Dark, System), Auto-translate (Off or a language) and a footnote on what syncs.
  - **AI**: the ChatGPT sign-in (Sign In… opens the browser and shows the code to enter, with Copy Code and Cancel; Sign
    Out), the OpenAI API key only while one is stored (Remove), both **On this Mac**; the Quick and the Regular AI, a model
    and its thinking each (the synced settings.AI_KEYS over `ai:options`/`ai:setOption`, which take only main/ai.js's own lists).
  - **Agents**: a switch per agent (Tana always on; one not installed greyed with what to install, still switchable off if
    another Mac switched it on) and the default agent.
  - **Lists**: the hidden titles as a list with + and − under it (+ and a title hides it, − or ⌫ on the selected one unhides
    it) and Show MCP chats.
  Every control makes the call its Cmd+K row makes, so a choice made there and one made here are the same write. Main
  sends the window what it sends the pages (main/state.js `send`, main/settings.js `tellOthers`): a setting changed in a
  page, another window or another Mac reads the window again, and only the newest answer for each part lands (`load`).
  A redraw gives the keyboard back to the control that had it. Demo mode (this Mac's, from localStorage) masks the
  email and the hidden titles with renderer/segments.js. Text size, shortcuts, the sensitive eye and demo mode keep
  their own keys and rows and are not in it, and neither is Home, which ⌘K Set as Home sets where you stand.

### Chats

An open `tana:chat:` is a conversation in the Codex app's style, drawn by renderer/chat.js from the rows sdk/chat.js
`chatRows` makes (docs/CHATS.md §8), in list order with the newest at the bottom: yours (`row.chat.mine`) in a light
blue bubble on the right (a deep blue in dark mode), Tana's and anyone else's as plain text across the page. The
conversation fades out at the top, under the header, and into the composer at the bottom (a mask on the scroll area). Who
said it heads each run of replies, in bold: a person, Tana AI or Codex. The markdown blocks keep their kind (headings, bullets, numbered items, quotes,
code), mentions and attachments are links that open their node, the thinking line or an error sits in grey above the
answer, and hovering a message shows when it was sent. The page opens at its end and follows new messages while you
are within 80 px of it; a short conversation sits at the bottom of the pane.

Under it is the composer (`#composer`, a rounded card whose textarea grows with its text and whose round blue button
sends), the pane's last row outside the scroll, so it stays at the bottom whatever the conversation's length or
scroll: Enter sends (`chat:send`, main/documents.js `sendChat`), Shift+Enter is a new line, and Escape leaves it.
**@** opens the link search as a dropdown at the caret and puts the node picked (or created) in as a chip (a pasted Tana link, home.tana.inc or a bare uri, becomes that node's chip too, as it becomes a reference in a row), with
**Tana** offered first while what is typed fits it: mentioned, Tana answers in a chat with other people in it, where a
message is otherwise only for them; **/** as the
first thing typed opens a page of the workspace's skills (`searchPreview` over the skills kind), and the one picked sits
as a pill in front of the text (Backspace at the start or a click drops it) and goes with the message as its
attachment. Chips are sent as `[label](tana:…)` links. A message goes **To Tana** (Tana is asked to
answer) or **To the chat** (a message for the people in it), which the empty message's placeholder says; it starts at what the chat does by itself, and Tab in an
empty message switches it. Picking a skill switches to To Tana, and it stays there while the skill is attached. The field is a `contenteditable` of plain text and chips
(renderSegs/readSegs); ⌘Z and the other editing keys stay its own rather than reaching the outline. What is typed and not sent is kept per chat while the window is open.
Opening a chat puts the caret in it. After a send, three dots stand where the answer will be until Tana's answer begins (two minutes
at most); the answer streams in as live changes to the chat, and a message Tana is still writing with no words yet
shows the dots in its place. A failed send puts the words back. **@Codex** (offered after Tana in "@") asks a Codex task on this Mac instead, and nothing of it reaches Tana: the question shows on your side in a grey bubble where it was asked, "@Codex" in bold, and the answer under it on the other side as a reply, in grey text, with dots until it arrives; each carries the cloud-slash glyph (as a badge on the top-right corner of the question’s bubble, and plain after Codex’s name over the answer) whose tooltip says it is only visible for you, on this device; **Add to message** on Codex’s name line (once the answer is in), Enter on the answer, or Cmd+K **Add Codex’s answer to message**, adds it to the message box to send as your own words (docs/CHATS.md §12). The questions and answers are kept on this Mac, so they are there again after a restart. **By keyboard**: ↑ at the very start of the message box selects the newest message, and ↑↓ with nothing focused go on from the selected message or, with none, select the lowest (↑) or highest (↓) message in view; ↑↓ walk the messages (a focus ring on the bubble, or around a message without one), ↓ past the last or Esc goes back to the box, Enter on a Codex answer adds it to the message box, and ⇧⌘⌫ or Cmd+K **Delete message** deletes the selected message when it is yours: your own message in the chat for everyone, as Tana's Delete message does (`chat:delete`), or a Codex question with its answer from this Mac (`chatAgent:delete`). The selection survives a redraw. With a message selected, Cmd+K opens with that message's own rows under **Message** at the top (Delete message; for a Codex question or answer also Add … answer to message and Open … task), and nothing that acts on the chat document itself (the Current node rows: pins, link, visibility, move, delete, export) is offered, nor does a recorded key for one of them act; with none selected, Add … answer and Open … task act on the latest ask, under Actions. **New chat** (Cmd+K, Actions) makes a chat with
Tana that is yours alone (`chat:new`) and opens it.
**Add to chat …** (Cmd+K, `addToChat`, on the row under the caret, the zoomed node or a selection: "Add 3 items to chat …") opens a page with **New chat** and the chats, last changed first, and puts references to them at the start of the picked chat's message: the same ones dragging the rows onto it makes (a document or a reference as a chip, a block's words as text), the message's own words on the line after them and the caret back where it was in them; an empty message just gets them, the caret after. A chat another pane of the window shows is brought into view there (its tab selected) and takes the keys (shell.js `addToChat`); any other chat, and a new one, opens in the pane the row ran in.

When Tana's AI asks questions (`row.chat.questions`, docs/CHATS.md §11), the composer gives way to a question card
like Codex's (`#chatQuestion`): one question at a time with "‹ 2 of 3 ›", its options numbered with the highlighted one on
a grey band, "Select all that apply" and ticks for a multiple choice, the last row a free answer ("No, and tell Tana what to
do differently"), then Dismiss (esc) and Continue (↩), Submit on the last. ↑↓ move, 1–9 pick, Space ticks, ↩ continues
(taking the highlighted option when nothing is picked), ←→ step between questions, Esc dismisses (Tana goes on with
defaults). Submitting writes the answers (`chat:answer`) and Tana goes on. **Invite to chat…** (Cmd+K on a chat) lists
the workspace's members; the one picked joins the chat as an editor (`chat:invite`), and "<name> was added to the
chat." shows as a centred status line, as other status lines do. **New chat with …** (Cmd+K, anywhere) lists the
same members: a new chat opens, yours alone until then, and the one picked is invited to it, so it is visible to the
two of you; a refused invite says why over the open chat (renderer/chat.js `newChatWith`: `chat:new`, open, then `chat:invite`).

### Work View, windows and panes

- **Work View** (`workView`, renderer/timeline.js; the default Home): the Timeline on the left and My Tasks on the
  right (`api.myTasks`: the search the synced `myTasks` setting names, so a rename in Tana keeps it; else your own
  saved search called My Tasks, the oldest if two machines each made one, hidden title or not; else one made from the My
  Tasks preset with the Library's arrangement, and remembered. Only a deletion in Tana makes a fresh one). It is the
  saved view installed first (`WORK_VIEW`, Cmd+K Saved views): main's two-pane layout (`window:setLayout` 'workView')
  with the Timeline in page '' and `{ myTasks: true }` in page '2', found or made at load. Going Home opens it, the one
  saved under its id if you replaced it, this one if you removed it. A first launch opens it as two panes.
  On a new account both panes are empty, so an empty page says what would fill it (`emptyText`, renderer/render.js):
  the Timeline what shows up there, Notifications and Proposals that there are none, a saved search or a type's page
  "Nothing matches.", with the Quick Add Task key after it when the search lists tasks, so an empty My Tasks is where the
  first task starts. Only a document says "No content".
- **Windows** (issue #137). File › New Window, ⌃⌘N or Cmd+K New window opens another outliner window 24px down and right
  of the front one, with one page on the place the page that asked was on (`window:new` answers its id). A page's id is
  unique across windows, since its view and place are stored under it. Only the main window (`win.primary`, the first;
  the one left when it closes) saves its bounds and layout, so another window never leaves the next launch its single
  page, and a saved view or Home chosen in another window is laid out in the main window, which comes forward (issue #444). What main pushes
  (`send`) reaches every page of every window; each window's view is refreshed and kept live while any window shows it
  (`openViews`), and each page keeps its own sidebar watch (`watchRelated(id, key)`). A command for one page goes to the
  page used last (`S.pane`): a notification click opens its node there. Closing the last window keeps the app in the
  Dock (issue #246): ⌘Q quits, the Dock icon opens a window when none is open, and a notification click opens one.
- **Panes** (issues #159, #435). An outliner window is a `BaseWindow` with one view, shell.html, holding a Trellis
  workspace (`@danfessler/trellis`, shell.js) of any number of pages, each an iframe of `index.html?side=<id>`: '' the first,
  then '2', '3', ..., an id that never changes while the page lives. Main keys a page by its frame, so a page is to
  main what another window is: each has its own view, place, history, filter and sidebar, stored under its id
  (`view:3`, `place:3`; renderer/state.js `SIDE`), so a restart or Reload keeps them. **One pane per place** (issue #533):
  a document, a node or a view already shown in another pane of the window is not opened a second time; going there (a
  row, a link, ⌘K, ⌘-click) takes you to that pane instead (renderer/edit.js `inOtherPane`, over the places each page tells
  the shell). The Library alone may be open in any number of panes. **New pane** (⇧⌘N) opens the Library in a
  page to the right of yours, **New tab** (⌘N) one in your panel and **New floating pane** (⌥⌘N) a floating one, the
  same modifiers ⌘-, ⇧- and ⌥-click open a link with: main gives the id
  (`api.splitWindow(where)` answers it) and tells the shell (`shell:command` 'open'), the page that asked stores its
  view and place under that id, and the new page opens there and takes the keyboard. Panes are docked, tabbed or
  floating and dragged between those by their tabs; the tab's title is the page's (renderer/render.js `tellTitle`
  posts `{ orbital: 'title', renamable }`: masked in demo mode, "Hidden" for a blurred sensitive document). Under a tab
  bar a view, a saved search or an app page drops its heading, which the tab already names (`html.listing`, issue
  #441); a document keeps its own. A right click on a tab (or its "…") opens the panel menu, led by **Refresh** on a saved search
  (its query asked again, the rows kept in place let go: renderer/pills.js `offerRefresh` tells the shell with the title,
  `{ refresh }`, and the menu posts `{ orbital: 'refresh' }`; not while pills stage an unsaved filter), **Save as new search** on a view with pills such as the Library
  (the Cmd+K row, run in that page; issue #538), **Copy link** on a page showing a node of Tana's (that node's link, not
  the row with the caret; issue #542), **Delete** on a saved search (the page's ⇧⌘⌫: Tana decides, ⌘Z restores; `{ remove }`, issue #615) and **Rename** when the page's title
  can be typed in (a chat's, agent's or skill's too, where you are its admin or editor, and a type's: their bodies stay
  read-only, only the title is written; a meeting's title stays calendar protected; sdk/node.js `editable(n, me, true)`, issue #540): the shell posts `{ orbital: 'rename' }` and the page shows its heading (`html.renaming`) with its
  words selected until it loses the focus (renderer/document.js `renameTitle`); Cmd+K **Rename** under Current node does the same, with or
  without a tab. ⌘W, a tab's X and the
  panel menu's Close close a page; the shell's close guard first asks the page to flush (renderer/app.js
  `leavePage`, also run on pagehide): the pending edit is sent and its presence room left. The last page never closes
  from inside: ⌘W closes the window then. The panel menu has no Hide, since a hidden page would have no way back.
  **Navigation**: with more than one page the workspace zooms (Trellis `navigation: 'free'`): Maximize or restore
  pane, Show all panes, Zoom back / forward and a pinch, which the shell takes from inside a page (ctrl+wheel) while
  a plain wheel stays the page's scroll. The pane keys are pressed in a page, which the shell never hears, so each is
  a Cmd+K row that posts `{ orbital: 'run', command }` to the shell (renderer/palette.js `PANE_ROWS`, `shellRun`);
  every Trellis key in the shell itself is off. After every change the shell tells each page how many pages the window
  holds (`{ orbital: 'layout' }`, renderer/state.js `windowPanes`), which decides those rows and puts the page under a
  tab bar (`html.tabbed`: a view, search or app page drops its heading).
  The window's header (§4) holds the traffic lights and drags the window (`-webkit-app-region` does nothing inside an
  iframe); the panes sit below it. **One page** has no tab bar and no navigation. With more, the tab bars along the
  top drag the window too, the tabs and buttons excepted (shell.js `mark`), and start at the window's left edge. A
  tab pressed makes the pages let the pointer pass until it is let go; a release the shell never hears ends on the
  next move with no button down, which cancels a Trellis drag still going too. The line between panes is Trellis's divider,
  drawn 1px; the panels have no gap and no rounding. The shell reports every committed change (`shell:layout`
  { doc, pages }), which main saves with the window, and starts from it (`shell:state`); signed out it shows page ''
  alone and keeps the layout aside until the login ('auth').
- **The palette over every pane** (issue #409). The palette is the opener's own page: while it is open the shell lays
  that page's iframe over the whole window, above every other pane, docked or floating (renderer/palette.js `coverWindow` posts
  `{ orbital: 'cover', on }` to the shell, shell.js `cover` lifts everything from the iframe up to the workspace and
  sizes the iframe to the workspace, divided by the pane's scale when zoomed, again on every resize). The page keeps
  drawing itself in its pane (styles.css `html.cover`: the body offset and sized to the pane, the toast at its
  bottom centre), read from the box Trellis gives its iframe, which stays put while the iframe reaches past it. It is
  see-through around it, so the other panes show under the scrim and keep drawing live updates. The class follows the
  page's own size, on once it is larger than its pane and off once it is back, so no frame shows the page out of
  place while the shell resizes it. A click on the scrim over another pane is a click on
  the opener's scrim and closes the palette; the page lets go once the scrim has faded (`MOTION.quick`), or at once when
  it goes away. A page alone asks too, which only takes the drag strip away so the scrim gets its clicks. A Help tour
  or Quick Add Task stays above it.

### Overlays

main lays two pages over the whole window, above every pane, as a transparent view (main.js
`openOverlay`), asked for by renderer/overlays.js; each is its own scope outside the outliner. The page that asked
keeps its caret and gets the keys back when the overlay closes, with what it had to say (`onOverlayClosed`).

- **Help** (help.html): eight short pages of the basics, each with a CSS loop of the keys at work; the rest is found in
  Cmd+K as you go. The last page, Orbital on your phone (`#help-mobile`), opens with a choice of phone, iPhone or
  Android: a radio group drawn as the Settings window's segmented control (one tab stop; ← and → switch inside it and
  do not page the tour; a click or Space picks), over one place that shows the phone picked, so there is only ever one
  code on screen. **iPhone**, picked to begin with: a code to scan that joins its TestFlight beta (help-testflight.svg,
  made by `qrencode -t SVG -m 0 --svg-path`) and the same public link, https://testflight.apple.com/join/wgcnRVKx, to
  open on the phone (it opens in the browser through main, `openExternal`), iOS 26 or later. **Android**: "Coming
  soon" in words, with no code, link or button until there is a release. The card keeps its size between the two.
  Cmd+K Install mobile app opens the tour on that page (`openHelp('mobile')`, main.js `openOverlay` passing `at=mobile`
  to help.html, and nothing else it is sent). The page before it offers Sign in with ChatGPT: the tour closes and its page opens the Cmd+K ChatGPT page
  and starts the sign-in (`onOverlayClosed` `chatgpt`); signed in already, it says so instead. Opened by Cmd+K Help, the ?
  in the header row, and once by itself on a first start (`helpOnce`, the `helpSeen` preference): after login, once
  the connection is up and the page the launch came back to is drawn. Main opens it (`api.claimHelp`, main.js
  `help:claim`): only after this session read the settings document (a failed read declines), over the first page asking
  in a window nothing covers, and marks `helpSeen` in the same step; a window Quick Add Task was covering gets it from main the
  moment that closes (`firstHelp`, `helpPending`), whichever half opened Quick Add Task. So it neither covers the login, nor
  shows again on a new machine, nor opens in every window, nor is spent
  unseen. ⌘K closes it and opens the palette.
- **Quick Add Task** (task.html; `createTask`, ⇧⌘Space, issues #232, #237, #241): the palette's card with a title field
  and, under it, the type — plain Task first, then the workflow types main offers (`api.taskTypes`: types with a board
  of states, `data.workflowUri`, that this user may create in); ↑/↓ choose. A line under the field says what the task
  will be and for whom ("Bug · Assigned to Me"); ⇥ or a click there turns the field into "Assign to…" over the members
  (`api.members`, you first), where ↑/↓ choose, Enter picks and brings the title back, and Escape or ⇥ go back
  unchanged. Enter creates the trimmed text through `api.createDocument(title, { kind: 'task', typeUri? })`, open and
  assigned to you, then `api.setAssignees` when someone else was picked; a refused assignment leaves the task and says
  why in the note, which the asking page shows as a toast. Enter on nothing does nothing, a refusal stays on the card
  with the text kept, Escape closes, ⌘K closes and opens the palette. Demo mode refuses it before it opens. The key
  works in Orbital's windows only.
- **The update card** (update.html, updater.js, #667): what a check finds — at launch, once a day, the app menu's Check
  for Updates… or ⌘K Check for updates — laid over the page that asked or the front window. The palette's card: "Orbital
  0.9.2 is available", the running version, then the GitHub release notes of every version since it, newest first, as
  markdown (release.sh's "Signed and notarized; unzip …" line left out). Later (Esc, a click on the scrim) closes it;
  Update and Restart (Enter) turns the buttons into a progress bar in the accent blue: "Downloading… 47 of 123 MB",
  then "Checking the download…" while it is unpacked and its signature checked, then the app quits and reopens as the
  new version. While it runs the card stays; a failure says why on the card and offers Try Again. A window the Help tour
  or Quick Add Task covers keeps the offer and shows the card once that closes (main.js `updatePending`).

### Presence (issue #14)

The page on screen has its presence room open (renderer/presence.js follows the zoom after every render;
main/presence.js keeps one counted room per document over sdk/presence.js). Lists show no presence.

- **Others.** Each person's caret drawn where Tana draws it: a thin line in their colour
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
  date is not. Pictures are never shown: an image is a grey box at the size the picture is drawn (the block's stored size, else the
  picture's own read off it without drawing it, shrunk to the row's 360px or a cell's 240px), the privacy glyph in its middle (renderer/render.js `demoImageEl`; a 360px 3:1 box
  until a size is known); the pixels are never drawn and the full view does not open. **Nothing is saved while it is on**: no text is editable, checkboxes are disabled, and `tana`
  (`readOnlyInDemo`, renderer/state.js) refuses every call in `DEMO_WRITES` with "Demo mode is on: nothing is saved to
  Tana", whatever asked; the day and week nodes are only looked up (`findOnly`). The switch reaches every window at
  once (the storage event) and main (`app:demoMode`), which then posts no notification banner. It is remembered on this
  machine (localStorage `demoMode`), read before the first render.
- **Hidden items** (`api.filters()`/`addFilter`/`removeFilter`; Cmd+K Edit hidden items): title patterns
  (the whole title, or a prefix with a trailing `*`, case-insensitive) that drop matching nodes from every list and
  search. A hidden node opened directly still opens. **Toggle MCP chats** hides MCP chats the same way (docs/CHATS.md).

## 18. The Graph pane

A document's relationships are shown in the window's **Graph pane** (issue #462, `#rail`, renderer/rail.js), fed by
`api.related(docId)`: one Trellis pane per window that follows the pane with the keys, so a window of several panes
has one list of links rather than a sidebar in each. Cmd+K **Show graph** opens it beside the page you are on, about
320px wide (Trellis scales a pane's content below 280px), and leaves you the keys; **Hide graph** closes it, as its
tab's X or ⌘W in it do. The page's own Graph switch runs the same row: one of its buttons at the top right, since
what it shows is this page's links, there only on a page with a document (not a view, a saved search or an app page)
and at full strength while the pane is open (renderer/rail.js `drawLinksBtn`). It is a pane like any other: tabbed, floated, maximized or dragged, and kept in the window's
layout and in a saved view.

How it works: it is an outliner page opened with `links=1` (`api.splitWindow('links')`, main.js `window:split`;
shell.js `open` keeps one per window and puts `links: true` in the page's params), and `LINKS` (renderer/state.js)
hides its outline column (styles.css `html.links`) so it draws only the rail, full width; its tab reads "Graph". It
follows by zooming into the followed page's document, hidden, which is what gives the rail its row, fields and live
changes; it records no Recent entry and joins no presence room. Every other page draws no rail and tells the shell
which document it is on, with its row (`tellDoc`: a view, a saved search, an app page or a draft is none), and that it
took the keys (`{ orbital: 'focus' }`); the shell follows the last page that did, never the Graph pane itself (and in a
window restored with the Graph pane in front, the page in front or else the first: `following`), and
sends it `{ orbital: 'follow', docId, doc }` (`follow`: the row opens the document without asking main; none leaves it
on the view). Each page tells its title and document again on the shell's layout message (`retell`), since what a
page says before the shell has seen its iframe load is lost. Its rows are edges, not nodes: a click or Enter opens one
in the followed page, which takes the keys (`openLink`, `{ orbital: 'open', id }`, answered with `goto` there), as
does a notification opened while it has the keys; a task row toggles on Space, and nothing there takes a caret. A
document with nothing linked says so; an empty section is omitted; a collapsed section is remembered (`railClosed`),
and every head carries `aria-expanded`. It never stands alone: the last page beside it does not close from its tab, and
⌘W there closes the window (main.js `closeFront`, which knows the Graph pane by its `links=1`).

- Tags on sidebar rows collapse to their `#` and hue and show their label on hover or focus, without changing the
  row's height.
- **No Details section.** What it listed lives with the page: who it is for and who can see it are the first fields
  under the title, and Open in Tana, Join call and Edit pins are Cmd+K rows under Current node. **Assigned to** (a task) is a mention per
  person, drawn as a person in any other field is (no chip), or "Unassigned", and opens the assignee picker; **Visible to** (any document with a known audience) is the
  audience's glyph with a bubble per person as a list row's subtext has them, "Everyone" or the space's name for those audiences, you as a mention for a private page, one person as a mention drawn as Assigned to draws one (or the audience's words where it names
  nobody), "Anyone with the link" when Tana's link sharing is on, each assignee it shuts out as a dashed "+ Name" pill after who can see it, in a soft rose with the lock left grey — a click shares the page with that person as an editor where the page's own people are its audience and you may change them, and otherwise the pill only says so (`fghost`, issue #622) —, and assigning such a person from the assignee picker asks there and then, as Tana does: "Priya Raman can't see this", with Grant access (the pill's share; Enter), Keep private (or Escape) and Cancel (the assignment taken back), Tana's sentence under them (`openShareAsk`, renderer/access.js) — and opens the visibility picker, on a meeting's
  write-up the event's; a sensitive page, a chat and a saved search have none. Both open on a click, Enter or Space (renderer/fields.js
  `assigneeFieldEl`, `visibilityFieldEl`). A page asks for its fields' data itself (`loadRelated`), with or without a
  Graph pane beside it.
- **Attendees** (a meeting, on the event and on its write-up; a task attached to a meeting has none of its own) follows Visible to: the roster main's `meeting:info` reads,
  one person per line, a member as a mention and anyone else by the calendar's name or address, rooms and resources left
  out. Past five lines "And n more" shows the rest on a click, Enter or Space, for as long as the page is open. The
  answer is kept per meeting and read again when the event changes (renderer/meeting.js `meetingInfoOf`,
  renderer/fields.js `attendeesFieldEl`).
- **A chat** has neither field: one grey line at the top right says who can see it ("Only you can see this chat", or
  the audience's glyph and words or faces as a row's subtext has them) and, for a meeting's chat, "about" the meeting as
  a link, and **Add participants** after who can see it, for whoever may share it (`access.sharing`), which opens
  Cmd+K Add participants …. The meeting's attendees stay on the meeting's page: listed on the chat they read as its audience (renderer/chat.js
  `chatContextEl`, issue #543).
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
- **Keys**: Cmd+K **Focus graph** (`rail`, no default key; record one with ⇧⌘K) moves the keys to its first row (as does
  any way into the pane: ⌘/, a click on its tab), ↑/↓ move, Enter opens, Space toggles a task, ← folds the focused
  row's section and → unfolds it, Escape or ⌘← gives the keys back to the page it follows. **Show/Hide graph**
  (`railToggle`) records a key the same way.
