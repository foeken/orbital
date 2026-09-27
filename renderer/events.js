'use strict';
// Keyboard and mouse handling on the outline, the filter input and the document.

// ---- navigation ----
function moveTo(el, dir, offset) {
  const all = caretRows(), target = all[all.indexOf(el) + dir];
  if (!target) { if (dir < 0) focusAbove(el); return; }
  flush(keyOfEl(el));
  setCaret(target, offset);
}

// Clicking the empty space under a list is a click on that list: there is nothing at that point, but there is an
// obvious thing meant by it — carry on where its words end. Each zone answers for itself, so the space below a
// field goes to that field's last row and the space below the page goes to the page's. A click level with a row
// is that row's own (the row's line.onclick puts the caret where it was clicked), and a click in the gap between
// two rows belongs to the one above it, which is where typing would continue.
for (const [zone, rows] of [[$('fields'), () => fieldValues()], [outline.parentElement, () => texts()]]) {
  zone.addEventListener('mousedown', (e) => {
    if (!e.target.closest || e.target.closest('.node, .text, input, button, a, .pills, .crumbs')) return; // something better was clicked
    if (e.target.closest('#fields, .scroll') !== zone) return; // the fields sit inside the page's scroll area: a click there is theirs alone
    const all = rows();
    const target = all.filter((row) => row.getBoundingClientRect().top <= e.clientY).at(-1) || all[0];
    if (!target) return;
    e.preventDefault();
    const box = target.getBoundingClientRect();
    // beside the words: where it was clicked; below them: the end of the line, which is the end of the list
    setCaret(target, e.clientY <= box.bottom ? caretAt(target, e.clientX, e.clientY) : target.textContent.length);
  });
}
// ---- events ----
// Rows live in two places: the outline, and the fields under the title, which are outlines too (docs/OUTLINER.md).
// Every row listener is bound to both, because a field row *is* a row — the same keys, the same handlers, the same
// behaviour, rather than a second editor that has to be taught each of them again.
const onRows = (type, handler) => { for (const root of [outline, $('fields')]) root.addEventListener(type, handler); };
onRows('keydown', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el || e.target.classList?.contains('cell')) return; // a table cell answers its own keys (renderer/table.js cellKey)
  const item = items.get(keyOfEl(el)), mod = e.metaKey || e.ctrlKey;
  const off = caretOffset(el), len = unanchored(el.textContent).length, collapsed = getSelection().isCollapsed; // the caret anchor before a leading chip is no character
  const isDoc = item.node.kind === 'document', combo = comboOf(e);
  if (item.node.upload) { // a placeholder: Esc cancels its upload, Up/Down step past it, nothing else
    if (e.key === 'Escape') cancelUpload(item, el);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') moveTo(el, e.key === 'ArrowUp' ? -1 : 1, 0);
    else if (mod) return;
    return e.preventDefault();
  }
  if (isAtomic(item.node)) { // image or divider, not editable: Backspace / ⌘⇧⌫ removes, Up/Down step past, Shift+Up/Down select, ⌘⇧Up/Down moves; everything else is swallowed
    const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown', dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.key === 'Backspace') removeNode(item, el);
    else if (e.key === ' ' && isImage(item.node)) openImage(item.node); // the row cannot be typed into: Space looks at the picture
    else if (e.key === 'Enter' && item.node.table) enterTable(el); // a table's way in: its first cell
    else if (vert && e.shiftKey && mod) shiftNode(item, el, 'move', dir < 0 ? 'up' : 'down');
    else if (vert && e.shiftKey) extendSel(item, dir);
    else if (vert && !mod) moveTo(el, dir, 0);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') moveTo(el, e.key === 'ArrowLeft' ? -1 : 1, e.key === 'ArrowLeft' ? Infinity : 0);
    else if (e.key === 'Tab') shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent');
    else if (e.key === 'Escape') el.blur();
    else if (mod) return; // ⌘K / ⌘S / ⌘Z … reach the document handler
    return e.preventDefault();
  }
  if (!canEditItem(item) || opensOnClick(item)) {
    if (isReference(item.node) && canEditStructure(item)) {
      const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown', dir = e.key === 'ArrowUp' ? 'up' : 'down';
      const editing = canEditText(item);
      if (e.key === 'Backspace' && (!editing || (off === 0 && collapsed))) removeNode(item, el);
      else if (vert && e.shiftKey && mod) shiftNode(item, el, 'move', dir);
      else if (vert && e.shiftKey) extendSel(item, dir === 'up' ? -1 : 1);
      else if (vert && !mod) moveTo(el, dir === 'up' ? -1 : 1, editing ? off : 0);
      else if (e.key === 'Escape') { if (editing) flush(item.key); el.blur(); }
      else if (e.key === ' ' && !editing) openReference(item.node); // Space on a focused reference opens what it points at
      else if (mod) return;
      else if (editing && e.key !== 'Enter' && e.key !== 'Tab') return; // typing edits the referenced document's title
      return e.preventDefault();
    }
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
    else if (item.node.notification && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNotification(item.node); } // renderer/inbox.js: read, and open what it is about
    else if (item.node.timeline && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTimeline(item.node); } // renderer/timeline.js: the node the event is about
    else if (item.parent?.node?.timeline && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); goTo(item.node.id); } // a task listed under a Timeline entry opens as itself (see render.js)
    else if (!mod && (e.key === ' ' || (e.key === 'Enter' && opensOnClick(item)))) { e.preventDefault(); if (isReference(item.node)) openReference(item.node); else if (zoomable(item.node)) zoomTo(item); } // Space zooms into a read-only row, since typing into it is not an option; a member has no page; Enter opens a type row as its click does; a ⌘ combo is a recorded shortcut's
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
    else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
    else if (e.key === 'ArrowLeft' && !mod && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
    else if (e.key === 'ArrowRight' && !mod && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
    else if (!mod) e.preventDefault(); // every ⌘ combo (⌘K, ⌘S, ⌘F …) is the document handler's to run, as the atomic branch above already does
    return;
  }
  if (item.node.draft) { // empty draft: Enter/Tab do nothing, Backspace drops it (caret to the node above); typing creates it (input handler)
    if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault();
    if (e.key === 'Backspace' && len === 0) { e.preventDefault(); const all = rowsBeside(el), prev = all[all.indexOf(el) - 1], k = prev && keyOfEl(prev); dropDraft(item); return k ? placeCaret(k) : focusAbove(); }
    if (e.key !== 'Escape' && !(e.key.startsWith('Arrow') && !mod)) return;
  }
  // a row that is only a mention chip deletes like an image: the caret beside the chip can remove nothing (chipOnly)
  if (!isDoc && !mod && (e.key === 'Backspace' || e.key === 'Delete') && chipOnly(el)) { e.preventDefault(); return removeNode(item, el); }
  // formatting: the toolbar's toggles from the keyboard, and Tab/Escape into and out of the toolbar itself
  if (e.key === 'Escape' && !toolbarEl.hidden) { e.preventDefault(); returnToSelection(); }
  else if (e.key === 'Tab' && !e.shiftKey && !toolbarEl.hidden) { e.preventDefault(); focusToolbar(); }
  else if (mod && !e.shiftKey && MARK_KEYS[e.key.toLowerCase()]) { e.preventDefault(); toggleMarkKey(item, el, MARK_KEYS[e.key.toLowerCase()]); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); toggleMarkKey(item, el, 'strike'); }
  // ⌘A selects the row's words; pressing it again, with them all selected, selects the rows themselves — every row
  // of this editor, which for a field is that field's rows and for the page is the page's.
  else if (mod && !e.shiftKey && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    const range = selectionOffsets(el);
    if (range && range[0] === 0 && range[1] === len) selectAllRows(el); else selectRange(item.key, 0, len);
  }
  else if (e.key === 'Escape') { e.preventDefault(); flush(item.key); el.blur(); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); } // multi-select over siblings
  else if (e.key === '@' && (!collapsed || !isDoc)) { const range = collapsed ? [off, off] : selectionOffsets(el); if (range) { e.preventDefault(); startLink(item, el, range); } } // a selection links it; a caret in a block inserts a reference there (a title cannot hold one, so "@" is typed)
  else if (combo === hotkeyFor('toggleDone')) { e.preventDefault(); if (isDoc) toggleDone(item); else toggleCheckbox(item); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertAtCaret(el, '\n'); }
  else if (e.key === 'Enter' && isDoc && item.parent) e.preventDefault(); // document child (inside a space): nothing to split or draft yet
  else if (e.key === 'Enter' && isDoc && !zoom && !isOpen(item)) { e.preventDefault(); draftDoc(item); } // collapsed document in a view: draft sibling document
  else if (e.key === 'Enter') { e.preventDefault(); splitNode(item, el, off ?? len); }
  // Tab at the start of a plain line starts a list there, the same gesture as typing "- " (renderer/toolbar.js
  // rebullet), and ⇧Tab at the start of a bullet with nothing to outdent into takes the marker off again (unbullet
  // refuses a nested row, so ⇧Tab there is still the outdent), which is what Backspace does. Anywhere else in the
  // line, and on a row that is already in a list, Tab is the indent it has always been.
  else if (e.key === 'Tab' && off === 0 && collapsed && !isDoc && (e.shiftKey ? unbullet(item) : bulletOrIndent(item, el))) e.preventDefault();
  else if (e.key === 'Tab') { e.preventDefault(); if (!isDoc) shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent'); }
  // a document row is the document: the same shortcut deletes it (reversibly, like the zoomed title), not just blocks
  else if (e.key === 'Backspace' && mod && e.shiftKey) { e.preventDefault(); if (isDoc) removeDocument(item); else removeNode(item, el); }
  // at the start of a row: the bullet comes off first (unbullet), then the row itself when it is empty, and
  // otherwise the empty row above it — the one a plain empty row leaves invisible — or else its words join the row above
  else if (e.key === 'Backspace' && off === 0 && collapsed) {
    e.preventDefault();
    if (isDoc || unbullet(item)) return;
    if (len === 0) removeNode(item, el); else removeEmptyAbove(item, el) || joinAbove(item, el);
  }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mod && e.shiftKey) { e.preventDefault(); if (!isDoc) shiftNode(item, el, 'move', e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (combo === hotkeyFor('collapse')) { e.preventDefault(); setOpen(item, false); }
  else if (combo === hotkeyFor('expand')) { e.preventDefault(); setOpen(item, true); } // an empty node opens onto a draft child
  else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
  else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
  else if (e.key === 'ArrowLeft' && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
  else if (e.key === 'ArrowRight' && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
});
onRows('input', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  const item = items.get(keyOfEl(el));
  if (!canEditText(item)) return;
  // the caret was parked below the fold when the node opened: typing is the moment to scroll to it, once, and
  // "nearest" is the smallest move that shows it (and nothing at all when the row is already on screen)
  if (scrollOnType) { scrollOnType = false; el.scrollIntoView({ block: 'nearest' }); }
  const chip = chipOnly(el);
  el.classList.toggle('chiponly', chip); // typing beside the chip gives the row a caret again
  if (!item.node.draft) scheduleSave(item, readSegs(el));
  else if (!item.busy && !item.node.pendingSplit) { item.busy = true; materialise(item, el); }
  // A full reference stops being one the moment anything is typed beside its chip, and becomes one again when that
  // is deleted. Both are redrawn here, on the keystroke: waiting for the debounced save to come back left the row
  // standing in for the other node — box, tags and all — for the length of the round trip.
  const row = el.closest('.node');
  // Not mid-composition: rebuilding the row under an IME would drop what is being composed, and the flip can wait
  // the one keystroke until the composed character lands.
  if (row && !e.isComposing && !isReference(item.node) && referenceTarget(item.node) && row.classList.contains('fullref') !== chip) render(true);
  if (item.node.kind === 'block' && el.textContent === '/' && palette.hidden) openSlash(item); // "/" alone in a node is the command menu
  else if (item.node.kind === 'block' && startsList(el.textContent.slice(0, caretOffset(el) ?? 0))) rebullet(item, el); // "- " at the start of a row starts a list there
});
// A pasted Tana node link becomes the reference Tana itself inserts, not the url: the clipboard holds one node link,
// the row is a real block, and the title is read before anything is written, so a link to something unreadable
// leaves the row as it was and only shows the error. Everything else — prose around a url, another host, a broken
// id, no clipboard text — pastes the browser's way. linkTo is the same path "@" uses, so the surrounding text,
// the replaced selection and the caret behave exactly as they do there, and the url never lands as text beside it.
// ponytail: a draft row pastes as text — it has no Tana id yet, so setText has nothing to write to
onRows('paste', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el || !e.clipboardData || !tana.node) return;
  const item = items.get(keyOfEl(el));
  if (!item || item.node.kind !== 'block' || isAtomic(item.node) || isReference(item.node) || !canEditText(item)) return;
  if (item.node.draft && (item.busy || item.node.pendingSplit)) return; // already being created: the text lands in it like any other typing
  // A pasted image (#28) is uploaded and lands as an image row after this one — or, pasted into the empty draft row,
  // after the last real row, which is where that draft stands (renderer/upload.js). Not through run(): an upload
  // takes seconds and would hold every edit queued behind it.
  const files = imageFiles(e.clipboardData.files);
  if (files.length) {
    const last = item.node.draft ? childrenOf(item.parent)?.at(-1) : null;
    if (item.node.draft && item.parent.node.kind !== 'document' && !last) return; // an empty child row has no row to follow
    e.preventDefault();
    flush(item.key);
    uploadImages(item.docId, item.node.draft ? last?.id || null : item.node.id, files).catch(showError);
    return;
  }
  const uri = tanaNodeUri(e.clipboardData.getData('text/plain'));
  if (!uri) return;
  const off = caretOffset(el);
  const range = getSelection().isCollapsed ? (off == null ? null : [off, off]) : selectionOffsets(el);
  if (!range) return;
  e.preventDefault();
  flush(item.key);
  const ctx = { item, segs: readSegs(el), start: range[0], end: range[1] };
  // A draft row has no Tana id yet, so it is created first — by the same materialise the first typed character
  // uses, which is what keeps it one create — and the reference is written into the row it became. The title is
  // read before any of that, so a link that cannot be resolved creates nothing at all, and a create that fails
  // (or a draft dropped while it ran) leaves the row a draft with nothing written and its own error already shown.
  tana.node(uri).then(async (n) => {
    const mention = { label: n.title || uri, uri };
    if (!item.node.draft) return linkTo(ctx, mention);
    item.busy = true;
    await materialise(item, el);
    if (!item.node.draft) return linkTo(ctx, mention);
  }, showError).catch(showError);
});
onRows('focusout', (e) => {
  const el = e.target, item = el.classList && el.classList.contains('text') && items.get(keyOfEl(el));
  if (!item) return;
  if (!item.node.draft) flush(item.key);
  // left empty by the user: no node is created. Deferred one microtask because during focusout nothing is focused yet,
  // so the re-render would find no caret to keep; by then the row the caret moved to (Arrow keys, a click) holds it.
  else if (!rendering && !el.textContent && !item.busy && el.isConnected) queueMicrotask(() => {
    if (!rendering && !el.textContent && !item.busy && el.isConnected && document.activeElement !== el) dropDraft(item);
  });
});
onRows('mousedown', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.mention')) e.preventDefault();
  const line = e.target.closest('.line');
  // a row that is nothing but a chip or a link can only be clicked on that chip, so with a modifier held it still selects
  if (!line || e.target.closest(e.metaKey || e.shiftKey ? '.check, .bullet, .chev' : '.check, .bullet, .chev, a')) return;
  const key = line.parentElement.dataset.key;
  if (e.metaKey && line.closest?.('.tl')) return; // a Timeline row, and a task under one, opens on a click and ⌘ opens it beside (render.js), so ⌘ does not select there
  if (e.metaKey) { // Cmd+click: add or remove this row, and make it the keyboard range anchor
    e.preventDefault(); toggleSel(key);
  } else if (e.shiftKey) { // Shift+click: replace the anchored range while retaining other Cmd-selected rows
    e.preventDefault();
    const f = focused(), anchor = sel ? sel.anchor : f ? f.key : key;
    rangeSelTo(key, anchor);
  }
});
onRows('focusin', () => { // the caret is back in a node
  if (!sel) return;
  sel = null; selectionFrozen = false;
  for (const n of eachRow('.selected')) n.classList.remove('selected');
  if (renderDeferred) queueMicrotask(() => { if (!editingRow()) render(); });
});
onRows('click', (e) => {
  if (!e.target.closest) return;
  const mention = e.target.closest('.mention');
  // a modifier means "select this row", handled on mousedown; and a chip on a full-reference row is that row's own
  // title rather than a link out of it, so clicking it selects the row (its bullet is the way in)
  // a date is no document: its chip opens that day's page (the date-titled node, which lists what mentions the day)
  if (mention && !mention.closest('.fullref')) {
    e.preventDefault();
    const day = dayOfUri(mention.dataset.uri);
    const where = linkElsewhere(e, mention);
    if (where) run(async () => openElsewhere(where, day ? (await tana.todayNode(day)).id : mention.dataset.uri));
    else if (!e.metaKey && !e.shiftKey) { if (day) run(async () => goTo(await tana.todayNode(day))); else goTo(mention.dataset.uri); }
    return;
  }
  const url = e.target.closest('a.url, a.link'); // a bare URL and a link mark both open in the browser, like Tana; a link mark to a node is a reference
  if (url && tana.openExternal) {
    e.preventDefault();
    const where = /^tana:[a-z-]+:[0-9a-z]{26}$/.test(url.dataset.href) && linkElsewhere(e, url);
    if (where) run(() => openElsewhere(where, url.dataset.href));
    else if (!e.metaKey && !e.shiftKey) run(() => (url.dataset.href.startsWith('tana:') ? goToLink(url.dataset.href) : tana.openExternal(url.dataset.href)));
  }
});
// A link to a node opened somewhere else (issue #443): ⌥ as a tab, anywhere; ⌘ in a pane beside, except on a row's
// line, where a ⌘-click selects the row (mousedown above). A chat has no rows, so there ⌘ opens too.
const linkElsewhere = (e, link) => (e.altKey || !link.closest('.line') ? elsewhere(e) : null);
// A link mark whose href is a node: the new id opens directly; an old outliner id ("tana:IAFYBzLWyNMw", written by
// the importer as a link) is found through the "Outliner ID: …" line the importer leaves in the imported note, and
// falls back to the old Tana when nothing here carries it.
async function goToLink(href) {
  if (/^tana:[a-z-]+:[0-9a-z]{26}$/.test(href)) return goTo(href);
  const old = href.slice(5), hits = tana.search ? (await tana.search(old)).filter((n) => !n.related) : [];
  if (hits.length === 1) return goTo(hits[0].id);
  if (hits.length) showNote(`${hits.length} imported nodes mention ${old}`);
  else return tana.openExternal('https://app.tana.inc?nodeid=' + encodeURIComponent(old));
}

filterEl.addEventListener('input', render);
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { filterEl.value = ''; filterShown = false; render(); filterEl.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); const first = texts()[0]; if (first) setCaret(first, 0); }
});
filterEl.addEventListener('blur', () => { if (!filterEl.value) { filterShown = false; render(); } });
$('clear').onclick = () => { filterEl.value = ''; render(); filterEl.focus(); };
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey, inFilter = document.activeElement === filterEl;
  // every combo, built-in or recorded, is a palette row id (DEFAULT_HOTKEYS in state.js); ⌘K and the text-size keys stay fixed
  // (a key the focused node already answered to — ⌘↑, ⌘↩ — arrives defaultPrevented and must not run twice)
  const combo = comboOf(e), found = (mod || /^F\d{1,2}$/.test(e.key)) && !inFilter && !e.defaultPrevented ? hotkeyIds().find((id) => hotkeyFor(id) === combo) : undefined; // a function key (F6) needs no ⌘
  // ⌘C copies the current node's link, but only with nothing selected: a text selection is the browser's copy to make,
  // and taking it would break copying a few words out of a node. With no document to copy, runAction finds no row and
  // the key falls through on its own.
  const hotkey = found === 'copyLink' && !getSelection().isCollapsed ? undefined : found;
  if (mod && e.key === 'k') { e.preventDefault(); togglePalette('cmd'); }
  else if (mod && (e.key === '0' || (e.shiftKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')))) { e.preventDefault(); setZoom(e.key === '0' ? BASE_ZOOM : zoomFactor * (e.key === '-' || e.key === '_' ? 1 / 1.1 : 1.1)); }
  else if (hotkey === 'search') { e.preventDefault(); togglePalette('search'); } // also while the palette is open: it switches it to search
  else if (!palette.hidden) return;
  // The Graph pane has no outline: none of the keys below (⇧⌘⌫, the selection's, entering rows, a first draft) may act
  // on its hidden page. Only a built-in or recorded key runs, in the page it follows (runAction); its rows answer the
  // rest themselves, and an Escape with no row (renderer/rail.js).
  else if (LINKS) { if (hotkey && runAction(hotkey)) e.preventDefault(); }
  else if (sel && document.activeElement === document.body && (e.defaultPrevented || selKey(e))) e.preventDefault(); // selection keys; a Shift+Arrow already handled in the node stops here (focus is on body by now)
  else if (mod && e.shiftKey && e.key === 'Backspace' && document.activeElement === document.body && zoom) { e.preventDefault(); removeZoomedBlock(); }
  else if (hotkey) { if (runAction(hotkey)) e.preventDefault(); } // a row that is not there right now (no rail, nothing to go back to) leaves the key to the browser
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && !e.shiftKey && document.activeElement === document.body && chatArrow(e.key === 'ArrowUp')) e.preventDefault(); // a chat: its messages (renderer/chat.js)
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && document.activeElement === document.body) { // nothing focused: enter the outline
    const all = texts(), el = e.key === 'ArrowDown' ? all[0] : all.at(-1);
    if (el) { e.preventDefault(); setCaret(el, e.key === 'ArrowDown' ? 0 : el.textContent.length); }
  }
  else if (e.key === 'Enter' && !mod && document.activeElement === document.body && !zoom && viewOf() && !viewOf().nodes.length) { e.preventDefault(); draftDoc(null); } // empty view: first draft
  else if (e.key === 'Escape' && document.activeElement === document.body && filterEl.value) { filterEl.value = ''; filterShown = false; render(); }
  // Escape nothing here used (a row, the selection and the filter answer it first) backs out of one zoom level of the
  // panes, as Escape does in Trellis, which never hears a key pressed in a page (shell.js run)
  else if (e.key === 'Escape' && !e.defaultPrevented && document.activeElement === document.body && windowPanes.pages > 1) shellRun('navigation.stepOut');
});
