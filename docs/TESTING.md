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
| Keys and focus | Escape, a click outside or a palette page left the caret somewhere else, or a recorded shortcut did not run. | #187, #200, #288, #377, #463, #603 |
| Screen and saved outline apart | Enter flashed old text, ⇧↑ selected nothing, a draft row stayed after a delete, a checkbox leaked into a new row. | #125, #488, #489, #490, #601, #603 |
| Panes and windows | State that belongs to one pane leaked into another, or closing a pane lost an edit or a presence. | #138, #164, #435, #463, #474 |
| Drift | Docs, the mock, the manual or the PR description no longer matched the code; a third of all findings. New code no check exercised. | #314, #324, #607, #671, and "not covered by npm run check" in #510, #659, #668, #673, #677 |
| iPhone | VoiceOver read what the eye could not see, Reduce Motion was ignored, demo mode let a write through. | #659, #677 |

## The layers

From fastest to slowest. Each catches what the one before it cannot.

1. **`npm run lint` and `npm run check`** (about 10 s, Node, offline). The SDK against a fake SyncService, `main.js` and every
   `main/` module in one vm with a fake Electron, the renderer's load order, and about 120 behavior checks that each slice a
   renderer function and run it against a fake DOM. Most were written after one bug and guard that bug.
   `scripts/renderer-check.js` also holds the **API contract**: every call `preload.js` hands the page is either refused in
   demo mode (`DEMO_WRITES`, renderer/state.js) or listed as writing no content (`DEMO_SAFE`), and either answered by the
   mock or listed in `NOT_MOCKED`. A new call fails until both are decided. Demo mode lets the synced settings through on
   purpose (view filters, hidden titles, agents, preferences): they are settings, not content.
2. **`npm run flows`** (about 20 s, Chromium on the mock, `scripts/flow-check.js`). Whole journeys in the real page, each on a
   fresh page that fails on any uncaught error, unhandled rejection or `console.error`:
   - sensitive titles stay hidden on every page, in Cmd+K, in tooltips, labels and the window title;
   - demo mode shows none of your words and saves nothing, whatever is typed;
   - a read-only document takes no caret, and no key asks for a write;
   - typing, Enter, Tab, ⇧Tab, Backspace, ⇧⌘⌫ and ⌘Z keep the screen and the saved outline the same;
   - Cmd+K, the / menu and Escape give the caret back where it was;
   - a slow answer for a page you left does not replace the one you are on;
   - a change made elsewhere shows live and leaves what you are typing alone.
   - a right-click on a Timeline meeting is Cmd+K on it, and Copy link copies the meeting's link.
   - the Settings window (settings.html, on a stand-in for main) stores what you pick, keeps the newest answer when an
     older read lands after it, keeps the keyboard on a switch through its redraw, and masks your email and hidden
     titles in demo mode.

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
   - a view: the Library grouped, sorted and filtered with ⌘F, Escape clearing it, then saved as a search that opens
     on the same rows;
   - Notifications read by bullet and by Mark all as read, a row opening its node; a proposal approved from Cmd+K and
     one rejected with its button;
   - a chat message sent with ↩ shows as yours and Tana's answer follows;
   - panes and tabs (shell.html): ⌘↩ on a search result opens a tab, ⇧↩ a pane beside, ⇧⌘N a new pane, the keys go
     with the page just opened and every page keeps its own place.

   A drag is dispatched in the page as Chromium delivers one (`__drag`: dragstart on the row's grip, dragover and drop
   where the pointer is), since the DevTools protocol cannot start a native drag in a headless page.
   A page main would open is driven on a stand-in for main, given before its scripts run (`p.beforeLoad`, cleared
   when the flow ends) and opened with `p.open`: task.html gets a `window.api`, shell.html a `window.shell` that
   opens a page the way main.js `window:split` does. `p.jsIn(side, …)` runs in one pane's page, whose CSP refuses
   eval.

   The first two scan the whole page rather than one element, so a new surface is covered the day the mock reaches it.
   It needs a loopback port and Chromium, so an agent runs it escalated; CI runs it on every PR marked ready for review (a draft is tested on the machine that writes it, AGENTS.md).
3. **iPhone UI tests** (about a minute, `ios/OrbitalUITests`). The app on `-sample`, driven by the labels VoiceOver reads; the
   iOS workflow runs them on a simulator when `ios/` changes. `scripts/ios-engine-check.js` covers the engine, and the desktop
   code it bundles, on every ready PR.
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
