# Quick add (global shortcut)

**⌘⇧Space** opens a small panel over whatever app is in front, types one task into Tana and gets out of the way. It is
a second window (`quick-add.html`), not a mode of the outliner: the main window keeps its own state, and the panel is
cheap enough to throw away.

## What a press does

`main/quickadd.js:togglePanel` owns the one window. The first press builds it, a press while it has focus hides it,
and a press while it is open but behind something raises the same window — so the shortcut never stacks panels and
never rebuilds one over a half-typed title. Clicking away hides it too (the `blur` handler in `main.js`). The panel is
destroyed with the main window, or closing the outliner after one press would leave the app running invisibly.

Every show sends `quick:open`, and the panel answers it by re-reading its context. The meeting is therefore read at
open time and never cached from launch: "the meeting I am in" is only true for minutes at a time.

## What the panel shows

`quick:context` returns `{ meeting, meetingError?, members, membersError?, me }`. The two reads are independent, so a
slow or broken meeting lookup still leaves a usable panel with the member list, and vice versa; neither blocks typing,
because the field is focused before anything is fetched. The meeting line says one of four honest things: still
looking, **Adding to &lt;meeting&gt;**, **No active meeting**, or **Could not check meetings**. Only the second one
sends a meeting id with the task.

The meeting itself is `sdk/calls.currentCalls` (docs/MEETINGS.md): the live `sessions` of the event’s call document,
which is the only server-side proof that this user has *joined*. An event merely scheduled now does not qualify, and a
title is never used as a stand-in for a link.

## Keys

| Key | What |
|-----|------|
| ⌘↵ | create the task, from anywhere in the panel |
| ↵ | create, unless the caret is in the chooser (picks) or the agent prompt (newline) |
| ⇥ or ↓ | open the chooser — people, or the model list once the agent has the task |
| ↑ ↓ | move the highlight in the chooser |
| ↵ in the chooser | pick the highlighted row; picking the chosen one again clears the choice |
| esc | close the chooser, or — with no chooser open — the panel |

⌘↵ is answered before the chooser and before the prompt's own newline, so neither swallows it, and it runs the same
guarded submit as ↵ does: the empty-title and in-flight guards cannot be walked around by reaching for it.

The assignee comes from the same member list the outliner uses (`main/rows.js:members`), so it is always a real
`tana:user-profile:` uri and never a typed name. Choosing nobody leaves Tana’s own default: a new task is assigned to
whoever created it. The chosen name wears the app's own glyph — `member` for a person, `robot` for the agent — cloned
from `icons.js` the way `iconNode` does it in the outliner.

## The agent

**Agent** heads the same list, above the people, and is not one of them: the local Codex agent is an app-local mark,
never a Tana user (`main/documents.js`), so it is held apart from the assignee and the two are refused together.
Choosing it reveals the prompt the agent is handed with the task and puts the caret there; ⇥ then offers the model for
this one assignment — Codex's own list (`codex:models`), with `Codex default` meaning no model is sent — plus a row
back to the people. Choosing a person takes the task off the agent, prompt and all.

The handoff itself is `main.js:assignToAgent`, lifted unchanged out of the `codex:set` handler so ⌘K and this panel
share one path: the same context write, the same task creation with its blank workspace, the same opening of the
Codex task. `main/quickadd.js` is injected with it rather than requiring anything of the Agent integration, so no
Agent state or launch logic is duplicated here. A task with no instruction is refused before anything is created.

## What gets written

`quick:create` composes three operations that already existed, in this order:

1. `createDocument(title, { kind: ’task’ })` — the same creation path the outliner’s ⌘K Create Task uses.
2. the assignee, if one was chosen: `setAssignees` through `mut`, the same write as the assignee picker.
3. the meeting link, if a meeting is live: `pins.nodePin(eventId, taskId, true)`.

**Why a pin.** A meeting hub carries two kinds of documents (docs/MEETINGS.md): things *owned* by the event —
`data.ownerUri` — which are its notes and outcomes, and things *pinned* on it, the event’s own `pinnedItems` list that
the graph reports as `EDGE_TYPE_HAS_PIN`. A real task created during a meeting in Tana itself was verified read-only to
be the second shape: owned by a space, with `createdInUri` naming the event and a pin on that event. The pin is also
the smaller relationship — it needs no change to `initDocument`, which accepts only a space as an owner — and the
sidebar already reads it back under **Pinned**. `nodePin` refuses when this user may not write the event, which is the
native capability check rather than a guess.

The task is the unit of work. Once it exists the panel must not be submitted again, so a failed assignment or pin is
returned beside the created node (`assignedError` / `linkError`) and pushed into the app status the main window shows —
never thrown over a task that was created, which would invite a second Enter and a second task.

A failure of the creation itself keeps every character in the field, shows the reason, and leaves the panel open; only
a created task clears and closes it. One submit runs at a time, so a held or double Enter creates one task.

## The shortcut itself

`CommandOrControl+Shift+Space`, registered at `app.whenReady` and released on `will-quit`. There is deliberately no
settings screen for it: the app has no pattern for configurable global shortcuts, and one hard-coded accelerator is
less to maintain than a configurator nobody asked for. Cmd+Space and Cmd+Option+Space belong to Spotlight; the app’s
own hotkeys are window-level and cannot collide with a global one.

Registration can fail two ways — another app holds the combo (`register` returns false) or Electron rejects the
accelerator (it throws). Both land in `S.status.quickAdd = { accelerator, registered, error }` and, when it failed, in
the status error the window already shows, so a dead shortcut is diagnosable instead of looking like a broken keyboard.

## Two rules the behaviour depends on

Both live bugs in this panel were styling, and both read as broken logic. `quick-add.css` now carries them:

- `.qpanel [hidden] { display: none; }` — the `hidden` property only hides an element while nothing gives it a display
  of its own, and the chooser is a flex column. Without this rule, picking a person committed the assignee, closed the
  chooser and moved the caret back to the title exactly as intended, and the finder stayed on screen anyway. The
  outliner pairs every hidden box with such a rule (`.pills[hidden]`, `.palette[hidden]`); one rule for the whole panel
  means the next hidden element here cannot forget it.
- The accent is the app's, not a second blue: `#e8f1fb` selection, `#2b6fcf` text, `#b7d2f5` focus ring, straight from
  `styles.css`. The check asserts those three are used and shared, and that no decidedly blue value appears here that
  the app does not already use.
- `.qchooser`/`.qlist` are `min-height: 0` with the list `overflow-y: auto` — a flex item will not shrink below its
  content unless told to, so a long member list grew the form past the bottom of a window that cannot resize. The list
  is now bounded by the space the form leaves it rather than by a fixed pixel height, and scrolls; no member is
  dropped from it.

Neither is visible to the panel's behaviour check, which has no CSS engine, so that check asserts the two rules
against the stylesheet itself.

## Checks

- `scripts/sdk-check.js` — a fresh meeting per open, a half-broken context, the refusals, the exact pin on the event,
  created-but-unlinked, both shortcut failures and the one reused panel.
- `scripts/renderer-behavior-check.js:runQuickAddPanelCheck` — the panel script run whole in a fake DOM built from
  `quick-add.html`: the meeting states, empty and duplicate submit, the keyboard assignee, escape, the retry that keeps
  the title, re-open keeping what was typed, the two stylesheet rules above, and a 200-member workspace where the
  search, the wrapping highlight and the dismissal still behave as they do with two people.
