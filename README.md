# Tana Companion

A small macOS app for the new Tana (home.tana.inc), rendered the way Tana's own outliner reads: every
line is a node, top-level rows are documents and their children are the document's content blocks.
It is not a wrapper around the web app — it talks to Tana's platform sync directly (Connect-RPC plus
Loro CRDTs), so edits are written back as you type and changes made anywhere else arrive within a
second.

It exists because a keyboard-first outline over your own tasks, meetings and notes is a different
thing from a browser tab, and because the round trip through a web view makes a list feel slow.

## What it does

**Six views that are one screen.** Inbox, Tasks, Meetings, Library, Chats and People are the same
list with a different filter on it: a kind, a status, an assignee, a text query. The Library picks
its own kinds; the other five are what their name says. Each view keeps its own filter, sort and
grouping, and each caches its rows, so any of them opens instantly and stays readable while auth or
sync reconnect. The contract is in [docs/VIEWS.md](docs/VIEWS.md).

**An outliner, not a form.** Type anywhere. Enter splits or creates a node, Tab and Shift+Tab nest
and unnest, Backspace on an empty node removes it, Cmd+Up/Down collapse and expand, Cmd+Shift+Up/Down
move a node among its siblings, and clicking a bullet zooms in. `/` at the start of a node opens the
block menu (headings, lists, code, quote, divider, tables, new documents); `@` links to another node;
selecting text opens the formatting bar. Undo and redo are CRDT-aware and local-only: Cmd+Z never
rolls back someone else's edit. The full keyboard contract is [docs/OUTLINER.md](docs/OUTLINER.md).

**Cmd+K for everything else.** Switch views, run an action on the current node (copy link, show
in Tana, pin, set an icon, change visibility, move to a space), or act on a multi-selection: Cmd+click
rows, then mark them sensitive, add them to today's, tomorrow's or the week's node, set a status, assign them or
delete them; with nothing selected the same actions apply to the node you are on. "Today"
and "This week" (both under Views) open (and create) the date-titled and the "Week 38 (2026)" documents.
Cmd+Shift+K on any palette row records a hotkey for it, and refuses one the app already uses. Cmd+S
searches Tana itself, with `#task`, `#meeting`, `#space`, `#member` and `#<Type>` filters; Cmd+F
filters the rows already on screen.

**Quick add from anywhere.** Cmd+Shift+Space opens a small panel over whatever app you are in: type a
task and press Enter. If you are in a meeting right now it says so and pins the new task to that
meeting; if you are not, it says that instead and creates a plain task. Tab picks an assignee from
your workspace members without leaving the keyboard. The panel is described in
[docs/QUICK-ADD.md](docs/QUICK-ADD.md).

**The things a day needs.** Meetings carry their times and mark today; a meeting's sidebar shows its
call link, its notes and its pins. Tasks carry state, assignee and audience. Sensitive nodes are
redacted for screen-sharing and toggled back with one command, and titles you never want to see
("Lunch", "Block*") can be hidden from every list and search. None of that leaves the machine: the
sensitive marks, the hidden list and the row cache are local.

## Running it

macOS on Apple Silicon, Node 24, and a Tana account.

```sh
npm install
npm start
```

On first run, open Cmd+K and choose **Log in to Tana**: a window opens on home.tana.inc, you sign in
as usual, and the cookie session stays in the app's own partition. Everything after that is
background: the access token is refreshed before it expires, every listed document is subscribed for
live updates, and the active view is re-queried every 30 seconds and whenever the window regains
focus.

Local state lives in `~/Library/Application Support/tana-tasks`: the SQLite row cache, cached images,
the sync peer identity and the login partition. Deleting that folder resets the app without touching
anything in Tana.

## Releasing

Releases are signed, notarized and published to a public repo, so the source repo can stay private
and the updater needs no token:

```sh
npm run release            # patch; also accepts minor, major or an explicit version
```

It refuses to start on a dirty tree, then checks both credentials **before** bumping anything, since a
failure afterwards would leave a local commit and tag to undo:

- a **Developer ID Application** certificate in the Keychain, and
- a `notarytool` keychain profile that still authenticates (`xcrun notarytool store-credentials`).
  Override the profile name with `TANA_NOTARY_PROFILE`.

Then it bumps the version, packages the arm64 bundle with the hardened runtime, notarizes and staples
it, validates the staple, prints the verdict Gatekeeper will give on someone else's Mac, zips the
bundle with `ditto` (which preserves both the signature and the ticket), pushes the commit and tag,
and publishes the zip to `foeken/tana-companion-releases` — override with `TANA_RELEASES_REPO`.
Signing every nested file takes a few minutes; let it finish, and never run two packager builds at
once, because the packager clears a shared temporary tree at startup and the second run breaks the
first in a way that looks like a signing bug.

The app updates itself from that public repo: it checks at launch, once a day, and from
**Check for Updates…** in the app menu, over the plain GitHub API with no token. On "Update and
Restart" it downloads the zip, and a detached shell waits for the app to quit, swaps the bundle and
reopens it. No Squirrel — its signature check cannot pass for a bundle swapped this way, and the swap
is a dozen lines ([updater.js](updater.js)).

## Development

`npm run check` runs everything offline: the SQLite cache, the SDK against a fake sync service and a
real task snapshot, and the renderer's auth and behaviour checks. It must pass before a commit, and
every non-trivial change is expected to leave a check behind that fails when the logic breaks.

```sh
npm run check                       # all offline checks
npm run package                     # dist/Tana Companion-darwin-arm64/Tana Companion.app
npm run tana -- whoami              # the platform, without the UI
npm run icon                        # re-render build/icon.icns
node scripts/build-icons.js <dir>   # regenerate icons.js from the line icon set
node scripts/build-nucleo.js        # rebuild build/nucleo-ui.json.gz (the Set icon set) from the local Nucleo library
```

`npm run tana` is an Electron-run CLI over the same SDK: `login`, `whoami`, `search`, `get`,
`outline`, `watch`, `create`, `delete`, `set-title`, `set-state`, `fields`, `graphnode`, `edges`,
`caps`, `rows` and more — useful for checking what Tana actually returns before changing code.

## How it is put together

`main.js` is the Electron process boundary (window, menu, the IPC table, boot) and `main/` is what
it delegates to: shared state, rows, documents and their undo stack, the meeting hub, the six views
and their refresh loop, pins, images. `renderer/` with `index.html` and `styles.css` is the whole UI:
eighteen plain scripts sharing one global scope, loaded in the order `index.html` lists them, no
framework and no bundler. `sdk/` is a generic, Electron-independent Tana client (graph
queries, the sync stream, Loro documents, outline operations, access rules); `tana-session.js` is the
login and token layer; `db.js` is the local SQLite cache.

Start with [AGENTS.md](AGENTS.md) for the map and the working rules, then the docs:
[VIEWS.md](docs/VIEWS.md) (the six views), [OUTLINER.md](docs/OUTLINER.md) (the UI and keyboard
contract), [PLATFORM-PROTOCOL.md](docs/PLATFORM-PROTOCOL.md) (the wire protocol, the source of
truth), [sdk/01–05](docs/sdk) (overview, data model, API reference, recipes, gotchas),
[MEETINGS.md](docs/MEETINGS.md), [CHATS.md](docs/CHATS.md), [PINNING.md](docs/PINNING.md) and
[VERIFICATION.md](docs/VERIFICATION.md) (what was checked against real data, and how).

## The caveat

This speaks Tana's undocumented `v1alpha1` protocol, reverse-engineered from their web client. It can
break with any deploy of theirs. When it does, the protobuf descriptors are re-extracted from the
current bundle and diffed against `sdk/proto/descriptors.js`; the how is in
[docs/PLATFORM-PROTOCOL.md](docs/PLATFORM-PROTOCOL.md).
