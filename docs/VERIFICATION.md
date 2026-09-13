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
- Risk task “Ask Foundry teams for risks…” shows Visible only to you.

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
