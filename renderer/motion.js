'use strict';
// Motion: the few moves the app makes, each written once. styles.css holds the durations, the curves and the keyframes
// (its top, and its Motion section); this file holds the moves a script has to play, reading the same numbers. Every
// helper is a plain state change when motion is not welcome, so no caller asks first.

const stillPreferred = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const motionOK = () => !stillPreferred() && typeof Element === 'function' && typeof Element.prototype.animate === 'function';
const MOTION = (() => {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : { getPropertyValue: () => '' }; // no stylesheet: the numbers it holds
  const ms = (name, d) => parseFloat(cs.getPropertyValue(name)) || d;
  const ease = (name) => cs.getPropertyValue('--ease-' + name).trim() || 'ease';
  return { quick: ms('--dur-quick', 160), base: ms('--dur-base', 240), slow: ms('--dur-slow', 420), flash: ms('--dur-flash', 800), stagger: ms('--stagger', 30),
    out: ease('out'), in: ease('in'), spring: ease('spring'), move: ease('move'), settle: ease('settle') };
})();
// A move answers a hand: a key or a press in the moment before. A reload, a live update or a page drawing itself is not
// moved, so nothing on screen shifts on its own — the rule the saved-search pills taught (renderer/pills.js).
let handAt = -Infinity;
if (typeof addEventListener === 'function') for (const type of ['keydown', 'pointerdown']) addEventListener(type, () => { handAt = performance.now(); }, true);
const acted = (within = 1000) => performance.now() - handAt < within;
// Press, for a button the press itself draws again (a pill, a toolbar button): the new one arrives at full size, and
// the spring back the old one would have played (styles.css Press) is handed to it instead. The Press buttons are the
// ones styles.css marks with --press, so the list stays there alone; data-id finds the new copy. A press in a menu
// hanging from a button is the menu's.
let pressed = null;
if (typeof addEventListener === 'function') {
  addEventListener('pointerdown', (e) => {
    const el = e.target.closest && !e.target.closest('.menu') && e.target.closest('[data-id]');
    pressed = el && getComputedStyle(el).getPropertyValue('--press').trim() === '1' ? { el, id: el.dataset.id, kind: el.classList[0] } : null;
  }, true);
  addEventListener('pointerup', () => {
    const p = pressed;
    pressed = null;
    if (p) requestAnimationFrame(() => {
      if (p.el.isConnected) return; // still there: its own transition springs it back
      const again = [...document.querySelectorAll('.' + p.kind)].find((el) => el.dataset.id === p.id);
      play(again, [{ transform: 'scale(.95)' }, { transform: 'none' }], { duration: MOTION.slow, easing: MOTION.settle });
    });
  }, true);
}
function play(el, frames, opts) {
  return motionOK() && el && el.animate ? el.animate(frames, { fill: 'backwards', ...opts }).finished.catch(() => {}) : Promise.resolve();
}
// One shot of a class: the turn a press gives before its answer arrives, the pop a button makes when it turns up.
// Restartable, which is the whole reason it is a function: dropping the class and re-adding it in the same frame
// does nothing at all, so the reflow read in between is what lets a second run start instead of being swallowed by
// the one still going. The class goes again when its animation ends: left on, it played again whenever the element
// was shown again — Refresh turned on every arrival at a saved search once it had been pressed. Under reduced
// motion the class is dropped and never re-added: the element is where it is.
function playOnce(el, name) {
  if (!el || !el.classList) return;
  el.classList.remove(name); // dropped before anything is asked: these elements are not rebuilt, so a class left on one would be
  if (stillPreferred()) return;
  void el.offsetWidth;
  el.classList.add(name);
  const end = (e) => { if (e && e.target !== el) return; el.removeEventListener('animationend', end); el.classList.remove(name); };
  if (el.addEventListener) el.addEventListener('animationend', end);
}
// Flash: a tint that says "this changed" and fades — green arriving, red leaving, blue for "here".
function flash(el, kind = 'here') {
  if (!el || !el.style) return;
  el.style.setProperty('--tint', 'var(--flash-' + kind + ')');
  playOnce(el, 'flash');
}
const flashAt = (key) => flash(key ? nodeElOf(key) : null); // the row a caret came back to (an undo)
// the row a document is drawn as on this page, if it is on it
function rowFor(id) {
  for (const [key, item] of items) if (item.node && item.node.id === id) return nodeElOf(key);
  return null;
}

// ---- Reveal: what opens in place, as a curtain ----
// Nothing is laid out while it moves. The page is drawn open (or still open, when closing) and the rows below the
// region slide on transform alone, from where they stood to where they stand; the region shows through a clip whose
// edge runs exactly along the top of those rows, so the two never overlap and nothing reflows frame by frame. Animating
// height relaid the whole outline every frame, and every row of a section at once, which is what made it stutter.
// els are the region (a node's children, or a section's rows), in order; done, when closing, is the state change,
// run once the curtain is down, so the render lands on rows already where it puts them.
let settleAt = 0;
const settling = () => Math.max(0, settleAt - performance.now()); // how long a move still needs the rows it moves (renderSoon waits)
function below(el) { // what is drawn after el in its scroll box: its later siblings, and theirs at every level up
  const stop = el.closest('.scroll, .rail, .app'), out = []; // .app: the ⌘F field sits above the scroll box, and the sidebar beside it must not move
  for (let n = el; n && n !== stop && n !== document.body; n = n.parentElement) for (let s = n.nextElementSibling; s; s = s.nextElementSibling) out.push(s);
  return out;
}
function curtain(els, opening, done) {
  els = els.filter((el) => el && el.isConnected);
  if (!motionOK() || !els.length) return done && done();
  const rects = els.map((el) => el.getBoundingClientRect()), top = rects[0].top, h = Math.max(...rects.map((r) => r.bottom)) - top;
  if (h < 1) return done && done();
  // How far the rows below really move: not the region's box, since a margin at its end reaches past the box and
  // collapses differently once the region is gone — the difference was the jolt at the end of a collapse. Measured by
  // taking the region out for one layout, so the rows land exactly where the redraw puts them.
  const next = below(els.at(-1)).find((el) => el.getBoundingClientRect().height);
  let d = h;
  if (next) {
    const open = next.getBoundingClientRect().top, shown = els.map((el) => el.style.display);
    for (const el of els) el.style.display = 'none';
    d = open - next.getBoundingClientRect().top;
    els.forEach((el, i) => { el.style.display = shown[i]; });
  }
  if (d < 1) return done && done();
  // only what is on screen at some point of the move — each travels between r.top - d and r.top, whichever way it
  // goes — so rows far below go to their place unseen and cost nothing
  const followers = below(els.at(-1)).filter((el) => { const r = el.getBoundingClientRect(); return r.height && r.bottom > 0 && r.top - d < innerHeight; });
  const timing = { duration: opening ? MOTION.base : MOTION.quick, easing: MOTION.move, fill: opening ? 'backwards' : 'forwards' };
  // the clip reaches a little past the sides and top, so list markers, chevrons and focus rings are not cut
  const clip = (hidden) => 'inset(-4px -60px ' + hidden + 'px -60px)';
  const flip = (frames) => frames.map((f) => ({ ...f, offset: 1 - f.offset })).reverse();
  const anims = els.map((el, i) => {
    // each piece of the region opens while the edge crosses it: one keyframe where the edge reaches its top, one where
    // it passes its bottom, on the same eased progress the rows below move on. One piece (a node's children) is
    // clipped to the edge; many (a section's rows) fade in as it reaches each, since a clip repaints every row it
    // cuts on every frame and a fade does not repaint at all — that was the stutter of a long section.
    const at = Math.min(1, (rects[i].top - top) / d), end = Math.min(1, (rects[i].bottom - top) / d), hi = rects[i].height;
    const shut = els.length > 1 ? { opacity: 0 } : { clipPath: clip(hi) }, shown = els.length > 1 ? { opacity: 1 } : { clipPath: clip(0) };
    const frames = [{ offset: 0, ...shut }, ...(at > 0 ? [{ offset: at, ...shut }] : []), ...(end < 1 ? [{ offset: end, ...shown }] : []), { offset: 1, ...shown }];
    return el.animate(opening ? frames : flip(frames), timing);
  });
  const slid = [{ transform: 'translateY(' + -d + 'px)' }, { transform: 'none' }];
  for (const el of followers) anims.push(el.animate(opening ? slid : [...slid].reverse(), timing));
  settleAt = performance.now() + timing.duration + 40;
  if (done) Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => { done(); for (const a of anims) a.cancel(); });
}
// a chevron drawn afresh turns from where the old one pointed
const turnFrom = (el, from) => { if (el && from !== undefined) play(el, [{ transform: from }, { transform: getComputedStyle(el).transform }], { duration: MOTION.quick, easing: MOTION.out }); };
// A node's children (renderer/edit.js setOpen). Closing shrinks them away and then draws the node closed; opening
// draws them and grows them in — once they are there: a node whose children are still loading reveals them when they
// arrive (motionAfter), unless that takes longer than a moment, when they simply appear.
let revealing = null;
function foldRow(key, opening, done) {
  glideUntil = 0; // what opens or closes moves the rows below it itself: a glide on top would move them twice
  const row = nodeElOf(key), chev = row && row.querySelector(':scope > .line > .chev');
  // the chevron answers the click at once, and the redraw finds it already pointing the new way
  if (chev && motionOK()) chev.animate([{ transform: 'none' }, { transform: 'rotate(' + (opening ? 90 : -90) + 'deg)' }], { duration: MOTION.base, easing: MOTION.out, fill: 'forwards' });
  if (!opening) { // closed at once for the keyboard (inert: no Tab, no caret move into it), while the children shrink away
    const kids = row && row.querySelector(':scope > .children');
    if (kids) kids.inert = true;
    return curtain([kids], false, () => { if (kids) kids.inert = false; done(); }); // rows are reused: none keeps it
  }
  const open = () => { settleAt = 0; done(); revealing = { key, until: performance.now() + 1500 }; revealOpened(); };
  // A document opens onto its fields and its children, both read from Tana. Wait a moment for them, so the block opens
  // in one move instead of the fields landing after it and pushing the rows below a second time; an answer slower
  // than that opens on its own when it lands (motionAfter, revealOpened).
  const item = items.get(key), doc = item && (referenceTarget(item.node) || item.node), own = !!item && doc === item.node;
  // (what loadRelated would never ask for is not waited for either)
  const unasked = doc && (!tana.related || !isRealId(doc.id));
  const ready = () => !doc || doc.kind !== 'document' || ((unasked || relatedBy.get(doc.id) != null) && (!own || kids.get(doc.id) != null));
  if (!motionOK() || !connected || ready()) return open();
  loadRelated(doc.id);
  if (own) ensureLoaded(item);
  const until = performance.now() + 400;
  settleAt = until; // the renders those answers ask for wait too (renderSoon), or they would draw the row closed again under the turned chevron
  const wait = () => (ready() || performance.now() > until ? open() : requestAnimationFrame(wait));
  requestAnimationFrame(wait);
}
function revealOpened() {
  if (!revealing) return;
  if (performance.now() > revealing.until || !motionOK()) { revealing = null; return; }
  const wrap = nodeElOf(revealing.key)?.querySelector(':scope > .children');
  if (!wrap || wrap.classList.contains('loading')) return;
  revealing = null;
  curtain([wrap], true);
}
// A folded section: its rows are the siblings after its heading up to the next heading (the outline's group sections,
// the sidebar's). find hands back the heading as the redraw built it again.
const sectionRows = (head) => {
  const rows = [];
  for (let n = head && head.nextElementSibling; n && !n.classList.contains(head.classList[0]); n = n.nextElementSibling) rows.push(n);
  return rows;
};
function foldSection(head, toggle, find) {
  glideUntil = 0;
  const svg = head.querySelector('svg'), from = svg && motionOK() ? getComputedStyle(svg).transform : undefined;
  const opening = head.getAttribute('aria-expanded') === 'false';
  // The redraw that folds or unfolds is quiet: its rows are not arriving in the view or leaving it, and playing that
  // on top of the curtain (the green grow, the red shrink) is what made a section stutter (renderer/render.js animateRows).
  const quietly = () => { rowsQuiet = true; try { toggle(); } finally { rowsQuiet = false; } };
  const land = () => { const again = find(); turnFrom(again && again.querySelector('svg'), from); if (opening && again) curtain(sectionRows(again), true); };
  if (opening) { quietly(); return land(); }
  const rows = sectionRows(head); // closed at once for the keyboard, as a node's children are (foldRow)
  for (const el of rows) el.inert = true;
  curtain(rows, false, () => { for (const el of rows) el.inert = false; quietly(); land(); });
}
let rowsQuiet = false;
// Something that comes and goes in the page's flow (the ⌘F field): it opens and closes as a curtain, so what is below
// slides instead of jumping by its height. Only for a hand; a page drawn with it already open simply has it.
function showHide(el, show) {
  if (show) {
    const was = el.hidden && !el.dataset.closing;
    delete el.dataset.closing;
    el.hidden = false;
    if (was && acted()) curtain([el], true);
    return;
  }
  if (el.hidden || el.dataset.closing) return;
  if (!motionOK() || !acted()) { el.hidden = true; return; }
  el.dataset.closing = '1';
  curtain([el], false, () => { if (el.dataset.closing) { delete el.dataset.closing; el.hidden = true; } });
}
// Flash for a zoomed page's row, which a render builds afresh: it leaves the way a view's row does (styles.css
// .node.leaving), tinted green for a yes and red for a no, and done takes it off the page once it has gone.
function dismissRow(el, kind, done) {
  if (!el || !motionOK()) return done();
  let over = false;
  const end = () => { if (!over) { over = true; done(); } };
  el.style.setProperty('--tint', 'var(--flash-' + kind + ')');
  el.classList.add('leaving');
  el.addEventListener('animationend', end, { once: true });
  setTimeout(end, MOTION.quick + MOTION.base + 120); // a render that rebuilds the page meanwhile takes the row, and its animationend, with it
}
// The last row a view let go of has gone: draw the view again, so it says it is empty (and Inbox zero gets its moment
// in motionAfter) instead of standing blank until something else renders.
function settleEmpty(root) { if (!root.querySelector('.node')) renderSoon(); }
// The sidebar slides out past the window's edge and back in (Reveal): off the right edge, by its margin, so its rows
// never reflow on the way. Hiding waits for the slide; showing slides the drawn sidebar in.
function slideRail(opening, update) {
  const rail = document.getElementById('rail');
  const frames = () => [{ marginRight: -rail.getBoundingClientRect().width + 'px', opacity: 0 }, { marginRight: '0px', opacity: 1 }];
  if (opening) { update(); if (rail && !rail.hidden) play(rail, frames(), { duration: MOTION.base, easing: MOTION.move }); return; }
  if (!motionOK() || !rail || rail.hidden) return update();
  const a = rail.animate(frames().reverse(), { duration: MOTION.quick, easing: MOTION.move, fill: 'forwards' });
  a.finished.catch(() => {}).then(() => { update(); a.cancel(); });
}

// ---- Glide, and the outline's other moves around a render ----
// An action that moves rows (a move, an indent, a drop, a sort, a group, a status, Clean up) arms the glide; the
// renders in the next moment measure every row before and after and slide each from where it was. A row inside
// another moves with it, so it is given only what it moved on its own.
let glideUntil = 0;
const armGlide = () => { glideUntil = performance.now() + 1500; };
let rowsLeftAt = -Infinity;
function motionBefore(root) {
  if (!motionOK()) return null;
  const nodes = [...root.querySelectorAll('.node[data-key]')];
  return {
    page: root.dataset.key + '|' + view,
    bodies: new Map(nodes.map((el) => [el.dataset.key, el.dataset.body])),
    fieldsWaiting: new Set([...root.querySelectorAll('.inline-fields[hidden]')].map((el) => el.dataset.docId)),
    rects: performance.now() < glideUntil ? new Map(nodes.map((el) => [el.dataset.key, el.getBoundingClientRect()])) : null,
  };
}
function motionAfter(root, was) {
  revealOpened();
  if (!was || !motionOK()) return;
  const nodes = [...root.querySelectorAll('.node[data-key]')], same = was.page === root.dataset.key + '|' + view;
  if (!same) return;
  // the fields of a row just opened, landing after it did: they open in place as the row did
  if (acted(5000)) for (const el of root.querySelectorAll('.inline-fields:not([hidden])')) if (was.fieldsWaiting.has(el.dataset.docId)) curtain([el], true);
  if (was.rects) {
    const moved = new Map();
    for (const el of nodes) {
      const a = was.rects.get(el.dataset.key);
      if (!a) continue;
      const b = el.getBoundingClientRect();
      moved.set(el, [a.left - b.left, a.top - b.top]);
    }
    for (const [el, [dx, dy]] of moved) {
      const up = moved.get(el.parentElement && el.parentElement.closest('.node')) || [0, 0], x = dx - up[0], y = dy - up[1];
      if (Math.abs(x) > 1 || Math.abs(y) > 1) play(el, [{ transform: 'translate(' + x + 'px, ' + y + 'px)' }, { transform: 'none' }], { duration: MOTION.base, easing: MOTION.move });
    }
  }
  // Someone else's edit: a row whose words or state changed while your hands were elsewhere lights up once. Your own
  // edits come with a key or a press just before them, so they never do.
  if (!acted(3000)) for (const el of nodes) { const was2 = was.bodies.get(el.dataset.key); if (was2 != null && was2 !== el.dataset.body) flash(el, 'here'); }
  // Inbox zero: the last rows of a view just left, and what is left is the note saying so.
  if (nodes.some((el) => el.classList.contains('leaving'))) rowsLeftAt = performance.now();
  const note = !zoom && root.querySelector(':scope > .empty-note');
  if (note && !nodes.length && performance.now() - rowsLeftAt < 1500 && !note.querySelector('button')) { note.textContent = 'All clear'; note.classList.add('cleared'); rowsLeftAt = -Infinity; }
}

// ---- Page: going somewhere ----
// The page changes at once — every caller expects it changed when this returns — and then lands: the title comes in
// the way you went and the rest follows it, one part after another. Back and forward slide by direction, opening a
// page rises into place, a view switch only fades. Only for a hand, and only when it went somewhere: a reload, a
// notification click from outside the window, a restored place, and Home (or a pin, a crumb) pressed on the page it
// opens are drawn as they stand.
let turning = false;
const placeNow = () => JSON.stringify([view, zoom && zoom.docId, zoom && zoom.nodeId]);
function turnPage(dir, update) {
  if (turning || !motionOK() || !acted()) return update();
  const from = placeNow();
  turning = true;
  try { update(); } finally { turning = false; }
  if (placeNow() === from) return; // the same page again: nothing to arrive
  const x = dir === 'back' ? -16 : dir === 'fwd' ? 16 : 0, y = dir === 'in' ? 8 : 0;
  ['title', 'crumbs', 'taskInfo', 'fields', 'pills', 'outline', 'rail'].forEach((id, i) => {
    const still = id === 'rail'; // the sidebar is beside the page, not ahead of it: it fades
    const lift = id === 'title' ? y / 2 : y; // the title leads, travelling less than what follows it
    play(document.getElementById(id), [{ opacity: 0, transform: still ? 'none' : 'translate(' + x + 'px, ' + lift + 'px)' }, { opacity: 1, transform: 'none' }],
      { duration: MOTION.base, easing: MOTION.out, delay: Math.max(0, i - 1) * MOTION.stagger });
  });
}
// An element grows out of where something else stood (a picture out of its row), or back into it. scale is the size
// it starts at; the width ratio unless the caller knows better.
function growFrom(el, rect, scale, back) {
  if (!el || !rect || !motionOK()) return Promise.resolve();
  const r = el.getBoundingClientRect();
  if (!r.width) return Promise.resolve();
  const s = scale || rect.width / r.width;
  const there = { transformOrigin: '0 0', transform: 'translate(' + (rect.left - r.left) + 'px, ' + (rect.top - r.top) + 'px) scale(' + s + ')' }, here = { transformOrigin: '0 0', transform: 'none' };
  return play(el, back ? [here, there] : [there, here], { duration: back ? MOTION.quick : MOTION.slow, easing: MOTION.move, fill: back ? 'forwards' : 'backwards' });
}
// A theme change, which touches every colour at once: one crossfade of the whole window rather than a cut.
function crossfade(update) {
  if (!motionOK() || !acted() || !document.startViewTransition) return update();
  document.startViewTransition(update);
}

// ---- Pop and Surface for things built again on every render ----
// A menu is rebuilt with its button on every key: it grows in when there was none, and one no longer wanted shrinks
// away over the button that owned it. data-for says which menu is which.
function menuMotion(old, next, host) {
  if (next && !(old && old.dataset.for === next.dataset.for)) next.classList.add('in');
  if (!old || (next && old.dataset.for === next.dataset.for) || !host || !motionOK()) return;
  old.classList.remove('in'); old.classList.add('out'); host.append(old);
  const gone = () => old.remove();
  old.addEventListener('animationend', gone, { once: true });
  setTimeout(gone, MOTION.quick + 60);
}
// The palette's list slides across when it changes mode while open (Cmd+K to Assign to …); a fresh open is the
// palette's own arrival (styles.css), so it only remembers the mode then.
let panelShown = null;
function swapPanel(el, mode) {
  if (el && mode && panelShown && mode !== panelShown) playOnce(el, 'swap');
  panelShown = mode;
}
// A Codex badge whose state just changed pops; done shines once, broken shakes. Only a change: a badge drawn again in
// the state it had is left alone, however often a render draws it.
const badgeSeen = new Map();
function badgeMoved(el, id, state) {
  const was = badgeSeen.get(id);
  badgeSeen.set(id, state);
  if (!was || was === state || !motionOK()) return;
  playOnce(el, state.startsWith('broken') ? 'shake' : 'pop'); // one-shot: a row reused by a later render must not play it again
  if (state === 'done') playOnce(el, 'shine');
}
// Notifications just read: each dot shrinks back to a plain one, in order, once the render that reads them has drawn.
function popRead(ids) {
  if (!motionOK() || !ids.length) return;
  requestAnimationFrame(() => ids.forEach((id, i) => { const el = rowFor(id); if (el) { el.style.setProperty('--i', i); playOnce(el, 'read-now'); } }));
}
// a mention just linked lights up in its row (renderer/toolbar.js linkTo)
function popMention(key, uri) {
  for (const m of textEl(key)?.querySelectorAll('.mention') || []) if (m.dataset.uri === uri) playOnce(m, 'pop');
}
