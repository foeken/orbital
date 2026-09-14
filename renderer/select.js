'use strict';
// Multi-select: an arbitrary set of rows with one anchored sibling range, and the keys that act on it.

// ---- multi-select: an arbitrary set (Cmd+click), with one anchored sibling range for Shift+Up/Down and Shift+click ----
function rangeKeys(anchor, focus) {
  const a = nodeElOf(anchor), f = nodeElOf(focus);
  if (!a || !f || a.parentElement !== f.parentElement) return f ? [focus] : [];
  const sibs = nodeEls(a).map((n) => n.dataset.key), i = sibs.indexOf(anchor), j = sibs.indexOf(focus);
  return i < 0 || j < 0 ? [] : sibs.slice(Math.min(i, j), Math.max(i, j) + 1);
}
function selKeys() { // visible selected keys in outline order; stale rows simply fall out of the set
  if (!sel) return [];
  const keys = [...items.keys()].filter((key) => sel.keys.has(key) && nodeElOf(key));
  if (!keys.length) return [];
  if (!nodeElOf(sel.anchor)) sel.anchor = keys.at(-1);
  if (!nodeElOf(sel.focus)) sel.focus = keys.at(-1);
  return keys;
}
function applySel() {
  for (const n of outline.querySelectorAll('.node.selected')) n.classList.remove('selected');
  for (const k of selKeys()) nodeElOf(k).classList.add('selected');
}
function leaveText() { const el = document.activeElement; if (el && (outline.contains(el) || el === titleEl) && (el.isContentEditable || el.classList.contains('text'))) { flush(keyOfEl(el)); el.blur(); } }
function toggleSel(key) {
  const keys = new Set(sel ? sel.keys : []);
  if (keys.has(key)) keys.delete(key); else keys.add(key);
  sel = { keys, anchor: key, focus: key };
  leaveText(); applySel();
  if (!keys.size && selectionFrozen) { selectionFrozen = false; if (renderDeferred) render(); }
}
function rangeSelTo(key, anchor) {
  if (!sel) sel = { keys: new Set([anchor]), anchor, focus: anchor };
  const extras = new Set(sel.keys);
  for (const old of rangeKeys(sel.anchor, sel.focus)) extras.delete(old);
  sel.anchor = anchor; sel.focus = key;
  sel.keys = new Set([...extras, ...rangeKeys(anchor, key)]);
  leaveText(); applySel();
}
function extendSel(item, dir) { // grow (or shrink) the range from the focus end; the caret leaves the text
  if (!sel) sel = { keys: new Set([item.key]), anchor: item.key, focus: item.key };
  const f = nodeElOf(sel.focus), next = f && nodeEls(f)[nodeEls(f).indexOf(f) + dir];
  if (next) rangeSelTo(next.dataset.key, sel.anchor);
}
function clearSel(key) { sel = null; selectionFrozen = false; render(); if (key) placeCaret(key); }
function blockSelection(keys, contiguous, action) {
  const its = keys.map((key) => items.get(key));
  const first = its[0];
  if (!first || its.some((it) => !it || it.node.kind !== 'block' || !canEditStructure(it) || it.docId !== first.docId || it.parent !== first.parent)) {
    showError(new Error(action + ' requires writable sibling blocks'));
    return null;
  }
  if (contiguous) {
    const sibs = childrenOf(first.parent) || [], indexes = its.map((it) => sibs.indexOf(it.node)).sort((a, b) => a - b);
    if (indexes.some((index, i) => index < 0 || (i && index !== indexes[i - 1] + 1))) {
      showError(new Error(action + ' requires a contiguous selection of writable sibling blocks'));
      return null;
    }
  }
  return its;
}
async function removeSel(keys) { // Cmd+Shift+Backspace: every selected block, last first; caret to the node before the range
  const all = texts().map(keyOfEl), before = all[all.indexOf(keys[0]) - 1], its = keys.map((k) => items.get(k));
  sel = null;
  for (const it of its) dropPending(it.key);
  await run(async () => { await tana.removeMany(its[0].docId, its.map((it) => it.node.id)); await reload(its[0].docId); });
  render(true);
  const k = before || texts().map(keyOfEl)[0];
  if (k) placeCaret(k); else focusAbove();
}
async function moveSel(keys, dir) { // Cmd+Shift+Up/Down: the whole range, one api.move per node in the order that keeps them adjacent; keys are node ids so the selection follows
  const its = keys.map((k) => items.get(k)), sibs = childrenOf(its[0].parent) || [];
  if (dir === 'up' ? sibs.indexOf(its[0].node) === 0 : sibs.indexOf(its.at(-1).node) === sibs.length - 1) return;
  await run(async () => { await tana.moveMany(its[0].docId, its.map((it) => it.node.id), dir); await reload(its[0].docId); });
  render(true);
}
// Tab / Shift+Tab on a selection: the whole range shifts together and stays selected (keys are node ids, which the shift keeps).
// Older preload bridges fall back to per-row calls; the current plural bridge keeps this one undo step.
async function indentSel(keys, op) {
  const its = keys.map((k) => items.get(k)), docId = its[0].docId, ids = its.map((it) => it.node.id);
  if (op === 'indent') {
    const sibs = childrenOf(its[0].parent) || [], prev = sibs[sibs.indexOf(its[0].node) - 1];
    if (!prev) return; // the range starts at the top: there is nothing to indent under
    open.set(keyFor(docId, prev), true);
  }
  const many = tana[op + 'Many'];
  await run(async () => {
    if (many) await many(docId, ids);
    else for (const id of op === 'indent' ? ids : [...ids].reverse()) await tana[op](docId, id); // outdent runs last-first, the way moveMany does, so the range keeps its order
    await reload(docId);
  });
  // a live update landing between two per-row calls sees the range half moved, and selKeys() collapses a range whose
  // rows no longer share a parent; the rows themselves moved together, so put the selection back on them
  sel = { keys: new Set(keys), anchor: keys[0], focus: keys[keys.length - 1] };
  render();
}
function selKey(e) { // keys while a selection is active (nothing focused); document nodes: delete/move ignored
  const mod = e.metaKey || e.ctrlKey, keys = selKeys();
  if (!keys.length) return false;
  const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (e.shiftKey && !mod && vert) extendSel(items.get(sel.focus), e.key === 'ArrowUp' ? -1 : 1);
  else if (e.key === 'Backspace' && (!mod || e.shiftKey)) { if (blockSelection(keys, false, 'Remove')) removeSel(keys); }
  else if (mod && e.shiftKey && vert) { if (blockSelection(keys, true, 'Move')) moveSel(keys, e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (e.key === 'Tab' && !mod) { if (blockSelection(keys, true, e.shiftKey ? 'Outdent' : 'Indent')) indentSel(keys, e.shiftKey ? 'outdent' : 'indent'); }
  else if (e.key === ' ' && !mod && keys.length === 1) { const it = items.get(keys[0]); sel = null; if (isReference(it.node)) openReference(it.node); else zoomTo(it); } // Space on one selected row zooms into it
  else if (e.key === 'Escape' || (e.key.startsWith('Arrow') && !mod)) clearSel(sel.focus);
  else return false;
  return true;
}
