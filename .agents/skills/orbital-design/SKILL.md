---
name: orbital-design
description: Andre's design philosophy for Orbital, visual and interaction, and the mock-first loop he designs in. Use when designing, mocking up, restyling or reviewing any Orbital UI or UX (a new page, surface, component, flow, empty or loading state, animation), before choosing a layout or writing CSS. docs/UI-PATTERNS.md says how to build it; this says what it should be.
---

# Designing for Orbital

[docs/UI-PATTERNS.md](../../../docs/UI-PATTERNS.md) holds the building blocks, tokens, classes and UX conventions, and
[docs/OUTLINER.md](../../../docs/OUTLINER.md) holds what the app does today. Follow both. This file is the taste
behind them: how Andre decides what a feature should look and feel like, drawn from what he has asked for, kept
and pushed back on. The `#n` references are issues in foeken/orbital. Read one when a rule seems not to fit your
case.

## How a design gets made

1. **Start from current main.** Pull first. A mockup of an old layout gets redone: the first Links pane mockups
   missed the Trellis panes and had to be drawn again (#462).
2. **Ask how Tana does it** when the feature is a Tana concept (meetings #465, chats #446, changes, proposals,
   visibility). Read the bundle and the data, then design Orbital's surface over what Tana already stores and
   writes. The UI never shows a state the data cannot back.
3. **Mock before code** for anything new or visibly different. Give 3 or 4 real options. For each, say in one
   line what it is, what it is good at and what it costs, then name your pick. Draw them in the real window with
   the mock data (`scripts/shoot.js` below), in light and dark, at full width and in a narrow pane. Post them on
   the issue. Image generation is fine for a concept sketch when you give it a real screenshot to start from, so
   the sketch matches the app.
4. **Build the smallest slice** of the option he picks. "Let's start super simple ... add just that" (#461)
   shipped the audience line under rows and none of the rest of the mockup. The rest waits until he asks.
5. **Show screenshots along the way**, both themes, without being asked.
6. **Read short feedback as direction.** "Too much" means take something away. "Do better on the design" means
   find one stronger idea, not more pieces: the login splash became ⌘K as the planet with Tana orbiting it
   (#459). "Copy X's design" means copy it closely, down to radius, shadow, colours and both themes (Codex's
   chat and question card, #446 and #455), and not mixed with another style (iMessage was dropped for Codex).

## Visual

- **Tana Outliner's calm is the baseline.** Content comes first and chrome gives way. There is no footer or
  status bar (history row 11). Header icons show only while the pointer is over their pane (#206). Pills fold
  away behind a button (#175). Actions that were pills became icon-only header buttons (history rows 317, 319).
- **Say a thing once, where it belongs.** A tab names its page, so the heading under it goes (#441). App-wide
  switches sit in the window header and page things sit in the page (the sensitive eye moved up, #448). A
  window gets one Links pane, not a sidebar in every pane (#462).
- **Grey unless colour means something.** Icons are monochrome Nucleo line glyphs, in ⌘K (#193) and on the
  Timeline (#217) too. Colour belongs to a meaning: a type's hue is the node's identity (its glyph, chip and
  links), plus done green, link blue, error red, meeting gold, and the accent blue for focus and for things
  happening now (the focused tab, the recording pulse #456). Decorative colour is "too much": the audience
  colours at the ends of rows were cut for grey glyphs, faces and a count (#461).
- **Rank by weight and opacity, not boxes or colour.** Past or finished things are drawn quiet (a meeting with no
  write-up, #214). What still needs you is in the normal text colour (#218). Quiet text must still be readable
  (AA, #292).
- **Use hairlines.** Lines are 1px, and panes have no gaps or rounding between them. The header and the tab bars
  read as one band, with no line under the header (#448). An accent line is thin and bright (1.5px, #450). Only
  floating things are soft, with a radius and a shadow (the chat composer card, #446).
- **Show people as faces.** Initial bubbles and a count say who can see something (#461). Avatars say who is here
  (presence).
- **Every width holds.** A design must work in a narrow pane (about 560px) as well as in a full window. Nothing
  important may live only in chrome that a narrow pane drops; visibility vanished that way once (#461).

## Interaction

- **Everything orbits ⌘K.** A feature starts as a palette row. A button comes later, and its tooltip names the key
  (#196). Teach the key rather than hide it: the splash teaches ⌘K and offers the mouse only after 15 seconds.
  While signed out, the one row that works stays live and every other row is greyed (#459).
- **An outliner, not a form.** Act in place, on the row you are on. No edit modes, no confirm dialogs (undo
  instead), and one field with Enter wherever that is enough (Create task, #232). Inside a field, Tab switches
  what the field does rather than adding a control (the chat composer's human and AI modes, #446).
- **Leave people where they were.** Focus goes back and the page does not jump. A live change patches its own row,
  and only what really arrived flashes, never the whole list (#431, history row 245).
- **Motion answers something.** Motion follows a direct action or new live data, never a reload or a redraw (#185).
  The loader plays on launch and Reload only (#223). Small delights mark the moments that reward you: ticking off a
  task (history row 318), a refresh icon's one turn (history row 266), the splash keycaps pressing. Something live
  pulses softly (recording, #456). Nothing loops without a reason.
- **Guide in the app's own words.** An empty page says what would fill it and how to start (#356). A first screen
  says what Orbital is (#367).
- **Borrow proven patterns and name them.** Use Tana's own surface for a Tana concept, Codex for chat and
  questions, and Trellis for panes, each copied faithfully.

## Before you show it

Check that it works by keyboard alone and has its ⌘K row. Check it in both themes and in a narrow pane. Every
colour should carry a meaning, and every motion should follow an action or new data. It should say each thing
once. Take out anything the request did not ask for.

## Screenshots of the real window

`scripts/shoot.js` serves the checkout and draws shell.html (Trellis panes, header, ⌘K over the window) in
headless Chromium with the renderer's mock data, then writes `<out>/<name>-<theme>.png`. It opens a loopback
port and starts Chromium, so run it outside the sandbox. Run it from the checkout, with `node_modules`
installed:

```sh
node .agents/skills/orbital-design/scripts/shoot.js --name work --panes 2                 # light and dark
node .agents/skills/orbital-design/scripts/shoot.js --name narrow --size 560x760 --themes light
node .agents/skills/orbital-design/scripts/shoot.js --name splash --signed-out --wait 16000  # past the 15 s button
node .agents/skills/orbital-design/scripts/shoot.js --name palette --panes 2 --wait 1500 \
  --eval "if (location.search === '?side=2') togglePalette('cmd')"
```

`--eval` runs in every page after login, in the renderer's global scope, so any renderer function can set the
scene. Pick one page with `location.search` (`SIDE` is empty under the mock). To show a proposal before it
exists, draw it into the mock page this way, or edit a scratch copy of the checkout. For mockups meant for the
issue, commit the images to a `codex/<topic>-mockups` branch under `docs/mockups/<topic>/` and link them
from there, as #461 did.
