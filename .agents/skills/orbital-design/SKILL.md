---
name: orbital-design
description: Andre's visual and interaction taste for Orbital. Use when designing, mocking up, restyling or reviewing any Orbital UI or UX (a page, surface, component, flow, empty or loading state, animation), before choosing a layout or writing CSS. docs/UI-PATTERNS.md says how to build it; this says what it should look and feel like.
---

# Designing for Orbital

[docs/UI-PATTERNS.md](../../../docs/UI-PATTERNS.md) has the building blocks, tokens and conventions, and
[docs/OUTLINER.md](../../../docs/OUTLINER.md) has what the app does. This file is the taste behind them, drawn
from what Andre asked for, kept and pushed back on. `#n` is an issue in foeken/orbital, and "row n" is a row of
docs/TASKS-HISTORY.md. Read the source when a rule seems not to fit.

## Visual

**The outline is the design.** Orbital should look like Tana Outliner: a title, then rows. The marker sits in a
fixed gutter, a guide line runs under the bullet, a chevron shows on hover, and a collapsed bullet has a halo
(rows 18, 19, 360). Alignment is part of that look, so measure it. The words of every row line up with the title.
Every field value starts in one column (#145), and a nested reference keeps the gutter an icon needs (#91, #94). A
field row stays one line, never a whole node twice the height of its neighbours (row 345). A placeholder takes
the slot of what will land, so nothing shifts when it arrives (row 155).

**Chrome gives way until it is wanted.** There is no footer or status line (row 11). The filter hides until ⌘F
(row 12), and pills fold away behind a button (#175, row 316). Header icons show only while the pointer is over
their pane (#206), and they are icon-only, with the key in the tooltip (#196, rows 317, 319). A pill that lists
choices shows two and an ellipsis rather than growing (#183).

**Say a thing once, where it belongs.** A tab names its page, so the heading under it goes (#441). App-wide
switches sit in the window header, and a page's own controls sit in the page (#448). A window gets one Links
pane, not a sidebar per pane (#462). A link needs no person icon beside it (row 16). A toggle shows its state by
its look, with no "shown/hidden" words (row 58). A section with nothing in it is not drawn (row 269).

**Grey unless colour means something.** Icons are monochrome Nucleo line glyphs, one shade everywhere (rows 15,
321), including in ⌘K (#193) and on the Timeline (#217). Colour is reserved for meaning:

- a type's hue is its node's identity: bullet, chip and links all take it (rows 48, 63, 334), read as OKLCH so it
  matches Tana (row 331);
- green means done, blue means a link, red means an error or leaving, gold means a meeting;
- the bright accent blue is for focus and for things happening now (the focused tab #450, the recording pulse
  #456).

Finished work loses its colour: a done task's agent badge turns to a grey outline (row 295). Decoration is "too
much": audience colours at the end of rows were cut for grey glyphs and faces (#461). A new colour needs a
meaning nothing else has.

**Rank by weight and opacity.** What is past or settled is quiet: a meeting with no write-up is drawn at low
opacity (#214), and a done row is struck and grey. What still needs you is in the normal text colour, and so are
the headings over it (#218). Quiet text must still pass AA (#292). Bold marks the verb or value that matters
("Priya **completed** …"), not decoration.

**Leave the title room.** A row's facts (assignee, audience, bell) move to its grey line, after a bullet, when the
title needs the width; they never wrap into what looks like a second title (row 290). A chip shortens to its #
in its hue and shows the full tag on hover (row 136). A date is spelled out only where a bare weekday would
mislead, such as last Friday (row 186). A meeting's date rides quietly in the breadcrumb (row 154).

**Draw with hairlines; save softness for what floats.** Lines are 1px. Panes have no gap or rounding between
them, and the header and the tab bars read as one band with no line under the header (#448). An accent line is
thin and bright (1.5px, #450). Radius and shadow belong to floating surfaces only: the palette card, menus, the
chat composer (#446). Measure spacing: a divider sits centred between the sections it separates (#190, #208).

**Show people as faces.** Initial bubbles and a count say who can see something (#461), and avatars say who is
here (presence). Words come after faces.

**Hold at every width, in both themes.** Every design must work in a narrow pane (about 560px) as well as a full
window. Nothing important may live only in chrome that a narrow pane drops; a narrow pane once showed no
visibility at all (#461). Dark is its own charcoal palette, designed rather than inverted (row 86). When copying
a reference, copy its dark mode too (#446).

## Interaction

**Everything orbits ⌘K.** A feature starts as a palette row, which makes it reachable, recordable and
findable. A button comes later, and its tooltip names the key (#196). Teach the key rather than hide it: the
splash teaches ⌘K and offers the mouse only after 15 seconds, and while signed out only the row that works is live
(#459). A command row starts with a verb, and ends in " …" when it asks something first (row 233).

**An outliner, not a form.** Act in place, on the row you are on, with no edit mode and no confirm dialog; undo
is the safety net. Expanding an empty node gives a draft child with a blinking caret, saved once it has words
(rows 32, 40). Backspace at the start of a row joins it to the row above (#125). A reference alone on its line is
the node itself, so you can tick it off there (row 289). One field and Enter beats a dialog (Create task, #232).
Tab switches what a field does rather than adding a control (the chat composer's human and AI modes, #446).

**Gestures carry meaning.** Dropping a task into a group writes whatever puts it in that group (#169). ⌘ opens a
node in a new pane and ⌥ in a new tab, the same from a click, ⌘K or ⌘S (#443). A member or a type is not
zoomable, so its bullet does nothing and looks it (row 331).

**Show every option, and say why one can't run.** Greyed with a reason beats hidden. A palette row that cannot
run stays in place, greyed, with its hint saying why (#459). Opening ⌘K over a selection offers the actions that
fit it, never one aimed at nothing (#296).

**Never move things under the user.** A row that falls out of a list while you are still in it only dims, and goes
once the caret leaves (row 177). Rows you just changed stay where they are until Clean up (#85). Focus goes back
to where it came from. A live change patches its own row, and only what really arrived flashes, never the whole
list on a reload (#431, row 245).

**Answer at the moment of the press.** A pressed button eases down. Refresh turns once the instant it is pressed,
not when its rows come back (row 266). A row arriving tints green, and one leaving tints red (row 177).

**Motion answers something.** It follows a direct action or new live data, never a reload or a redraw (#185).
The loader plays on launch and Reload only (#223). Delight is for the moments that reward you: ticking off a task
squashes the box, draws the tick and strikes the title, in the app's own green (row 318). Something live pulses
softly (the recording dot, row 29, #456). Nothing loops without a reason, and reduced motion stills it all.

**Private stays private, and errors stay out of the way.** Sensitive nodes blur, and every launch starts hidden
(row 166). Read-only looks read-only. A failed action is a toast that fades; the line under the title is only
for the session (#247).

**Guide in the app's own words.** An empty page says what would fill it and how to start (#356). The first screen
says what Orbital is (#367). Help shows the keys at work rather than describing them.

**Tana decides meaning, and good patterns are borrowed.** Show what Tana stores and write what Tana's client
writes; never draw a state the data cannot back. A Tana concept follows Tana's own surface (meeting page
#465). Chat and questions copy Codex, and panes follow Trellis, each copied closely and never blended: iMessage was
dropped for Codex (#446, #455).

## Working with Andre on a design

Pull main first, since a mockup of an old layout is redone (#462). For anything new, show 3 or 4 options in the
real window before any code, each with one line on what it is good at and what it costs, then name your pick.
Build only the smallest slice of the option he picks (#461). Read short feedback as direction. "Too much" means
take something away. "Do better on the design" means one stronger idea, not more pieces (the splash became ⌘K
as the planet, #459). "Copy X" means copy it closely.

## Screenshots of the real window

`scripts/shoot.js` draws shell.html (Trellis panes, the header, ⌘K over the window) on the renderer's mock data
in headless Chromium, writing `/tmp/orbital-shots/<name>-<theme>.png`. Run it from the checkout, outside the
sandbox (it opens a loopback port and starts Chromium):

```sh
node .agents/skills/orbital-design/scripts/shoot.js --name work --panes 2          # light and dark
node .agents/skills/orbital-design/scripts/shoot.js --name narrow --size 560x760 --signed-out --wait 16000
node .agents/skills/orbital-design/scripts/shoot.js --name palette --panes 2 \
  --eval "if (location.search === '?side=2') togglePalette('cmd')"
```

`--eval` runs in every page after login, in the renderer's global scope. Under the mock, pick a page by
`location.search` (`SIDE` is empty there).
