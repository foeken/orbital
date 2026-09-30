# Writing a chapter of the Orbital manual

Updating the manual for a PR (which chapter owns a feature, the steps, the capture gotchas) is the orbital-manual
skill: .agents/skills/orbital-manual/SKILL.md. This file is the reference for the building blocks.

The manual is static HTML in manual/, opened from Cmd+K → Help → Open Manual in a window of its own (main.js
manual:open). It ships in the app; manual/scenes/ (this folder: the capture runner, the scene files, this guide) does not.

## Files

| What | Where |
|---|---|
| A chapter | manual/<id>.html, where <id> is its entry in CHAPTERS at the top of manual/manual.js |
| Its pictures | manual/media/<id>-<what>-light.webp / -dark.webp (stills), -light.mp4 / -dark.mp4 (clips) |
| Its scenes | manual/scenes/<id>.js, run with node manual/scenes/run.js manual/scenes/<id>.js |
| Shared look and behaviour | manual/manual.css, manual/manual.js (do not edit these from a chapter: ask the lead) |
| Search index | manual/search-index.js, made by node manual/scenes/index.js (the lead runs it) |

Start from manual/scenes/template.html: it shows every building block. Copy it to manual/<id>.html.

## What a good chapter does (educational design)

1. **Hero**: eyebrow "Chapter N", an h1 that names the idea, a lead of one or two sentences saying what you will be able to
   do, then a **motion diagram** (.mg) that teaches the chapter's one core idea in a loop (e.g. "a view is one screen with
   three presets", "a pin puts one node in several places"). Then an empty <ul class="learn"></ul>: it fills itself with
   the chapter's sections.
2. **One section (section.topic with an h2 id) per group of features**, in the order someone would learn them. Each
   feature: what it is for (one sentence), how to do it (the Cmd+K row's exact name, the key, the click), what you see,
   then the picture. Big ideas first, edge cases after.
3. **Show, then tell.** Every section has at least one picture; the features that move (typing, ticking, dragging,
   palettes, panes) get a clip. Annotated stills (figure.anno) for anything with several parts on screen.
4. **A "Try" callout** at the end of most sections: a short key sequence to do it yourself.
5. **A key table** at the end of the chapter when it has more than three keys.
6. Plain words, second person, active verbs, short sentences. Name UI exactly as it appears (Cmd+K row labels are in
   renderer/*.js as label: '…'; use them verbatim, including the trailing " …"). Write keys as <kbd>⌘K</kbd>, one kbd per
   combo. No marketing words, no "simply", no "powerful".
7. **Cover every feature** in your part of docs/OUTLINER.md (and the docs it links: VIEWS.md, PINNING.md, MEETINGS.md,
   CHATS.md, SETTINGS.md). Read the code when the doc is unclear. Small features can share a paragraph or a list, but none
   is left out. Things the user cannot see (protocol, caching) stay out unless they explain behaviour ("why did this row
   dim?"): then one "Why" note.

## Building blocks (see template.html)

- Still: <figure class="shot"><img data-m="tasks-row" alt="…"><figcaption>…</figcaption></figure>
  (data-m is the name without -light/-dark and extension; manual.js picks the reader's theme)
- Clip: <figure class="clip"><video data-m="tasks-tick"></video><figcaption>…</figcaption></figure> (loops while in view,
  a click pauses it)
- Annotated: <figure class="anno"><img data-m="…"><span class="pin" style="--x:12%;--y:30%">1</span>…</figure> followed
  directly by <ol class="legend"><li><b>Name</b> what it does</li>…</ol>; --x/--y are percentages of the picture
- Text beside a picture: <div class="split"><div>text</div><figure …></figure></div> (add .flip to swap sides)
- Wide picture: add class wide to the figure
- Callouts: <div class="try"><span class="seq"><kbd>⌘K</kbd><i>→</i> type <b>pin</b> <i>→</i><kbd>↩</kbd></span></div>,
  <div class="tip">…</div>, <div class="note">…</div> (a "Why")
- Keys: <table class="keys"><tr><th>Action</th><th>Keys</th></tr><tr><td>…</td><td><kbd>⌘K</kbd></td></tr></table>
- Cards: <div class="grid"><a class="card" href="#x"><h4>…</h4><p>…</p></a></div>
- h2/h3 get anchors by themselves; give every h2 an id; add data-short="…" when the h2 is long (sidebar label) and
  data-k="words" for extra search words. A kbd inside an h3 shows in search results.

## Motion diagrams (.mg)

Drawn in HTML and CSS, in the chapter's own <style> in <head> (inline styles are allowed; scripts are not). Compose from the
primitives in manual.css: .win (a floating card), .row (.dot, .bar with --w, .box/.box.on, .strike), .chip (--hue), .face
(--hue), .faces, .cap (a keycap; .cap.press with --at 0..1 presses it once per loop), .caret, .ptr (a pointer), .hl, .glow,
.lbl, .arrow. Write the animation rules under .mg.in (the stage gets .in while it is in view and loses it when it leaves,
so each loop starts from its first frame when the reader arrives; .shown is the fade-in, separate), set --loop on the
stage (6s–9s), and write @keyframes in percent of it.
Prefix your keyframe and class names with the chapter id (tasks-tick) so chapters never collide. Grey unless colour means
something: type hue, green done, blue link/focus/now, gold meeting. Keep them calm: one idea, a few moving parts, a
readable pause at the end. Under reduced motion they freeze, so their plain (unanimated) state must be the scene's
meaningful end state.

## Scenes: capturing pictures

manual/scenes/<id>.js exports an array of shots; the header of run.js documents every field and step. Run it outside the
sandbox (it starts Chromium on a loopback port):

    node manual/scenes/run.js manual/scenes/<id>.js                 # every shot, light and dark
    node manual/scenes/run.js manual/scenes/<id>.js --only a,b --themes light   # while iterating

It draws the real window (shell.html, Trellis panes) on the renderer's mock data (renderer/mock.js), logged in. Steps run
in a page's global scope, so the renderer's own functions drive it:

- goTo('mockdoc0') opens a node; goTo('orbital:timeline'), goTo('orbital:notifications'), goTo('orbital:proposals') the
  app pages; setView('inbox') / 'library' / 'types' a view (renderer/edit.js); openElsewhere('tab' | 'float', id) and
  openSavedView(v) in renderer/palette.js
- tana.myTasks().then((n) => goTo(n.id)) opens My Tasks (the Work View's right pane)
- togglePalette('cmd') opens Cmd+K (or press it: { key: '⌘K' }); { type: 'pin' } types into it
- focus a row: click it ({ click: '.node .text', text: 'Agenda' }) or use the renderer's focus helpers
- 2 panes: panes: 2 (page '' left, page '2' right); { js: …, page: '2' } runs in the right one
- signed out: signedOut: true
- Read renderer/*.js for the function behind anything you want to show; prefer real key presses and clicks in clips,
  and js only to set the stage in setup.

Mock data worth knowing: tasks mockdoc0…mockdoc13 (mockdoc0 "Schedule something with Sam Okafor and Dana Brooks" holds every
block type, a table, an image, references and mentions; mockdoc1 has typed fields; mockdoc2 is pinned to today), the Dutch
note mocknl0, meetings mockmeeting0…8 (mockmeeting2 "Leadership sync" has a write-up and attendees; 6–8 start later
today), the space tana:space:mock "Studio LT", types tana:type:mock0…2 (Project has field definitions), chats
tana:chat:mockchat0…4 (mockchat0 a conversation, mockchat4 waits on questions), members robin (you), sam, priya, tomas.
If a feature needs data the mock lacks, add it to renderer/mock.js in small, additive edits near related data (other
authors edit the same file: never reformat or move code there), then run node --check renderer/mock.js and
npm run check. Keep the mock's data fictional.

Pictures:
- Crop to what the reader needs: clip: { page: '' } for one pane, { sel: '#palette', pad: 24 } for an element, or
  [x, y, w, h]. A full window only when the whole layout is the point. Default window 1280x800; 1440x900 for two panes.
- Clips: 4–12 seconds, one action, ending on the result (hold: 1400 rests on it). Use { caption: '…' } sparingly to name
  what happens. Aim below 500 KB per clip; stills below 250 KB.
- Always both themes (the default). Look at every picture you make (view the image) before using it.

Check your chapter: a shot { name: '<id>-page', url: 'manual/<id>.html', full: true, size: '1440x900' } run with
--out /tmp/manual-check draws the whole page; look at it in both themes, and fix what looks wrong.

Do not run git (the lead commits), do not edit other chapters, manual.css or manual.js. When done, report: the features you
covered (by section), the media you made, anything you could not capture and why, and any mock or shared change you made.
