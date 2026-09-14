'use strict';
// Keyboard and mouse handling on the outline, the filter input and the document.

// ---- navigation ----
function moveTo(el, dir, offset) {
  const all = texts(), target = all[all.indexOf(el) + dir];
  if (!target) { if (dir < 0) focusAbove(el); return; }
  flush(keyOfEl(el));
  setCaret(target, offset);
}

// ---- events ----
outline.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  const item = items.get(keyOfEl(el)), mod = e.metaKey || e.ctrlKey;
  const off = caretOffset(el), len = el.textContent.length, collapsed = getSelection().isCollapsed;
  const isDoc = item.node.kind === 'document', combo = comboOf(e);
  if (isAtomic(item.node)) { // image or divider, not editable: Backspace / ⌘⇧⌫ removes, Up/Down step past, Shift+Up/Down select, ⌘⇧Up/Down moves; everything else is swallowed
    const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown', dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.key === 'Backspace') removeNode(item, el);
    else if (vert && e.shiftKey && mod) shiftNode(item, el, 'move', dir < 0 ? 'up' : 'down');
    else if (vert && e.shiftKey) extendSel(item, dir);
    else if (vert && !mod) moveTo(el, dir, 0);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') moveTo(el, e.key === 'ArrowLeft' ? -1 : 1, e.key === 'ArrowLeft' ? Infinity : 0);
    else if (e.key === 'Tab') shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent');
    else if (e.key === 'Escape') el.blur();
    else if (mod) return; // ⌘K / ⌘S / ⌘Z … reach the document handler
    return e.preventDefault();
  }
  if (!canEditItem(item)) {
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
    else if (e.key === ' ') { e.preventDefault(); if (isReference(item.node)) openReference(item.node); else zoomTo(item); } // Space zooms into a read-only row, since typing into it is not an option
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
    else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
    else if (e.key === 'ArrowLeft' && !mod && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
    else if (e.key === 'ArrowRight' && !mod && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
    else if (!(mod && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 's'))) e.preventDefault();
    return;
  }
  if (item.node.draft) { // empty draft: Enter/Tab do nothing, Backspace drops it (caret to the node above); typing creates it (input handler)
    if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault();
    if (e.key === 'Backspace' && len === 0) { e.preventDefault(); const all = texts(), prev = all[all.indexOf(el) - 1], k = prev && keyOfEl(prev); dropDraft(item); return k ? placeCaret(k) : focusAbove(); }
    if (e.key !== 'Escape' && !(e.key.startsWith('Arrow') && !mod)) return;
  }
  // formatting: the toolbar's toggles from the keyboard, and Tab/Escape into and out of the toolbar itself
  if (e.key === 'Escape' && !toolbarEl.hidden) { e.preventDefault(); returnToSelection(); }
  else if (e.key === 'Tab' && !e.shiftKey && !toolbarEl.hidden) { e.preventDefault(); focusToolbar(); }
  else if (mod && !e.shiftKey && MARK_KEYS[e.key.toLowerCase()]) { e.preventDefault(); toggleMarkKey(item, el, MARK_KEYS[e.key.toLowerCase()]); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); toggleMarkKey(item, el, 'strike'); }
  else if (e.key === 'Escape') { e.preventDefault(); flush(item.key); el.blur(); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); } // multi-select over siblings
  else if (e.key === '@' && !collapsed) { const range = selectionOffsets(el); if (range) { e.preventDefault(); startLink(item, el, range); } } // no selection: "@" is typed
  else if (combo === hotkeyFor('toggleDone')) { e.preventDefault(); if (isDoc) toggleDone(item); else toggleCheckbox(item); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertAtCaret(el, '\n'); }
  else if (e.key === 'Enter' && isDoc && item.parent) e.preventDefault(); // document child (inside a space): nothing to split or draft yet
  else if (e.key === 'Enter' && isDoc && !zoom && !isOpen(item)) { e.preventDefault(); draftDoc(item); } // collapsed document in a view: draft sibling document
  else if (e.key === 'Enter') { e.preventDefault(); splitNode(item, el, off ?? len); }
  else if (e.key === 'Tab') { e.preventDefault(); if (!isDoc) shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent'); }
  // a document row is the document: the same shortcut deletes it (reversibly, like the zoomed title), not just blocks
  else if (e.key === 'Backspace' && mod && e.shiftKey) { e.preventDefault(); if (isDoc) removeDocument(item); else removeNode(item, el); }
  else if (e.key === 'Backspace' && off === 0 && collapsed) { e.preventDefault(); if (!isDoc && len === 0) removeNode(item, el); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mod && e.shiftKey) { e.preventDefault(); if (!isDoc) shiftNode(item, el, 'move', e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (combo === hotkeyFor('collapse')) { e.preventDefault(); setOpen(item, false); }
  else if (combo === hotkeyFor('expand')) { e.preventDefault(); setOpen(item, true); } // an empty node opens onto a draft child
  else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
  else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
  else if (e.key === 'ArrowLeft' && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
  else if (e.key === 'ArrowRight' && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
});
outline.addEventListener('input', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  const item = items.get(keyOfEl(el));
  if (!canEditText(item)) return;
  if (!item.node.draft) scheduleSave(item, readSegs(el));
  else if (!item.busy && !item.node.pendingSplit) { item.busy = true; materialise(item, el); }
  if (item.node.kind === 'block' && el.textContent === '/' && palette.hidden) openSlash(item); // "/" alone in a node is the command menu
});
outline.addEventListener('focusout', (e) => {
  const el = e.target, item = el.classList && el.classList.contains('text') && items.get(keyOfEl(el));
  if (!item) return;
  if (!item.node.draft) flush(item.key);
  // left empty by the user: no node is created. Deferred one microtask because during focusout nothing is focused yet,
  // so the re-render would find no caret to keep; by then the row the caret moved to (Arrow keys, a click) holds it.
  else if (!rendering && !el.textContent && !item.busy && el.isConnected) queueMicrotask(() => {
    if (!rendering && !el.textContent && !item.busy && el.isConnected && document.activeElement !== el) dropDraft(item);
  });
});
outline.addEventListener('mousedown', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.mention')) e.preventDefault();
  const line = e.target.closest('.line');
  if (!line || e.target.closest('.check, .bullet, .chev, a')) return;
  const key = line.parentElement.dataset.key;
  if (e.metaKey) { // Cmd+click: add or remove this row, and make it the keyboard range anchor
    e.preventDefault(); toggleSel(key);
  } else if (e.shiftKey) { // Shift+click: replace the anchored range while retaining other Cmd-selected rows
    e.preventDefault();
    const f = focused(), anchor = sel ? sel.anchor : f ? f.key : key;
    rangeSelTo(key, anchor);
  }
});
outline.addEventListener('focusin', () => { // the caret is back in a node
  if (!sel) return;
  sel = null; selectionFrozen = false;
  for (const n of outline.querySelectorAll('.selected')) n.classList.remove('selected');
  if (renderDeferred) queueMicrotask(() => { if (!editingRow()) render(); });
});
outline.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const mention = e.target.closest('.mention');
  if (mention) { e.preventDefault(); return goTo(mention.dataset.uri); }
  const url = e.target.closest('a.url, a.link'); // a bare URL and a link mark both open in the browser, like Tana; a link mark to a node is a reference
  if (url && tana.openExternal) { e.preventDefault(); run(() => (url.dataset.href.startsWith('tana:') ? goToLink(url.dataset.href) : tana.openExternal(url.dataset.href))); }
});
// A link mark whose href is a node: the new id opens directly; an old outliner id ("tana:IAFYBzLWyNMw", written by
// the importer as a link) is found through the "Outliner ID: …" line the importer leaves in the imported note, and
// falls back to the old Tana when nothing here carries it.
async function goToLink(href) {
  if (/^tana:[a-z-]+:[0-9a-z]{26}$/.test(href)) return goTo(href);
  const old = href.slice(5), hits = tana.search ? await tana.search(old) : [];
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
  const combo = comboOf(e), hotkey = mod && !inFilter && !e.defaultPrevented ? hotkeyIds().find((id) => hotkeyFor(id) === combo) : undefined;
  if (dropDoc) { if (e.defaultPrevented) return; if (e.key === 'Escape') { e.preventDefault(); endDrop(); } else if (e.key === 'Enter') { e.preventDefault(); $('dropFile').click(); } } // (the palette's Enter that started drop mode is already handled)
  else if (mod && e.key === 'k') { e.preventDefault(); togglePalette('cmd'); }
  else if (mod && (e.key === '0' || (e.shiftKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')))) { e.preventDefault(); setZoom(e.key === '0' ? BASE_ZOOM : zoomFactor * (e.key === '-' || e.key === '_' ? 1 / 1.1 : 1.1)); }
  else if (hotkey === 'search') { e.preventDefault(); togglePalette('search'); } // also while the palette is open: it switches it to search
  else if (!palette.hidden) return;
  else if (sel && document.activeElement === document.body && (e.defaultPrevented || selKey(e))) e.preventDefault(); // selection keys; a Shift+Arrow already handled in the node stops here (focus is on body by now)
  else if (mod && e.shiftKey && e.key === 'Backspace' && document.activeElement === document.body && zoom) { e.preventDefault(); removeZoomedBlock(); }
  else if (hotkey) { if (runAction(hotkey)) e.preventDefault(); } // a row that is not there right now (no rail, nothing to go back to) leaves the key to the browser
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && document.activeElement === document.body) { // nothing focused: enter the outline
    const all = texts(), el = e.key === 'ArrowDown' ? all[0] : all.at(-1);
    if (el) { e.preventDefault(); setCaret(el, e.key === 'ArrowDown' ? 0 : el.textContent.length); }
  }
  else if (e.key === 'Enter' && !mod && document.activeElement === document.body && !zoom && viewOf() && !viewOf().nodes.length) { e.preventDefault(); draftDoc(null); } // empty view: first draft
  else if (e.key === 'Escape' && document.activeElement === document.body && filterEl.value) { filterEl.value = ''; filterShown = false; render(); }
});
