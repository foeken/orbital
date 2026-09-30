---
name: orbital-manual
description: Build, update and re-capture Orbital's in-app manual (manual/, Cmd+K Open Manual). Use in every PR that adds, removes or changes something a user can see or do in Orbital (a Cmd+K row, a key, a page, a pane, a label, a behaviour), and whenever a chapter, a picture, a clip or a motion diagram of the manual is written, restyled or re-recorded.
---

# The Orbital manual

The manual is the app's own documentation: static pages in `manual/`, opened from Cmd+K → Help → **Open Manual** in a
window of their own (main.js `manual:open`). Every chapter pictures the real window on the mock data. It ships in the
app; `manual/scenes/` (the tooling) does not.

**Every PR updates the manual.** A change a user can see or do lands with its chapter updated in the same PR: the words,
the scene and the pictures. A PR that changes nothing a user meets says so in its description ("Manual: nothing
user-visible"). A manual that trails the app teaches the wrong keys, which is worse than no manual.

## Where things are

| What | Where |
|---|---|
| Chapters | `manual/<id>.html`; the order and titles are `CHAPTERS` at the top of `manual/manual.js` |
| Pictures | `manual/media/<id>-<what>-light.webp` and `-dark.webp` (stills), `.mp4` (clips), always both themes |
| Scenes | `manual/scenes/<id>.js`, played by `manual/scenes/run.js` (its header documents every shot field and step) |
| Building blocks, diagrams, mock data | `manual/scenes/README.md` and `manual/scenes/template.html` (read both before writing) |
| Shared look and behaviour | `manual/manual.css`, `manual/manual.js` (one owner at a time) |
| Search index and audit | `node manual/scenes/index.js --coverage` writes `manual/search-index.js` and reports gaps |

Which chapter owns a feature:

| Feature area | Chapter |
|---|---|
| sign-in, the window, Help tour, loader, toasts, Create new | start |
| Cmd+K, recording keys, ⌘S search, opening elsewhere from the palette | commands |
| rows, keys in a row, marks, "/", @, images, drafts, undo, selection, drag, tables in a document | writing |
| zoom, back/forward, the title and header buttons, Home, recent places | navigating |
| Timeline, Notifications, Proposals | timeline |
| task states, assignees, bells, Quick Add, Selection actions, Clean up | tasks |
| Inbox/Library/Types, pills, group/sort/display, table mode, saved searches | views |
| sidebar/date/meeting pins, Today and This week, date mentions | pins |
| meeting pages, time/place/attendees, calls | meetings |
| types, icons, colours, fields and their definitions | types |
| ChatGPT/API key, Discuss with, Classify, Process image, translation, Codex agents | ai |
| chats, the composer, questions, @Codex in a chat | chats |
| panes, tabs, windows, saved views, the Graph pane, presence, canvases | windows |
| visibility, move, delete/restore/archive, links, sensitive, demo mode, hidden items | sharing |
| theme, text size, what syncs, PDF, reload, updates, about, log out | settings |
| every key | keys (always, when a key is added or changed) |

## Updating it for a PR

1. Find the chapter (table above) and the section; `rg -n "<the Cmd+K label>" manual/*.html` finds every mention.
2. Change the words: what it is for, the exact Cmd+K row label (verbatim from `label: '…'`, including a trailing " …"),
   the key, what you see. Update the chapter's key table and `manual/keys.html` when a key moved.
3. Change or add the shot in `manual/scenes/<id>.js` (build it from `manual/scenes/kit.js`) and record, outside the
   sandbox: `node manual/scenes/run.js manual/scenes/<id>.js` records only the shots whose definition changed or whose
   file is missing; `--only <shot> --themes light` while iterating. A change to how the app looks that leaves the
   shot's definition alone needs `--only <shot> --force` on the shots that show it (`rg` the scene files for its row or
   selector). Commit `manual/scenes/manifest.json` with the pictures.
4. Look at every picture you made (a clip: `ffmpeg -ss 2 -i f.mp4 -frames:v 1 /tmp/f.png`). Redo a bad crop, an empty
   page, a palette saying "No results", clipped text.
5. If the mock lacks what the feature needs, add it to `renderer/mock.js` (small, additive, fictional), then
   `node --check renderer/mock.js`.
6. `node manual/scenes/index.js --coverage`: rebuilds the search index; it must report no broken links or missing
   pictures, no unused pictures, and your feature's labels must not be in the "not mentioned" list.
7. Check the page as a reader sees it: the chapter's `<id>-page` shot (`{ name, url: 'manual/<id>.html', full: true,
   size: '1440x900' }`) with `--only <id>-page`, drawn into `$TMPDIR/manual-check`, both themes.
8. `npm run lint` and `npm run check` (on Node 22, as CI; see Checks). Say in the PR what the manual gained.

A removed feature: delete its words, its shots from the scene file and its pictures (the audit lists unused ones).

## What makes a good chapter (educational design)

- **One idea per chapter, taught first.** A hero motion diagram (`.mg`) loops the chapter's core idea in a few moving parts
  (a view is one screen with three presets; a pin puts one node in several places). Then an empty `<ul class="learn">`,
  which fills with the sections.
- **In learning order.** Big ideas first, edge cases after. Each feature: why, how (row, key, click), what you see, then
  the picture. Every section has at least one real picture; things that move get a clip; screens with several parts get
  an annotated still (numbered pins linked to a legend).
- **Show, then let them try.** A "Try" callout with the key sequence; a "Why" note only where behaviour surprises
  (a row that dims instead of leaving). A key table closes a chapter with more than three keys.
- **The app's voice.** Plain, second person, short sentences, active verbs, exact UI words. Grey unless colour means
  something (type hue, green done, blue focus/now, gold meeting), as the orbital-design skill says.
- **Diagrams**: in the chapter's own `<style>`; animation rules under `.mg.in` (in view; `.shown` is the separate fade-in);
  `--loop` 6–9 s with keyframes in percent of it; names prefixed with the chapter id; the unanimated style is the
  meaningful end state, because reduced motion freezes everything.
- **Pictures**: crop to what matters (a pane, the palette, a row), 1280x800 by default, 1440x900 for two panes. Clips
  4–12 s, one action, ending on the result (`hold`), under `500 KB; stills under `250 KB. A caption step sparingly.

## Capture lessons (what bit us)

The runner draws shell.html (Trellis panes) on the mock in headless Chromium over the DevTools protocol, with a drawn
cursor, a ripple on clicks and keycaps for each key.

- It must run **outside the sandbox** (loopback port, Chromium): `sandbox_permissions: require_escalated`, prefix
  `["node","manual/scenes/run.js"]`. A run over `30 s outlives one exec call: keep the session and poll it.
- Clips are H.264 MP4 loops, not GIFs: sharp on Retina, a tenth of the size, same autoplay/loop/muted behaviour.
  Chromium runs with `--force-device-scale-factor=2`, or screencast frames come at 1x.
- Every shot starts from a cleared origin: pages keep their place in localStorage, and one shot's page leaked into the
  next (both panes on My Tasks).
- **Many rows and buttons only appear for real-looking ids** (`tana:text:…`): current-node Cmd+K rows (Edit visibility,
  Move to, Set type, Classify, Assign to Agent, pin rows), the header's meeting button, the Graph pane, task meta and
  fields. The mock's `mockdocN` ids miss them: use or add a `tana:text:mock…` node (there are `tana:text:mockai0`,
  `mockpin0`, `mockpin1`), or wrap the page's api in the scene to translate ids both ways (meetings.js does).
- The mock does not do: splitting panes (`splitWindow` is a no-op; windows.js reloads the shell with a bridge), overlays
  (lay help.html or task.html in an iframe as main does), native drag (dispatch DragEvents in the page, or teach it
  with a diagram), right-click (the runner clicks left only), tooltips (headless draws none: say it in words).
- A clip whose last change is only a CSS animation records no new frames at the end: finish on a DOM change or take a
  still for the result.
- On a palette page (Set type, Set icon, Set colour), typing shows "No results" under rows that match
  (renderer/palette.js, the "No results" condition): pick with arrows in clips until it is fixed.
- Data a picture shows is fictional and should look lived-in: the mock's Timeline "Now" block, meetings starting a few
  minutes after the capture, a meeting write-up with Key takeaways, a Dutch note, faces on meetings. Keep it that way.

## Regenerating cheaply

Nothing is drawn twice without a reason, and the tricks are kept, not rediscovered:

- **The pictures are kept** in `manual/media/` and **the recipes** in `manual/scenes/*.js`; both are committed. Never
  regenerate the whole manual for one change: record the shots the change touches.
- **`manual/scenes/manifest.json`** holds a hash of every shot's definition as last recorded. The runner skips a shot
  whose hash matches and whose file exists, so `node manual/scenes/run.js manual/scenes/*.js` records exactly what
  changed (and says "nothing to record" otherwise). `--force` records anyway; `--adopt` marks the current definitions
  as recorded without drawing (after a comment-only edit). Bump `RECIPE` in run.js only when the runner changes how
  every picture looks.
- **Repeatable renders**: every page runs on a fixed clock (`--now`, default 2026-09-30 11:40 local), so Timeline times,
  "no meetings for 45 more minutes" and meeting slots come out the same each time, and a still whose bytes are
  unchanged is not rewritten. A clip is always re-encoded when recorded, so record clips only when they changed.
- **Shared steps** are in `manual/scenes/kit.js`: `open`, `settle`, `palette`/`onlyPalette`/`NARROW`, `real()`/`REAL` (mock
  ids read as tana: ids), `seedTaskMeta`, `seedFields`, `live()` with `layout`/`panel`/`page` (panes that really open),
  `helpTour`, `quickAdd`, `overlay`, `dropOnCreate`, `translate`. Add a trick there the second time a scene needs it.
- **Checks of a whole manual page** (a shot with `url`) run only when named with `--only` and are written to
  `$TMPDIR/manual-check`, never into media.
- Every recorded clip adds its bytes to git history for good. If the repository grows heavy from re-recorded media,
  move `manual/media` to Git LFS rather than recording less.

## Checks

- `npm run lint` covers `manual/` (browser globals for the pages, node plus browser for the scenes).
- `npm run check` on **Node 22**, as CI (`PATH=`/.asdf/installs/nodejs/22.14.0/bin:$PATH npm run check`, escalated for
  its loopback servers). On Node 26 sdk-check dies in undici with "ReadableStream is already closed": that is the
  runtime, not the change.
- The manual loads from `file://` in Electron: relative links, media and scripts only; a quick look without the app is
  `chrome-headless-shell --screenshot … "file://$PWD/manual/<id>.html?theme=dark"`.

## A big rewrite: many chapters at once

Split by chapter, one worker per two or three chapters, each owning its pages, its scene files and its media prefix;
the lead owns manual.css, manual.js, the runner and the cover, and merges mock needs. At most six agents run at once:
store each id as it is spawned (a loop that fails part-way leaves agents running unnamed) and close each one when it
reports, or no new one can start. Give every worker README.md, template.html, a finished chapter to match and this
skill; then run the audit, a contact sheet of every chapter's opening in both themes, lint and the checks yourself.
