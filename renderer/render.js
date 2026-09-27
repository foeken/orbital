'use strict';
// Caret helpers and the outline render: rows, drafts, crumbs, fields, animation of arriving and leaving rows.

// ---- caret helpers (contenteditable: text nodes + non-editable mention anchors) ----
// Where in a row's text a point lands. The point is pulled into the text's own box first, so a click beside a
// line lands on that line rather than at the end of the row, and only a click past the last line lands at the end.
// A point the browser cannot read a position from — a row with nothing rendered, an answer outside this text —
// falls back to the end, which is what the row always used to answer.
function caretAt(text, x, y) {
  const box = text.getBoundingClientRect(), end = () => unanchored(text.textContent).length;
  if (!box.width && !box.height) return end();
  const at = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
  for (const px of [Math.min(Math.max(x, box.left + 1), box.right - 1), box.left + 1]) {
    const hit = document.caretRangeFromPoint && document.caretRangeFromPoint(px, at);
    if (!hit || !text.contains(hit.startContainer)) continue;
    const r = document.createRange(); r.selectNodeContents(text); r.setEnd(hit.startContainer, hit.startOffset);
    return unanchored(r.toString()).length; // the same count every offset in this file is made of
  }
  return end();
}
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.focusNode)) return null;
  const r = document.createRange(); r.selectNodeContents(el); r.setEnd(sel.focusNode, sel.focusOffset);
  return unanchored(r.toString()).length;
}
// preventScroll: for putting a caret back where it already was. Focusing a freshly built element scrolls it into
// view, which is right when the user moved the caret and wrong when a re-render moved the element under a caret
// that never went anywhere.
function setCaret(el, offset, preventScroll) {
  el.focus({ preventScroll: !!preventScroll });
  let left = Math.max(0, Math.min(offset, unanchored(el.textContent).length));
  const r = document.createRange(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let t, placed = false;
  while ((t = walker.nextNode())) {
    const len = unanchored(t.data).length; // the caret anchor is no character: offset 0 lands in it, before the chip
    if (left <= len) {
      const a = t.parentNode !== el && t.parentNode.closest('.mention');
      if (a) { if (left === 0) r.setStartBefore(a); else r.setStartAfter(a); } else r.setStart(t, left); // never inside a mention
      placed = true; break;
    }
    left -= len;
  }
  if (!placed) r.setStart(el, el.childNodes.length);
  r.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
// A row that is nothing but one mention chip — Tana's full-reference presentation, a block whose only content is a
// reference. The caret anchor renderSegs puts before the chip is not content, so it does not make the row ordinary.
// Chromium will not delete a non-editable inline from a plaintext field, so Backspace removes the row, and the chip
// shows the focus itself (.chiponly). The caret still lands before and after it, and typing either side makes the
// row ordinary again — text plus an inline reference.
const chipOnly = (el) => {
  const kids = [...el.childNodes].filter((n) => n.nodeType !== 3 || unanchored(n.data));
  return kids.length === 1 && kids[0].nodeType === 1 && !!kids[0].classList.contains('mention');
};
function focused() {
  const el = document.activeElement;
  if (el === titleEl && titleEl.isContentEditable) return { key: titleEl.dataset.key, offset: caretOffset(titleEl) };
  if (el && el.classList.contains('cell') && inRows(el)) return { key: keyOfEl(el), offset: caretOffset(el), cell: el.dataset.cell }; // a table cell: its row, and which cell
  return el && el.classList.contains('text') && inRows(el) ? { key: keyOfEl(el), offset: caretOffset(el) } : null;
}
// [node, offset] for a plain-text offset inside el (the DOM point the same character sits at)
function textPoint(el, offset) {
  let left = Math.max(0, Math.min(offset, unanchored(el.textContent).length));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let t;
  while ((t = walker.nextNode())) { const len = unanchored(t.data).length; if (left <= len) return [t, left]; left -= len; }
  return [el, el.childNodes.length];
}
// put the selection back after a formatting round trip re-rendered the node
function selectRange(key, start, end, preventScroll) {
  const el = textEl(key);
  if (!el) return;
  el.focus({ preventScroll: !!preventScroll });
  const r = document.createRange(), [sn, so] = textPoint(el, start), [en, eo] = textPoint(el, end);
  r.setStart(sn, so); r.setEnd(en, eo);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
// [start, end] plain-text offsets of a non-empty selection inside el, else null
function selectionOffsets(el) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const pre = document.createRange(); pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset); const start = unanchored(pre.toString()).length;
  pre.setEnd(r.endContainer, r.endOffset); const end = unanchored(pre.toString()).length;
  return end > start ? [start, end] : null;
}
function placeCaret(key, offset, preventScroll) {
  const el = textEl(key);
  if (el) setCaret(el, offset == null ? el.textContent.length : offset, preventScroll);
}
// caret into keys[i] (at offset) when it still exists, else the nearest surviving node: previous ones first, then following
function caretNear(keys, i, offset) {
  for (const k of [keys[i], ...keys.slice(0, i).reverse(), ...keys.slice(i + 1)]) if (k && textEl(k)) return placeCaret(k, k === keys[i] ? offset : null);
}
// true when the caret sits on the first (up) / last (down) visual line of el
function atEdge(el, dir) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const rects = sel.getRangeAt(0).getClientRects();
  if (!rects.length) return true;
  const r = rects[0], box = el.getBoundingClientRect(), lh = r.height || 20;
  return dir === 'up' ? r.top - box.top < lh / 2 : box.bottom - r.bottom < lh / 2;
}

// ---- render ----
let rendering = false; // a focusout caused by swapping elements out during a render is not the user leaving a node
let renderDeferred = false;
// the same for the fields under the title, which are outside the outline and drawn even while a row is edited
let fieldsDeferred = false;
let caretOnOpen = false; // set when a node is opened: the first render with its children puts the caret where typing works
let scrollOnType = false; // that caret is parked below the fold: the first character typed brings its row into view
// Opening a node leaves a row to type in: the local draft row the empty document case has always shown, which stays
// out of Tana until its first typed character (materialise) and is discarded by anything else.
// A block with children appends through insertAfter(last); an empty block uses insertChild.
function withDraftTail(list, parent) {
  if (!Array.isArray(childrenOf(parent)) || isSpace(parent.node) || isSearchDoc(parent.node) || isTypeDoc(parent.node) || !canEditItem(parent) || !canInsertChild(parent)) return list;
  // The row is there so that there is somewhere to type, not as a permanent blank line: a node with content ends
  // at its last row, and Enter adds the next one. It comes back when there is nothing to type in — an empty node,
  // or one holding only an image, a divider or a reference — because then there would be no way in at all.
  if (list.some((n) => n && n.kind === 'block' && !isAtomic(n) && !isReference(n))) return list;
  return [...list, draftNode(parent, list.at(-1))];
}
function editingRow() {
  const el = document.activeElement;
  // The fields under the title are rows too now — the same editor, in another container — so a render defers for a
  // caret in one of them exactly as it does for a row in the outline.
  return !!(el && el.isContentEditable && (el === titleEl || inRows(el)));
}
// A row arriving in or dropping out of a view is shown, not swapped in silently: an arrival fades in over a green
// tint, and a row that left is put back where it was over a red tint and fades away. Within one view only, since
// switching views, zooming and the first paint replace every row and must not flash.
function animateRows(before) {
  // Nothing on screen before this paint is the view appearing, not every row arriving at once: a view whose rows have
  // not loaded yet paints empty first (loadView resolves after the render that asked for it), and that empty paint
  // must not be mistaken for "these rows were already here".
  // A section folding or unfolding redraws quietly too (renderer/motion.js foldSection): its own move shows it.
  if (animView !== view || !before.size || rowsQuiet) { animView = view; return; }
  const rows = [...outline.children].filter((el) => el.classList.contains('node'));
  const keys = new Set(rows.map((el) => el.dataset.key));
  const old = [...before.keys()];
  const arrived = rows.filter((el) => !before.has(el.dataset.key) && !el.classList.contains('draft'));
  const gone = old.filter((key) => !keys.has(key) && !key.startsWith('draft'));
  if (arrived.length > BULK || gone.length > BULK) return;
  // An arrival plays once: the class goes when it ends, or every later render — which puts reused rows back with
  // replaceChildren, restarting whatever animation they carry — would play it again.
  for (const el of arrived) { el.classList.add('entering'); el.onanimationend = (e) => { if (e.target === el) el.classList.remove('entering'); }; }
  for (const key of gone) {
    const el = before.get(key);
    const next = old.slice(old.indexOf(key) + 1).find((k) => keys.has(k)); // back where it was: before the first row that outlived it
    if (!el.classList.contains('leaving')) { // one that is already on its way out: the renders that keep coming must not cut it short
      el.classList.add('leaving'); el.classList.remove('selected', 'entering'); // a row that just arrived and left again only leaves
      for (const t of el.querySelectorAll('[contenteditable]')) t.removeAttribute('contenteditable');
      // not animationend: a render meanwhile restarts it. The last one gone draws the view again, so an emptied view
      // says so (and Inbox zero gets its moment, renderer/motion.js motionAfter) instead of standing blank.
      setTimeout(() => { el.remove(); settleEmpty(outline); }, 500);
    }
    outline.insertBefore(el, (next && nodeElOf(next)) || null);
  }
}
// The render that would drop the row you are typing in is deferred until the caret leaves (complete a task and the
// Tasks filter no longer wants it). Dim it meanwhile: it stays where it is, and the deferred render fades it out
// like any other row that left. The view lists documents only, so the row to test is the top-level one the caret is in:
// a block under an expanded task is not leaving unless that task is.
function markFalling() {
  const f = zoom ? null : focused(), v = viewOf();
  let row = f && nodeElOf(f.key);
  while (row && row.parentElement !== outline) row = row.parentElement?.closest('.node') || null;
  if (row && v) row.classList.toggle('falling', !v.nodes.some((n) => keyFor(n.id, n) === row.dataset.key));
}
// A render that waits for the caret (or a frozen selection) still brings every checkbox up to date: its tick, its dashed
// Inbox box and the struck-through text are chrome, not the text being typed, so a status set from Cmd+K with rows
// selected, a live change from another device or a sidebar click shows at once instead of when the caret leaves. The
// rows are read fresh: docCache can still hold rows a loadRoots has replaced since the last full render.
function refreshRowChrome() {
  // One lookup table per call: allDocs() builds every view's rows afresh, and asking it once per row on screen cost a
  // frame and more on a list of a thousand (#263). The first copy wins, as find() answered.
  const byId = new Map();
  for (const d of allDocs()) if (!byId.has(d.id)) byId.set(d.id, d);
  const fresh = (id) => byId.get(id) || extra.get(id);
  for (const el of outline.querySelectorAll('.node')) {
    const item = items.get(el.dataset.key), check = el.querySelector(':scope > .line > .check');
    if (!item || !check) continue;
    const node = (item.node.kind === 'document' && fresh(item.node.id)) || item.node, display = referenceTarget(node) || node;
    check.checked = !!display.done;
    check.classList.toggle('inbox', isTask(display) && display.stateType === 'proposed');
    el.classList.toggle('done', !!display.done);
  }
  const page = zoom && !zoom.nodeId && !titleCheck.hidden ? fresh(zoom.docId) : null;
  if (page) { titleCheck.checked = !!page.done; titleCheck.classList.toggle('inbox', acceptsFirst(page)); titleEl.classList.toggle('done', !!page.done); }
  const related = new Map(railGroups(zoom ? relatedBy.get(zoom.docId) : null).flatMap(([, rows]) => rows || []).map((n) => [n.id, n]));
  for (const row of railEl.querySelectorAll('.rrow[data-id]')) {
    const n = related.get(row.dataset.id), check = row.querySelector('.check');
    if (!n || !check) continue;
    check.checked = !!n.done; check.classList.toggle('inbox', n.stateType === 'proposed'); row.classList.toggle('done', !!n.done);
  }
  playTicks();
}
// Completing a task here (not a live update from elsewhere) is worth a flourish: the box squashes, pops and sends out
// a green ring, the tick appears stroke by stroke (a cover the colour of the box, wiped off left to right; styles.css
// .check:checked) and the strike sweeps across the text before the plain line-through takes over. Script animations
// on the elements rather than a CSS class: a render puts reused rows back with replaceChildren, which restarts a
// CSS animation mid-flight and leaves these running. A row rebuilt meanwhile (the live update of the task lands
// within the moment, and a zoomed page builds its rows afresh) joins at the time the click's animation has reached.
const TICK_MS = 700; // longer than the last of the three below
// Where Chrome draws a line-through (Blink's TextDecorationInfo): a stroke of max(1px, font-size / 10) centred two
// thirds of the font's ascent down from the top of the text's content area, which sits at the top of an inline box
// and is centred in the line box of a block (the page title, a sidebar row). Measured from the font itself so the
// sweep lands on the line that replaces it, at every size.
function strikeTop(text) {
  const cs = getComputedStyle(text), ctx = (strikeTop.ctx ||= document.createElement('canvas').getContext('2d'));
  ctx.font = cs.font;
  const m = ctx.measureText('x'), lh = parseFloat(cs.lineHeight) || m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const lead = cs.display === 'inline' ? 0 : (lh - m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
  const thick = Math.max(1, parseFloat(cs.fontSize) / 20); // the system font's own underline weight: 1px at 16px, under 2px on the page title
  // ponytail: checked by eye against Blink's own line at 16px on a 1.8x display; tune STRIKE_NUDGE (px) if a font
  // or scale disagrees
  const snap = (v) => Math.round(v * devicePixelRatio) / devicePixelRatio; // on device pixels, like Blink's stroke: no anti-aliased smear that reads as weight
  return { top: snap(lead + m.fontBoundingBoxAscent * 2 / 3 - thick / 2 + STRIKE_NUDGE), lh, thick: snap(thick) };
}
const STRIKE_NUDGE = 0;
// Unchecking is instant: taking a tick back is a correction, not something to celebrate. The tick keeps its own timing,
// tuned by eye: on the shared curves the strike lingered at its end and the whole thing read as slower.
function playTick(check, text, at) {
  if (!check || !text || check.dataset.tick === String(at) || !motionOK()) return;
  check.dataset.tick = String(at);
  const ring = (px, a) => '0 0 0 ' + px + 'px rgba(111, 174, 130, ' + a + ')';
  // one stroke per line (a line-high tile repeated down), so a wrapped title is struck on every line, where the line-through will be
  const { top, lh, thick } = strikeTop(text);
  const strike = (w) => ({ backgroundImage: 'linear-gradient(transparent ' + top + 'px, currentColor ' + top + 'px ' + (top + thick) + 'px, transparent 0)', backgroundRepeat: 'repeat-y', backgroundSize: w + ' ' + lh + 'px', textDecorationColor: 'transparent' });
  const anims = [
    check.animate([{ transform: 'scale(1)', boxShadow: ring(0, .6) }, { transform: 'scale(.8)', offset: .25 }, { transform: 'scale(1.18)', boxShadow: ring(7, .25), offset: .6 }, { transform: 'scale(1)', boxShadow: ring(12, 0) }],
      { duration: 550, easing: 'cubic-bezier(.34, 1.56, .64, 1)' }),
    check.animate([{ backgroundSize: '100% 100%, 100% 100%' }, { backgroundSize: '0% 100%, 100% 100%' }], { duration: 260, delay: 120, easing: 'ease-out', fill: 'backwards' }),
    text.animate([strike('0'), strike('100%')], { duration: 400, delay: 180, easing: 'ease-in-out', fill: 'backwards' }),
  ];
  for (const a of anims) a.currentTime = Date.now() - at;
}
// At the end of a render: every place a task completed here is drawn (its row, its sidebar row, the page head).
function playTicks() {
  if (!justDone.size) return;
  const now = Date.now();
  for (const [id, at] of justDone) if (now - at > TICK_MS) justDone.delete(id);
  for (const el of outline.querySelectorAll('.node.done')) { // a task row, or a line that is one mention of a task
    const item = items.get(el.dataset.key), n = item && (referenceTarget(item.node) || item.node);
    if (n && justDone.has(n.id)) playTick(el.querySelector(':scope > .line > .check'), el.querySelector(':scope > .line .text'), justDone.get(n.id));
  }
  for (const row of railEl.querySelectorAll('.rrow.done[data-id]')) if (justDone.has(row.dataset.id)) playTick(row.querySelector('.check'), row.querySelector('.rtitle'), justDone.get(row.dataset.id));
  if (zoom && !zoom.nodeId && justDone.has(zoom.docId) && titleEl.classList.contains('done')) playTick(titleCheck, titleEl, justDone.get(zoom.docId));
}
function render(force = false) {
  if (force !== true && (editingRow() || selectionFrozen)) { renderDeferred = true; markFalling(); refreshRowChrome(); if (pillsDrawn) renderPills(true); return; }
  renderDeferred = false; rendering = true;
  // presence (renderer/presence.js) follows the page and redraws who is here; the check harnesses load render.js without it
  try { renderOutline(); if (typeof syncPresence === 'function') syncPresence(); } finally { rendering = false; playTicks(); }
  fitRowMeta();
}
// The page's title on its tab in the shell (shell.js): what the header shows, so masked in demo mode, and 'Hidden'
// while the document's sensitive mark blurs it, and whether it can be typed in, which offers Rename on the tab (issue
// #441). Told once per change; outside the shell (the mock) there is no tab.
let toldTitle = null;
const retellTitle = () => { if (toldTitle) tellTitle(titleEl.classList.contains('sensitive') ? 'Hidden' : titleEl.textContent, toldTitle.endsWith('\ntrue')); };
function tellTitle(title, renamable) {
  const told = title + '\n' + renamable;
  if (told === toldTitle || !window.frameElement) return;
  toldTitle = told;
  window.parent.postMessage({ orbital: 'title', title, renamable }, '*');
}
// A task row carries its grey facts — who it is for, who can see it, whether it notifies — after the title. When the
// title fills the line the browser wraps them onto a line of their own, where they read as a second title rather
// than as facts about the first; there they belong with the subtext instead, joined to it by the same separator its
// own parts use. Every row is measured before any is moved, so the whole outline costs one layout rather than one
// per row, and the measurement asks how much room the line leaves rather than where the facts currently sit — the
// same answer whether they are inline or already below, which is what keeps them from flipping back and forth.
const META_SEP = ' · ';
const META_GAP = 8; // .meta's margin-left in styles.css, which offsetWidth does not carry
function fitRowMeta() {
  const plan = [];
  for (const body of outline.querySelectorAll('.node > .line > .body')) {
    if (tableView() && body.matches('.outline.table-view > .node > .line > .body')) continue; // a table row keeps its icons in their own column: its grey line is the other columns
    const meta = body.querySelector('.meta.tmeta'), sub = body.querySelector(':scope > .subtext');
    if (!meta || !sub) continue;
    const anchor = body.querySelector(':scope > .meta:not(.tmeta)') || body.querySelector(':scope > .text');
    const rects = anchor ? anchor.getClientRects() : [], last = rects[rects.length - 1];
    if (!last) continue; // nothing on screen to measure against: a hidden row keeps whatever it has
    plan.push({ body, meta, sub, below: meta.offsetWidth + META_GAP > body.getBoundingClientRect().right - last.right });
  }
  for (const { body, meta, sub, below } of plan) {
    if (below === (meta.parentElement === sub)) continue;
    const sep = body.querySelector('.metasep');
    if (sep) sep.remove();
    if (below) { const mark = document.createElement('span'); mark.className = 'metasep'; mark.textContent = META_SEP; sub.append(mark, meta); }
    else body.insertBefore(meta, body.querySelector(':scope > .chip') || sub);
  }
}
// the outline changes width with the window, the sidebar drag and the text-size keys, and all three land here.
// Only a width change is answered: moving the facts changes the outline's height, which would otherwise come back.
let fitWidth = null;
if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
  if (outline.clientWidth === fitWidth) return;
  fitWidth = outline.clientWidth;
  fitRowMeta();
}).observe(outline);
// A row patched in place (renderer/tasks.js patchMeta) asks for the fit here: metadata arrives one answer per row as
// the rows scroll in, and fitting after each one forced a layout of the whole outline per answer (#264). The frame
// callback runs before the paint, so a row is never seen with its facts on the wrong line.
let fitQueued = false;
function fitRowMetaSoon() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; fitRowMeta(); });
}
// Metadata and sync may finish between keystrokes. Apply their deferred render only after the caret leaves editable rows.
document.addEventListener('focusout', () => queueMicrotask(() => {
  if ((renderDeferred || fieldsDeferred) && !editingRow() && !selectionFrozen) render();
}));
// Answers that arrive on their own — a row's metadata, pins, the rail, a crumb date, live updates — render once per
// frame between them rather than once each: a view of N rows used to rebuild itself N times as its metadata came in.
// A live update needs the forced render (it must not be deferred while the caret sits in a row), and those arrive in
// bursts of their own — one per document a view subscribes — so the force rides the same frame rather than skipping
// the queue: renderSoon(true) coalesces with anything else waiting and redraws once. Only a literal true forces, so
// a stray promise value from .then(renderSoon) cannot turn into one.
let renderQueued = false, renderQueuedForce = false;
function renderSoon(force) {
  renderQueuedForce ||= force === true;
  if (renderQueued) return;
  renderQueued = true;
  // An answer that lands while a row is opening or closing waits for it to finish (renderer/motion.js settling): an
  // expanded row is rebuilt on every render, and one rebuilt mid-move jumped straight to its end.
  const go = () => { const wait = settling(); if (wait) return setTimeout(go, wait); renderQueued = false; const forced = renderQueuedForce; renderQueuedForce = false; render(forced); };
  requestAnimationFrame(go);
}
// What a list row is built from. A row whose signature has not changed since the last render is kept as it is,
// which turns a live update or a refresh into a handful of rebuilt rows instead of a whole new outline.
function rowSig(n) {
  const meta = taskMetaById.get(n.id);
  // stateType too: accepting an Inbox task changes only the state, and a reused row would keep the tick the click put in its box
  return JSON.stringify([n.text, n.done, n.stateType, n.icon, n.hue, n.meta, n.tags, n.editable, n.draft, n.hasChildren, n.kind, n.type, n.start,
    n.updatedAt, n.createdAt, n.createdBy, n.fields, // the subtext's times, author and field values: they arrive after the row and a reused row would still show none
    sensitiveHidden(n.id), isPinned(n.id), meta || (taskMetaLoading.has(n.id) ? 'loading' : null), members ? members.length : 0, open.get(n.id), pending.has(n.id),
    displayKeys().join(','), codexIds.has(n.id), agentStateOf(n.id), agentTaskHosts.get(n.id), pinnedOn(n), n.table,
    n.proposal ? n.proposal.note : null, n.subtext, n.join, n.timeline && n.timeline.recording, tableView(), // which facts the row shows, and as a list or a table: without this a reused row would keep the old ones, a proposal's buttons included
    tableView() ? typeDefs() : null, // a table cell's picker is made from the page's field definitions (views.js cellPicker)
    demoMode, // demo mode masks the words and makes every row read-only: a row drawn before the switch shows real titles
    outline.dataset.key]); // and the page it was built for: a row's editability follows its parent, so a view's row is not a type page's
}
function renderOutline() {
  const saved = focused();
  // a live update must not eat a selection: the formatting toolbar acts on it, and a re-render lands mid-toggle
  const savedSel = saved && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('text') ? selectionOffsets(document.activeElement) : null;
  rendered.clear(); docCache.clear();
  const was = motionBefore(outline); // where every row stood and what it said, for the moves after (renderer/motion.js)
  let trail = null;
  if (zoom) { trail = resolveZoom(); if (!trail) zoom = null; }
  const parent = trail && trail.at(-1);
  outline.dataset.key = parent ? parent.key : ''; // whose rows these are, for a drop (renderer/drag.js); a view owns none
  let list, hidden = 0;
  // An unchanged, collapsed row is reused; anything expanded or different is rebuilt. Views and result pages (a saved
  // search, a type) list documents keyed by their id, so both go through this; an outline's blocks do not.
  const reuse = !parent || isSearchDoc(parent.node) || isTypeDoc(parent.node); // an outline, Proposals and the Timeline rebuild
  const before = new Map(reuse ? [...outline.children].filter((el) => el.classList.contains('node')).map((el) => [el.dataset.key, el]) : []);
  const rowEl = (n) => {
    // and whether the page lets its rows be edited (canEditItem reads the nearest document above): a row drawn before
    // access changed must not keep its old contenteditable, box and drag handle
    const old = before.get(n.id), sig = rowSig(n) + (parent ? canEditNode(parent.node) : '');
    if (old && old.dataset.sig === sig && !old.classList.contains('leaving') && !old.querySelector(':scope > .children')) { mkItem(n.id, n, parent); return old; }
    const el = parent ? childEl(n, parent) : nodeEl(n, n.id, null); el.dataset.sig = sig; return el; // childEl: a block row keeps its page's document
  };
  if (parent) {
    if (!parent.node.draft) ensureLoaded(parent);
    list = parent.node.draft ? [] : childrenOf(parent) || [];
    // A saved search page is a result list, like a view, so ⌘F narrows it the same way. No other zoomed page
    // filters: an outline's rows are content you are editing, not a result set you are searching through.
    let groups = null, row = (n) => childEl(n, parent);
    if (isSearchDoc(parent.node) || isTypeDoc(parent.node)) {
      row = rowEl;
      if (isSearchDoc(parent.node)) {
        loadSearchFilter(parent.docId); // its stored query, as the filter the pills above it show
        previewRows(parent.docId);      // and the rows that filter finds, so editing a pill moves the list
      }
      // a saved search is a list of results, so it narrows, sorts and groups exactly as a view does — same helper,
      // with the arrangement its own document stores rather than the one this browser remembers for a view
      const shown = pageRows(list, filterEl.value.trim().toLowerCase());
      list = shown.list; groups = shown.groups; hidden = shown.hidden;
    } else if (parent.docId === PROPOSALS_PAGE) { // yours without a heading, then From others (renderer/proposals.js)
      groups = proposalGroups(list);
      list = groups.flatMap((g) => (g.collapsed ? [] : g.nodes));
    } else if (parent.docId === TIMELINE_PAGE) { // a section per day (renderer/timeline.js)
      groups = timelineGroups(list);
      list = groups.flatMap((g) => (g.collapsed ? [] : g.nodes));
    }
    list = withDraftTail(list, parent); // an open node always has a row to type in; a read-only one (every chat) never does
    const chat = isChatPage(parent), stick = chat && chatStick(parent); // a chat is a conversation, not an outline (renderer/chat.js)
    outline.replaceChildren(...(chat ? chatEls(list, parent.docId) : groups
      ? groups.flatMap((g) => [...(g.title ? [groupHeadEl(g)] : []), ...(g.collapsed ? [] : g.nodes.flatMap((n, i) => [row(n), ...(timelineTopEnds(n, g.nodes[i + 1]) ? [timelineDividerEl()] : [])])), ...(g.more ? [groupMoreEl(g)] : [])])
      : list.map(row)));
    if (parent.docId === TIMELINE_PAGE && tana.timelinePages && kids.get(TIMELINE_PAGE) && !timelinePartial && timelinePages < TIMELINE_MAX_PAGES) outline.append(timelineOlderEl()); // three days a page: more as the end comes into view, once the first page is whole
    animView = null; // a zoom replaced every row, and a zoomed row is keyed docId/nodeId while a view row is keyed by
    // its document id, so on the way back nothing would match and the whole view would flash as if it had just arrived
    // A node opens at its top, however far down the draft tail the caret goes (the caretOnOpen block below parks it
    // there without scrolling). caretOnOpen is still set through both renders of an open — the "Loading…" one and the
    // one the children arrive on, which grows the content — so both land at the top; later renders are left alone.
    if (caretOnOpen && !chat) outline.parentElement.scrollTop = 0;
    chatAfterRender(parent, stick);
  } else {
    chatAfterRender(null);
    const v = viewOf(), docs = v ? v.nodes : [];
    const shown = pageRows(docs, filterEl.value.trim().toLowerCase()); // Default leaves the view's own order alone
    list = shown.list; hidden = shown.hidden;
    const groups = shown.groups; // null when the view is not grouped: one flat list, as before
    outline.replaceChildren(...(groups
      ? groups.flatMap((g) => [groupHeadEl(g), ...(g.collapsed ? [] : g.nodes.map(rowEl)), ...(g.more ? [groupMoreEl(g)] : [])])
      : list.map(rowEl)));
    animateRows(before);
    if (list.length && !outline.hidden && scrolledView !== view) { // a view opens at the top
      scrolledView = view;
      outline.parentElement.scrollTop = 0;
    }
  }
  outline.classList.toggle('table-view', tableView());
  // ponytail: at least one fact column, because repeat(0) and a division by 0 make the grid invalid; with Display
  // empty that column is simply blank. A layout of its own if that case ever matters.
  if (tableView() && list.length) { outline.style.setProperty('--cols', Math.max(1, tableKeys().length)); outline.style.setProperty('--fcols', tableCols()); outline.prepend(tableHeadEl()); } // a list page shown as a table (renderer/views.js)
  // "No content" is about a page with nothing on it, so it goes by what was just drawn rather than by the row count:
  // a grouped page with every section folded away has no rows and is not empty — its headings are right there.
  // Empty is an answer the page has been given: no entry at all means it has not been asked yet, which is where a
  // launch starts — the page it reopens is drawn before there is a connection to ask with (renderer/edit.js). Until
  // then it shows the loading animation, as a view does, rather than a line saying so.
  let asking = false;
  // the Timeline's "Show three more days" is a way to more rows, not a row: an empty Timeline still says so, above it
  if (parent && !list.length && ![...outline.children].some((el) => !el.classList.contains('tl-older'))) {
    asking = !signedOut && !(kids.has(parent.docId) && kids.get(parent.docId) !== null); // signed out, nothing is on its way: the login shows
    const note = document.createElement('div');
    note.className = 'empty-note'; note.textContent = emptyText(parent);
    if (!asking) outline.prepend(note);
  }
  // the page title is the zoom target itself: documents use setTitle, blocks use setText through the same debounce
  const editable = !demoMode && parent && !isAtomic(parent.node) && !isReference(parent.node) && canEditText(parent); // demo text is never typed into, so a mask is never saved
  if (editable) titleEl.contentEditable = 'plaintext-only'; else titleEl.removeAttribute('contenteditable');
  titleEl.dataset.key = editable ? parent.key : '';
  titleEl.textContent = editable && pending.has(parent.key) ? plainOf(pending.get(parent.key).segs) : parent ? demoText(parent.node.text, parent.node.id) : viewOf() ? viewOf().title : 'Tana';
  blurSensitive(titleEl, parent && parent.docId);
  tellTitle(titleEl.classList.contains('sensitive') ? 'Hidden' : titleEl.textContent, !!editable);
  // a view, a saved search or an app page is named by its tab under a tab bar, so its heading goes (styles.css html.listing)
  document.documentElement.classList.toggle('listing', !parent || appOwned(parent.docId));
  // zoomed task: its checkbox before the title (toggleDone, like row checkboxes; Cmd+Enter in the title too)
  const zoomedTask = parent && isTask(parent.node);
  titleCheck.hidden = !zoomedTask; titleCheck.checked = zoomedTask && !!parent.node.done;
  titleCheck.classList.toggle('inbox', !!zoomedTask && acceptsFirst(parent.node)); // dashed while it waits in the Inbox
  titleCheck.disabled = zoomedTask && !canEditItem(parent);
  titleCheck.onclick = zoomedTask && canEditItem(parent) ? () => toggleDone(parent) : null;
  if (demoMode) { titleCheck.disabled = true; titleCheck.onclick = null; } // read-only while demo mode is on
  titleEl.classList.toggle('done', zoomedTask && !!parent.node.done);
  codexHeader(); // a rebuilt header loses the badge with everything else, so it is put back with the title
  // assignees and visibility now live at the top of the sidebar (railMetaRows); under the title only the chips remain.
  // Any zoomed document shows its type, not only a task: what is dropped is the kind chip, whose label is the row's
  // own icon name (task, doc, meeting, space, chat…), so an Organization or any other type stays.
  const titleTags = parent ? visibleTags(parent.node).filter((tag) => tag.label !== parent.node.icon) : [];
  taskInfoEl.hidden = !titleTags.length; taskInfoEl.replaceChildren();
  for (const tag of titleTags) taskInfoEl.append(chipEl(tag, parent.node.hue));
  blurSensitive(taskInfoEl, parent && parent.docId);
  renderFields(parent, true); // this render already got past the caret guard, so the fields are redrawn with it
  renderRail(parent);
  // A saved search is a query you can edit, so it gets the pills too — every other zoomed page is content, not a query.
  const showPills = authed && pillsApply() && (!parent || isSearchDoc(parent.node) || isTypeDoc(parent.node));
  renderPills(showPills);
  showHide(filterRow, !((!!parent && !isSearchDoc(parent.node) && !isTypeDoc(parent.node)) || !(filterShown || filterEl.value))); // it opens and closes in place (renderer/motion.js)
  filterRow.classList.toggle('empty', !filterEl.value);
  // a type page asks for 1,000 rows (main/related.js searchPreview), so a full answer is one that may have been cut
  const cut = parent ? onTypePage() && (kids.get(zoom.docId) || []).length >= 1000 : truncated.has(view);
  $('filtered').textContent = [hidden ? hidden + ' items filtered out' : '', cut ? 'Showing the first 1,000 results' : ''].filter(Boolean).join(' · ');
  // Cached rows remain usable while auth and sync reconnect; reserve the skeleton for an empty outline.
  const loading = asking || (!parent && !outline.children.length && (authChecking || !rootsLoaded || !filters.has(view) || (authed && !connected)));
  // Only the first page builds itself (renderer/loading.js); one opened later, or a reconnect, waits blank for its
  // rows. Signed out is not landed: the page after the login is still the first. Nor is the view under a place still
  // being restored (a first launch's My Tasks half is found only once connected): the loader stays over it, and the
  // outline under it is hidden (styles.css). Offline with nothing to restore, the cached rows show as they are.
  // A Timeline landing in parts is drawn as it comes, the loader building on under what is in (its .tail).
  const placing = !placed && (!!savedPlace || connected), tail = !loading && !!parent && parent.docId === TIMELINE_PAGE && timelinePartial;
  // signed out: the login is the page, and the loader waits for the first page after it (booted stays false)
  const loaderOff = booted || signedOut || !(loading || placing || tail);
  $('skeleton').classList.toggle('gone', loaderOff);
  $('skeleton').classList.toggle('tail', tail);
  // the page under a whole-page loader is hidden (styles.css body.building); a class, since body:has(#skeleton…)
  // restyled the whole page on every DOM change (a ⌘K key on 1,000 rows: 16 ms)
  document.body.classList.toggle('building', !loaderOff && !tail);
  if (!loading && !placing && !tail && authed) booted = true;
  // the same rule as "No content" above: a view with every section folded away has no rows and is not empty
  if (!parent && !list.length && !outline.children.length && !loading && !filterEl.value) { // an empty view says so; a filtered-out list is explained by the count below it
    const note = document.createElement('div');
    note.className = 'empty-note'; note.textContent = 'Nothing here yet';
    if (viewFiltered()) { // the view is empty because of its filters, not because there is nothing there
      const clear = document.createElement('button');
      clear.className = 'clearfilters'; clear.textContent = 'Clear filters'; clear.onclick = clearFilters;
      note.append(' ', clear);
    }
    outline.append(note);
  }
  applySel();
  motionAfter(outline, was);
  for (const key of items.keys()) if (!rendered.has(key)) items.delete(key);
  // Putting the caret back is preserving state, not navigating: a render that only rebuilt the rows must not scroll
  // the page to wherever the caret happens to be. Clicking a task's box while another row held the caret rebuilt the
  // outline and then jumped the view to that other row. Typing still scrolls to itself, through scrollOnType.
  if (saved && savedSel) selectRange(saved.key, savedSel[0], savedSel[1], true);
  else if (saved && saved.cell) placeCell(saved.key, saved.cell, saved.offset);
  else if (saved) placeCaret(saved.key, saved.offset, true);
  // the caret lands in that typable row once per open: a later render (a live update, a refresh) must not pull it back,
  // nor take it from a pill whose menu was opened while the rows were on their way: that is where the typing goes
  if (caretOnOpen && parent && Array.isArray(childrenOf(parent))) {
    caretOnOpen = false;
    const last = list.at(-1), el = last && palette.hidden && !focused() && !$('pills').contains(document.activeElement) ? textEl(keyFor(parent.docId, last)) : null;
    // preventScroll: that row is the last one, so focusing it the ordinary way scrolls a long node to its bottom and
    // the open never shows its top. setCaret's own focus() is then a no-op (already the active element) and collapsing
    // a range into it does not scroll either, so the caret waits out of sight until the first keystroke catches up.
    if (el && el.isContentEditable && !el.textContent) { el.focus({ preventScroll: true }); setCaret(el, 0); scrollOnType = true; }
  }
  noteNavigation(); // where this render landed, for Cmd+[ and Cmd+]
  renderNav(); // and what the two arrows can do from here, which only the line above knows
}

// What an empty page says. A document has no content; a list page has no answer yet, and says what would fill it. The
// two a first launch opens on, the Timeline and My Tasks, are the whole first screen of a new account, so a list of
// tasks also names the key that makes one.
function emptyText(parent) {
  const id = parent.docId;
  if (id === TIMELINE_PAGE) return 'Nothing yet. Changes to the nodes you watch, and tasks added to your Inbox, show up here.';
  if (id === INBOX_PAGE) return 'No notifications yet.';
  if (id === PROPOSALS_PAGE) return 'No proposals waiting.';
  if (isChatPage(parent)) return 'No messages yet. Say something to Tana below.';
  if (!isSearchDoc(parent.node) && !isTypeDoc(parent.node)) return 'No content';
  const filter = filters.get(id), key = hotkeyFor('createTask');
  return 'Nothing matches.' + (filter && tasksInFilter(filter) && key ? ' ' + key + ' creates a task.' : '');
}

function resolveZoom() {
  const doc = docOf(zoom.docId);
  if (!doc) return null;
  let item = mkItem(zoom.docId, doc, null);
  const trail = [item];
  if (zoom.nodeId) {
    const found = locate(kids.get(zoom.docId) || [], zoom.nodeId);
    if (!found) return kids.has(zoom.docId) && kids.get(zoom.docId) !== null ? null : trail;
    for (const t of found.trail) trail.push(item = mkItem(zoom.docId, t.node, item));
    trail.push(item = mkItem(zoom.docId, found.node, item));
  }
  return trail;
}

// The zoomed node's own fields (type attributes) under the title; the values come with api.related.
function renderFields(parent, force = false, el = $('fields')) {
  // The caret is in one of these values: rebuilding the block would take it out of the word being typed, and the
  // values on screen *are* what is being typed. So the redraw waits, exactly as a render with the caret in an
  // outline row does (renderDeferred), and the blur that ends the edit asks for it again. Without this, every
  // render while a field has focus — a live update, the refresh loop, or the field's own save coming back as a
  // metadata change — dropped the caret mid-sentence.
  // A *forced* render is different: it is the answer to something the user just did in this field — a row split by
  // Enter, a bullet indented by Tab — and the action puts the caret back itself (placeCaret). Holding those back
  // is what left a new row invisible until the next click.
  if (!force && el.contains(document.activeElement)) { fieldsDeferred = true; return; }
  fieldsDeferred = false;
  // a field that holds choices is no row, so the caret-keeping every render does cannot find it: it keeps its own focus
  const active = document.activeElement, keep = active && active.classList && active.classList.contains('fchoice') && el.contains(active) ? active.dataset.key : null;
  const data = parent && parent.node.kind === 'document' ? relatedBy.get(parent.docId) : null;
  const fields = (data && data.fields) || [];
  // A type's page is the list of its instances; the fields it defines are shown only while ⌘K Edit fields is on (renderer/fields.js).
  const defs = (data && editingType === parent.docId && data.definitions) || [];
  el.hidden = !fields.length && !defs.length;
  el.replaceChildren();
  for (const def of defs) el.append(definitionEl(parent, def));
  for (const field of fields) {
    const row = document.createElement('div'); row.className = 'field';
    const icon = document.createElement('span'); icon.className = 'ricon'; addIcon(icon, 'field');
    row.append(icon);
    // the type names its fields; an unreadable type leaves the value to speak for itself
    if (field.label) { const label = document.createElement('span'); label.className = 'flabel'; label.textContent = field.label; row.append(label); }
    // A field value is an outline of its own, so it is drawn by the outline’s own rows: the same items, the same
    // keys, the same keyboard. Its id is the document and the field together ("<doc>|<type>?attribute=<key>", read
    // by main/documents.js), which is all that tells the editor where the rows it writes belong — everything else
    // about them, from "- " to Tab to a reference, is the page’s behaviour because it is the page’s code.
    const values = document.createElement('div'); values.className = 'fvalues';
    const hostId = parent.docId + '|' + field.key;
    const host = mkItem(hostId, {
      id: hostId, text: field.label || '', kind: 'document', hasChildren: true, editable: canEditItem(parent),
    }, parent);
    values.dataset.key = hostId; // a field is an outline of its own, and a drop has to know which one (renderer/drag.js)
    ensureLoaded(host);
    const rows = kids.get(host.docId);
    // options, link and member fields hold a closed list: chips to pick, not an editor (renderer/fields.js)
    if (field.type === 'options' || field.type === 'link' || field.type === 'member') values.append(choiceEl(parent, field, host));
    else if (rows === null || rows === undefined) { // still being read: the value it was last seen holding, as words
      const waiting = document.createElement('span'); waiting.className = 'fvalue'; renderSegs(waiting, field.segments || []); values.append(waiting);
    } else {
      // A page keeps an empty row at the bottom to type in; a field must not. Its rows are the value, and a blank
      // one under them is a line that is not there — nothing in Tana carries it, and it makes every filled field
      // look one value longer than it is. An empty field is the exception: without that row there would be
      // nothing to click into to fill it.
      values.replaceChildren(...withDraftTail(rows, host).map((n) => childEl(n, host)));
    }
    row.append(values);
    el.append(row);
  }
  blurSensitive(el, parent && parent.docId);
  if (keep) el.querySelector('.fchoice[data-key="' + CSS.escape(keep) + '"]')?.focus();
}

// a child row: document children (inside a space) are their own document, so their key, children and edits go by their own id
const childEl = (n, item) => nodeEl(n, n.kind === 'document' ? n.id : item.docId, item);
// A node assigned to the local Codex agent. Not an icon in the metadata strip: that strip is one of the facts the
// Display pill can switch off, and this mark says the agent has the node.
// The badge says what the linked task is doing, not merely that a node was assigned: an assignment with no task
// behind it yet is pending and grey, and only work in progress animates. The wording carries the state as well as
// the colour, so the colour is never the only signal.
// `done` is the row's own node, which is what the tick and the strikethrough beside it are drawn from. It is passed
// rather than looked up because `docOf` scans every view's cached rows and answers with the first copy it finds —
// one that may still be open in a view that has not refreshed since.
function codexBadgeEl(id, done = !!docOf(id)?.done) {
  const state = agentStateOf(id), words = AGENT_BADGE[state];
  const el = document.createElement('span');
  // The task itself being finished outranks whatever the agent state was: the badge becomes history, a grey outline
  // with a grey glyph, so a completed row says "there was a thread" without competing with the live ones.
  el.className = 'cbadge ' + state + (done ? ' closed' : '');
  badgeMoved(el, id, state + (done ? ':closed' : '')); // a state that just changed pops, shines or shakes
  // A badge with a task behind it is the way into that task; a pending one has nowhere to go, so it stays a plain
  // image rather than a button that does nothing. Only linked nodes have a status entry at all, which is the same
  // fact — no second list to keep in step.
  // Only a task on this machine can be opened from here: the deep link resolves against this app. One elsewhere is
  // still a badge with its status, but not a way in, and its wording says where it is instead of pretending.
  const where = agentTaskHosts.get(id);
  const linked = agentStates.has(id) && (!where || where === 'local');
  const elsewhere = agentStates.has(id) && where && where !== 'local';
  el.setAttribute('role', linked ? 'button' : 'img');
  const hostName = elsewhere ? (agentHosts.find((h) => h.id === where) || {}).title || where : '';
  el.setAttribute('aria-label', linked ? words.label + ', open the Codex task' : elsewhere ? words.label + ', on ' + hostName : words.label);
  el.title = linked ? words.title + ' — click to open the task' : elsewhere ? words.title + ' — this task runs on ' + hostName : words.title;
  if (linked) {
    el.tabIndex = 0;
    el.onmousedown = (e) => e.preventDefault(); // the caret stays where it is, as every other row control does
    el.onclick = (e) => { e.stopPropagation(); run(() => tana.openCodexTask(id)); };
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); run(() => tana.openCodexTask(id)); } };
  }
  const svg = iconNode('robot');
  if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); el.append(svg); }
  return el;
}
// Assigning from Cmd+K has to show on the row, and the palette hands the caret back to the row it was opened from,
// where a render is deferred until the caret leaves — so the badge is put on the row itself, as patchMeta does.
function patchCodex(docId) {
  for (const row of outline.querySelectorAll('.node')) {
    const item = items.get(row.dataset.key), line = row.querySelector(':scope > .line');
    const node = item && (referenceTarget(item.node) || item.node);
    if (!item || !line || node.id !== docId) continue;
    line.querySelector(':scope > .cbadge')?.remove();
    if (codexIds.has(docId)) line.append(codexBadgeEl(docId, node.done));
    if (row.dataset.sig) row.dataset.sig = rowSig(item.node); // the row now matches what a fresh render would build
  }
  codexHeader(); // the open page says it too, and for the same reason it is patched rather than re-rendered
}
// The badge beside the zoomed title, from the same element the rows use. Only on the document's own page: zooming
// into a block shows that block's title, and the agent was handed the document, not the block.
function codexHeader() {
  const head = titleEl.parentElement;
  if (!head) return;
  head.querySelector(':scope > .cbadge')?.remove();
  if (zoom && !zoom.nodeId && codexIds.has(zoom.docId)) head.append(codexBadgeEl(zoom.docId));
}
// A full view of an image: Space on the row, or a click on it. Built when it is asked for and taken away again,
// so there is nothing to keep in step while it is not showing, and the focus goes back to the row it came from.
// The picture is whatever the row already has (the same cache), so opening one costs no fetch.
function openImage(node) {
  if (demoMode || document.querySelector('.lightbox')) return; // demo mode shows no picture, and the cache may still hold one
  const uri = node.image.uri, from = document.activeElement;
  // the picture grows out of the row it was opened from and goes back into it (renderer/motion.js growFrom)
  const thumb = from && from.querySelector ? from.querySelector('img') : null, at = () => (thumb && thumb.isConnected ? thumb.getBoundingClientRect() : null);
  const box = document.createElement('div'); box.className = 'lightbox'; box.tabIndex = -1;
  const img = document.createElement('img');
  const close = () => {
    if (box.classList.contains('out')) return;
    if (!motionOK()) { box.remove(); if (from && from.focus) from.focus(); return; }
    box.classList.add('out');
    growFrom(img, at(), 0, true).then(() => box.remove());
    if (from && from.focus) from.focus();
  };
  box.onclick = close;
  // its own keys: Escape, Space and Enter close it, and nothing reaches the outline behind it
  box.onkeydown = (e) => { e.stopPropagation(); if (['Escape', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); close(); } };
  box.append(img);
  img.onload = () => growFrom(img, at());
  document.body.append(box);
  box.focus();
  Promise.resolve(images.get(uri) ?? tana.image(uri)).then((url) => { images.set(uri, url); img.src = url; }, (e) => { close(); showError(e); });
}
function nodeEl(node, docId, parent) {
  const item = mkItem(docId, node, parent);
  const reference = isReference(node);
  // A reference to a node that is gone (main marked it, or a refused read did): it keeps the label it was written
  // with, struck through behind a trash bullet, and opens nothing — an "Unavailable reference" in blue read as a
  // live link to a page that answers "Node has been deleted" to everything. Decided before the target, because the
  // row may still be holding the copy of it that was resolved before the deletion: drawing that copy put the node's
  // own glyph on the line beside the trash on the chip, as though it were both there and not.
  const gone = markGone(node.reference?.uri, node.reference?.deleted);
  const field = inField(docId); // a row inside a field value: read below for both the target and the bullet
  // liveTarget, not referenceTarget: a full reference being typed into is already an ordinary line here, rather than
  // when the debounced save comes back (renderSegs draws the same pending segments).
  // In a field, a row whose whole content is one reference stays a line with a link in it rather than becoming the
  // node it points at: a field is a list of names, and a row that grows a glyph, a status and an "Updated 4 days
  // ago" beneath it is twice the height of the line above it. The reference is live either way — the same chip,
  // the same target, the same click.
  const target = gone || field ? null : liveTarget(node, pending.get(item.key)), display = target || node;
  const fullref = !!target && !reference; // a line that is one mention: the row is the node, the text stays editable
  // Expanding a full reference opens the outline of the node it points at, not the block's own (a block with
  // children is never one): the rows below it belong to that document, so they are built against it.
  const childHost = fullref ? { key: item.key, docId: target.id, node: { ...target, hasChildren: false }, parent: item } : item;
  // A reference opens only when it is asked to: isOpen has blocks open by default, which is right for a block's own
  // children and wrong for another document's — a pasted reference would arrive expanded whenever that document
  // happened to be loaded already.
  const has = hasKids(childHost), opened = fullref ? open.get(item.key) === true : isOpen(item);
  const expandable = has || (!node.draft && canEditItem(item) && !isAtomic(node) && (node.kind === 'document' || node.done != null || ['paragraph', 'bullet', 'numbered'].includes(node.block)));
  const el = document.createElement('div');
  const heading = headingOf(node); // a heading arrives as node.heading or as the heading1-3 block type
  // an image draws a marker only where a list row would: on its own it is the picture and nothing else
  const blockClass = node.kind === 'block' ? ' t-' + (isDivider(node) ? 'divider' : isImage(node) ? (node.block || 'image') : blockTypeOf(node)) : '';
  el.className = 'node ' + node.kind + (reference ? ' reference' : '') + (fullref ? ' fullref' : '') + (gone ? ' gone' : '') + blockClass + (heading ? ' h' + heading : '') + (display.done ? ' done' : '') + (has ? ' has' : '') + (has && !opened ? ' collapsed' : '') + (node.draft || node.upload ? ' draft' : '') + ((node.notification || node.timeline) && node.unread ? ' unread' : '') + (node.timeline ? ' tl tl-' + node.timeline.tone : '') + (node.timeline?.today ? ' tl-today' : '') + (node.timeline?.upcoming ? ' tl-upcoming' : '') + (node.timeline?.recording ? ' tl-recording' : '');
  if (node.start != null) el.style.counterSet = 'ol ' + (node.start - 1); // a numbered list counting from its own start (sdk/content.js); the row's increment makes it start
  el.dataset.key = item.key;
  el.dataset.body = [display.text, display.done ? 1 : 0, display.stateType || ''].join('\n'); // what an edit elsewhere would change (motionAfter)
  const line = document.createElement('div'); line.className = 'line';
  const chev = document.createElement('button'); chev.className = 'chev'; chev.tabIndex = -1;
  chev.onmousedown = (e) => e.preventDefault();
  chev.classList.toggle('off', !expandable); // hidden glyph, kept in the layout so the row never shifts
  const bullet = document.createElement('span'); bullet.className = 'bullet';
  // A row in a field does not open as a page: a field is a list of values, and its rows are read and edited where
  // they are. A reference in one still opens what it points at — that is the chip's own click, not the bullet's.
  const opens = reference || fullref || (zoomable(node) && !field);
  const clickOpens = opensOnClick(item);
  if (opens) bullet.title = 'Zoom in'; else bullet.classList.add('still'); // a member or a type has no page: the bullet is only a glyph
  const bulletIcon = gone ? 'trash' : iconOf(display);
  if (bulletIcon) addIcon(bullet, bulletIcon).classList.add('icon', bulletIcon);
  if (display.hue != null) { bullet.classList.add('hue'); bullet.style.setProperty('--hue', String(display.hue)); } // type hue tints the icon and the plain bullet alike, a task's type glyph included
  // the grab: a row is picked up by its own marker (renderer/drag.js); a task under Today's Tasks shows a box in its
  // place, so the whole read-only line is the handle there
  if (canDragItem(item)) (parent?.node?.timeline?.today ? line : bullet).draggable = true;
  // The press on a marker keeps the caret where it is — except on one that can be dragged, where Chromium starts
  // the drag from exactly this default and preventDefault would quietly stop it from ever beginning. Ending an
  // edit is what reaching for another row means anyway, and the row being left flushes as it blurs.
  bullet.onmousedown = (e) => { if (!bullet.draggable) e.preventDefault(); };
  // ⌘-click opens it in a pane beside this one, ⌥-click as a tab in this pane (renderer/palette.js openElsewhere)
  if (!node.draft && opens) bullet.onclick = (e) => {
    const where = e && elsewhere(e), ref = reference || fullref;
    if (where && (!ref || node.reference?.uri)) return run(() => (ref ? openElsewhere(where, node.reference.uri) : openElsewhere(where, item.docId, item.node.kind === 'document' ? null : item.node.id)));
    if (ref) openReference(node); else zoomTo(item);
  };
  // A notification's bullet is its read state, and the row action that flips it (renderer/inbox.js)
  if (node.notification) { bullet.title = node.unread ? 'Mark as read' : 'Mark as unread'; bullet.onclick = () => setNotificationRead(node, !!node.unread); }
  line.append(chev, bullet);
  // a task's box is its status, so Display hides it with the rest of the status; a checkbox block is outline content
  // the user typed, not a fact about the row, so it is never hidden
  if ((isTask(display) && displayOn('status')) || (!isTask(display) && isCheckboxBlock(display))) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!display.done; check.tabIndex = -1;
    if (isTask(display) && display.stateType === 'proposed') check.classList.add('inbox'); // not accepted yet: a dashed box
    check.onmousedown = (e) => e.preventDefault();
    // a read-only row can still carry a box that ticks (node.checkable: a task listed on the Timeline)
    const ticks = canEditItem(item) || (!!node.checkable && isTask(node));
    check.disabled = target ? !canEditNode(display) : !ticks;
    check.onclick = target && canEditNode(display) ? () => toggleReference(node) : ticks ? () => (isTask(node) ? toggleDone(item) : toggleCheckbox(item)) : null;
    if (demoMode) { check.disabled = true; check.onclick = null; } // read-only while demo mode is on
    line.append(check);
  }
  const body = document.createElement('div'); body.className = 'body'; // text + meta + chips; only .text is editable
  const text = document.createElement('span');
  text.className = 'text';
  if (isImage(node)) { // focusable, not editable: keeps its place in texts() so Up/Down/Backspace work like any block
    text.classList.add('image'); text.tabIndex = -1;
    const img = document.createElement('img'), { uri, alt, width, height } = node.image;
    if (demoMode) text.classList.add('loading', 'demo'); // demo mode: the picture's place as the grey box a loading one shows, never its pixels or its words
    else if (alt) img.alt = img.title = alt;
    else imageTitle(uri).then((t) => { if (t) img.alt = img.title = t; }); // Tana's AI title, once it has written one
    if (width && height) { img.width = width; img.height = height; }
    const show = (url) => { images.set(uri, url); img.src = url; text.classList.remove('loading'); if (images.size > 200) images.delete(images.keys().next().value); }; // oldest out: main keeps the file cache
    const cached = images.get(uri);
    if (demoMode) { /* nothing fetched, nothing shown */ } else if (typeof cached === 'string') img.src = cached;
    else { text.classList.add('loading'); (cached || images.set(uri, tana.image(uri)).get(uri)).then(show, (e) => { images.delete(uri); showError(e); }); }
    img.onclick = (e) => { e.stopPropagation(); openImage(node); }; // the row is not text to put a caret in: a click is a look at the picture
    text.append(img);
  } else if (node.upload) { // renderer/upload.js: a file on its way up; Esc cancels it
    text.classList.add('upload'); text.tabIndex = -1;
    text.textContent = demoText(node.text, node.id) + ' — Uploading…';
  } else if (isDivider(node)) { // atomic like an image: focusable so Up/Down and Backspace still reach it
    text.classList.add('divider'); text.tabIndex = -1;
    text.append(document.createElement('hr'));
  } else if (node.table) { // atomic too: the row focuses, moves and deletes; its cells are the editable part (renderer/table.js)
    text.classList.add('table'); text.tabIndex = -1;
    text.append(tableEl(item));
  } else {
    if (!demoMode && !clickOpens && canEditText(item)) text.contentEditable = 'plaintext-only'; else text.tabIndex = -1;
    text.spellcheck = false;
    // a full reference reads its label from the target, like the rest of the row, so a rename in Tana shows through
    renderSegs(text, pending.has(item.key) ? pending.get(item.key).segs : reference ? [{ text: referenceLabel(node) }] : fullref ? [{ mention: { uri: node.reference.uri, label: referenceLabel(node) } }] : segsOf(node), display.id);
    text.classList.toggle('chiponly', chipOnly(text));
  }
  body.append(text);
  if (node.join && tana.openExternal && tana.nodeLink) body.append(timelineJoinEl(node)); // a meeting to come or under way, on the Timeline
  const metaText = node.notification ? agoText(node.createdAt) : node.timeline ? node.timeline.time ?? timelineTime(node.createdAt) : node.proposal ? agoText(node.proposal.proposedAt) : demoMeta(display, display.meta); // a notification says when it came in, a proposal when it was made
  if (metaText) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = metaText; body.append(m); }
  // every row describes who can see it, not only task rows; the fetch waits until the row is on screen
  const taskInfo = taskSummary(display, true) || documentSummary(display, true);
  if (displayOn('assigned')) {
    if (taskInfo) body.append(taskMetaEl(taskInfo, display.id, display));
    else if (observeMeta(el, display)) body.append(taskMetaEl({ assignees: '', pending: true })); // hold the slot: the real icon lands in the same place, so the row never shifts
  } else if (!taskInfo) observeMeta(el, display); // "Lives in" reads the same answer, so the fetch still goes out
  if (displayOn('type')) appendTags(body, display);
  // when it was made, when it last moved and where it lives, as one grey line under the title (renderer/views.js)
  // what a Timeline edit put there (renderer/timeline.js): Tana's longer words, quoted between the headline and who did it
  if (node.timeline && (node.timeline.change || node.timeline.detail)) {
    const q = document.createElement('div'); q.className = 'tl-detail';
    if (node.timeline.change) { const h = document.createElement('strong'); h.textContent = demoText(node.timeline.change, node.timeline.uri); q.append(h); } // what changed, in Tana's one line
    if (node.timeline.detail) { const d = document.createElement('div'); d.textContent = demoText(node.timeline.detail, node.timeline.uri); q.append(d); } // and its longer words for it
    body.append(q);
  }
  const sub = subtextEl(display, taskInfo, undefined, tableRow(parent));
  if (sub) body.append(sub);
  blurSensitive(body, docId, target && target.id);
  line.append(body);
  // handed to the local Codex agent: the robot badge at the end of the row, after everything the row says about itself
  if (codexIds.has(display.id)) line.append(codexBadgeEl(display.id, display.done));
  if (node.proposal) line.append(proposalButtonsEl(node)); // approve and reject, at the end of a Proposals row (renderer/proposals.js)
  // A click that misses the words still belongs to the row, and the row is bigger than its text: the padding
  // around it, and the blank line a soft break leaves inside it, are all places a caret can sit. It used to answer
  // with the end of the row, which walked the caret past everything written after the point that was clicked.
  line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !reference && !fullref && (e.target === line || e.target === body || e.target.parentElement === text)) setCaret(text, caretAt(text, e.clientX, e.clientY)); };
  if (node.notification) line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !e.target.closest('.bullet, .chev')) openNotification(node); }; // a click on it opens it, as in Tana
  if (node.timeline?.uri) line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !e.target.closest('.chev')) openTimeline(node); }; // and a Timeline row opens the node it is about
  else if (node.timeline) line.onmousedown = (e) => e.preventDefault(); // one about nothing (an "added to your Inbox" line) takes no click and no caret
  // as does a task listed under one, as itself: goTo reads the real node, where zoomTo would open the read-only copy the
  // Timeline lists, filed under the Timeline in the crumb — a page that looked like the task and could not be edited
  else if (parent?.node?.timeline) line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !e.target.closest('.chev, .check, .bullet')) goTo(node.id); };
  else if (clickOpens) line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !e.target.closest('.chev, .bullet, .check')) { if (e.altKey) run(() => openElsewhere('tab', item.docId, item.node.kind === 'document' ? null : item.node.id)); else zoomTo(item); } }; // .check: a task's box in a table row ticks it and stays; ⌥: as a tab in this pane (⌘-click selects the row)
  if (clickOpens) el.classList.add('opens');
  // a reference row: the bullet opens the target, a click selects the row, and a click on the selected row starts
  // editing it — a native embed takes the caret where it was clicked, while a full reference has nothing to click
  // into (its text is one chip), so the caret goes to the end, which is where Enter on the selection puts it too
  if (reference || fullref) line.onmousedown = (e) => {
    if (e.metaKey || e.shiftKey || e.target.closest('.check') || e.target.closest('.bullet') || e.target.closest('.chev')) return;
    if (selKeys().includes(item.key) && canEditText(item)) { if (fullref) { e.preventDefault(); setCaret(text, text.textContent.length); } return; }
    e.preventDefault(); sel = { keys: new Set([item.key]), anchor: item.key, focus: item.key }; leaveText(); applySel();
  };
  el.append(line);
  // expanded = real children shown, or an explicitly opened empty node (which shows one draft child)
  const expanded = expandable && (has ? opened : !node.draft && open.get(item.key) === true);
  chev.classList.toggle('closed', !expanded); chev.title = expanded ? 'Collapse' : 'Expand';
  chev.onclick = () => setOpen(item, !expanded);
  if (expanded) {
    const wrap = document.createElement('div'); wrap.className = 'children';
    wrap.dataset.outline = childHost.docId; // whose outline is drawn open here, rows or none (renderer/app.js forgetReleased)
    if (childHost.node.kind === 'document' && !inField(childHost.docId)) {
      const fields = document.createElement('div'); fields.className = 'fields inline-fields';
      fields.dataset.docId = childHost.docId;
      renderFields(childHost, true, fields);
      wrap.append(fields);
      loadRelated(childHost.docId);
    }
    const c = childrenOf(childHost);
    if (c == null) { ensureLoaded(childHost); wrap.classList.add('loading'); wrap.append('Loading…'); }
    else if (c.length) wrap.append(...c.map((k) => childEl(k, childHost)));
    // Expanding a row is asking it for sub-items, so the row it opens onto is a bullet whatever the parent is —
    // a document's own page still starts as plain text (withDraftTail), which is a different question.
    else if (!fullref && !isSpace(node) && canEditItem(item) && (node.kind === 'document' || node.done != null || ['paragraph', 'bullet', 'numbered'].includes(node.block))) wrap.append(nodeEl({ ...draftNode(item), block: 'bullet' }, docId, item));
    if (node.timeline?.today) {
      const emptyToday = Array.isArray(c) && c.length === 0;
      if (emptyToday) { const empty = document.createElement('span'); empty.className = 'tl-empty'; empty.textContent = 'All done - '; wrap.append(empty); }
      wrap.append(timelineAddMoreEl(node, emptyToday));
    }
    el.append(wrap);
  }
  return el;
}

// a draft becomes real on its first typed character: created with that text, caret kept
async function materialise(item, el) {
  const { parent, node } = item, oldKey = item.key, text = el.textContent;
  let key, real;
  await run(async () => {
    if (node.kind === 'document') {
      const n = await tana.createDocument(text, node.createOptions || { kind: node.draft });
      real = { ...n, text: n.title ?? n.text ?? '', hasChildren: true };
      addSearch(real); // a saved search drafted here is in Cmd+K at once (#141); anything else is left alone
      const s = sectionOf(node.id), i = s ? s.nodes.indexOf(node) : -1;
      if (i >= 0) { s.nodes.splice(i, 1, real); fresh.set(real.id, { section: s.id, after: i ? s.nodes[i - 1].id : null, node: real }); }
      if (zoom?.docId === node.id) zoom = { ...zoom, docId: real.id };
      key = real.id;
    } else {
      const last = childrenOf(parent)?.at(-1);
      // the kind the draft was drawn as is the kind that gets written: a row must not change shape under the caret
      const id = parent.node.kind === 'document' || last ? await tana.insertAfter(parent.docId, last?.id || null, text, node.block) : await tana.insertChild(parent.docId, parent.node.id, text);
      await reload(parent.docId);
      await inheritCheckbox(parent, id); // old preload bridges lack native insert inheritance; current bridge already returns done: 0
      key = parent.docId + '/' + id;
      real = locate(kids.get(parent.docId) || [], id)?.node || { ...node, id, text };
    }
  });
  if (!key || !real) {
    item.busy = false;
    if (parent) { await reload(parent.docId); render(true); }
    return;
  }
  const latest = el.textContent; // typed on while the create was in flight
  if (key && slashCtx && slashCtx.key === item.key) slashCtx = { key }; // the "/" menu opened on the draft: follow it to the real node
  item.key = key; item.docId = real.kind === 'document' ? real.id : item.docId; item.node = real; delete item.busy; delete item.node.draft;
  items.delete(oldKey); items.set(key, item);
  const host = el === titleEl ? el : el.closest('.node');
  if (host) { host.dataset.key = key; host.classList.remove('draft'); }
  renderDeferred = true; // refresh the row chrome after the user leaves; the active contenteditable stays untouched
  if (latest !== text) scheduleSave(item, [{ text: latest }]);
}
function dropDraft(item) {
  if (item.node.kind === 'document') { const s = sectionOf(item.docId); if (s) s.nodes.splice(s.nodes.indexOf(item.node), 1); }
  else open.delete(item.parent.key);
  render(true);
}
function dropDrafts() { for (const s of views) s.nodes = s.nodes.filter((n) => !n.draft); } // navigating away drops empty draft documents
// Enter on a collapsed top-level document (or with nothing focused in an empty view): a draft sibling document below it
function draftDoc(after) {
  const s = viewOf();
  if (!s) return;
  if (after) flush(after.key);
  const node = draftDocNode('doc'); // every view drafts a doc: Tasks was the last one with a kind of its own, and it is gone
  s.nodes.splice(after ? s.nodes.indexOf(after.node) + 1 : 0, 0, node);
  render(true);
  placeCaret(node.id, 0);
}
