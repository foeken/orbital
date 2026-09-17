'use strict';
// Edits (debounced saves), structural operations (split, shift, remove, undo), zoom and navigation between documents.

// ---- edits (debounced) ----
function scheduleSave(item, segs) {
  if (!canEditText(item)) return;
  const p = pending.get(item.key);
  if (p) clearTimeout(p.timer);
  pending.set(item.key, { item, segs, timer: setTimeout(() => flush(item.key), 400) });
}
function dropPending(key) { const p = pending.get(key); if (p) { clearTimeout(p.timer); pending.delete(key); } }
function flush(key) {
  const p = pending.get(key);
  if (!p) return;
  dropPending(key);
  const { item, segs } = p, text = plainOf(segs);
  if (!canEditText(item)) return;
  if (isReference(item.node)) { // the row edits the referenced document's title
    if (text === referenceLabel(item.node)) return;
    item.node.reference.node.title = text;
    return run(() => tana.setTitle(item.node.reference.uri, text));
  }
  if (text === item.node.text && JSON.stringify(segs) === JSON.stringify(segsOf(item.node))) return;
  if (item.node.kind === 'block' && (typeof item.node.id !== 'string' || !item.node.id)) {
    return run(async () => { await reload(item.docId); render(true); throw new Error('This outline row no longer exists'); });
  }
  item.node.text = text; item.node.segments = segs;
  run(async () => {
    try { await (item.node.kind === 'document' ? tana.setTitle(item.docId, text) : tana.setText(item.docId, item.node.id, saveValue(segs))); }
    catch (e) { if (item.node.kind === 'block') { await reload(item.docId); render(true); } throw e; }
  });
}
function insertAtCaret(el, str) {
  if (caretOffset(el) == null) setCaret(el, el.textContent.length);
  document.execCommand('insertText', false, str); // keeps mention anchors intact and fires 'input'
}

// ---- structural operations ----
async function splitNode(item, el, off) {
  if (!canEditItem(item)) return;
  const { docId, node } = item;
  const original = readSegs(el), [before, after] = splitSegs(original, off);
  let newId, asChild = false, splitDraft, splitKey, typed = after, typedOffset = 0;
  const splitList = (parent) => parent?.node?.kind === 'block' ? parent.node.children : kids.get(docId);
  const readSplitDraft = () => {
    const draftEl = splitKey && typeof textEl === 'function' && textEl(splitKey);
    if (draftEl) { typed = readSegs(draftEl); typedOffset = typeof caretOffset === 'function' ? caretOffset(draftEl) ?? 0 : 0; }
  };
  const addSplitDraft = (list, index) => {
    splitDraft = { id: 'draft:split:' + node.id + ':' + Date.now(), text: plainOf(after), segments: after, kind: 'block', done: node.kind === 'block' && node.done != null ? 0 : undefined, draft: true, pendingSplit: true };
    list.splice(index, 0, splitDraft);
    splitKey = docId + '/' + splitDraft.id;
    render(true); placeCaret(splitKey, 0);
  };
  if (node.kind === 'document') {
    flush(item.key);
    const list = splitList(item);
    if (Array.isArray(list)) addSplitDraft(list, list.length);
    // ponytail: no prepend op in the contract; a document's new child is appended (first child when the doc is empty)
    await run(async () => {
      newId = await tana.insertAfter(docId, null, '');
      readSplitDraft();
      await reload(docId);
    });
    open.set(item.key, true);
  } else {
    dropPending(item.key);
    asChild = hasKids(item) && isOpen(item);
    const list = splitList(asChild ? item : item.parent);
    if (Array.isArray(list)) {
      if (JSON.stringify(before) !== JSON.stringify(original)) { node.text = plainOf(before); node.segments = before; }
      addSplitDraft(list, asChild ? 0 : list.indexOf(node) + 1);
    }
    await run(async () => {
      if (JSON.stringify(before) !== JSON.stringify(original)) await tana.setText(docId, node.id, saveValue(before));
      newId = asChild ? await tana.insertChild(docId, node.id, plainOf(after)) : await tana.insertAfter(docId, node.id, plainOf(after));
      if (after.some((s) => 'mention' in s)) await tana.setText(docId, newId, after); // insert ops take plain text; restore the mentions
      readSplitDraft();
      await reload(docId);
      if (asChild) await inheritCheckbox(item, newId);
    });
  }
  render(true);
  if (newId) {
    const key = docId + '/' + newId, real = typeof items !== 'undefined' && items.get(key);
    if (real && JSON.stringify(typed) !== JSON.stringify(after)) { renderSegs(textEl(key), typed); scheduleSave(real, typed); }
    placeCaret(key, typedOffset);
  }
}

async function shiftNode(item, el, op, arg) {
  if (!canEditStructure(item)) return;
  flush(item.key);
  const off = caretOffset(el);
  if (op === 'indent') {
    const siblings = childrenOf(item.parent) || [], prev = siblings[siblings.indexOf(item.node) - 1];
    if (prev) open.set(keyFor(item.docId, prev), true);
  }
  await run(async () => { await tana[op](item.docId, item.node.id, arg); await reload(item.docId); });
  render(true);
  placeCaret(item.key, off);
}

async function removeNode(item, el) {
  if (!canEditStructure(item)) return;
  const keys = texts().map(keyOfEl), i = keys.indexOf(item.key);
  dropPending(item.key);
  await run(async () => { await tana.remove(item.docId, item.node.id); await reload(item.docId); });
  render(true);
  caretNear(keys, i, null);
}
async function removeDocument(item) {
  if (!canEditItem(item) || !tana.deleteDocument || !tana.accessOptions) return;
  flush(item.key);
  await run(async () => {
    const access = await tana.accessOptions(item.docId);
    if (!access?.deletable) throw new Error(access?.reason || 'This document cannot be deleted');
    await tana.deleteDocument(item.docId); invalidateNode(item.docId); await loadRoots();
  });
  render(true);
}
function removeZoomedBlock() {
  const item = resolveZoom()?.at(-1);
  if (item?.node.kind === 'block') removeNode(item);
  else if (item?.node.kind === 'document') removeDocument(item);
}
// Cmd+Z / Cmd+Shift+Z: undo/redo through the API (never the browser's contenteditable history), then re-read what changed
// ponytail: the API returns only the docId; the caret stays in the focused node or moves to the nearest surviving one
async function history(op) {
  flushAll();
  const saved = focused(), keys = texts().map(keyOfEl);
  await run(async () => {
    const docId = await tana[op]();
    await loadRoots();
    if (docId && kids.has(docId)) await reload(docId);
  });
  render(true);
  if (saved && !focused()) caretNear(keys, keys.indexOf(saved.key), saved.offset);
}

function setOpen(item, value) {
  if (value && !canExpand(item)) return;
  if (value && !hasKids(item) && item.node.kind !== 'document' && item.node.done == null && !['paragraph', 'bullet', 'numbered'].includes(item.node.block)) return;
  open.set(item.key, value); render(true);
}
// The box and ⌘↩ accept an Inbox task first (In Progress) and complete it on the next go; direct is the Cmd+K
// Complete/Reopen row, which does what its label says.
function toggleDone(item, direct) {
  if (!canEditItem(item) || !isTask(item.node) || item.node.draft) return;
  holdRow(item.node); // the row stays put, new box and all, until the view is left
  const accept = !direct && acceptsFirst(item.node);
  if (!accept) item.node.done = item.node.done ? 0 : 1;
  item.node.stateType = item.node.done ? 'closed' : 'open'; // what setDone makes of it: an unchecked Inbox task comes back In Progress, not dashed
  if (zoom && zoom.docId === item.docId) extra.set(item.docId, item.node); // the page stays open when the task leaves the filtered view
  render(true);
  run(() => (accept ? tana.setState(item.docId, 'open') : tana.setDone(item.docId, item.node.done)));
}
function toggleCheckbox(item) {
  if (!canEditItem(item) || item.node.kind !== 'block' || !tana.toggleCheckbox) return;
  run(async () => { await tana.toggleCheckbox(item.docId, item.node.id); await reload(item.docId); });
}
async function inheritCheckbox(parent, nodeId) {
  if (!nodeId || parent.node?.kind !== 'block' || parent.node.done == null || !tana.toggleCheckbox) return;
  const child = locate(kids.get(parent.docId) || [], nodeId);
  if (child && child.node.done != null) return;
  await tana.toggleCheckbox(parent.docId, nodeId);
  await reload(parent.docId);
}
function zoomTo(item) {
  flushAll(); dropDrafts(); caretOnOpen = true;
  if (item.node.kind === 'document') recordRecent(item.node);
  let top = item; while (top.parent && top.parent.docId === item.docId) top = top.parent; // the item's document row (itself, or an ancestor in the same document)
  const same = zoom && zoom.docId === item.docId;
  const via = same ? zoom.via : top.parent && zoom ? [...(zoom.via || []), zoom] : undefined; // a document inside a zoomed space: the space stays in the crumb
  if (via && !docOf(item.docId)) extra.set(item.docId, top.node);
  zoom = { docId: item.docId, nodeId: item.node.kind === 'document' ? null : item.node.id, from: same ? zoom.from : undefined, via };
  render(true);
  followSummary(item.docId);
}
function openReference(node) {
  const target = referenceTarget(node);
  if (!target || !node.reference?.uri) return;
  extra.set(node.reference.uri, target);
  openDoc(node.reference.uri, 'Reference');
}
function toggleReference(node) {
  const target = referenceTarget(node);
  if (!target || !isTask(target) || !canEditNode(target)) return;
  if (acceptsFirst(target)) { // an Inbox task is accepted (In Progress) first, completed on the next click
    node.reference.node = { ...node.reference.node, stateType: 'open' };
    extra.set(target.id, { ...target, stateType: 'open' });
    render(true);
    return run(() => tana.setState(target.id, 'open'));
  }
  const done = target.done ? 0 : 1; // referenceTarget() hands back a copy: write the new state where the row reads it
  node.reference.node = { ...node.reference.node, done };
  extra.set(target.id, { ...target, done });
  render(true);
  run(() => tana.setDone(target.id, done));
}
function setView(id) { dropDrafts(); releaseHeld(); view = id; localStorage.setItem('view', id); zoom = null; sel = null; menu = null; loadView(id); render(true); }
// zoom into a document, switching to its view first when it belongs to another one; from = breadcrumb root instead of the view
function openDoc(docId, from) {
  flushAll(); dropDrafts(); caretOnOpen = true;
  const s = from ? null : sectionOf(docId);
  if (s && s.id !== view) { releaseHeld(); view = s.id; localStorage.setItem('view', view); }
  const doc = allDocs().find((d) => d.id === docId) || extra.get(docId);
  if (doc) recordRecent(doc);
  zoom = { docId, nodeId: null, from };
  render(true);
  followSummary(docId);
}
// An event has no content of its own, so a meeting opens at its write-up. Every zoom passes through here, so the
// redirect behaves the same from a list row, search, the rail, a pin, a breadcrumb or a link.
function followSummary(docId) {
  if (!tana.summaryUri || typeof docId !== 'string' || !docId.startsWith('tana:event:')) return;
  tana.summaryUri(docId).then((uri) => { if (uri && zoom && zoom.docId === docId) { navReplace = true; goTo(uri); } }, () => {}); // the event page is a hop, not a place to come back to
}
async function goTo(uri) {
  if (!allDocs().some((d) => d.id === uri) && !extra.has(uri)) {
    try { const n = await tana.node(uri); extra.set(uri, { ...n, text: n.title || '', hasChildren: true }); }
    catch (e) { return showError(e); }
  }
  openDoc(uri);
}
function flushAll() { for (const key of [...pending.keys()]) flush(key); }
// ---- history: Cmd+[ and Cmd+] walk the places you have been, like a browser ----
// A place is the view plus the zoom. Every render that lands somewhere new records it, however it got there (a
// view switch, a bullet, a mention, a crumb, search, a pin), so nothing that navigates needs to know about this.
const navBack = [], navForward = [];
let navHere = null, navigating = false, navReplace = false; // navReplace: the next place stands in for the current one (a meeting forwarding to its write-up)
const navPlace = () => ({ view, zoom: zoom && { ...zoom }, key: JSON.stringify([view, zoom && zoom.docId, zoom && zoom.nodeId, zoom && (zoom.via || []).map((v) => v.docId)]) });
// The place to reopen at the next launch. Only the document and the node: the crumb trail (zoom.via) rebuilds itself
// from tana.path, and naming its documents would mean fetching each one. A draft id means nothing after a restart.
function rememberPlace() {
  if (zoom && isRealId(zoom.docId)) localStorage.setItem('place', JSON.stringify({ docId: zoom.docId, nodeId: zoom.nodeId || null, from: zoom.from }));
  else localStorage.removeItem('place');
}
function noteNavigation() {
  const here = navPlace();
  if (navHere && navHere.key === here.key) return;
  if (navHere && !navigating && !navReplace) { navBack.push(navHere); navForward.length = 0; if (navBack.length > 100) navBack.shift(); }
  navReplace = false;
  navHere = here;
  rememberPlace();
}
function navigate(dir) {
  const from = dir < 0 ? navBack : navForward, to = dir < 0 ? navForward : navBack;
  const place = from.pop();
  if (!place) return;
  to.push(navHere);
  navigating = true;
  try {
    flushAll(); dropDrafts();
    if (place.view !== view) { view = place.view; localStorage.setItem('view', view); }
    zoom = place.zoom && { ...place.zoom };
    caretOnOpen = !!zoom;
    render(true);
  } finally { navigating = false; }
}
// Reopen the last place, once the views are loaded. A document already in a view needs no fetch; one reached through a
// mention or a search is pulled into extra the way goTo does it, but here a failure is silent — landing on the view is
// fine, an error banner on every launch is not. renderOutline drops a zoom it cannot resolve, so a node that was
// deleted or is no longer readable ends up on the view too.
function readStoredPlace() {
  try { return JSON.parse(localStorage.getItem('place') || 'null'); } catch { return null; } // a corrupt entry is simply not a place
}
// Read at load, before the first paint: renderOutline records the place it drew, and on boot that is the view with no
// zoom, which clears the stored place. Reading it here means the first render can no longer erase what we reopen.
let savedPlace = readStoredPlace();
async function restorePlace() {
  const saved = savedPlace;
  if (!saved || !isRealId(saved.docId) || zoom) { savedPlace = null; return; }
  // Boot draws the cached roots before the sync client exists, so reopening the page now would ask for its children
  // with nothing to ask — "not connected to Tana" from outline:children. The place is kept rather than spent, and
  // app.js runs this again the moment the connection comes up.
  if (!connected) return;
  savedPlace = null; // one restore per launch
  if (!allDocs().some((d) => d.id === saved.docId) && !extra.has(saved.docId)) {
    const before = navPlace().key;
    try { const n = await tana.node(saved.docId); extra.set(saved.docId, { ...n, text: n.title || '', hasChildren: true }); }
    catch { return; }
    if (zoom || navPlace().key !== before) return; // you navigated while it loaded: you stay where you went
  }
  zoom = { docId: saved.docId, nodeId: saved.nodeId || null, from: saved.from };
  render(true);
  followSummary(saved.docId);
}
// Up past the first node: the editable page title (zoomed), else the last filter pill
function focusAbove(el) {
  if (el) flush(keyOfEl(el));
  const p = $('pills').lastElementChild;
  if (titleEl.isContentEditable) setCaret(titleEl, titleEl.textContent.length);
  else if (p && !$('pills').hidden) { if (el) el.blur(); p.focus(); }
}
