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
  // A title is plain text (#53), and segsOf() prefers segments over text: left behind on a document node, the ones
  // typed here would outlive every in-place patch of that row (an undo, a remote edit, a status change), since a
  // patch carries only text. Same rule as the mark toggles in toolbar.js.
  item.node.text = text; item.node.segments = item.node.kind === 'document' ? undefined : segs;
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
    const draftEl = splitKey && textEl(splitKey);
    if (draftEl) { typed = readSegs(draftEl); typedOffset = caretOffset(draftEl) ?? 0; }
  };
  const addSplitDraft = (list, index) => {
    // the kind the write will make it (siblingBlock), not the default one: a bullet flashing under the caret for
    // the length of a round trip on a row that is about to be plain text is a visible wrong answer
    const block = asChild ? 'bullet' : siblingBlock(node); // a child is a listItem in Tana's schema, whatever its parent is
    splitDraft = { id: 'draft:split:' + node.id + ':' + Date.now(), text: plainOf(after), segments: after, kind: 'block', block, done: node.kind === 'block' && node.done != null ? 0 : undefined, draft: true, pendingSplit: true };
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
  } else if (off === 0 && plainOf(original).length) {
    // Enter at the very start: an empty row goes in front and takes the caret, the node keeps its text and children.
    // Splitting here would move everything into a new node, and into a new child when the node is open.
    dropPending(item.key);
    await run(async () => { newId = await tana.insertBefore(docId, node.id, ''); await reload(docId); });
  } else {
    dropPending(item.key);
    asChild = hasKids(item) && isOpen(item);
    const list = splitList(asChild ? item : item.parent);
    if (Array.isArray(list)) {
      if (JSON.stringify(before) !== JSON.stringify(original)) { node.text = plainOf(before); node.segments = before; }
      addSplitDraft(list, asChild ? 0 : list.indexOf(node) + 1);
    }
    await run(async () => {
      // Truncation and insertion are one mutation, so one undo puts the node back whole.
      newId = await tana.split(docId, node.id, saveValue(before), saveValue(after), asChild);
      readSplitDraft();
      await reload(docId);
      if (asChild) await inheritCheckbox(item, newId);
    });
  }
  render(true);
  if (newId) {
    const key = docId + '/' + newId, real = items.get(key);
    if (real && JSON.stringify(typed) !== JSON.stringify(after)) { renderSegs(textEl(key), typed); scheduleSave(real, typed); }
    placeCaret(key, typedOffset);
    lastEnter = { from: item.key, created: key, at: off }; // undoing this Enter belongs in the row it acted on, not in whatever sits above
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
  const leaving = op === 'outdent' ? item.parent : null; // the row it is about to leave: emptied, it closes with it
  await run(async () => { await tana[op](item.docId, item.node.id, arg); await reload(item.docId); });
  // An outdent takes the row out of its parent, which is the same as a removal for the parent it leaves behind:
  // without this the parent stayed expanded over nothing and drew a draft row where the child had been.
  if (leaving) closeIfEmpty(leaving);
  render(true);
  placeCaret(item.key, off);
}

// An empty node shows a draft row only while it is explicitly expanded (renderer/render.js), and that expansion
// was made to hold a child. When a removal takes the last one away, the expansion goes with it, so no draft row
// is left standing where the child was. Deleted rather than set false, so children arriving again — an undo, a
// live update from another client — show without having to be expanded a second time.
function closeIfEmpty(parent) { if (parent && !hasKids(parent)) open.delete(parent.key); }
async function removeNode(item, el) {
  if (!canEditStructure(item)) return;
  const keys = rowsBeside(el).map(keyOfEl), i = keys.indexOf(item.key);
  dropPending(item.key);
  await run(async () => { await tana.remove(item.docId, item.node.id); await reload(item.docId); });
  closeIfEmpty(item.parent);
  render(true);
  caretNear(keys, i, null);
}
// Backspace at the start of a row takes the empty row above it away. A plain empty row draws nothing at all now,
// so there is no bullet left to click and no text to put a caret in — without this it can only be reached from
// the row below, which is also what every editor does at the start of a line. The caret does not move: it stays
// where it already was, at the start of the row the user is typing in, so the text does not jump.
// A row with children, an image, a divider, a reference, a draft or a row belonging to another document (the
// rows an opened reference borrows) is not "an empty row above" and is left alone.
function removeEmptyAbove(item, el) {
  const all = rowsBeside(el), prev = all[all.indexOf(el) - 1], above = prev && items.get(keyOfEl(prev));
  if (!above || above.docId !== item.docId || above.node.kind !== 'block' || above.node.draft) return false;
  if (isAtomic(above.node) || isReference(above.node) || hasKids(above) || above.node.hasChildren) return false;
  if (unanchored(prev.textContent).length || plainOf(above.node).length) return false;
  if (!canEditStructure(above)) return false;
  dropPending(above.key);
  run(async () => { await tana.remove(above.docId, above.node.id); await reload(above.docId); closeIfEmpty(above.parent); render(true); placeCaret(item.key, 0); });
  return true;
}
// Backspace at the start of a row with words in it: they join the row above, and the caret lands where the two meet.
// The reverse of Enter mid-text (splitNode), written as one change in main (sdk/content.js join), so one ⌘Z brings
// the row back. Only words join words: a row with children, an image, a divider, a table, a reference, a draft or a
// row of another document stays where it is.
function joinAbove(item, el) {
  const all = rowsBeside(el), prev = all[all.indexOf(el) - 1], above = prev && items.get(keyOfEl(prev));
  if (!above || above.docId !== item.docId || above.node.kind !== 'block' || above.node.draft || item.node.draft) return false;
  if (isAtomic(above.node) || isReference(above.node) || hasKids(item) || item.node.hasChildren) return false;
  if (!canEditItem(above) || !canEditItem(item)) return false;
  const top = readSegs(prev), joined = saveValue([...top, ...readSegs(el)]), at = plainOf(top).length;
  dropPending(item.key); dropPending(above.key); // the words on screen are what gets written, both rows at once
  run(async () => { await tana.join(item.docId, item.node.id, above.node.id, joined); await reload(item.docId); render(true); placeCaret(above.key, at); });
  return true;
}
async function removeDocument(item) {
  if (!canEditItem(item) || !tana.deleteDocument || !tana.accessOptions) return;
  // A draft has no Tana id yet: main reads a local one as "not connected to Tana", so asking it whether the node may
  // be deleted fails with a connection error for a node that was never created. Dropping it is the whole delete.
  if (item.node.draft) return dropDraft(item);
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
    // The changed row, wherever it is listed: a view, or a page that lists documents (a saved search, a space),
    // whose rows loadRoots never touches. onChanged patches it too, but its render is deferred while the caret is
    // still in the row — which is exactly where it is after a Cmd+Z — so the undo would not show until you left.
    if (docId) await patchDoc(docId);
    for (const id of docId ? outlinesOf(docId) : []) await reload(id); // its page and its fields: both are its rows
  });
  render(true);
  if (saved && !focused()) {
    // Undoing an Enter takes the row it created away. The caret belongs back where Enter ran — the row below when
    // the new row went in above it, the row above when the node was split — which is not what "nearest" would pick.
    const undone = lastEnter && lastEnter.created === saved.key && textEl(lastEnter.from) ? lastEnter : null;
    if (undone) { placeCaret(undone.from, undone.at); lastEnter = null; }
    else caretNear(keys, keys.indexOf(saved.key), saved.offset);
  }
}

function setOpen(item, value) {
  if (value && !canExpand(item)) return;
  if (value && !hasKids(item) && item.node.kind !== 'document' && item.node.done == null && !['paragraph', 'bullet', 'numbered'].includes(item.node.block)) return;
  open.set(item.key, value); render(true);
}
// The box and ⌘↩ accept an Inbox task first (In Progress) and complete it on the next go; direct is the Cmd+K
// Complete/Reopen row, which does what its label says.
function toggleDone(item, direct) {
  if (!(canEditItem(item) || item.node.checkable) || !isTask(item.node) || item.node.draft) return; // checkable: a Timeline row's box (main/timeline.js)
  holdRow(item.node); // the row stays put, new box and all, until the view is left
  const accept = !direct && acceptsFirst(item.node);
  if (!accept) item.node.done = item.node.done ? 0 : 1;
  item.node.stateType = item.node.done ? 'closed' : 'open'; // what setDone makes of it: an unchecked Inbox task comes back In Progress, not dashed
  if (item.node.done) justDone.set(item.docId, Date.now());
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
  if (done) justDone.set(target.id, Date.now());
  render(true);
  run(() => tana.setDone(target.id, done));
}
function setView(id) { dropDrafts(); releaseHeld(); view = id; localStorage.setItem('view' + SIDE, id); zoom = null; sel = null; menu = null; loadView(id); render(true); }
// zoom into a document, switching to its view first when it belongs to another one; from = breadcrumb root instead of the view
function openDoc(docId, from) {
  // Every zoom of a document comes through here, whichever route asked for it — a row, a pin, the rail, a crumb, a
  // mention, a notification, a meeting's write-up redirect — so this is where a deleted node is refused. Opening one
  // put an empty page on screen whose every read came back "Node has been deleted", once per metadata retry.
  if (isGone(docId)) return showError(new Error('That node has been deleted'));
  flushAll(); dropDrafts(); caretOnOpen = true;
  const s = from ? null : sectionOf(docId);
  if (s && s.id !== view) { releaseHeld(); view = s.id; localStorage.setItem('view' + SIDE, view); }
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
  if (isGone(uri)) return showError(new Error('That node has been deleted'));
  if (!allDocs().some((d) => d.id === uri) && !extra.has(uri)) {
    // A read refused because the node is gone is how a link into something deleted is usually found out: noteGone
    // remembers it, so every copy of it on screen is struck through and the next click does not ask again.
    try { const n = await tana.node(uri); extra.set(uri, { ...n, text: n.title || '', hasChildren: true }); }
    catch (e) { noteGone(uri, e); return showError(e); }
  }
  openDoc(uri);
}
function flushAll() { for (const key of [...pending.keys()]) flush(key); for (const id of [...cellPending.keys()]) saveCell(id); } // table cells too (renderer/table.js)
// ---- history: Cmd+[ and Cmd+] walk the places you have been, like a browser ----
// A place is the view plus the zoom. Every render that lands somewhere new records it, however it got there (a
// view switch, a bullet, a mention, a crumb, search, a pin), so nothing that navigates needs to know about this.
const navBack = [], navForward = [];
let navHere = null, navigating = false, navReplace = false; // navReplace: the next place stands in for the current one (a meeting forwarding to its write-up)
const navPlace = () => ({ view, zoom: zoom && { ...zoom }, key: JSON.stringify([view, zoom && zoom.docId, zoom && zoom.nodeId, zoom && (zoom.via || []).map((v) => v.docId)]) });
// The place to reopen at the next launch: the document, the node, and the document's own title and glyph — enough
// for the next launch to draw the page before anything is fetched. The crumb trail (zoom.via) rebuilds itself from
// tana.path, and naming its documents would mean fetching each one. A draft id means nothing after a restart.
// A page of the app's own (Notifications, Proposals, Timeline) is a place too: its id is orbital:…, never a Tana id,
// and a reload has to land back on it rather than on whatever was stored before it.
const isPlaceId = (id) => isRealId(id) || String(id || '').startsWith('orbital:');
function rememberPlace(key = 'place' + SIDE) {
  const doc = zoom ? docOf(zoom.docId) : null; // a row the app does not have simply stores no title: the next launch opens on the view, as before
  if (zoom && isPlaceId(zoom.docId)) localStorage.setItem(key, JSON.stringify({ docId: zoom.docId, nodeId: zoom.nodeId || null, from: zoom.from, title: doc ? doc.text : undefined, icon: doc ? doc.icon : undefined }));
  else localStorage.removeItem(key);
}
function noteNavigation() {
  const here = navPlace();
  if (navHere && navHere.key === here.key) return;
  if (navHere && !navigating && !navReplace) { navBack.push(navHere); navForward.length = 0; if (navBack.length > 100) navBack.shift(); }
  navReplace = false;
  const previousDoc = navHere?.zoom?.docId;
  const id = here.zoom?.docId;
  navHere = here;
  rememberPlace();
  if (previousDoc === INBOX_PAGE && id !== INBOX_PAGE) markAllNotificationsRead();
  // Proposals are read afresh on every arrival: nothing pushes them, and one approved in Tana should not linger here.
  if (id === PROPOSALS_PAGE && previousDoc !== id && kids.get(id)) run(async () => { await reload(id); renderSoon(true); });
  // The Timeline too: main rebuilds it from Tana on every read, so an arrival is what brings it up to date.
  if (id === TIMELINE_PAGE && previousDoc !== id && kids.get(id)) run(async () => { if (tana.timelineWeeks) timelineWeeks = await tana.timelineWeeks(1); await reload(id); renderSoon(true); }); // and it opens on the last week again
  // Returning by history, a crumb or a pin must rerun the query, not reuse its old result set.
  if (id !== previousDoc && isSearchDoc({ id }) && kids.get(id)) {
    releaseHeld();
    if (searchRows.delete(id)) previewRows(id); // keep unsaved filter edits and refresh their preview
    else run(async () => { await reload(id); renderSoon(true); });
  }
}
function navigate(dir) {
  const from = dir < 0 ? navBack : navForward, to = dir < 0 ? navForward : navBack;
  const place = from.pop();
  // A page that has been deleted since you were on it is skipped rather than reopened: keep walking the stack, which
  // also empties one that is nothing but deleted pages (it lands on Home, as an empty stack does).
  if (place && place.zoom && isGone(place.zoom.docId)) return navigate(dir);
  // Nothing to go back to: Back lands on Home rather than on whichever view happens to be behind the page. That is
  // the whole point of choosing one — a note opened from a search or a link used to leave you in the Library.
  if (!place) return dir < 0 && !atHome() ? goHome() : undefined;
  to.push(navHere);
  navigating = true;
  try {
    flushAll(); dropDrafts();
    if (place.view !== view) { view = place.view; localStorage.setItem('view' + SIDE, view); }
    zoom = place.zoom && { ...place.zoom };
    caretOnOpen = !!zoom;
    render(true);
  } finally { navigating = false; }
}
// The same two moves as a pair of buttons in the header, beside the sidebar toggle: the mouse route to Cmd+[ and
// Cmd+]. They run navigate, so there is one history and one set of rules; every render draws their state.
const backBtn = $('navBack'), fwdBtn = $('navFwd');
backBtn.addEventListener('click', () => navigate(-1));
fwdBtn.addEventListener('click', () => navigate(1));
function renderNav() {
  // Back with an empty stack is still a move while you are away from Home, which is where it lands (navigate above),
  // so it reads as live there -- the same rule the Cmd+K row uses.
  for (const [el, id, label, live] of [[backBtn, 'back', 'Go back', navBack.length || !atHome()], [fwdBtn, 'forward', 'Go forward', navForward.length]]) {
    el.disabled = !live;
    const key = hotkeyFor(id);
    el.title = key ? label + ' ' + key : label;
    el.setAttribute('aria-label', label);
    if (!el.childNodes.length) { const svg = iconNode(id); if (svg) el.append(svg); } // the glyph never changes: drawn once, not on every render
  }
}
// Reopen the last place, once the views are loaded. A document already in a view needs no fetch; one reached through a
// mention or a search is pulled into extra the way goTo does it, but here a failure is silent — landing on the view is
// fine, an error banner on every launch is not. renderOutline drops a zoom it cannot resolve, so a node that was
// deleted or is no longer readable ends up on the view too.
function readStoredPlace() {
  try { return JSON.parse(localStorage.getItem('place' + SIDE) || 'null'); } catch { return null; } // a corrupt entry is simply not a place
}
// Read at load, before the first paint: renderOutline records the place it drew, and on boot that is the view with no
// zoom, which clears the stored place. Reading it here means the first render can no longer erase what we reopen.
let savedPlace = readStoredPlace();
// Nothing to restore: a launch opens Home. The Library needs nothing here (it is the view already), and a saved
// search is opened exactly the way a stored place is — it waits for the connection, is fetched if no view lists it,
// and silently leaves you on the view if it cannot be read, which is the fallback a deleted Home needs anyway.
if (!savedPlace && isRealId(home)) savedPlace = { docId: home, nodeId: null };
// The page itself, before the first paint. A launch used to draw the view behind the place it was about to reopen
// and replace it once the connection came up, which read as the Library flashing past on every start; the stored
// title and glyph are enough for the header, and the rows say Loading… until there is a connection to ask. Only
// with a title: a Home search that has never been drawn has no name to show, so that one still opens on the view.
// restorePlace reads the real node over this stub the moment it can.
if (savedPlace && isPlaceId(savedPlace.docId) && savedPlace.title != null) {
  extra.set(savedPlace.docId, asDoc({ id: savedPlace.docId, title: savedPlace.title, icon: savedPlace.icon }));
  zoom = { docId: savedPlace.docId, nodeId: savedPlace.nodeId || null, from: savedPlace.from };
}
async function restorePlace() {
  const saved = savedPlace;
  // Somewhere else already — a link, a notification — wins. The page seeded above is this same place, so it does not.
  if (!saved || !isPlaceId(saved.docId) || (zoom && zoom.docId !== saved.docId)) { savedPlace = null; return; }
  // Boot draws the cached roots before the sync client exists, so reopening the page now would ask for its children
  // with nothing to ask — "not connected to Tana" from outline:children. The place is kept rather than spent, and
  // app.js runs this again the moment the connection comes up.
  if (!connected) return;
  savedPlace = null; // one restore per launch
  // extra is not proof any more: the seeded page is a stub with a title and nothing else — no state, no tags, no
  // editability — so a document no view lists is read for real here whether or not the stub is sitting in it.
  if (!allDocs().some((d) => d.id === saved.docId) && !extra.get(saved.docId)?.appPage) { // an app page is known from load: nothing to fetch
    const before = navPlace().key;
    try { const n = await tana.node(saved.docId); extra.set(saved.docId, { ...n, text: n.title || '', hasChildren: true }); }
    // Deleted, or no longer yours: the stub is taken down again and the launch lands on the view, as it used to.
    catch { if (zoom && zoom.docId === saved.docId) { zoom = null; extra.delete(saved.docId); render(true); } return; }
    if (navPlace().key !== before) return; // you navigated while it loaded: you stay where you went
  }
  zoom = { docId: saved.docId, nodeId: saved.nodeId || null, from: saved.from };
  render(true);
  followSummary(saved.docId);
}
// Up past the first node: the editable page title (zoomed), else the last filter pill
function focusAbove(el) {
  if (el) flush(keyOfEl(el));
  const p = $('pills').lastElementChild;
  const field = fieldValues().at(-1); // the last field value sits between the outline and the title
  if (field) setCaret(field, field.textContent.length);
  else if (titleEl.isContentEditable) setCaret(titleEl, titleEl.textContent.length);
  else if (p && !$('pills').hidden) { if (el) el.blur(); p.focus(); }
}
