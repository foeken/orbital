'use strict';
// Caret helpers and the outline render: rows, drafts, crumbs, fields, animation of arriving and leaving rows.

// ---- caret helpers (contenteditable: text nodes + non-editable mention anchors) ----
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
  return el && el.classList.contains('text') && outline.contains(el) ? { key: keyOfEl(el), offset: caretOffset(el) } : null;
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
let caretOnOpen = false; // set when a node is opened: the first render with its children puts the caret where typing works
let scrollOnType = false; // that caret is parked below the fold: the first character typed brings its row into view
// An empty ordinary row is already somewhere to type; an image, divider or reference row is not.
const typableRow = (n) => !!n && n.kind === 'block' && !isAtomic(n) && !isReference(n) && !plainOf(n).length;
// Opening a node leaves a row to type in: the local draft row the empty document case has always shown, which stays
// out of Tana until its first typed character (materialise) and is discarded by anything else.
// A block with children appends through insertAfter(last); an empty block uses insertChild.
function withDraftTail(list, parent) {
  if (!Array.isArray(childrenOf(parent)) || isSpace(parent.node) || isSearchDoc(parent.node) || !canEditItem(parent) || !canInsertChild(parent)) return list;
  if (typableRow(list.at(-1))) return list;
  return [...list, draftNode(parent)];
}
function editingRow() {
  const el = document.activeElement;
  return !!(el && el.isContentEditable && (el === titleEl || outline.contains(el)));
}
// A row arriving in or dropping out of a view is shown, not swapped in silently: an arrival fades in over a green
// tint, and a row that left is put back where it was over a red tint and fades away. Within one view only, since
// switching views, zooming and the first paint replace every row and must not flash.
function animateRows(before) {
  // Nothing on screen before this paint is the view appearing, not every row arriving at once: a view whose rows have
  // not loaded yet paints empty first (loadView resolves after the render that asked for it), and that empty paint
  // must not be mistaken for "these rows were already here".
  if (animView !== view || !before.size) { animView = view; return; }
  const rows = [...outline.children].filter((el) => el.classList.contains('node'));
  const keys = new Set(rows.map((el) => el.dataset.key));
  const old = [...before.keys()];
  const arrived = rows.filter((el) => !before.has(el.dataset.key) && !el.classList.contains('draft'));
  const gone = old.filter((key) => !keys.has(key) && !key.startsWith('draft'));
  // ponytail: above a handful, the list changed rather than an item moving in or out (filtering, a reload, a new
  // set of rows), and it neither reads as an arrival nor is worth a few hundred ghost rows. Raise if it feels shy.
  const BULK = 25;
  if (arrived.length > BULK || gone.length > BULK) return;
  for (const el of arrived) el.classList.add('entering');
  for (const key of gone) {
    const el = before.get(key);
    const next = old.slice(old.indexOf(key) + 1).find((k) => keys.has(k)); // back where it was: before the first row that outlived it
    if (!el.classList.contains('leaving')) { // one that is already on its way out: the renders that keep coming must not cut it short
      el.classList.add('leaving'); el.classList.remove('selected', 'entering'); // a row that just arrived and left again only leaves
      for (const t of el.querySelectorAll('[contenteditable]')) t.removeAttribute('contenteditable');
      setTimeout(() => el.remove(), 500); // not animationend: reduced motion runs no animation and the row must still go
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
  const fresh = (id) => allDocs().find((d) => d.id === id) || extra.get(id);
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
}
function render(force = false) {
  if (force !== true && (editingRow() || selectionFrozen)) { renderDeferred = true; markFalling(); refreshRowChrome(); if (!$('pills').hidden) renderPills(true); return; }
  renderDeferred = false; rendering = true;
  try { renderOutline(); } finally { rendering = false; }
}
// Metadata and sync may finish between keystrokes. Apply their deferred render only after the caret leaves editable rows.
document.addEventListener('focusout', () => queueMicrotask(() => { if (renderDeferred && !editingRow() && !selectionFrozen) render(); }));
// Answers that arrive on their own — a row's metadata, pins, the rail, a crumb date, live updates — render once per
// frame between them rather than once each: a view of N rows used to rebuild itself N times as its metadata came in.
let renderQueued = false;
function renderSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}
// What a list row is built from. A row whose signature has not changed since the last render is kept as it is,
// which turns a live update or a refresh into a handful of rebuilt rows instead of a whole new outline.
function rowSig(n) {
  const meta = taskMetaById.get(n.id);
  // stateType too: accepting an Inbox task changes only the state, and a reused row would keep the tick the click put in its box
  return JSON.stringify([n.text, n.done, n.stateType, n.icon, n.hue, n.meta, n.tags, n.editable, n.draft, n.hasChildren, n.kind, n.type,
    n.updatedAt, n.createdAt, n.createdBy, // the subtext's times and author: they arrive after the row and a reused row would still show none
    sensitiveHidden(n.id), meta || (taskMetaLoading.has(n.id) ? 'loading' : null), members ? members.length : 0, open.get(n.id), pending.has(n.id),
    displayKeys().join(','), codexIds.has(n.id), agentStateOf(n.id)]); // which facts the row shows: without this a reused row would keep the old ones
}
function renderOutline() {
  const saved = focused();
  // a live update must not eat a selection: the formatting toolbar acts on it, and a re-render lands mid-toggle
  const savedSel = saved && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('text') ? selectionOffsets(document.activeElement) : null;
  rendered.clear(); docCache.clear();
  let trail = null;
  if (zoom) { trail = resolveZoom(); if (!trail) zoom = null; }
  const parent = trail && trail.at(-1);
  let list, hidden = 0;
  if (parent) {
    if (!parent.node.draft) ensureLoaded(parent);
    list = parent.node.draft ? [] : childrenOf(parent) || [];
    // A saved search page is a result list, like a view, so ⌘F narrows it the same way. No other zoomed page
    // filters: an outline's rows are content you are editing, not a result set you are searching through.
    let groups = null;
    if (isSearchDoc(parent.node)) {
      loadSearchFilter(parent.docId); // its stored query, as the filter the pills above it show
      previewRows(parent.docId);      // and the rows that filter finds, so editing a pill moves the list
      // a saved search is a list of results, so it narrows, sorts and groups exactly as a view does — same helper,
      // with the arrangement its own document stores rather than the one this browser remembers for a view
      const shown = pageRows(list, filterEl.value.trim().toLowerCase());
      list = shown.list; groups = shown.groups; hidden = shown.hidden;
    }
    list = withDraftTail(list, parent); // an open node always has a row to type in; a read-only one (every chat) never does
    outline.replaceChildren(...(groups
      ? groups.flatMap((g) => [groupHeadEl(g), ...(g.collapsed ? [] : g.nodes.map((n) => childEl(n, parent)))])
      : list.map((n) => childEl(n, parent))));
    animView = null; // a zoom replaced every row, and a zoomed row is keyed docId/nodeId while a view row is keyed by
    // its document id, so on the way back nothing would match and the whole view would flash as if it had just arrived
    // A node opens at its top, however far down the draft tail the caret goes (the caretOnOpen block below parks it
    // there without scrolling). caretOnOpen is still set through both renders of an open — the "Loading…" one and the
    // one the children arrive on, which grows the content — so both land at the top; later renders are left alone.
    if (caretOnOpen) outline.parentElement.scrollTop = 0;
  } else {
    const v = viewOf(), docs = v ? v.nodes : [];
    const shown = pageRows(docs, filterEl.value.trim().toLowerCase()); // Default leaves the view's own order alone
    list = shown.list; hidden = shown.hidden;
    const groups = shown.groups; // null when the view is not grouped: one flat list, as before
    const before = new Map([...outline.children].filter((el) => el.classList.contains('node')).map((el) => [el.dataset.key, el]));
    const rowEl = (n) => { // an unchanged, collapsed row is reused; anything expanded or different is rebuilt
      const old = before.get(n.id), sig = rowSig(n);
      if (old && old.dataset.sig === sig && !old.classList.contains('leaving') && !old.querySelector(':scope > .children')) { mkItem(n.id, n, null); delete old.dataset.today; return old; }
      const el = nodeEl(n, n.id, null); el.dataset.sig = sig; return el;
    };
    outline.replaceChildren(...(groups
      ? groups.flatMap((g) => [groupHeadEl(g), ...(g.collapsed ? [] : g.nodes.map(rowEl))])
      : list.map(rowEl)));
    animateRows(before);
    if (list.length && !outline.hidden && scrolledView !== view) { // a view opens at the top
      scrolledView = view;
      outline.parentElement.scrollTop = 0;
    }
  }
  // "No content" is about a page with nothing on it, so it goes by what was just drawn rather than by the row count:
  // a grouped page with every section folded away has no rows and is not empty — its headings are right there.
  if (parent && !list.length && !outline.children.length) {
    const note = document.createElement('div');
    note.className = 'empty-note'; note.textContent = kids.get(parent.docId) === null ? 'Loading…' : 'No content';
    outline.append(note);
  }
  // the page title is the zoom target itself: documents use setTitle, blocks use setText through the same debounce
  const editable = parent && !isAtomic(parent.node) && !isReference(parent.node) && canEditText(parent);
  if (editable) titleEl.contentEditable = 'plaintext-only'; else titleEl.removeAttribute('contenteditable');
  titleEl.dataset.key = editable ? parent.key : '';
  titleEl.textContent = editable && pending.has(parent.key) ? plainOf(pending.get(parent.key).segs) : parent ? parent.node.text : viewOf() ? viewOf().title : 'Tana';
  blurSensitive(titleEl, parent && parent.docId);
  // zoomed task: its checkbox before the title (toggleDone, like row checkboxes; Cmd+Enter in the title too)
  const zoomedTask = parent && isTask(parent.node);
  titleCheck.hidden = !zoomedTask; titleCheck.checked = zoomedTask && !!parent.node.done;
  titleCheck.classList.toggle('inbox', !!zoomedTask && acceptsFirst(parent.node)); // dashed while it waits in the Inbox
  titleCheck.disabled = zoomedTask && !canEditItem(parent);
  titleCheck.onclick = zoomedTask && canEditItem(parent) ? () => toggleDone(parent) : null;
  titleEl.classList.toggle('done', zoomedTask && !!parent.node.done);
  codexHeader(); // a rebuilt header loses the badge with everything else, so it is put back with the title
  // assignees and visibility now live at the top of the sidebar (railMetaRows); under the title only the chips remain
  const titleTags = zoomedTask && visibleTags(parent.node).some((tag) => tag.label !== 'task');
  taskInfoEl.hidden = !titleTags; taskInfoEl.replaceChildren();
  if (titleTags) appendTags(taskInfoEl, parent.node);
  blurSensitive(taskInfoEl, parent && parent.docId);
  renderFields(parent);
  renderCrumbs(trail);
  renderRail(parent);
  // A saved search is a query you can edit, so it gets the pills too — every other zoomed page is content, not a query.
  const showPills = authed && pillsApply() && (!parent || isSearchDoc(parent.node));
  renderPills(showPills);
  filterRow.hidden = (!!parent && !isSearchDoc(parent.node)) || !(filterShown || filterEl.value);
  filterRow.classList.toggle('empty', !filterEl.value);
  $('filtered').textContent = [hidden ? hidden + ' items filtered out' : '', truncated.has(view) ? 'Showing the first 1,000 results' : ''].filter(Boolean).join(' · ');
  // Cached rows remain usable while auth and sync reconnect; reserve the skeleton for an empty outline.
  const loading = !parent && !outline.children.length && (authChecking || !rootsLoaded || !filters.has(view) || (authed && !connected));
  $('skeleton').classList.toggle('gone', !loading);
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
  for (const key of items.keys()) if (!rendered.has(key)) items.delete(key);
  // Putting the caret back is preserving state, not navigating: a render that only rebuilt the rows must not scroll
  // the page to wherever the caret happens to be. Clicking a task's box while another row held the caret rebuilt the
  // outline and then jumped the view to that other row. Typing still scrolls to itself, through scrollOnType.
  if (saved && savedSel) selectRange(saved.key, savedSel[0], savedSel[1], true);
  else if (saved) placeCaret(saved.key, saved.offset, true);
  // the caret lands in that typable row once per open: a later render (a live update, a refresh) must not pull it back
  if (caretOnOpen && parent && Array.isArray(childrenOf(parent))) {
    caretOnOpen = false;
    const last = list.at(-1), el = last && palette.hidden && !focused() ? textEl(keyFor(parent.docId, last)) : null;
    // preventScroll: that row is the last one, so focusing it the ordinary way scrolls a long node to its bottom and
    // the open never shows its top. setCaret's own focus() is then a no-op (already the active element) and collapsing
    // a range into it does not scroll either, so the caret waits out of sight until the first keystroke catches up.
    if (el && el.isContentEditable && !el.textContent) { el.focus({ preventScroll: true }); setCaret(el, 0); scrollOnType = true; }
  }
  noteNavigation(); // where this render landed, for Cmd+[ and Cmd+]
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
function renderFields(parent) {
  const el = $('fields');
  const data = parent && parent.node.kind === 'document' ? relatedBy.get(parent.docId) : null;
  const fields = (data && data.fields) || [];
  el.hidden = !fields.length;
  el.replaceChildren();
  for (const field of fields) {
    const row = document.createElement('div'); row.className = 'field';
    const icon = document.createElement('span'); icon.className = 'ricon'; icon.innerHTML = iconSvg('field');
    row.append(icon);
    // the type names its fields; an unreadable type leaves the value to speak for itself
    if (field.label) { const label = document.createElement('span'); label.className = 'flabel'; label.textContent = field.label; row.append(label); }
    const value = document.createElement('span');
    value.className = 'fvalue'; value.textContent = field.text || '';
    if (tana.setField && canEditItem(parent)) { // a field value is ordinary text on this document
      value.contentEditable = 'plaintext-only'; value.spellcheck = false;
      value.onblur = () => { const next = value.textContent.trim(); if (next !== (field.text || '')) { field.text = next; run(() => tana.setField(parent.docId, field.key, next)); } };
      value.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); value.blur(); } else if (e.key === 'Escape') { e.preventDefault(); value.textContent = field.text || ''; value.blur(); } };
    }
    row.append(value);
    el.append(row);
  }
  blurSensitive(el, parent && parent.docId);
}
// The date of a meeting crumb, in the form the Meetings list and search already show (main.js eventMeta): read off
// the event row when the app has it, else fetched once through api.node, which carries the same formatted string.
const eventWhen = new Map(); // event id -> its meta string ('' when it has none), null while the fetch is in flight
function crumbWhen(id) {
  if (typeof id !== 'string' || !id.startsWith('tana:event:')) return null;
  const known = docOf(id);
  if (known && known.meta) return known.meta;
  if (!eventWhen.has(id) && tana.node) {
    eventWhen.set(id, null);
    tana.node(id).then((n) => { eventWhen.set(id, n.meta || ''); if (n.meta) renderSoon(); }, () => eventWhen.delete(id));
  }
  return eventWhen.get(id) || null;
}
// One link, icon and name together, so the whole thing is the target and the icon is never the only thing to read.
function homeCrumb() {
  const name = homeName();
  if (!name || homeId() === 'library' || atHome()) return null;
  const a = document.createElement('a');
  const icon = iconNode('home');
  if (icon) { const ricon = document.createElement('span'); ricon.className = 'ricon home'; ricon.append(icon); a.append(ricon); }
  a.append(name);
  a.setAttribute('aria-label', 'Go to Home: ' + name);
  a.title = 'Go to Home: ' + name;
  a.onclick = () => goHome();
  return a;
}
function renderCrumbs(trail) {
  const nav = $('crumbs');
  nav.hidden = !trail;
  if (!trail) return;
  const back = () => { zoom = null; render(); };
  nav.replaceChildren();
  // The Home anchor, ahead of the location: the house glyph and Home's own current name, then a bullet to keep it
  // apart from the › chain that follows. It is a shortcut, not an ancestor — the structural path behind it is
  // untouched, so nothing suggests a saved search owns the node. Left out where it would only repeat what is already
  // there: on Home itself, and when Home is the Library, whose crumb the location already starts with.
  const homeEl = homeCrumb();
  if (homeEl) { const dot = document.createElement('span'); dot.className = 'sep'; dot.textContent = '•'; nav.append(homeEl, dot); }
  // location in Tana (owner chain from api.path, e.g. "Library" or "Automation Guild › Meeting"), loaded once per document.
  // A document reached through a space (zoom.via) starts at the space's location; the spaces follow as crumbs.
  const root = zoom.via ? zoom.via[0] : zoom, rootId = root.docId;
  const path = paths.get(rootId);
  if (!path && tana.path && isRealId(rootId)) { paths.set(rootId, []); tana.path(rootId).then((p) => { paths.set(rootId, p); if (zoom && (zoom.via ? zoom.via[0] : zoom).docId === rootId) renderSoon(); }).catch(() => {}); }
  for (const [i, p] of (path && path.length ? path : [{ id: '', title: root.from || (viewOf() ? viewOf().title : 'Tana') }]).entries()) {
    if (i) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; nav.append(sep); }
    const a = document.createElement('a');
    // ancestors can share a title (a meeting named after its space), so each crumb shows its kind icon
    if (p.icon) { const ricon = document.createElement('span'); ricon.className = 'ricon ' + p.icon; ricon.innerHTML = iconSvg(p.icon); a.append(ricon); }
    a.append(p.title);
    const when = crumbWhen(p.id); // a meeting crumb also says when it was: two meetings often share a title
    if (when) { const date = document.createElement('span'); date.className = 'cdate'; date.textContent = when; a.append(date); }
    blurSensitive(a, p.id);
    a.onclick = p.id === 'library' ? () => setView('library') : p.id ? () => goTo(p.id) : back;
    nav.append(a);
  }
  for (const v of zoom.via || []) {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement('a'); a.textContent = (docOf(v.docId) || {}).text || 'Untitled'; blurSensitive(a, v.docId); a.onclick = () => { zoom = v; render(); };
    nav.append(sep, a);
  }
  for (const item of trail.slice(0, -1)) { // ancestors only: the page title already shows the current node
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement('a'); a.textContent = item.node.text || 'Untitled'; blurSensitive(a, item.docId); a.onclick = () => zoomTo(item);
    nav.append(sep, a);
  }
}

// a child row: document children (inside a space) are their own document, so their key, children and edits go by their own id
const childEl = (n, item) => nodeEl(n, n.kind === 'document' ? n.id : item.docId, item);
// A node assigned to the local Codex agent. Not an icon in the metadata strip: that strip is one of the facts the
// Display pill can switch off, and this mark says the agent has the node.
// The badge says what the linked task is doing, not merely that a node was assigned: an assignment with no task
// behind it yet is pending and grey, and only work in progress animates. The wording carries the state as well as
// the colour, so the colour is never the only signal.
function codexBadgeEl(id) {
  const state = agentStateOf(id), words = AGENT_BADGE[state];
  const el = document.createElement('span');
  el.className = 'cbadge ' + state;
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
    if (!item || !line || (referenceTarget(item.node) || item.node).id !== docId) continue;
    line.querySelector(':scope > .cbadge')?.remove();
    if (codexIds.has(docId)) line.append(codexBadgeEl(docId));
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
function nodeEl(node, docId, parent) {
  const item = mkItem(docId, node, parent);
  const target = referenceTarget(node), display = target || node, reference = isReference(node);
  const fullref = !!target && !reference; // a line that is one mention: the row is the node, the text stays editable
  // Expanding a full reference opens the outline of the node it points at, not the block's own (a block with
  // children is never one): the rows below it belong to that document, so they are built against it.
  const childHost = fullref ? { key: item.key, docId: target.id, node: { ...target, hasChildren: false }, parent: item } : item;
  const has = hasKids(childHost), opened = isOpen(item);
  const expandable = has || (!node.draft && canEditItem(item) && (node.kind === 'document' || node.done != null || ['paragraph', 'bullet', 'numbered'].includes(node.block)));
  const el = document.createElement('div');
  const heading = headingOf(node); // a heading arrives as node.heading or as the heading1-3 block type
  const blockClass = node.kind === 'block' ? ' t-' + (isDivider(node) ? 'divider' : blockTypeOf(node)) : '';
  el.className = 'node ' + node.kind + (reference ? ' reference' : '') + (fullref ? ' fullref' : '') + blockClass + (heading ? ' h' + heading : '') + (display.done ? ' done' : '') + (has ? ' has' : '') + (has && !opened ? ' collapsed' : '') + (node.draft ? ' draft' : '');
  el.dataset.key = item.key;
  const line = document.createElement('div'); line.className = 'line';
  const chev = document.createElement('button'); chev.className = 'chev'; chev.tabIndex = -1;
  chev.onmousedown = (e) => e.preventDefault();
  chev.classList.toggle('off', !expandable); // hidden glyph, kept in the layout so the row never shifts
  const bullet = document.createElement('span'); bullet.className = 'bullet'; bullet.title = 'Zoom in';
  if (display.icon) { bullet.classList.add('icon', display.icon); const svg = iconNode(display.icon); if (svg) bullet.append(svg); }
  if (display.hue != null) { bullet.classList.add('hue'); bullet.style.setProperty('--hue', String(display.hue)); } // type hue tints the icon and the plain bullet alike
  bullet.onmousedown = (e) => e.preventDefault();
  if (!node.draft) bullet.onclick = () => (reference || fullref ? openReference(node) : zoomTo(item));
  line.append(chev, bullet);
  // a task's box is its status, so Display hides it with the rest of the status; a checkbox block is outline content
  // the user typed, not a fact about the row, so it is never hidden
  if ((isTask(display) && displayOn('status')) || (!isTask(display) && isCheckboxBlock(display))) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!display.done; check.tabIndex = -1;
    if (isTask(display) && display.stateType === 'proposed') check.classList.add('inbox'); // not accepted yet: a dashed box
    check.onmousedown = (e) => e.preventDefault();
    check.disabled = target ? !canEditNode(display) : !canEditItem(item);
    check.onclick = target && canEditNode(display) ? () => toggleReference(node) : canEditItem(item) ? () => (isTask(node) ? toggleDone(item) : toggleCheckbox(item)) : null;
    line.append(check);
  }
  const body = document.createElement('div'); body.className = 'body'; // text + meta + chips; only .text is editable
  const text = document.createElement('span');
  text.className = 'text';
  if (isImage(node)) { // focusable, not editable: keeps its place in texts() so Up/Down/Backspace work like any block
    text.classList.add('image'); text.tabIndex = -1;
    const img = document.createElement('img'), { uri, alt, width, height } = node.image;
    if (alt) img.alt = img.title = alt;
    if (width && height) { img.width = width; img.height = height; }
    const show = (url) => { images.set(uri, url); img.src = url; text.classList.remove('loading'); if (images.size > 200) images.delete(images.keys().next().value); }; // oldest out: main keeps the file cache
    const cached = images.get(uri);
    if (typeof cached === 'string') img.src = cached;
    else { text.classList.add('loading'); (cached || images.set(uri, tana.image(uri)).get(uri)).then(show, (e) => { images.delete(uri); showError(e); }); }
    text.append(img);
  } else if (isDivider(node)) { // atomic like an image: focusable so Up/Down and Backspace still reach it
    text.classList.add('divider'); text.tabIndex = -1;
    text.append(document.createElement('hr'));
  } else {
    if (canEditText(item)) text.contentEditable = 'plaintext-only'; else text.tabIndex = -1;
    text.spellcheck = false;
    // a full reference reads its label from the target, like the rest of the row, so a rename in Tana shows through
    renderSegs(text, pending.has(item.key) ? pending.get(item.key).segs : reference ? [{ text: referenceLabel(node) }] : fullref ? [{ mention: { uri: node.reference.uri, label: referenceLabel(node) } }] : segsOf(node));
    text.classList.toggle('chiponly', chipOnly(text));
  }
  body.append(text);
  if (display.meta) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = display.meta; body.append(m); }
  // every row describes who can see it, not only task rows; the fetch waits until the row is on screen
  const taskInfo = taskSummary(display, true) || documentSummary(display, true);
  if (displayOn('assigned')) {
    if (taskInfo) body.append(taskMetaEl(taskInfo, display.id));
    else if (observeMeta(el, display)) body.append(taskMetaEl({ assignees: '', pending: true })); // hold the slot: the real icon lands in the same place, so the row never shifts
  } else if (!taskInfo) observeMeta(el, display); // "Lives in" reads the same answer, so the fetch still goes out
  if (displayOn('type')) appendTags(body, display);
  // when it was made, when it last moved and where it lives, as one grey line under the title (renderer/views.js)
  const subText = subtextOf(display, taskInfo);
  if (subText) {
    const sub = document.createElement('div');
    sub.className = 'subtext'; sub.textContent = subText;
    body.append(sub);
  }
  blurSensitive(body, docId, target && target.id);
  line.append(body);
  // handed to the local Codex agent: the robot badge at the end of the row, after everything the row says about itself
  if (codexIds.has(display.id)) line.append(codexBadgeEl(display.id));
  line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !reference && !fullref && (e.target === line || e.target === body || e.target.parentElement === text)) setCaret(text, text.textContent.length); };
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
    const c = childrenOf(childHost);
    if (c == null) { ensureLoaded(childHost); wrap.classList.add('loading'); wrap.textContent = 'Loading…'; }
    else if (c.length) wrap.append(...c.map((k) => childEl(k, childHost)));
    else if (!fullref && !isSpace(node) && canEditItem(item) && (node.kind === 'document' || node.done != null || ['paragraph', 'bullet', 'numbered'].includes(node.block))) wrap.append(nodeEl(draftNode(item), docId, item));
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
      const s = sectionOf(node.id), i = s ? s.nodes.indexOf(node) : -1;
      if (i >= 0) { s.nodes.splice(i, 1, real); fresh.set(real.id, { section: s.id, after: i ? s.nodes[i - 1].id : null, node: real }); }
      if (zoom?.docId === node.id) zoom = { ...zoom, docId: real.id };
      key = real.id;
    } else {
      const last = childrenOf(parent)?.at(-1);
      const id = parent.node.kind === 'document' || last ? await tana.insertAfter(parent.docId, last?.id || null, text) : await tana.insertChild(parent.docId, parent.node.id, text);
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
  const node = draftDocNode(DRAFT_KIND[s.id] || 'doc');
  s.nodes.splice(after ? s.nodes.indexOf(after.node) + 1 : 0, 0, node);
  render(true);
  placeCaret(node.id, 0);
}
