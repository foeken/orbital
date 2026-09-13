# TASKS.md — request tracker

Every request made during the build and its state. ✓ done and verified · ◐ in progress · ○ open. Newest at the bottom; keep this file current.

| # | Request | State | Where |
|---|---------|-------|-------|
| 1 | Small macOS Electron companion app with its own task database, syncing to/from Tana; old Outliner look; select / double-click edit / check off / filter / expand | ✓ | main.js, db.js, renderer |
| 2 | Data must come from the new Tana | ✓ | sdk/ |
| 3 | Use subagents (Fable 5.1) with the main agent coordinating | ✓ | process |
| 4 | Sync as a menu bar item | ✓ (later replaced by Cmd+K) | — |
| 5 | Hook into Tana's live updates instead of MCP | ✓ | docs/PLATFORM-PROTOCOL.md, sdk/sync.js |
| 6 | Login from the app, reuse the session, drop MCP, clean SDK layer | ✓ | tana-session.js, sdk/ |
| 7 | Keep the SDK generic (all items, not just tasks) | ✓ | sdk/ |
| 8 | Full Tana-Outliner UI: nodes, Tab to nest, each block a Tana node; generic copy; Tasks first | ✓ | renderer.js, sdk/content.js, docs/OUTLINER.md |
| 9 | Cmd+Shift+Up/Down moves a node | ✓ | sdk/content.js move |
| 10 | References render as underlined links that navigate | ✓ | renderer |
| 11 | Remove the "Connected" footer | ✓ | renderer |
| 12 | Filter hidden, Cmd+F shows it | ✓ | renderer |
| 13 | Keep the original task icon | ✓ (Nucleo line set) | icons.js |
| 14 | Assignees render + changeable; "Visible for" renders — mock up first | ○ mockup at docs/mockups/assignees-visibility.png, awaiting verdict | — |
| 15 | Icons as SVG from Nucleo, greyscale; links in the Outliner blue | ✓ (#508fbb) | scripts/build-icons.js |
| 16 | Remove the person icon from links | ✓ | renderer |
| 17 | Sync generic; "# task"/"# meeting" tags like "# todo"; typed docs tagged; Meetings list | ✓ | main.js, renderer |
| 18 | Hover chevron circle (expanded/collapsed) | ✓ | styles.css |
| 19 | Bullet halo for collapsed-with-children; green checked box | ✓ | styles.css |
| 20 | App name and icon (Tana logo) | ✓ Tana.app → renamed | build/, scripts/build-icon.js |
| 21 | Cmd+K palette with Sync, Tasks, Meetings as views | ✓ | renderer |
| 22 | Cmd+S search palette for any top-level item | ✓ | main.js search, renderer |
| 23 | Undo/redo; Cmd+Shift+Backspace removes the node; ensure todo works | ✓ (todo verified live) | sdk/document.js, main.js |
| 24 | Sync icon; Cmd+Shift+K hotkey recorder; smaller centred chevron; past meetings; #type search filters; no current title in breadcrumb; @ on a selection links or creates | ✓ | renderer, sdk/query.js |
| 25 | Empty search shows recently viewed | ✓ | renderer |
| 26 | Find out how pinning works; pin to sidebar and today from Cmd+K | ✓ | docs/PINNING.md, sdk/pins.js |
| 27 | Customize a node's icon via Cmd+K + SVG drop | ✓ (app-local) | main.js, db.js, renderer |
| 28 | Name "Tana Companion" not Electron; icon moved down; remove Tana > Sync menu | ✓ | package.json, main.js |
| 29 | Animate the recording dot; smaller button fonts | ✓ | styles.css |
| 30 | Keyboard first; Down with nothing focused focuses the top node | ✓ (standing rule in docs/OUTLINER.md) | renderer |
| 31 | Cmd+Shift+ +/- font size | ✓ | preload.js zoom, renderer |
| 32 | Expanding an empty node shows a draft child (saved once it has content) | ✓ | renderer |
| 33 | Enter in Tasks/Meetings creates a draft task/meeting | ✓ (creation verified live) | sdk/node.js initDocument, main.js |
| 34 | "The one where…" nodes: doc icon + # doc | ✓ | main.js, icons.js |
| 35 | Breadcrumbs show the real location (space / Library) | ✓ | main.js pathOf, renderer |
| 36 | Does Tana support SVG icons on nodes? | ✓ answered: no (appearance.imageUri/hue only) | — |
| 37 | @-search: title matches first; no Create when the title exists | ✓ | main.js search, renderer |
| 38 | Spaces (Foundry LT) rendered as spaces, listing their documents | ✓ | main.js spaceChildren, renderer |
| 39 | Multi-select nodes; Cmd+Shift+Backspace deletes and Cmd+Shift+Up/Down moves the selection | ◐ renderer (Euclid) | renderer |
| 40 | Blinking caret on empty draft nodes | ◐ renderer (Euclid) | renderer |
| 41 | Search Tana members, tag # member | ✓ main · ◐ renderer | main.js members, sdk/query.js |
| 42 | Task filters: Status and Assigned pills | ✓ main · ◐ renderer | main.js taskFilter |
| 43 | Edit the title of a zoomed node; Cmd+K on the title | ◐ renderer | renderer |
| 44 | Library view with a similar type filter | ✓ main · ◐ renderer | main.js library, sdk/query.js |
| 45 | Chevron a bit more to the left; pin icons for sidebar and today | ◐ renderer | icons.js (pin, pinDate) |
| 46 | Loading skeleton bars on first boot | ◐ renderer | renderer |
| 47 | Document everything learned for a future agent; track requests in TASKS.md | ✓ | AGENTS.md, TASKS.md, docs/ |
| 48 | Type tags in the type's colour (appearance.hue) | ✓ main · ◐ renderer | main.js typeTag, CLI types |
| 49 | Images in the outline (image blocks -> api.image(uri) data URL, cached) | ✓ main/SDK · ◐ renderer | sdk/content.js, sdk/assets.js, main.js image, CLI image |
| 50 | Structured SDK documentation for future agents (overview, data model, API reference, recipes, gotchas) | ✓ | docs/sdk/, sdk/README.md |
| 51 | Stale recently viewed text nodes render with the doc icon and tag | ✓ | renderer.js recent cache migration |

Open questions: meeting notes live outside event documents (events have empty content); Cmd+K context actions for a focused (not zoomed) document child.
