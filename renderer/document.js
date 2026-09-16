'use strict';
// The zoomed document: page title editing, pin state, sensitive marks.

// ---- page title (zoomed into a document): edits go through the same debounce as node text; Enter -> first child, Esc restores ----
titleEl.addEventListener('input', () => { const item = items.get(titleEl.dataset.key); if (!item) return; if (item.node.draft && !item.busy) { item.busy = true; materialise(item, titleEl); } else if (!item.node.draft) scheduleSave(item, [{ text: titleEl.textContent }]); });
titleEl.addEventListener('blur', () => { const item = items.get(titleEl.dataset.key); if (item?.node.draft && !item.busy && !titleEl.textContent) { zoom = null; return dropDraft(item); } flush(titleEl.dataset.key); });
titleEl.addEventListener('keydown', (e) => {
  const item = items.get(titleEl.dataset.key);
  if (!titleEl.isContentEditable || !item) return;
  if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); removeDocument(item); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleDone(item); }
  else if (e.key === 'Enter') { e.preventDefault(); flush(item.key); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); dropPending(item.key); titleEl.textContent = item.node.text; titleEl.blur(); }
  else if (e.key === 'ArrowDown' && atEdge(titleEl, 'down')) { const first = texts()[0]; if (first) { e.preventDefault(); flush(item.key); setCaret(first, 0); } }
});
// the document Cmd+K context actions apply to: the zoomed one, else the document whose node is focused
function currentDoc() {
  const f = focused(), item = f && items.get(f.key);
  const docId = zoom ? zoom.docId : item ? item.docId : null;
  const d = docId && (allDocs().find((x) => x.id === docId) || extra.get(docId));
  return d && !d.draft ? d : null;
}
// ---- pins (api.pinState / pin / unpin): what the palette needs is whether this document is pinned, not the tree ----
function loadPins() {
  const doc = palDoc;
  if (!doc || !tana.pinState) { pinInfo = null; return; }
  tana.pinState(doc.id).then((s) => {
    pinInfo = s ? { docId: doc.id, ...s } : null;
    if (!palette.hidden && palMode === 'cmd') renderPalette();
  }, showError);
}
function pinAction(op, target) { run(async () => { await tana[op](pinInfo.docId, target); loadPins(); }); }
function invalidatePinCaches(id, includeRecent = true) {
  if (pinInfo && pinInfo.docId === id) pinInfo = null;
  if (includeRecent) forgetRecent(id);
  palRows = palRows.filter((row) => row.id !== 'pinned:' + id);
}
function invalidateNode(id) {
  invalidatePinCaches(id);
  extra.delete(id); paths.delete(id); kids.delete(id); fresh.delete(id); taskMetaById.delete(id);
  for (const section of views) section.nodes = section.nodes.filter((node) => node.id !== id);
  palRows = palRows.filter((row) => row.node?.id !== id);
  if (palDoc?.id === id) { palDoc = null; pinInfo = null; }
  if (zoom?.docId === id) zoom = null;
}
function setSensitiveMark(ids, on) {
  run(async () => {
    for (const id of [ids].flat()) {
      await tana.setSensitive(id, on);
      if (on) sensitiveIds.add(id); else sensitiveIds.delete(id);
    }
    refreshSensitive();
  });
}
function toggleSensitiveVisibility() {
  sensitiveVisible = !sensitiveVisible;
  refreshSensitive();
}
