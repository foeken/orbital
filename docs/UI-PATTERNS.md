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
  let answer = null; // null while asked, then what main said, or the Error it failed with
  const note = (label) => [{ group: 'Example', label, disabled: true, note: true }];
  const exampleRows = (q) => (!answer ? note('Loading…') : answer instanceof Error ? note(answer.message) : rowsFrom(answer, q));
  function openExample(doc) {
    answer = null; // the first draw says Loading…, never the last document's answer
    openPage('example', 'Choose…', { rows: exampleRows, back: BACK_TO_COMMANDS });
    const seq = palSeq, landed = (value) => { if (seq === palSeq) { answer = value; renderPalette(); } };
    tana.exampleRead(doc.id).then(landed, (e) => landed(e instanceof Error ? e : new Error(String(e))));
  }
  ```

### A page that lists one read: `loadList` and `listRows` (renderer/palette.js)

The read runs once per open, after the actions already queued through `run`, and only the latest read of a page is
kept. While there are no rows, the page shows one note: Loading…, the error, or its empty line for an empty list with
nothing typed. A query that matches nothing is the palette's own "No results", which is never drawn under a note.

```js
let trashList = null;
const trashRows = (q) => listRows(TRASH_GROUP, trashList, q, 'Nothing deleted recently',
  (list) => list.filter((d) => fuzzyMatch(d.title, q)).map((d) => ({ group: TRASH_GROUP, label: demoText(d.title, d.id), run: … })));
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

### A popover over the whole window: `coverWindow` (renderer/palette.js)

In a split window each half is its own page, so anything `position: fixed` covers only that half. A centred, modal
popover that should cover the window while acting on its half (the palette and the key recorder over it) calls
`coverWindow(mode)` as it opens and `coverWindow(null)` as it closes: main lays the page over the whole window and
the page keeps drawing itself in its half (`html.cover`), see-through beside it. `showPage` and `closePalette` already
do this, so a palette page needs nothing. A new element fixed to an edge of the window gets an `html.cover` rule in
styles.css that puts it at the half's edge (`--pane-x`, `--pane-w`), as the split line and the toast have; one placed
from an element's rect is right already. A popover that belongs to a spot in the half (a pill menu, the toolbar, the
@ and / menus) stays in the half and never covers. A page of its own over the window (Help, Create task) is an
overlay instead (main.js `openOverlay`).

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

## Tokens and classes

styles.css is the only stylesheet. A new piece of UI is built from a class that already exists and the tokens below.
It gets no colour, shadow, layer or duration of its own.

### Tokens (styles.css, top)

The colour and shadow tokens are set once for light and once for dark (`[data-theme="dark"]`), so a rule written with
them needs no dark twin. Motion and layers are one value for both themes, and `--hue` is set on the element itself.

| Token | Light / dark | For |
|---|---|---|
| `--surface` | `#fff` / `#242729` | the neutral floating surfaces: menus, the toolbar, ⌘K's, the recorder's and Help's cards. The toast is the exception on purpose: it is inverted (dark in light, light in dark) |
| `--scrim` | 12% / 52% black | behind a dialog (⌘K, the key recorder, Help) |
| `--shadow-menu` | | a menu or dropdown (`.menu`, the @ dropdown) |
| `--shadow-card` | | a dialog's card (⌘K, the recorder, Help) |
| `--focus` | `#b5d0ee` / `#58768a` | every keyboard focus ring: `outline: 2px solid var(--focus); outline-offset: 2px` on a row or block, `box-shadow: 0 0 0 2px var(--focus)` on a button. Two exceptions, on purpose: the green save pills ring green, and the agent badge rings a stronger `#4f8ad9` on its coloured tag |
| `--muted` | `#666` / `#a0a5a8` | secondary words: facts, hints, headings, placeholders, done rows. It meets WCAG AA on the page, on menus and on grey pills. Icons keep their lighter greys, and disabled rows too |
| `--z-toolbar` 9 < `--z-palette` 10 < `--z-recorder` 11 < `--z-toast` 12 < `--z-drag` 15 < `--z-lightbox` 20 | | what stacks over the page. Below them, page chrome uses small numbers: 5 for the pill row (so its menus hang over the rows) and the split grip, and 1 to 3 to order siblings inside a component. A new overlay takes a token, and new page chrome stays under 9 |
| `--dur-quick` / `--dur-base` / `--dur-slow` / `--dur-flash` / `--dur-loop`, `--stagger`, `--ease-*`, `--loader-wait` (300ms before the loader shows) | | every transition and animation of a new component. Some keep clocks of their own on purpose, for example a caret's `blink` (1s) and the Help tour's choreography (`--hv-loop` 6s, the moon's 7s). Reduced motion sets the finite ones (`--dur-quick` to `--dur-flash`, `--stagger`, `--loader-wait`) to 0, so a move built on them needs no guard. `--dur-loop` is not zeroed: an endless loop always goes behind `@media (prefers-reduced-motion: no-preference)` |
| `--hue` | set per element by the renderer | one hue for one element: a type's colour, or a person's in presence. Always used as `oklch(L C var(--hue))`, and each component picks its own L and C per theme (a glyph goes 0.7 → 0.8 in dark, a chip's background 0.95 → 0.33). A new hued element copies the L and C of the component it resembles |
| `--flash-in` / `--flash-out` / `--flash-here` | | the tint of a row arriving, leaving or found again (`flash()`) |

Sizes are small scales rather than tokens. Pick from the common values below. The few other values in the file (the
Help tour's 14.5 and 21/650 type and 5px key caps, presence's 12.5 label and 5px bubble, the 500 weight in Create
task's picks line) belong to one component each and are not for reuse:

- **Font sizes**: 12 (chips, uppercase headings), 13 (crumbs, the error line, toasts, palette group names, `kbd`), 14
  (a row's facts and grey line, hints, sidebar titles), 15 (pills, palette rows, toolbar), 16 (body text, menu rows),
  17 (the palette field); a dialog's `.button` is 13.5, its own size. Headings are 20 and 24, and the page title is
  34. Weights are 400, 600 (labels, headings) and 700 (bold, a pill's value).
- **Radii**: 3 (a focus ring's corners), 4 (chips, small icon buttons), 6 (buttons, badges, code, images), 7 (a
  dialog's `.button`), 8 (rows in a menu or ⌘K, inputs, toasts), 10 (menus), 12 (dialog cards; Help's is 14), `999px`
  for a pill, `50%` for a dot.
- **Spacing**: the page's side gutter is 32px (`.titlebar`, `.filter`, `.pills`, and `.scroll`'s
  right edge). `.scroll` pads only 16px on the left: a row's own marker gutter makes up the rest, so its words line
  up with the title. A row is a 24px line
  with 3px above and below. A menu has 8px of padding and rows of 8px 12px.

### Component classes

styles.css keeps each component under one header, `/* ==== Name (renderer file) ==== */`, and lists them in order at
the top of the file. The table gives the states a new use most often needs; the component's section in styles.css has
the full set. State classes are set by the renderer, pseudo-classes by the browser.

| Component | Classes | States |
|---|---|---|
| Row | `.node > .line > .chev, .bullet, .check, .body > .text, .meta, .subtext`; children in `.children` | `.selected`, `.collapsed`, `.has`, `.done` (a document: struck and grey), `.draft`, `.gone`, `.unread`, `.entering` / `.leaving`; `.text[tabindex]:focus` rings a read-only row |
| A row's facts | `.tmeta` holding `.ticon` glyphs (#372); `.meta.pending` while they load | `[role="button"]` makes one clickable |
| Chip | `.chip.grey`, `.chip.gold` (meetings), `.chip.hue` with `--hue` (`chipEl`) | |
| Pill | `.pills > .pill`, the value in `<b>`; grey for arranging (`data-id` sort, group, display); green `.save` for making something | `:hover`, `.open` (its menu is showing), `:focus`, `.in` (arriving). Leaving is on the row: `.pills.out`, with `.sliding` / `.folding` while it folds |
| Menu | `.menu > .mrow > .micon, .mlabel, .tick`; `.mhead`, `.mdiv`, `.msearch`; `.menu.search` for long lists of titles | `.mrow.active` (keyboard), `:hover`, `.mrow.disabled` (the toolbar's style menu sets it; pill menus have no disabled row); `.menu.up` when it opens upwards; `.menu.in` / `.menu.out` while it arrives or leaves, set by `menuMotion` (renderer/motion.js), never by hand |
| Palette | `.palette > .card > input, .list > .group, .row > .ricon, .label, .hint, kbd` | `.row.active`, `.row.disabled`, `.ricon.thinking`, `.row.arrive`; `.palette.anchored` is the @ dropdown |
| Header button | `.navbtn` holding an svg | `:hover`, `:disabled` (still shown, faint), `[hidden]`, `.in` / `.out` |
| Toolbar | `.toolbar > .tbtn` | `.on` (the mark is set), `:hover`, `:focus`, `.style.open` |
| Group heading | `.ghead` (a button; its chevron follows `aria-expanded`), `.gmore` for "Show more" | `:hover`, `:focus` |
| Sidebar | `.rail > .rhead`, `.rrow > .ricon, .rtext > .rtitle, .rsub` | `.rhead.closed`, `.rrow:hover`, `.rrow:focus`, `.rrow.done`, `.rrow.rmeta.fixed` (not clickable) |
| Fields | `.fields > .field > .ricon, .flabel, .fvalues`; `.fchoice > .fchip`, `.fhint`, `.fkind` | `.fchip.gone`, `.fchip.wrong` |
| Table | `.outline.table-view` with `.thead`, `.cell`, `.tgrip`; a table block is `.text.table` | `.cell.pick`, `.tgrip.dragging` |
| Agent badge | `.cbadge` | `.pending`, `.working`, `.waiting`, `.done`, `.broken`, `.unavailable`, `.closed`; `[role="button"]` when it opens something |
| Proposal buttons | `.pbuttons > .pbutton.approve` / `.pbutton.reject` (renderer/proposals.js) | `:hover`, `:disabled` |
| Empty and loading | `.empty-note` ("Nothing here yet"), `.children.loading`, `.skeleton` (renderer/loading.js) | `.empty-note.cleared`; `.skeleton.gone` once the rows have landed, `.skeleton.tail` while the Timeline is still landing in parts (renderer/render.js sets both) |
| Toast | `.toast`, only through `showNote` / `showError` | `.show`, `.error` |
| Button | `.button`, `.button.primary` for the one that goes on (a dialog's footer: the key recorder, Help) | `:hover`, `:disabled` on a plain `.button` only: `.primary` has no disabled look, so a button that can be disabled (the recorder's Save) stays plain |
| Dialog | a scrim element with a `.card` inside: `.palette`, `.recorder`, `.help` | `[hidden]` on `.palette` and `.recorder`; `.help` is a `<dialog>`, so `[open]` (`showModal()` / `close()`). The palette and the recorder arrive and leave with the Surface motion; Help only arrives, and `close()` removes it at once |
| Lightbox | `.lightbox` | `.out` while it closes |

A new kind of button is added by hand to both selector lists of the Press rule in styles.css (`:is(.navbtn, .pill, …)`
and the same list with `:active`), so it eases down under the pointer like the others. Nothing joins it on its own.

### Adding a component

1. Look for the class that already draws it. A list of choices is a `.menu` or a palette page, a toggle is a
   `.pill`, a label is a `.chip`, a small action is a `.navbtn`, a dialog's button is a `.button`, a status is a
   `.cbadge`.
2. If nothing fits, write one rule set under the section it belongs to, with a comment naming the renderer file that
   builds it. Colours come from the tokens, from `currentColor`, or from the colour the same meaning already has:
   link blue `#508fbb`, done green `#5a9670`, error red `#c0392b`, meeting gold `#8a6a17`, and the
   `.cbadge` pairs for status. Sizes come from the scales above, and moves from the motion tokens.
3. A rule written only with tokens needs no dark twin. A literal colour does: add its twin to the dark theme block, or
   better, use a token.
4. Give it the states the table lists for its kind, and read its section in styles.css for the rest. Keyboard focus is `var(--focus)`, never a new blue.

```css
/* a made-up example: a date chip that floats under a row (renderer/<its file>.js) */
.datechip { padding: 1px 6px; border-radius: 4px; font-size: 12px; background: var(--surface); box-shadow: var(--shadow-menu); }
.datechip:focus { outline: none; box-shadow: 0 0 0 2px var(--focus); }
```

## UX conventions

The full contract is [OUTLINER.md](OUTLINER.md). These are the rules a new feature most often gets wrong.

- **Keyboard first.** Everything works from the keyboard before a mouse affordance is added. A list (a page, a menu, the
  palette) answers ↑/↓, Enter and Escape. The Help tour pages with ←/→ instead. A command is a palette row, so ⌘K finds
  it. A row with a stable `id` can also be given a key with ⇧⌘K (`DEFAULT_HOTKEYS` for a built-in one); a row that only
  makes sense in context (Notify on changes, Assign to Agent) carries no `id` and takes no key. New keys are written up
  in OUTLINER.md.
- **Wording.** Rows are sentence case. A command row starts with a verb: "Pin to today", "Set status", "Move to
  Library". Some rows that ask something before they act end in " …" ("Move to …", "Pin to date …") and others do not
  ("Set type", "Search Tana"); a new row follows the rows beside it in its group. A place or a choice is named as it is
  (a view's title, "Any status", a member). A hint says the current value ("Inbox") or why a row cannot run, and `✓`
  marks the current choice. A placeholder says what to type ("Search Tana", "Choose a colour or type a hue…"). A notice
  says what was done, in the past tense, and names the thing: "Link copied", "Classified as Decision Record".
- **Where errors go.** An action runs through `run()`, and a failure becomes the red toast (`showError`). A palette page
  built on `loadList` shows a failed read as a disabled note row in place of its rows; other pages that read (Set icon
  and the Pin to today picker, for example) send it to the toast instead. The Create task card, a page of its own, keeps
  a failed create on the card (`.terror`) so the press can be repeated. The red line under the title (`#error`) belongs
  to the session alone: it asks for a new login. A notice never goes to `#error`.
- **Focus after an action.** Closing the palette puts the caret back on the row that had it (`closePalette`). A menu
  dismissed with Escape gives focus back to its own button (renderer/pills.js, toolbar.js). A choice made in the
  toolbar's style menu puts the text selection back instead (`applyBlockType`), so typing goes on. A new row takes the
  caret. With nothing to go back to, focus goes back to the page itself, where ↑/↓ pick up the first or last row.
- **Empty and loading.** A page with no rows says so in its own words (`.empty-note`; `emptyText` in
  renderer/render.js): "No notifications yet.", "Nothing matches." with the Create task key, or "Nothing here yet" with
  Clear filters when a filter hides rows. A new page adds its line to `emptyText`. A palette page with no match says "No
  results". Only a launch or a Reload shows the loading animation (after 300 ms). Later loads wait blank, and a row
  still coming says "Loading…" (`.children.loading`, a `disabled` palette row). A row that cannot run is shown greyed
  with the reason as its hint, not hidden.
- **Read-only is visible.** A row with `editable === false` never gets an editor. It takes focus with a ring, and main
  refuses the write as well.

