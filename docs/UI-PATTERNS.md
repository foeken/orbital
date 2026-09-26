# UI patterns

The renderer is classic scripts sharing one global scope (index.html's load order, guarded by
scripts/renderer-check.js), with no framework or build step. A feature is built by combining the plain functions and
classes below. Each one lives in one file, and each is used the same way everywhere. When something here does not fit,
add to the function that owns the concern. Write a new function only when the same thing already exists three times.

## Building blocks

### A palette row

Everything the palette lists is a plain object. The full field list and ordering rules are in
[EXTENDING.md](EXTENDING.md#a-palette-row-or-a-built-in-key).

```js
{ id: 'pinToday', group: 'Current node', icon: 'pinDate', label: 'Pin to today', hint: '✓', run: () => … }
```

- `hint: '✓'` marks the current choice on every picker. `keepOpen: true` marks a row that opens another page or stays
  for the next pick.
- A note is a row nobody can run that says why there are no rows: `{ group, label: 'Loading…', disabled: true,
  note: true }`. ↑/↓ step over it, and no "No results" is drawn under it. A disabled row without `note` is a choice
  that is unavailable right now.
- `docRow(node, hint, run)` (renderer/palette.js) makes a document into a row, with its icon, type chips and date.
- `fuzzyMatch(label, q)` (renderer/palette.js) is the palette's matcher: filter a page's list with it, as in
  `list.filter((x) => fuzzyMatch(x.title, q))`, and the bold letters agree with ⌘K. It filters only: a page keeps
  its rows in the order it returns them, and only the command page ranks by match (`rankRows`).
- `memberRows(q, pick, ticked)` (renderer/tasks.js) makes a list of people plus Unassigned, each row calling
  `pick(uri)` and ticked where `ticked(uri)` says so. It lists the members already read, so the page's opener calls
  `loadMembers()` first; the palette is drawn again when they arrive.

### A palette page: `openPage` (renderer/palette.js)

A page is its rows, where Escape goes, and optionally its own keys. `openPage` lets go of the last page, draws the new
one and focuses the field. Nothing else registers a page.

```js
function openHuePalette(doc) {
  hueCtx = doc; // context first: the first draw reads it
  openPage('setHue', 'Choose a colour or type a hue…', { rows: huePickRows, back: BACK_TO_COMMANDS });
}
function huePickRows(q, typed) { … } // every page's rows: q lowercased, typed as typed
```

- `back` is where Escape goes (`backPalette`); without one, Escape closes the palette. `BACK_TO_COMMANDS` steps back to
  the command page.
- `keys(e)` answers a key before the palette does; returning true swallows it (Edit choices uses ⌘⌫ and ⇧⌘↑/↓).
- `typed: true` marks a page whose row is what you type (Pin to date, Discuss with, a field). No "No results" line is
  drawn under it.
- A page that must start something before its first draw (Set icon's busy search) calls `showPage` with the same
  arguments, then `renderPalette()` and `palInput.focus()` itself.
- An answer that arrives later must check that it still belongs to the page on screen. `palMode` alone is not
  enough, because the same page may have been left and opened again for another document. Take the generation
  that `showPage` moves on, and compare it when the answer lands, a failure included. A page whose rows are one read
  gets all of this from `loadList` (below); anything else follows this shape:

  ```js
  typeCtx = doc; typeList = null; // the first draw says Loading…, never the last document's choices
  openPage('setType', 'Set type to…', { rows: typeRows, back: BACK_TO_COMMANDS });
  const seq = palSeq, landed = (keep) => (answer) => { if (seq === palSeq) { keep(answer); renderPalette(); } };
  tana.docTypes(doc.id).then(landed((list) => { typeList = list; }), landed((e) => { typeList = e; })); // rows show e.message
  ```

### A page that lists one read: `loadList` and `listRows` (renderer/palette.js)

The read runs once per open, after the actions already queued through `run`, and only the latest read of a page is
kept. While there are no rows, the page shows one note: Loading…, the error, or its empty line for an empty list with
nothing typed. A query that matches nothing is the palette's own "No results", which is never drawn under a note.

```js
let trashList = null;
const trashRows = (q) => listRows(TRASH_GROUP, trashList, q, 'Nothing deleted recently',
  (list) => list.filter((d) => fuzzyMatch(d.title, q)).map((d) => ({ group: TRASH_GROUP, label: d.title, run: … })));
function openTrashPalette() {
  loadList('trash', () => tana.deletedList(), (list) => { trashList = list; });
  openPage('trash', 'Restore something deleted', { rows: trashRows, back: BACK_TO_COMMANDS });
}
```

A write that answers with the new list sets it and calls `listReads.delete(mode)`, so a read still in flight cannot
overwrite it (`hiddenApply` in renderer/palette.js).

### Doing something: `run`, `showError`, `showNote` (renderer/nodes.js)

`run(fn)` queues an async action behind the ones before it. A throw becomes the red toast, so an action never catches
just to report. `showNote(text)` is the same toast, not red, for a result worth saying ("Link copied"). `showError(e)`
shows an error you already hold.

```js
keepOpen: true, // the palette stays up until the write is in; the row closes it itself
run: () => run(async () => {
  await tana.setType(doc.id, uri);
  closePalette();
  showNote('Classified as ' + title);
}),
```

A row that closes the palette only after its write keeps it open (`keepOpen: true`), as above. A row that does not
(`runRow` closes it before `run`) must not call `closePalette()` again when the write lands: by then another palette
may be open.

`run` must not be nested inside another `run`: the queue would wait for itself.

### Focus after an action: `closePalette` (renderer/palette.js)

The palette remembers the row that had the caret when it opened (`palReturn`), and `closePalette()` puts the caret back
there, or on the field a field page came from. ⌘K records it in `togglePalette`. A page that opens the palette itself
(a recorded key, a row's meta) records it in `showPage` (#377), so an opener does nothing for it. A row that is not
`keepOpen` is closed before its `run` (`runRow`). An action that opens a page instead of closing leaves focus in the
palette. Nothing else moves focus back by hand.

### Icons: `addIcon` and `iconNode` (renderer/nodes.js)

An icon is a name from `ICONS` (icons.js, built by scripts/build-icons.js) or a registered Nucleo glyph. It is parsed
once and cloned after that. scripts/renderer-check.js fails on `iconSvg(` outside nodes.js.

```js
const icon = document.createElement('span'); icon.className = 'ricon';
row.append(addIcon(icon, 'field'));               // appends the glyph, answers the element
btn.replaceChildren(); addIcon(btn, on ? 'visible' : 'hidden'); // a button that swaps its glyph
const svg = iconNode('robot'); svg.setAttribute('width', '14'); // the bare <svg>, when it needs attributes
```

### Drawing: `render`, `renderSoon`, `patchMeta` (renderer/render.js, renderer/tasks.js)

`render()` draws now and is for a user action that needs the DOM right after it (a caret placed in a new row). Anything
that arrives on its own, such as an answer, a live update or members, calls `renderSoon()`, which draws once per frame.
A metadata answer for one row calls `patchMeta(docId)` instead of redrawing the page. Rows are reused while `rowSig` is
unchanged, so anything a row is drawn from belongs in `rowSig`.

### Content that is someone's: `chipEl`, `demoText`, `blurSensitive`

Text from Tana goes through `demoText(text, id)` (renderer/segments.js), so demo mode can mask it. Every element that
shows a node's words is passed to `blurSensitive(el, id)` (renderer/nodes.js), so sensitive marks can blur it. A type
chip is `chipEl(tag, node.hue)` (renderer/nodes.js).

```js
label.textContent = demoText(node.text, node.id);
blurSensitive(label, node.id);
for (const tag of visibleTags(node)) label.append(chipEl(tag, node.hue));
```

### Keys: `DEFAULT_HOTKEYS`, `hotkeyFor`, `keyTitle` (renderer/state.js), `RESERVED` (renderer/palette.js)

A built-in key is a palette row id with a combo in `DEFAULT_HOTKEYS`, so it appears in ⌘K and can be re-recorded with
⇧⌘K. A handler that answers a key itself compares against `hotkeyFor(id)` and calls `preventDefault()`. A header
button's tooltip names its key with `keyTitle(button, 'Clean up', 'cleanup')`. `RESERVED` lists the few combos that are
wired by hand.

### Pills and their menus (renderer/pills.js)

A pill is a definition in `pillDefs()`, and its menu is the rows it answers. ⌘K offers the same rows through
`pillRowsFor`, under the pill's `command` (its ⌘K row label, required), so a pill needs nothing extra to be
keyboard-reachable. `label` is the word on the pill before its `value`.

```js
defs.push({ id: 'status', label: 'Status', command: 'Filter by status', icon: 'status', value: 'Open', rows: () => [
  { label: 'Any status', reset: true, checked: !f.states, run: () => save({ states: null }) },
  { head: 'States' }, { label: 'Open', icon: 'status', keepOpen: true, checked: true, run: … }, { div: true },
] });
```

`search: true` gives a long menu a type-to-narrow line. `toggle` makes the pill a switch with no menu.

### Motion (renderer/motion.js)

Moves are written once. `flash(el, 'in' | 'out' | 'here')` tints a row that arrived, is leaving, or that the caret came
back to. `showHide(el, show)` opens or closes an element in place. `playOnce(el, name)` runs a styles.css animation
class one time. Durations and reduced motion are handled in styles.css and `MOTION`; a feature never sets them.
