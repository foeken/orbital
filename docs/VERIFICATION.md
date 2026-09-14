# Verification log

## 2026-09-13

The localhost renderer has no Electron preload and uses `mockApi()`. Its login
button enables sample data, not the user's Tana session. Use it for destructive
interaction tests. Use the packaged Electron app for real-data, read-only checks.
Never replace or monkeypatch the frozen `window.api` bridge to simulate writes.

Verified through browser UI actions and rendered DOM:

- Cmd+K theme command uses the supplied dark-light SVG; dark preference survives reload.
- Custom-typed tasks show Project without redundant task tag, retaining checkbox.
- Enter followed immediately by typing preserves the complete new sibling text.
- Cmd+Enter converts a plain block to a checkbox; children remain plain.
- A sibling after an explicit checkbox inherits an unchecked checkbox.
- Shift+Down selects sibling nodes; selection border radius is zero.
- Backspace removes the selection and its descendants.
- Assignee selection saves and dismisses the picker.
- Cmd+K People opens member data with member tags.
- A read-only member with content expands; a loaded empty member has no draft or caret.

Verified in the rebuilt native app:

- Existing session loads real tasks without an interactive login.
- App menu is Tana Companion, Edit, Window; no old Tana Sync menu.
- Risk task “Ask Studio teams for risks…” shows Visible only to you.

Failures found during visual checks:

- Rapid typing after Enter lost its prefix during asynchronous insertion. Fixed
  by retaining the pending sibling text and caret; delayed-insert regression and
  actual keyboard retest pass.
- Multiple removal/move calls produce multiple undo steps. Atomic batch work is
  pending; do not claim one-step undo for a multi-node action yet.
- Visibility can be cached as unknown before document bootstrap. Backend now
  awaits readiness. Real tasks send and Testing have explicit private metadata;
  missing metadata is not evidence of private visibility. Native recheck pending.

TASKS.md remains the requirement/status ledger. Passing mock or helper tests does
not prove live mutation behavior, full native visual coverage, or all requirements.

## 2026-09-13 — backend read-only verification against real Tana data

Evidence came from `scripts/platform-cli.js` against the live account (read-only: `inspect`,
`audiences`, `refs`, `rows`, `pinrows`, `boot`). Nothing was written to Tana.

- **#93 visibility unknown.** `send` and `Testing` are explicitly `restricted: true` with me as the
  only participant and already resolved to `only-me`; the remaining wrong labels were elsewhere. A
  sweep of 80 assigned tasks found 7 unknown, all tasks owned by a meeting shared with several
  people, plus 2 more in a wider 120-document sweep: a meeting with an external
  `tana:guest-profile:` attendee, and a document whose only restricted boundary is the organisation
  root. All three causes were resolution gaps, not missing platform data — the same participant set
  read as `people` directly and `unknown` when inherited. After the fix a 150-document sweep returns
  82 `only-me`, 21 `people`, 18 `space`, 13 `everyone` and **zero unknown**. Findings are written up in
  docs/sdk/05-gotchas.md.
- **#89 space tooltip name.** A task inherited from the Platform Guild space returns
  `audienceSpace: { uri: 'tana:space:01examplej0000000000000000', title: 'Platform Guild' }`, so
  the real space name reaches the renderer. The tooltip string itself is renderer-side.
- **#85 Studio Goals embed.** The document's first block is an `embed` of
  `tana:text:01examplek0000000000000000`. Run through the real `outlineWithReferences`, it resolves to
  the task "Setup session with Studio Leadership…" with `icon: 'task'` and `done: 0`, so the backend
  hands the renderer a complete reference node. Rendering it is renderer-side.
- **#48/#63 type and node colours.** Custom types carry hues (Project 268, Decision Record 143,
  Co-Worker 27) and a Project-typed document reaches the renderer as `tags: [{ label: 'Project', hue: 268 }]`.
  Spaces do have hues (Studio LT 193, Platform LT 77, Automation Guild 327) but **pinned spaces arrived with no
  colour at all**: `appearance` exists only on graph nodes, and the pin path reads the document from
  Loro, which also erased hues the graph had already cached. After the fix the pin tree carries each
  space's real hue on both the node and its tag.
- **#97 boot noise.** The app's real startup path (session → client → sync → first refresh, ~70
  document subscriptions) completes in ~9 s with `connected: true`, `error: null` and **no warnings or
  errors logged**. Calls that arrive before the connection now fail as a benign state instead of
  publishing an error status. A clean native boot check still belongs to the orchestrator.

Not verified here: anything visual. These checks prove what the main process and SDK hand to the
renderer, not what the window draws.
