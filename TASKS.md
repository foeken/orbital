# TASKS.md — request tracker

Every request made during the build and its state. ✓ done and verified · ◐ in progress · ○ remaining (work stopped at user request). Newest at the bottom; keep this file current.

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
| 14 | Assignees render + changeable; "Visible for" renders — mock up first | ✓ Browser assignment edit/save and native assignee/visibility display verified; see #93 for bootstrap race follow-up. | — |
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
| 31 | Cmd+Shift+ +/- changes font size; Cmd+0 resets zoom | ○ Implemented, including Cmd+0; final native font-size/reset check remains. | preload.js zoom, renderer |
| 32 | Expanding an empty node shows a draft child (saved once it has content) | ✓ | renderer |
| 33 | Enter in Tasks/Meetings creates a draft task/meeting | ✓ (creation verified live) | sdk/node.js initDocument, main.js |
| 34 | "The one where…" nodes: doc icon + # doc | ✓ | main.js, icons.js |
| 35 | Breadcrumbs show the real location (space / Library) | ✓ | main.js pathOf, renderer |
| 36 | Does Tana support SVG icons on nodes? | ✓ answered: no (appearance.imageUri/hue only) | — |
| 37 | @-search: title matches first; no Create when the title exists | ✓ | main.js search, renderer |
| 38 | Spaces (Foundry LT) rendered as spaces, listing their documents | ✓ | main.js spaceChildren, renderer |
| 39 | Multi-select nodes; Cmd+Shift+Backspace deletes and Cmd+Shift+Up/Down moves the selection | ○ Atomic batch IPC/SDK and renderer integrated; offline group undo/redo passes. Retest multi-move/delete and one-step undo visually. | renderer |
| 40 | Blinking caret on empty draft nodes | ○ Empty-draft caret implementation present; final visual caret check remains. | renderer |
| 41 | Search Tana members, tag # member | ✓ Member data appears in search/view; member tags and read-only state verified. | main.js members, sdk/query.js |
| 42 | Task filters: Status and Assigned pills | ✓ Browser status and assignee pills open without error; backend filter checks pass. | main.js taskFilter |
| 43 | Edit the title of a zoomed node; Cmd+K on the title | ✓ Browser zoomed title edit saved; Cmd+K on title exposes current-node actions. | renderer |
| 44 | Library view with a similar type filter | ✓ Browser Library view/type picker verified; fixed search field removed. | main.js library, sdk/query.js |
| 45 | Chevron a bit more to the left; pin icons for sidebar and today | ○ Caret spacing and supplied pin icons implemented; final visual comparison remains. | icons.js (pin, pinDate) |
| 46 | Loading skeleton bars on first boot | ○ Skeleton implementation present; cached/uncached native boot verification remains (see #98). | renderer |
| 47 | Document everything learned for a future agent; track requests in TASKS.md | ✓ | AGENTS.md, TASKS.md, docs/ |
| 48 | Type tags in the type's colour (appearance.hue) | ○ Custom type colors implemented; Project tag verified in preview. Verify real custom-type hues. | main.js typeTag, CLI types |
| 49 | Images in the outline (image blocks -> api.image(uri) data URL, cached) | ○ Mock image renders and SDK image checks pass; real Project Aegis visual recheck remains. | sdk/content.js, sdk/assets.js, main.js image, CLI image |
| 50 | Structured SDK documentation for future agents (overview, data model, API reference, recipes, gotchas) | ✓ | docs/sdk/, sdk/README.md |
| 51 | Stale recently viewed text nodes render with the doc icon and tag | ✓ | renderer.js recent cache migration |
| 52 | Zoomed task title checkbox | ✓ Browser zoomed task checkbox toggles completion and retains child content. | Renderer integration / assigned agents |
| 53 | @ links in zoomed title | ✓ User chose native plain-text titles; durable links remain in content only. No app-local title links. | Renderer integration / assigned agents |
| 54 | Chats view, exclude MCP chats by default | ○ Chats view implemented; final MCP exclusion/toggle visual check remains. | Renderer integration / assigned agents |
| 55 | Assigned filter crash | ✓ Assigned filter opens in browser without crash; renderer checks pass. | Renderer integration / assigned agents |
| 56 | Lighter blue filter hover; asterisk for Any type | ○ Filter styling implemented; final hover check remains. Asterisk superseded by #69 pop.svg. | Renderer integration / assigned agents |
| 57 | Remove fixed Library search field | ✓ Browser Library has no fixed search field; Cmd+F remains the filter entry point. | Renderer integration / assigned agents |
| 58 | MCP chats grey/blue toggle without shown/hidden text | ○ Toggle implementation present; verify grey/blue states and exact MCP chats label visually. | Renderer integration / assigned agents |
| 59 | Sidebar pin uses supplied pin.svg | ○ Supplied pin.svg integrated; final command icon visual check remains. | Renderer integration / assigned agents |
| 60 | Rebuild and run latest app | ○ Latest package build succeeded at stop. Clean native restart and final boot/error check remain. | Renderer integration / assigned agents |
| 61 | Startup login button flashes despite an existing session | ○ Earlier native session boot passed; new startup fixes require clean recheck with #97/#98. | Renderer integration / assigned agents |
| 62 | Cmd+K “Set Image” uses the supplied images-3.svg | ○ Supplied images-3.svg and Set Image command implemented; final icon/flow check remains. | Renderer integration / assigned agents |
| 63 | Use the node’s appearance.hue to color its icon and tag, including spaces | ○ Node hue propagation implemented; final real space icon/tag color check remains. | Renderer integration / assigned agents |
| 64 | Long dropdown lists (including Assigned to) should stop before the window edge and scroll internally | ○ Bounded dropdown CSS implemented and preview inspected; final short-window keyboard-scroll check remains. | Renderer integration / assigned agents |
| 65 | Square corners for node selection highlights, including multi-selection | ✓ CSS verified by Mill; unrelated controls preserved | Renderer integration / assigned agents |
| 66 | Members top-level view in Cmd+K, using supplied circle-user.svg | ✓ Browser People command opens member view with member tags; label change tracked in #94. | Renderer integration / assigned agents |
| 67 | Discover pinned sidebar sections and show their grouping in Cmd+K | ✓ Native Cmd+K shows real Pinned and Foundry groups in order. | Renderer integration / assigned agents |
| 68 | Chat nodes use the chat icon consistently, not a generic bullet/doc icon | ○ Shared chat icon mapping implemented; final visual check across node/search/pins remains. | Renderer integration / assigned agents |
| 69 | Any type icon uses supplied pop.svg instead of asterisk.svg | ✓ exact SVG and generated ICONS.any verified by Mill | Renderer integration / assigned agents |
| 70 | Cmd+K repeats “Pinned” around named sections; combine unsectioned pins under one heading | ✓ Native Cmd+K contains one Pinned heading; deleted Test Pin absent. | Renderer integration / assigned agents |
| 71 | Remove Sync hotkey | ✓ Browser Cmd+K Sync has no displayed shortcut; shortcut regression passes. | Renderer integration / assigned agents |
| 72 | Respect node editability; lock read-only nodes such as member names | ✓ Read-only member cannot edit; populated content expands and empty member creates no draft. Backend permission checks pass. | Renderer integration / assigned agents |
| 73 | Cmd+Enter converts a plain node into a native Tana checkbox node, matching Scratchpad | ✓ Native SDK checks and actual browser keyboard test pass: conversion preserves children, checkbox sibling inherits unchecked, task children stay plain. Rapid Enter typing regression fixed and visually retested. | Renderer integration / assigned agents |
| 74 | @ search defaults to first matching result, not Create; Cmd+Enter still creates | ○ Search/link selection implementation present; final actual @ Enter and Cmd+Enter visual checks remain. | Renderer integration / assigned agents |
| 75 | Backspace deletes multi-selected nodes without modifiers | ✓ Browser Shift+Down then Backspace deletes selected siblings and descendants; batch undo follow-up remains in #39. | Renderer integration / assigned agents |
| 76 | New node under a checkbox node inherits checkbox formatting | ✓ Native SDK checks and actual browser keyboard test pass: conversion preserves children, checkbox sibling inherits unchecked, task children stay plain. Rapid Enter typing regression fixed and visually retested. | Renderer integration / assigned agents |
| 77 | Track all new requests as numbered rows in this same table | ✓ consolidated; standing rule | TASKS.md |
| 78 | Assignee metadata shows names only; visibility icons: lock = only me, user-lock = selected people, house-lock = space, users-3 = everyone | ○ Metadata icons/names implemented; private-task bootstrap race fixed. Final native visibility checks remain. | renderer.js, main.js, sdk/node.js, icons.js |
| 79 | Fix checkbox inheritance: children of a task remain plain; only new siblings following an actual checkbox block inherit checkbox format | ✓ Native SDK checks and actual browser keyboard test pass: conversion preserves children, checkbox sibling inherits unchecked, task children stay plain. Rapid Enter typing regression fixed and visually retested. | renderer.js, sdk/content.js |
| 80 | Cmd+K action to edit node visibility | ○ Native rules, sharing token, audience disclosure and stale-token handling implemented; final picker/error-path visual check remains. | main.js, sdk/, renderer.js |
| 81 | Cmd+K action to move a node to a space | ○ Native preview/token flow implemented; before/after confirmation visually appeared. Final successful move/cancel/stale-preview checks remain. | main.js, sdk/, renderer.js |
| 82 | Deleted and unpinned Test Pin still appears; invalidate stale pins/search/recent cache | ✓ Explicit removal and ordinary refresh regressions pass; native Cmd+K no longer lists deleted Test Pin. | main.js, sdk/sync.js, renderer.js, db.js |
| 83 | Agent nodes use the existing agent icon consistently in lists, search, pins and zoom | ○ Agent kind/icon mapping implemented; final actual node icon visual check remains. | main.js, renderer.js, icons.js |
| 84 | Library uses supplied bookmarked-book.svg icon | ○ Supplied bookmarked-book.svg integrated; final Library command icon visual check remains. | build/icons/, scripts/build-icons.js, icons.js, renderer.js |
| 85 | Foundry Goals embedded task reference renders as empty bullet; render referenced task correctly | ○ Native embed parsing/resolution regression passes; real Foundry Goals embedded task visual recheck remains. | sdk/content.js, main.js, renderer.js |
| 86 | Cmd+K toggles Light/Dark mode, matching supplied charcoal outliner style; use supplied dark-light.svg icon | ○ Light/dark mode and supplied icon verified in preview/native; final overlay/recorder contrast check remains. | styles.css, renderer.js, index.html |
| 87 | Hide redundant #task tag when a task has a custom type such as Project | ✓ Shared tag rendering hides #task for custom-typed tasks. Browser verified Project tag with retained checkbox; npm run check passes. | renderer.js |
| 88 | Verify private risk task is not incorrectly displayed as visible to everyone | ✓ Rebuilt native app verified task displays Visible only to you, matching Tana. Reported everyone value came from localhost sample data; no ACL changes. | main.js, sdk/node.js, renderer.js |
| 89 | Space visibility tooltip includes the space name | ○ Named-space metadata and tooltip implemented; final real named-space hover check remains. | main.js, renderer.js |
| 90 | Cmd+Shift+Backspace deletes the zoomed top-level node | ○ Reversible document delete/restore, permission gating and history implemented. Final visual delete/restore of a newly created item remains after preview permission fix. | renderer.js |
| 91 | Edit assignees dismisses picker after successful assignment | ✓ Browser keyboard assignment updated assignee and closed picker; failure-stays-open regression passes. | renderer.js |
| 92 | Empty read-only nodes cannot expand or show draft children; existing content remains expandable | ✓ Browser verified empty member resolves without draft/caret; member with content expands and remains read-only. | renderer.js |
| 93 | Investigate remaining Visibility unknown items that Tana shows as Only me, including send and Testing | ○ User still sees incorrect unknown labels after the fixes. Investigate all remaining examples, not only send and Testing; verify real metadata, bootstrap readiness and cache invalidation. Recorded only; do not investigate until work is resumed. | sdk/node.js, main.js |
| 94 | Rename Members view entry in Cmd+K to People | ✓ Browser verified People command opens member view; #member tags preserved. | renderer.js |
| 95 | Use supplied circle-dotted-user.svg for Unassigned | ✓ Supplied SVG built as currentColor; browser screenshot verified dotted-user icon beside Unassigned metadata. Picker uses same icon. | build/icons, icons.js, renderer.js |
| 96 | Cmd+K Create new opens type chooser (Task, Meeting, Chat, custom types) and zooms into new item; use supplied square-dashed-plus.svg | ○ Chooser/native initializers/supplied icon implemented. Click flow and typed zoomed task draft verified; keyboard activation, all type choices and new-item deletion need final visual retest. | main.js, preload.js, renderer.js, sdk/node.js |
| 97 | Electron app errors on boot | ○ Startup metadata retry storm reproduced; connection gating/failure suppression implemented and checks pass. Latest package built; clean native boot/log verification remains. | main.js, dist |
| 98 | Boot skeleton overlaps loaded/cached content | ○ Skeleton now requires an empty rendered outline; checks pass. Verify cached-content boot has no overlay and fresh boot still pulses. | renderer.js, styles.css |

Tracking rule: append new requests to the numbered table above using the next integer. Update an existing row for repeated requests; never create a separate unnumbered request list. Preserve status and verification evidence. Orchestrator owns this file.

Stopped at user request. All four worker agents are closed; no development or tests remain running under their ownership. The latest package build succeeded. The last full check run passed SDK, database, renderer auth and renderer behavior checks, but this is not proof of all visual requirements. Development remains stopped; committing this checkpoint does not mark the outstanding verification complete.

Resume with #97/#98 clean native boot, then #93 private metadata, #39/#90 grouped and document undo/delete, #96 creation chooser, and the other open visual checks above. See docs/VERIFICATION.md for observations. Do not mark these complete based only on worker reports.

Title-link decision resolved: the user chose native plain-text titles; links remain in content (#53).
