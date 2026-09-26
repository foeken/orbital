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
    out: ease('out'), in: ease('in'), spring: ease('spring'), move: ease('move') };
})();
// A move answers a hand: a key or a press in the moment before. A reload, a live update or a page drawing itself is not
// moved, so nothing on screen shifts on its own — the rule the saved-search pills taught (renderer/pills.js).
let handAt = -Infinity;
if (typeof addEventListener === 'function') for (const type of ['keydown', 'pointerdown']) addEventListener(type, () => { handAt = performance.now(); }, true);
const acted = (within = 1000) => performance.now() - handAt < within;
function play(el, frames, opts) {
  return motionOK() && el && el.animate ? el.animate(frames, { fill: 'backwards', ...opts }).finished.catch(() => {}) : Promise.resolve();
}
// One shot of a class: the turn a press gives before its answer arrives, the pop a button makes when it turns up.
// Restartable, which is the whole reason it is a function: dropping the class and re-adding it in the same frame
// does nothing at all, so the reflow read in between is what lets a second run start instead of being swallowed by
// the one still going. Under reduced motion the class is dropped and never re-added: the element is where it is.
function playOnce(el, name) {
  if (!el || !el.classList) return;
  el.classList.remove(name); // dropped before anything is asked: these elements are not rebuilt, so a class left on one would be
  if (stillPreferred()) return;
  void el.offsetWidth;
  el.classList.add(name);
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

// ---- Reveal: what opens in place grows from nothing and fades in; what closes shrinks away first ----
function reveal(els) {
  els = els.filter(Boolean);
  if (!motionOK() || !els.length) return;
  const heights = els.map((el) => el.getBoundingClientRect().height); // every read before any write
  els.forEach((el, i) => play(el, [{ height: '0px', opacity: 0, overflow: 'clip' }, { height: heights[i] + 'px', opacity: 1, overflow: 'clip' }],
    { duration: MOTION.base, easing: MOTION.move, delay: Math.min(i, 8) * MOTION.stagger }));
}
// done runs once they have gone, and is the state change itself: the render that follows replaces what shrank.
function conceal(els, done) {
  els = els.filter(Boolean);
  if (!motionOK() || !els.length) return done();
  const heights = els.map((el) => el.getBoundingClientRect().height);
  const anims = els.map((el, i) => el.animate([{ height: heights[i] + 'px', opacity: 1, overflow: 'clip' }, { height: '0px', opacity: 0, overflow: 'clip' }],
    { duration: MOTION.quick, easing: MOTION.move, fill: 'forwards' }));
  Promise.all(anims.map((a) => a.finished.catch(() => {}))).then(() => { done(); for (const a of anims) a.cancel(); });
}
// a chevron drawn afresh turns from where the old one pointed
const turnFrom = (el, from) => { if (el && from !== undefined) play(el, [{ transform: from }, { transform: getComputedStyle(el).transform }], { duration: MOTION.quick, easing: MOTION.out }); };
// A node's children (renderer/edit.js setOpen). Closing shrinks them away and then draws the node closed; opening
// draws them and grows them in — once they are there: a node whose children are still loading reveals them when they
// arrive (motionAfter), unless that takes longer than a moment, when they simply appear.
let revealing = null;
function foldRow(key, opening, done) {
  glideUntil = 0; // what opens or closes moves the rows below it itself: a glide on top would move them twice
  const land = () => {
    done();
    const again = nodeElOf(key);
    if (again && motionOK()) play(again.querySelector(':scope > .line > .chev'), [{ transform: 'rotate(' + (opening ? -90 : 90) + 'deg)' }, { transform: 'none' }], { duration: MOTION.base, easing: MOTION.out });
    if (opening) { revealing = { key, until: performance.now() + 1500 }; revealOpened(); }
  };
  if (opening) return land();
  const row = nodeElOf(key);
  conceal([row && row.querySelector(':scope > .children')], land);
}
function revealOpened() {
  if (!revealing) return;
  if (performance.now() > revealing.until || !motionOK()) { revealing = null; return; }
  const wrap = nodeElOf(revealing.key)?.querySelector(':scope > .children');
  if (!wrap || wrap.classList.contains('loading')) return;
  revealing = null;
  reveal([wrap]);
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
  const land = () => { const again = find(); turnFrom(again && again.querySelector('svg'), from); if (opening && again) reveal(sectionRows(again)); };
  if (opening) { toggle(); return land(); }
  conceal(sectionRows(head), () => { toggle(); land(); });
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
    rects: performance.now() < glideUntil ? new Map(nodes.map((el) => [el.dataset.key, el.getBoundingClientRect()])) : null,
  };
}
function motionAfter(root, was) {
  revealOpened();
  if (!was || !motionOK()) return;
  const nodes = [...root.querySelectorAll('.node[data-key]')], same = was.page === root.dataset.key + '|' + view;
  if (!same) return;
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
  if (note && !nodes.length && performance.now() - rowsLeftAt < 1500 && !note.querySelector('button')) { note.textContent = 'All clear'; playOnce(note, 'cleared'); rowsLeftAt = -Infinity; }
}

// ---- Page: going somewhere ----
// The page changes at once — every caller expects it changed when this returns — and then lands: the title grows out
// of the row it was opened from (or slides in the way you went), and the rest follows it, one part after another.
// Back and forward slide by direction; a view switch only fades. Only for a hand: a reload, a notification click from
// outside the window and a restored place are drawn as they stand.
let turning = false;
function turnPage(dir, from, update) {
  if (turning || !motionOK() || !acted()) return update();
  const src = typeof from === 'string' ? textEl(from) : from;
  const rect = src && src.getBoundingClientRect(), size = src && parseFloat(getComputedStyle(src).fontSize);
  turning = true;
  try { update(); } finally { turning = false; }
  const title = document.getElementById('title'), x = dir === 'back' ? -16 : dir === 'fwd' ? 16 : 0, y = dir === 'in' ? 8 : 0;
  if (rect && rect.width) growFrom(title, rect, size / parseFloat(getComputedStyle(title).fontSize));
  else play(title, [{ opacity: 0, transform: 'translate(' + x + 'px, ' + y / 2 + 'px)' }, { opacity: 1, transform: 'none' }], { duration: MOTION.base, easing: MOTION.out });
  ['crumbs', 'taskInfo', 'fields', 'pills', 'outline', 'rail'].forEach((id, i) => {
    const still = id === 'rail'; // the sidebar is beside the page, not ahead of it: it fades
    play(document.getElementById(id), [{ opacity: 0, transform: still ? 'none' : 'translate(' + x + 'px, ' + y + 'px)' }, { opacity: 1, transform: 'none' }],
      { duration: MOTION.base, easing: MOTION.out, delay: (rect ? 2 : 0) * MOTION.stagger + i * MOTION.stagger });
  });
}
// An element grows out of where something else stood (a row's title into the page title, a picture out of its row),
// or back into it. scale is the size it starts at; the width ratio unless the caller knows better.
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
  el.classList.add(state.startsWith('broken') ? 'shake' : 'pop');
  if (state === 'done') el.classList.add('shine');
}
// Notifications just read: each dot shrinks back to a plain one, in order, once the render that reads them has drawn.
function popRead(ids) {
  if (!motionOK() || !ids.length) return;
  requestAnimationFrame(() => ids.forEach((id, i) => { const el = rowFor(id); if (el) { el.style.setProperty('--i', i); playOnce(el, 'read-now'); } }));
}
// the ticks a click just took back: renders in the next moment play the tick in reverse (render.js playTicks)
const justUndone = new Map();
// a mention just linked lights up in its row (renderer/toolbar.js linkTo)
function popMention(key, uri) {
  for (const m of textEl(key)?.querySelectorAll('.mention') || []) if (m.dataset.uri === uri) playOnce(m, 'pop');
}
