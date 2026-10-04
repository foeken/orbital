# Adding a feature

The steps and files for the changes that come up again and again. Each section names the files in the order you
touch them. Read [AGENTS.md](../AGENTS.md) first for the map and the working rules; this file assumes it.

Two rules hold everywhere:

- **Code goes to the file that owns the concern.** Tana-side knowledge is `sdk/` (Electron-free, checked offline),
  the app's use of Tana is a module in `main/` together with the IPC handlers that reach it, `main.js` is only the
  process boundary (windows, menu, boot, registering the modules' handlers), and each renderer concern is one file in
  `renderer/`. A new concern is a new file; a new piece of an
  existing one goes in that file.
- **Dependencies point one way.** `sdk/` requires neither `main/` nor electron. A `main/` module requires only the
  modules before it in the order AGENTS.md lists; when an earlier one has to reach a later one, the later one sets a
  function on `S` (main/state.js), as `main/views.js` sets `S.refresh`. The renderer reaches main only through
  `tana`, the preload API.

## An IPC call

1. **The owning `main/` module** — an entry in its exported `ipc` table, beside the function it calls:
   `ipc = { '<area>:<verb>': (e, ...args) => fn(...args), … }` (main/inbox.js is a small example). main.js registers
   every table in one loop; a module that has no table yet exports one and joins that loop. Handlers not yet moved to
   a table (documents, views, pins, and `outline:children`, which routes between modules) stay in main.js with their
   siblings, as do Electron's own (windows, overlays, `shell`). The channel is named by area and verb
   (`doc:setTitle`, `block:split`, `pins:pin`, `meeting:edit`, `window:split`). The renderer is input from outside
   the process: check ids and shapes in the handler (`DOC_URI` in main/state.js, the regexes in `customCreation`),
   and keep the logic in the function, so the handler stays one line.
2. **preload.js** — one method on `window.api`, named for what it does, with a comment giving the shape of its answer:
   `meetingInfo: (docId) => ipcRenderer.invoke('meeting:info', docId), // { editable, start, end, … }`.
3. **Renderer** — call it as `tana.meetingInfo(id)` (renderer/state.js). Never declare a top-level `api`, and never
   call `window.api` directly: `tana` is the copy demo mode guards. Where the mock or an older main may lack the
   method, guard the row or the call with `if (tana.meetingInfo)`, as the palette rows do.
4. **A write to Tana** — add the method's name to `DEMO_WRITES` (renderer/state.js), so demo mode refuses it with
   "Demo mode is on: nothing is saved to Tana" wherever it is called from. Anything else goes in `DEMO_SAFE`
   (scripts/renderer-check.js), which fails until the method is in one of the two.
5. **renderer/mock.js** — add it when the UI should work without main (the mock stands in when `window.api` is
   undefined), or list it in `NOT_MOCKED` (scripts/renderer-check.js) when the mock cannot stand in for it.
6. **Push instead of pull** — main sends with `send('<area>:changed', …)` (main/state.js: every page of every
   window) or `e.sender.send(…)` (the page that asked); preload adds `onX: (cb) => ipcRenderer.on('<area>:changed',
   (_e, v) => cb(v))`; the renderer subscribes once at load, in the file that owns the concern (live document changes
   are renderer/app.js).
7. **Text the page already shows** — a write of text the renderer typed takes the sender and an `own` flag and runs
   inside `typed(e, own, fn)` (main.js), as `doc:setTitle`, `block:setText` and `block:setCell` do, with preload
   passing `own === true`. `typed` sets `S.writer` for the length of the write, so `sendChanged` tells that page the
   change is its own and the page does not re-read and rebuild itself under the caret (#265); a handler that drops
   `e` sends every page a plain change.
8. **Check** — `scripts/sdk-check.js` loads main.js with a fake electron and keeps every handler, so a test calls
   `backend.handlers.get('<area>:<verb>')(null, ...args)` (the field checks around `outline:children` are an example).
   It also fails when preload.js calls a channel main does not answer, when a handler has no caller, and when two
   handlers claim one channel.

## A main-process module

1. **main/<name>.js** — `'use strict'`, then a comment saying its one job and which doc describes it.
2. Require only modules earlier in the order (AGENTS.md map). Reassigned shared state (the client, the user, the
   windows) is read from `S`; shared caches are the Maps exported by main/state.js. A new Tana capability goes into
   `sdk/` first and the module uses it.
3. Export plain functions, and the module's `ipc` table when it answers the renderer (then add it to the loop in
   main.js that registers the tables). Boot-time work is started from main.js's boot sequence.
4. Add it to the AGENTS.md map at its place in the order, and give it checks in scripts/sdk-check.js, which runs
   main.js and every `main/` module in one vm context.

## A view or a page

Pick the smallest that fits:

- **A list over some kinds with a filter** is a saved search (`tana:search:`, docs/VIEWS.md §6): the user makes one
  with Create new … → Search. No code.
- **A new preset of the one view**: an entry in `VIEWS` (main/state.js: id, title, icon) and in `VIEW_PRESETS`
  (sdk/query.js), its id in `VIEW_ORDER` (renderer/palette.js), and optionally a starting arrangement in
  `VIEW_ARRANGEMENT` (renderer/views.js). The cache, the pills, the live refresh and the Cmd+K row come with it.
  renderer/mock.js hard-codes its own `views` and `filters`, so add the view and its preset there too, or the page
  is missing when the UI runs without main. Update docs/VIEWS.md §2.
- **An app page** — rows that are not a Tana node's children, like Notifications, Proposals and the Timeline:
  1. **main/<page>.js** exporting `PAGE = 'orbital:<page>'` and `rows()`, which answers `Node[]` (read-only rows,
     built with `graphRow`/`toNode` from main/rows.js when they are documents).
  2. **main.js** — a branch for `page.PAGE` in the `outline:children` handler, which is where every id is routed.
  3. **renderer/<page>.js** — at load, `extra.set(PAGE, { id: PAGE, text, title, kind: 'document', icon, editable:
     false, hasChildren: true, appPage: true })`, so `goTo`, Back and Recent find it without asking main; and a
     `<page>ViewRow()` answering `{ id, group: 'Views', icon, label, hint, run: () => goTo(PAGE) }`.
  4. **renderer/palette.js** — push that row with the other view rows in `paletteRows`, guarded by the api it needs,
     and add its id to `VIEW_ORDER`.
  5. **Live** — main sends a channel when the page's source changes; the renderer reloads the page whenever it
     holds cached rows for it (`if (kids.get(PAGE)) reload(PAGE)`, as renderer/inbox.js does), on screen or not,
     because a later `goTo(PAGE)` reuses those rows without asking main again.
  6. **renderer/mock.js** — rows for `PAGE` in its `content` map and mock versions of the page's own api calls and
     events, as it has for Notifications, Proposals and the Timeline; without them the page is blank with no main.
  7. **index.html** for the new renderer file (below), and docs/VIEWS.md §9.

## A palette row or a built-in key

A Cmd+K row is a plain object: `{ id, group, icon, label, hint?, disabled?, run, keepOpen?, sub?, subAlways?, rank?,
kbd? }`.

- `id` is what a recorded key is stored against, so it never changes once shipped (Pin to current meeting kept
  `pinToMeeting`). A row that must not be recordable carries `rank` instead of `id`.
- `icon` is a name from `ICONS` (icons.js, built by scripts/build-icons.js). `keepOpen` marks a row that opens a
  palette page. `sub` is an async function answering the second level's rows, folded into the list as "<label>
  <choice>" once the query reaches the row; `subAlways` loads it as the palette opens (short fixed lists only).
  `kbd` is a literal chip for the fixed keys.
- **Where it is built**: rows about one concern come from a function in the file that owns it (`tableRows` in
  renderer/table.js, `notificationRows` in inbox.js, `meetingRows` in meeting.js, `fieldRows` in fields.js),
  called from `paletteRows` (renderer/palette.js); app-wide rows are pushed in `paletteRows` itself. Groups appear
  in push order: Selection or Current node, Table, Views, Searches, Types, View options, Actions, Navigate, Window,
  Settings, Help.
- **Order**: a row about the current node gets a place in `NODE_ROW_ORDER`, a view row in `VIEW_ORDER` (both
  renderer/palette.js); an app row is pushed where it belongs in its group.
- **A built-in key**: an entry `<row id>: '⌘X'` in `DEFAULT_HOTKEYS` (renderer/state.js), keyed by the row's id as
  `createTask: '⇧⌘Space'` is. The document keydown handler
  finds the row by combo and runs it through `runAction`, so the key shows as the row's chip and ⇧⌘K can re-record
  it. The recorder refuses the combos in `RESERVED` (renderer/palette.js) and any combo another row has. A key the
  outline's own keydown answers to must compare against `hotkeyFor(id)` and `preventDefault`, so the row does not
  run twice.
- **A palette page** (a second level): a `xRows(q, typed)` answering its rows (`q` lowercased, `typed` as typed), and an
  `openXPalette()` that sets its context, starts its read and calls
  `openPage(mode, placeholder, { rows: xRows, back: BACK_TO_COMMANDS })` (renderer/palette.js). The page is everything
  the palette needs: `back` is where Escape goes (closing when absent), `keys(e)` answers a key first, and `typed: true`
  marks a page whose row is what you type, so no "No results" is drawn under it. Nothing else registers it.
- Document the row and its key in docs/OUTLINER.md (Palette), and add a harness in
  scripts/renderer-behavior-check.js when the row decides something (`runMultiTaskPaletteCheck`,
  `runReservedComboCheck` and `runPaletteSkipCheck` are examples).

## A renderer file

1. **renderer/<name>.js** — `'use strict'`, then a comment saying what it owns.
2. **index.html** — a `<script src="renderer/<name>.js">` at the point where everything its top-level code uses has
   loaded. Functions may call anything declared anywhere (they run later); code that runs at load may only reach
   backwards. No name may be declared at top level in two files. scripts/renderer-check.js fails on either.
3. Nothing else registers it: scripts/renderer-source.js reads the list from index.html for the checks and for eslint.
4. Add it to the AGENTS.md map in load order.

Renderer constraints: the CSP is `default-src 'self'` (no inline scripts or styles: use classes, or
`style.setProperty`); icons come from `iconNode`, not `innerHTML`; a user action that needs the DOM right after calls
`render()`, anything that arrives on its own calls `renderSoon()`; whatever a list row is drawn from belongs in
`rowSig`.

## A setting

First decide whose it is (docs/SETTINGS.md, "What follows you"): a choice about your content follows you between
machines; a choice about this screen or this machine does not.

| | Follows you (the settings document in Tana) | Stays on this machine |
|---|---|---|
| Renderer | `pref(key, fallback)` / `setPref(key, value)` (renderer/prefs.js, stored as `pref:<key>`) | `localStorage` |
| Main | `settings.get(key)` / `settings.set(key, value)` (main/settings.js) | `db.setting(key)` / `db.setSetting(key, value)` (db.js) |

- Values are JSON and reads are synchronous. A preference key has no `:` in it.
- A main-process key follows you only if it matches `SYNCED` in main/settings.js; add a rule there for a new one.
  A key that is not listed is kept in SQLite on this machine, even though it is read with `settings.get` (that is how
  `openaiApiKey` stays put). Every `pref:` key is synced already.
- A preference another machine changes arrives as `settings:changed`; apply it to what is on screen in the
  `onSettings` handler in renderer/app.js (theme, Home, hotkeys and the arrangements are the examples).
- A main handler that writes a setting a page keeps a copy of (a view filter, a watch choice, an agent mark) calls
  `settings.tellOthers(e.sender)` (main/settings.js), so the other half of a split and every other window hear it as
  `settings:changed` too; a page left holding the old value draws it and writes it back with its next change.
- Add the key to the table in docs/SETTINGS.md.

## A document kind

A kind is the `<kind>` of `tana:<kind>:<ulid>` (AGENTS.md lists the ones Tana has). To have the views list it:

1. **sdk/query.js** — one entry in `KIND_NODE_TYPE` (view kind → node type). `VIEW_KINDS` and the reverse
   `NODE_TYPE_KIND` are derived from it, so the filter accepts it and a saved search reads it back; sdk-check
   round-trips every kind through a saved search. Leave it out of `ANY_KINDS` if it is not library content (spaces,
   people and types are asked for by name), and add its node type to `searchParams` if ⌘S should find it. sdk-check pins the exact lists these make (`VIEW_KINDS`,
   the library's and ⌘S's node types): update those assertions with it.
2. **main/state.js** — `PLAIN_KINDS`, which gives its rows the icon named after the kind and a kind tag, and also keeps
   its documents out of a meeting's or space's sidebar notes and outcomes (main/related.js `related`); if they belong
   there, that filter needs a set of its own. The SVG itself
   is an entry in `scripts/build-icons.js` `WANT` (which writes `icons.js`) or in `renderer/nodes.js` `LIB_ICONS`,
   the two tables `iconSvg` looks in.
3. **renderer/views.js** — its choice in the Type pill, `TYPES`.
4. **renderer/mock.js** — a row, and the kind in `kindOf`, which otherwise files it under docs.

What it may do is not guessed. Rows of a kind that `sdk/node.js` `editable()` does not list stay read-only, and main's
`mut` refuses writes to them; sharing, moving, deleting and archiving are `sdk/access.js` `KINDS`, `DELETABLE`,
`ARCHIVABLE` and `LINK_SHAREABLE`, and `ORGANIZED` puts org-wide sharing under the org's creation policy. Change those only from verified Tana behaviour.

To create one: a `kind` branch in `sdk/node.js` `initDocument` (seed exactly the keys Tana writes; read a real one with
`platform-cli rawdoc`), its id prefix in `main/state.js` `KINDS` (`createDocument` refuses a kind without one), and
an entry in `main/documents.js` `creationOptions` and the mock's `creationOptions` for Cmd+K and "/" to offer it.

## An outline block

1. **sdk/content.js** — how it reads: `node()` builds the outline node and `blockType` names it; a block that holds no
   words is in `ATOMS`.
   - A type the outliner can switch to: its name in `BLOCK_TYPES`, its leaf in `setLeaf` and its container in the `rehome(…)` call in `setBlockType`. A new
     ProseMirror node that carries words also goes in `TEXT_BLOCKS`, or `setText` and `setBlockType` refuse it once a
     row has become one; the container must be one Tana already has (`bulletList`, `orderedList` or `blockquote`). A new
     holder is a change to sdk/content.js of its own: every walk and wrap there tests `isList`/`isQuote`/`isHolder`, `LISTS` or the
     `'blockquote'` name (reading, ids, lookup, wrapping, rehoming), so find them all with
     `rg "isList|isQuote|isHolder|LISTS|'blockquote'" sdk/content.js`.
   - A block that is inserted (like a divider or a table): an `insert…` function beside `insertDivider`, exported from sdk/content.js and listed in
     docs/sdk/03-api-reference.md, then an IPC
     call for it as above (the `block:insert…` handlers in main/documents.js, preload.js, `DEMO_WRITES`, the mock),
     and its "/" row and dispatch in renderer/toolbar.js.
2. **renderer/nodes.js** — a switchable type's label in `BLOCK_TYPES` (what `blockTypeOf` and the "/" menu read) and
   its glyph in `BLOCK_GLYPH`. A block with no words of its own also goes in `isAtomic` (else keys type and split into it), and, when
   `node()` marks it `editable: false`, in `canEditStructure` (else it cannot be moved or deleted).
3. **renderer/render.js** draws it; styles.css styles it.
4. **scripts/sdk-check.js** — its outline section: the read, the write, and two Documents wired
   `local-update → applyRemote` converging.

## The checks to extend

`npm run lint` and `npm run check` must pass before every push; the scheduled checks run both on main, on Node 22.

| You changed | Extend |
|---|---|
| `sdk/` | scripts/sdk-check.js (offline: an in-process fake SyncService and the synthetic task fixture) |
| a `main/` module or an IPC handler | scripts/sdk-check.js, through `backend.handlers` |
| `db.js` | scripts/db-check.js |
| renderer behaviour | scripts/renderer-behavior-check.js: `functionSource(name)` and `sourceBetween` slice the real functions out of the renderer and run them in a vm with a fake DOM |
| renderer load order, a top-level name, a pinned rule | scripts/renderer-check.js. Some of its assertions match source text; when you rewrite a line one of them pins, move the assertion to the new code and keep what it asserts |
| live queries, presence, PDF export, the updater | scripts/livequery-check.js, presence-check.js, pdf-check.js, updater-check.js |

When the change moves a convention or an API, update the doc that describes it in the same PR.

Every PR also updates the manual, as it moves from draft to ready (until then its Platforms line says `when ready: <the chapter>`): the chapter that owns the feature, its scene in `manual/scenes/` and its pictures, then `node manual/scenes/index.js --coverage`. The orbital-manual skill (`.agents/skills/orbital-manual/SKILL.md`) says which chapter owns what and how to re-record a picture.
