# Adding a feature

The steps and files for the changes that come up again and again. Each section names the files in the order you
touch them. Read [AGENTS.md](../AGENTS.md) first for the map and the working rules; this file assumes it.

Two rules hold everywhere:

- **Code goes to the file that owns the concern.** Tana-side knowledge is `sdk/` (Electron-free, checked offline),
  the app's use of Tana is a module in `main/`, `main.js` is only the process boundary (windows, menu, the IPC
  table, boot), and each renderer concern is one file in `renderer/`. A new concern is a new file; a new piece of an
  existing one goes in that file.
- **Dependencies point one way.** `sdk/` requires neither `main/` nor electron. A `main/` module requires only the
  modules before it in the order AGENTS.md lists; when an earlier one has to reach a later one, the later one sets a
  function on `S` (main/state.js), as `main/views.js` sets `S.refresh`. The renderer reaches main only through
  `tana`, the preload API.

## An IPC call

1. **main.js** — `ipcMain.handle('<area>:<verb>', (e, ...args) => module.fn(...args))`. The channel is named by area
   and verb (`doc:setTitle`, `block:split`, `pins:pin`, `meeting:edit`, `window:split`). The renderer is input
   from outside the process: check ids and shapes here (`DOC_URI` in main/state.js, the regexes in
   `customCreation`), and keep the logic in the `main/` module that owns it, so the handler stays one line.
2. **preload.js** — one method on `window.api`, named for what it does, with a comment giving the shape of its answer:
   `meetingInfo: (docId) => ipcRenderer.invoke('meeting:info', docId), // { editable, start, end, … }`.
3. **Renderer** — call it as `tana.meetingInfo(id)` (renderer/state.js). Never declare a top-level `api`, and never
   call `window.api` directly: `tana` is the copy demo mode guards. Where the mock or an older main may lack the
   method, guard the row or the call with `if (tana.meetingInfo)`, as the palette rows do.
4. **A write to Tana** — add the method's name to `DEMO_WRITES` (renderer/state.js), so demo mode refuses it with
   "Demo mode is on: nothing is saved to Tana" wherever it is called from.
5. **renderer/mock.js** — add it when the UI should work without main (the mock stands in when `window.api` is
   undefined).
6. **Push instead of pull** — main sends with `send('<area>:changed', …)` (main/state.js: every page of every
   window) or `e.sender.send(…)` (the page that asked); preload adds `onX: (cb) => ipcRenderer.on('<area>:changed',
   (_e, v) => cb(v))`; the renderer subscribes once at load, in the file that owns the concern (live document changes
   are renderer/app.js). A document change goes through `sendChanged` so the page that typed it hears it as `own`.
7. **Check** — `scripts/sdk-check.js` loads main.js with a fake electron and keeps every handler:
   `backend.handlers.get('<area>:<verb>')(null, ...args)` (the field checks around `outline:children` are an example).

## A main-process module

1. **main/<name>.js** — `'use strict'`, then a comment saying its one job and which doc describes it.
2. Require only modules earlier in the order (AGENTS.md map). Reassigned shared state (the client, the user, the
   windows) is read from `S`; shared caches are the Maps exported by main/state.js. A new Tana capability goes into
   `sdk/` first and the module uses it.
3. Export plain functions. main.js requires the module and wires its IPC; boot-time work is started from main.js's
   boot sequence.
4. Add it to the AGENTS.md map at its place in the order, and give it checks in scripts/sdk-check.js, which runs
   main.js and every `main/` module in one vm context.

## A view or a page

Pick the smallest that fits:

- **A list over some kinds with a filter** is a saved search (`tana:search:`, docs/VIEWS.md §6): the user makes one
  with Create new … → Search. No code.
- **A new preset of the one view**: an entry in `VIEWS` (main/state.js: id, title, icon) and in `VIEW_PRESETS`
  (sdk/query.js), its id in `VIEW_ORDER` (renderer/palette.js), and optionally a starting arrangement in
  `VIEW_ARRANGEMENT` (renderer/views.js). The cache, the pills, the live refresh and the Cmd+K row come with it.
  Update docs/VIEWS.md §2.
- **An app page** — rows that are not a Tana node's children, like Notifications, Proposals and the Timeline:
  1. **main/<page>.js** exporting `PAGE = 'orbital:<page>'` and `rows()`, which answers `Node[]` (read-only rows,
     built with `graphRow`/`toNode` from main/rows.js when they are documents).
  2. **main.js** — a branch for `page.PAGE` in the `outline:children` handler, which is where every id is routed.
  3. **renderer/<page>.js** — at load, `extra.set(PAGE, { id: PAGE, text, title, kind: 'document', icon, editable:
     false, hasChildren: true, appPage: true })`, so `goTo`, Back and Recent find it without asking main; and a
     `<page>ViewRow()` answering `{ id, group: 'Views', icon, label, hint, run: () => goTo(PAGE) }`.
  4. **renderer/palette.js** — push that row with the other view rows in `paletteRows`, guarded by the api it needs,
     and add its id to `VIEW_ORDER`.
  5. **Live** — main sends a channel when the page's source changes; the renderer reloads it only when
     `zoom?.docId === PAGE`.
  6. **index.html** for the new renderer file (below), and docs/VIEWS.md §9.

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
- **A built-in key**: an entry `id: '⌘X'` in `DEFAULT_HOTKEYS` (renderer/state.js). The document keydown handler
  finds the row by combo and runs it through `runAction`, so the key shows as the row's chip and ⇧⌘K can re-record
  it. The recorder refuses the combos in `RESERVED` (renderer/palette.js) and any combo another row has. A key the
  outline's own keydown answers to must compare against `hotkeyFor(id)` and `preventDefault`, so the row does not
  run twice.
- **A palette page** (a second level): an `openXPalette()` that calls `showPage(mode, placeholder)`, sets its own
  context, starts its read and calls `renderPalette()`; a `xRows(q)` that `renderPalette` uses for that `palMode` (or
  a table of pages like `MEETING_PAGES` in renderer/meeting.js); and the mode in `SECOND_LEVEL` in `backPalette`, so
  Escape steps back to the command page.
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
- A preference another machine changes arrives as `settings:changed`; apply it to what is on screen in the
  `onSettings` handler in renderer/app.js (theme, Home, hotkeys and the arrangements are the examples).
- Add the key to the table in docs/SETTINGS.md.

## The checks to extend

`npm run lint` and `npm run check` must pass before every push; CI runs both on Node 22.

| You changed | Extend |
|---|---|
| `sdk/` | scripts/sdk-check.js (offline: an in-process fake SyncService and the synthetic task fixture) |
| a `main/` module or an IPC handler | scripts/sdk-check.js, through `backend.handlers` |
| `db.js` | scripts/db-check.js |
| renderer behaviour | scripts/renderer-behavior-check.js: `functionSource(name)` and `sourceBetween` slice the real functions out of the renderer and run them in a vm with a fake DOM |
| renderer load order, a top-level name, a pinned rule | scripts/renderer-check.js. Some of its assertions match source text; when you rewrite a line one of them pins, move the assertion to the new code and keep what it asserts |
| live queries, presence, PDF export, the updater | scripts/livequery-check.js, presence-check.js, pdf-check.js, updater-check.js |

When the change moves a convention or an API, update the doc that describes it in the same PR.
