# Testing Orbital

The goal: an agent can change Orbital without breaking the flow of someone using it. This page says what has broken
before, which check guards each kind of break, and what a change has to add. Every check runs on the mock or on fakes,
so the whole set stays fast; only what the mock cannot reach needs the running app.

## What breaks

Read from the 307 merged PRs up to 2026-10-01: 771 findings from the review bots (616 distinct), the issues that
reported a regression, and the follow-up PRs that gathered them (#491, #546). Most findings fall into a few kinds, and
the same kinds came back PR after PR.

| Kind | What went wrong | Examples |
|------|-----------------|----------|
| Out-of-order answers | A late answer for a page, pill, search or pin read you already left replaced the one you were on. The single largest group of findings. | #399 (12 findings), #406 (20), #404, #463, #640, #354 |
| Live updates and caches | A change made elsewhere did not show, showed twice, wiped what you were typing, or a released document was never read again. | #148, #228, #265, #289, #406, #436 (13), #452 |
| Private words | A new surface showed a sensitive title or a real word in demo mode: palette hints, meeting locations, image pixels, tab titles, tooltips, the iPhone's VoiceOver labels. | #157 (9), #203, #435, #447, #659 (6) |
| Write access | A read-only row could be written, or an unknown (inherited) access was treated as read-only. | #170, #447, #545, #659 |
| Keys and focus | Escape, a click outside or a palette page left the caret somewhere else, or a recorded shortcut did not run; ↑ stayed inside a code block's padding, aimed at a title a tab bar hid, or circled a page's fields under a read-only title. | #187, #200, #288, #377, #463, #603, #764 |
| Screen and saved outline apart | Enter flashed old text, ⇧↑ selected nothing, a draft row stayed after a delete, a checkbox leaked into a new row. | #125, #488, #489, #490, #601, #603 |
| Panes and windows | State that belongs to one pane leaked into another, or closing a pane lost an edit or a presence. | #138, #164, #435, #463, #474 |
| Drift | Docs, the mock, the manual or the PR description no longer matched the code; a third of all findings. New code no check exercised. | #314, #324, #607, #671, and "not covered by npm run check" in #510, #659, #668, #673, #677 |
| iPhone | VoiceOver read what the eye could not see, Reduce Motion was ignored, demo mode let a write through, the Timeline built itself for good while a request in Tana's page never answered. | #659, #677, TestFlight report 2026-10-04 |

## The layers

From fastest to slowest. Each catches what the one before it cannot.

1. **`npm run lint` and `npm run check`** (about 20 s together, Node, offline). Offline, but not sandboxed: sdk-check and
   relay-check listen on a loopback port, which the Codex sandbox refuses (`listen EPERM ... 127.0.0.1`), so an agent runs
   `npm run check` escalated, as it does `npm run flows`. The SDK against a fake SyncService, `main.js` and every
   `main/` module in one vm with a fake Electron, the renderer's load order, and about 160 behavior checks that each slice a
   renderer function and run it against a fake DOM. Most were written after one bug and guard that bug.
   The scheduled checks run in UTC and a pull request is checked on a Mac in Amsterdam, which is coverage of two zones
   worth keeping: a check about times reads the machine's zone (renderer-behavior-check.js `LOCAL_ZONE`) rather than
   naming one, since a check that named Amsterdam passed here and turned main red on GitHub (#776). Run
   `TZ=UTC npm run check` before a pull request that touches times.
   `scripts/renderer-check.js` also holds the **API contract**: every call `preload.js` hands the page is either refused in
   demo mode (`DEMO_WRITES`, renderer/state.js) or listed as writing no content (`DEMO_SAFE`), and either answered by the
   mock or listed in `NOT_MOCKED`. A new call fails until both are decided. Demo mode lets the synced settings through on
   purpose (view filters, hidden titles, agents, preferences): they are settings, not content.
   `scripts/relay-check.js` runs the agent relay (relay/, docs/AGENT-RELAY.md) on a loopback port with its clock in hand:
   an agent's OAuth sign-in (PKCE, a code used once, rotating refresh), linking with a code, subscribing to
   task.assigned (the callback challenged and signed) and an event delivered once to it, isolation between agents and
   between Orbitals, and what must fail (an unknown key, a used or expired code, an unlinked connection subscribing, an
   unknown event or more than 16 KB of data, a callback to a private address, too many failed codes), a key rotated
   with the agents kept, and two first asks for a code making one Orbital. It checks that the request an event carried
   is not in the database afterwards, and that no Orbital key or OAuth token is stored as itself (the subscriptions'
   signing secrets are kept as given: signing needs them). sdk-check drives Orbital's side of it
   (main/agents/linked.js) against the same relay.
2. **`npm run flows`** (about a minute and a half, Chromium on the mock, `scripts/flow-check.js`). Whole journeys in the real page, each on a
   fresh page that fails on any uncaught error, unhandled rejection or `console.error`:
   - sensitive titles stay hidden on every page, in Cmd+K, in tooltips, labels and the window title;
   - demo mode shows none of your words and saves nothing, whatever is typed;
   - a read-only document takes no caret, and no key asks for a write;
   - typing, Enter, Tab, ⇧Tab, Backspace, ⇧⌘⌫ and ⌘Z keep the screen and the saved outline the same;
   - Cmd+K, the / menu and Escape give the caret back where it was;
   - ↑ from a page's first line walks its fields, nearest first, to the title and ↓ comes back: from an empty new note,
     from a code block's first line (one wrapped and one of two lines), through the seven fields of a mock page, to a
     read-only title in demo mode, and to a saved search's title hidden under a tab bar (#764);
   - a slow answer for a page you left does not replace the one you are on;
   - a change made elsewhere shows live and leaves what you are typing alone.
   - a right-click on a Timeline meeting is Cmd+K on it, and Copy link copies the meeting's link.
   - Copy link on a meeting offers your notes and its summary while they exist or may still come, copies the
     summary's link, and makes no notes by asking.
   - the Settings window (settings.html, on a stand-in for main) stores what you pick, keeps the newest answer when an
     older read lands after it, keeps the keyboard on a switch through its redraw, and masks your email and hidden
     titles in demo mode.
   - Cmd+K Install mobile app: the Help tour (help.html) opens on its phone page in either theme with iPhone picked
     (iOS 26 or later, one code drawn, its TestFlight link opening in the browser through main while the tour stays);
     picking Android shows coming soon with no code, link or button, in a card of the same size; the choice is one tab
     stop whose arrows switch phones without paging the tour. `scripts/renderer-check.js` decodes
     the code itself (help-testflight.svg) and holds it to that link and to the README's and the manual's, so a new
     TestFlight link has to come with a new code.

   Then the **golden paths**, what someone does every day from start to end, by key and by pointer as they would. They
   guard the paths themselves, so a change that breaks one fails even when it is a new kind of break:
   - the Timeline: a first launch opens on it; a row opens what it is about by click or ↩, and ⌘[ comes back; a task
     ticked under Today's Tasks is saved as done; its end reads three more days;
   - pins: pinned to today it is under Today's Tasks; pinned to the sidebar and on a meeting it is listed in Edit pins,
     where each ↩ takes one off, until it is pinned nowhere;
   - getting around: ⌘S finds a page, a bullet zooms in and a child's bullet zooms further (#657), ⌘[ walks back
     through each and ⌘] forward;
   - dragging a row: the drop line shows, the row lands above another or one level in, on screen and saved alike,
     and ⌘Z puts it back;
   - dragging a task from Today's Tasks onto a meeting pins it there, and the Timeline's record rows offer nothing to
     pick up.
   - a task's life from Cmd+K: Set status to Waiting, Assign to Sam, ⌘↩ to complete and again to reopen, each saved;
   - Quick Add Task (task.html): a title, a type with ↓, an assignee with ⇥, and ↩ makes it, hands it over and tells
     the window;
   - writing on Today's page: "/" makes a heading and a checklist row, "@" links a task and a day, saved as they read;
   - typing under a meeting (renderer/meetingnotes.js): the meeting stays the page, write-up or not, and opening it
     makes nothing; the first words make notes only you can see, under a first row linking to the meeting that the
     meeting's page never draws (it shows with the notes on their own, and once changed), and ↩ goes on as anywhere;
     the Tana glyph beside the title is there before any notes, says "Open in Tana" on hover and on keyboard focus
     without moving the title, opens the meeting's own link and makes no notes; the write-up opened on its own and
     ⌘[ comes back to the notes; notes already there are used; Tana refusing keeps each meeting's words in its own
     row, a "what you typed is kept" answer is retried by the page itself, a late answer for one meeting changes nothing
     on the next; notes shared in Tana stay the editor with "Shared notes" and faces, link, everyone or read only said,
     words typed as they are shared kept while the line checks (this pane's answer late, another pane's releasing the
     writes) and the caret kept, reopened the same, unshared "only you" again. Main's side (main/meeting-notes.js) is in sdk-check: what Tana must confirm before a
     word is written, a create Tana has not confirmed asked about again after a restart, two panes, two machines and
     two independent Loro documents making one note at once with every word kept (one seed, byte for byte), a slow
     document of another kind never seeded, a rename, a deleted note, other people's, never-confirmed shared (a create
     Tana answered as shared, retried) and meeting-owned notes left untouched, your notes shared after confirmation
     kept with a write under a stale "only you" refused until told, a public link, unshared, view-only, your grant
     gone, another owner set, older notes without the mark, older unowned notes given to their meeting only while
     restricted, notes pinned on the meeting once and left unpinned when unpinned in Tana, and another account; the
     sync checks hold
     subscribe's ifMissing to writing a seed on MISSING only;
   - Notes | Summary on a meeting with a write-up: Summary first, none without one; Summary shows the write-up's rows and
     its own audience (three people against the meeting's two), keeps the meeting and its Tana button, and makes no
     notes; typing in it saves to the write-up; a switch saves what was typed to its own document, a first word's create
     carries on under Summary, Notes puts the caret back; Notes kept on reopening; a newer answer about who sees it is never
     replaced by an older one; made public while a row is typed in, the line says "Checking" at once, then anyone with
     the link, never the lock; read only said; an answer from before the session changed is dropped;
   - "/" Task and "/" Meeting: each named and referenced in its row; the meeting's when page shows the slot it will make
     (now for half an hour, a typed time, or "tomorrow from 3-5" as the mock's AI reads it), words that read as no time
     make nothing, Escape walks back to the row, and a second ↩ while one is made makes nothing more (creates are
     counted, and slowed so the second ↩ lands in time); no meeting is given anyone;
   - Edit meeting details on a meeting: "tomorrow from 3-5" read by the mock's AI, shown, and written only when pressed,
     as tomorrow afternoon with nobody added; an answer that is no time is said, and Escape goes back;
   - a view: the Library grouped, sorted and filtered with ⌘F, Escape clearing it, then saved as a search that opens
     on the same rows;
   - Notifications read by bullet and by Mark all as read, a row opening its node; a proposal approved from Cmd+K and
     one rejected with its button;
   - a chat message sent with ↩ shows as yours and Tana's answer follows;
   - Connect your personal agent: both plugins named with their URLs, How to add them … and back to the same code, the
     instructions carry a one-time code, the agent links while the page waits, the
     palette closes on its name, and it is in Choose agents (on, where it runs) with a page to rename or unlink it;
   - panes and tabs (shell.html): ⌘↩ on a search result opens a tab, ⇧↩ a pane beside; ⇧⌘N, ⌘N and ⌥⌘N a pane, a tab
     and a floating pane each on a new note of its own with the caret in it, a held ⌘N opening one; the keys go with
     the page just opened (waited for: the shell gives them once the frame has loaded) and every page keeps its own
     place; the new note's caret, dropped as the shell's activation can drop it (its window focused again with nothing
     focused), comes back (renderer/edit.js caretBack);

   A drag is dispatched in the page as Chromium delivers one (`__drag`: dragstart on the row's grip, dragover and drop
   where the pointer is), since the DevTools protocol cannot start a native drag in a headless page.
   A page main would open is driven on a stand-in for main, given before its scripts run (`p.beforeLoad`, cleared
   when the flow ends) and opened with `p.open`: task.html gets a `window.api`, shell.html a `window.shell` that
   opens a page the way main.js `window:split` does. `p.jsIn(side, …)` runs in one pane's page, whose CSP refuses
   eval.

   The first two scan the whole page rather than one element, so a new surface is covered the day the mock reaches it.
   It needs a loopback port and Chromium, so an agent runs it escalated; the scheduled checks run it on main (a pull request is tested on the machine that writes it, AGENTS.md).
3. **iPhone UI tests** (about eight minutes here, `ios/OrbitalUITests`). The
   app on `-sample`, driven by the labels VoiceOver reads; There is no CI, so they run only here: `npm run phones`, before a phone change merges and in `npm run release`, on a simulator of the checkout's own ("Orbital <hash of its path>", made once and reused): two
   checkouts testing on one shared iPhone killed each other's tests ("Test crashed with signal kill"). Its build output stays in the checkout (`ios/.derived`), and `npm run done` deletes both when the worktree goes. It builds once, runs all but `WidgetTests` on two copies of that simulator at once (three were slower, each test waiting on the others) and then `WidgetTests` on the simulator itself, which keeps Orbital installed: a fresh copy's widget gallery took minutes to list it. The build is signed ad hoc, so the widgets can read what the app leaves them and `WidgetTests` runs to the end, and a failure collects no diagnostics, whose sysdiagnose held a run for ten minutes after its last test. `LoadingTests` launches on `-stall page` or `-stall read` (a Debug
   build's stand-in for a Tana that never answers) with `-patience 3`, and expects Can't reach Tana in place of a Timeline
   that builds itself for good; Android's `EngineTest` drives the same on virtual time. `VisibleToTests` opens a note for
   each audience in `pages-sample.json` by its `orbital:` link, one launch per text size (a launch each was twelve in one
   test, close to its time limit), at the default and an accessibility text size, and measures the gap
   between the Visible to glyph and its word in the row as drawn: a SwiftUI `Label` in a List row had put the glyph in the
   list's icon column, about 20 pt from its word (#753). `scripts/ios-engine-check.js`
   covers the engine, and the desktop code it bundles, in `npm run check`, among it every list the phones ask for (ios/engine/listed.js): your hidden titles, Hide MCP and the settings document stay out of it, as main/views.js listFilter keeps them out on the Mac, where the phones once showed Block and Lunch in Upcoming meetings.
   What each phone keeps a copy of, since it must answer without the engine (a box ticked before the page has written it, the widgets' Activity lines, the app's words), is held to one spec both run: `ios/PhoneSpec.json`, by `SpecTests` in the iPhone's UI test bundle (no app launched; `ios/Common` is compiled into it) and `SpecTest` in Android's jvmTest. A rule changed on one phone is changed in the spec, and the other phone's test fails until it follows.
4. **The running app**, only for what the mock cannot reach: main's live subscriptions, real Tana answers, a restart.
   Read-only first (`node scripts/platform-cli.js`), escalated. Say in the PR what was and was not tried there.

The manual's scenes (`manual/scenes`) play the same mock in the same Chromium, but they take pictures and assert nothing.

## What a change adds

- **A fix** comes with a check that fails on the old code: a behavior check for a function, a flow step for a journey. Run
  it once with the fix reverted.
- **A new `window.api` call**: put it in `DEMO_WRITES` or `DEMO_SAFE`, and mock it or list it in `NOT_MOCKED`. Mock it when the
  renderer's behavior depends on its answer.
- **A new place that shows a node's words**: `demoText` and `blurSensitive` (docs/UI-PATTERNS.md), and mock data that reaches
  it. A new page goes into the privacy flow's list of places.
- **Anything that draws an async answer**: a generation guard, and the page in the out-of-order flow when it reads per id.
- **A new key or palette page**: the caret comes back on Escape; extend the focus flow when it opens over a row.
- **A change to a golden path** (the Timeline, pins, getting around, dragging, tasks, Quick Add, writing, views,
  Notifications and Proposals, chats, panes and tabs): its flow passes, and a step that is new there joins it. A path
  the flows do not walk yet is listed under Open.
- **An iPhone screen**: an accessibility label for everything you can tap, and a step in `SampleTests`.
- **A rule both phones keep a copy of** (`Ticks`, `Phrases`, `Glimpse`): a case in `ios/PhoneSpec.json`, which both phones run.
- **Before the first push**: read the whole diff and trace every caller of what changed; walk missing and empty values, a
  rename or retype, async ordering, cache and restart, masking, and the labels. Review bots are a second opinion.

## Why not an AI test runner

We looked at tester.army's e2e (2026-10-01): an agent drives the app from plain-language goals and replays what it did.
The checks that matter here are exact (no word leaks, no write happens, the outline matches), and an agent step makes
those slower, costs model calls and adds flakiness, while e2e would bring Playwright and a pre-1.0 API. The flows use
the same dependency-free DevTools protocol as `shoot.js` and the manual. Worth another look for exploratory runs.

## Open

- More over the shell: the Graph pane following the focused page, and closing a pane mid-edit (the close guard's
  flush, which needs main's `page:gone`) (#138, #435, #463).
- Golden paths not walked yet: a table, and dragging a task between the sections of My Tasks by Responsibility, which
  needs the mock's tasks to carry `createdBy`.
- A sweep invariant in `sdk-check`: after every page closes, the fake SyncService holds no subscription (#436, #452).
- Stale Cmd+K results while typing.
- The gaps in `NOT_MOCKED`: `indentMany`, `outdentMany`, `pasteMarkdown`, `archiveDocument`, `taskTypes`.
- The iPhone engine's privacy: `ios-engine-check` could assert a sensitive row reaches Swift without its title (#659).
