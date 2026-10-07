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
  for (const n of eachRow('.node.selected')) n.classList.remove('selected', 'picked');
  // picked: a list row selected by a click on it (render.js topListRow) is ringed as a focused read-only row is, editable or not
  for (const k of selKeys()) nodeElOf(k).classList.add('selected', ...(sel.picked ? ['picked'] : []));
}
function leaveText() { const el = document.activeElement; if ((inRows(el) || el === titleEl) && (el.isContentEditable || el.classList.contains('text'))) { flush(keyOfEl(el)); el.blur(); } }
// ⌘A twice: every row of the editor the caret is in — the page's rows, or the rows of the field it is in, never
// both. A selection here is rows rather than characters, which is what ⌫, ⇧⌘↑/↓ and the Selection group in ⌘K act
// on; the browser's own select-all would take the window and leave nothing to act on.
function selectAllRows(el) {
  const keys = rowsBeside(el).map(keyOfEl).filter(Boolean);
  if (!keys.length) return false;
  sel = { keys: new Set(keys), anchor: keys[0], focus: keys.at(-1) };
  leaveText(); hideToolbar(); applySel(); // the first ⌘A's words had the toolbar up, and leaving the row fires no selectionchange to take it down
  return true;
}
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
  sel.anchor = anchor; sel.focus = key; sel.picked = false; // a range is drawn as a band, the clicked row's ring with it
  sel.keys = new Set([...extras, ...rangeKeys(anchor, key)]);
  leaveText(); applySel();
}
function extendSel(item, dir) { // grow (or shrink) the range from the focus end; the caret leaves the text
  if (!sel) sel = { keys: new Set([item.key]), anchor: item.key, focus: item.key };
  // ⇧↓ back on a parent ⇧↑ climbed to: the selection it climbed from comes back, as shrinking a range does
  if (dir > 0 && sel.below && sel.anchor === sel.focus) { sel = sel.below; leaveText(); return applySel(); }
  const f = nodeElOf(sel.focus), next = f && nodeEls(f)[nodeEls(f).indexOf(f) + dir];
  if (next) return rangeSelTo(next.dataset.key, sel.anchor);
  // past the first sibling ⇧↑ takes the parent row, which holds them all; with nothing further the row itself is selected
  const parent = dir < 0 && items.get(sel.focus)?.parent;
  if (parent && nodeElOf(parent.key)) { const below = { ...sel, keys: new Set(sel.keys) }; rangeSelTo(parent.key, parent.key); sel.below = below; }
  else rangeSelTo(sel.focus, sel.anchor);
}
function clearSel(key) { sel = null; selectionFrozen = false; render(); if (key) placeCaret(key); }
// What going into a selected row opens (a second click on it, Space, ↩ on one that cannot be typed in): the node a
// Timeline row is about, a task listed under one as itself (its row there is a read-only copy), a reference's target,
// else the row's own page. The selection is let go and its ring taken off first: not every open leaves this page (a
// canvas opens a window, a Timeline row about something with no page here opens in Tana, a place open in another pane
// comes forward there), and one that does not would leave a ring drawn around a selection nothing acts on any more.
function openSelectedRow(item) {
  sel = null; selectionFrozen = false; applySel();
  if (item.node.timeline) return openTimeline(item.node);
  if (item.parent?.node?.timeline) return goTo(item.node.id);
  if (referenceTarget(item.node)) return openReference(item.node);
  if (zoomable(item.node)) zoomTo(item);
}
// Moving, indenting and outdenting carry the rows as one block, so they need siblings, and a contiguous run of
// them. Removing does not: a selection to delete is a set of rows, whatever levels they sit on (sdk/content.js
// removeMany takes any of them, a row inside another going with the row that holds it). Requiring siblings there
// refused an ordinary \u2318A \u2192 \u232b outright.
function blockSelection(keys, contiguous, action, siblings = true) {
  const its = keys.map((key) => items.get(key));
  const first = its[0];
  if (!first || its.some((it) => !it || it.node.kind !== 'block' || !canEditStructure(it) || it.docId !== first.docId || (siblings && it.parent !== first.parent))) {
    showError(new Error(action + (siblings ? ' requires writable sibling blocks' : ' requires writable blocks of one document')));
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
  for (const it of its) closeIfEmpty(it.parent); // a selection can empty more than one node
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
// ⌘↩ on a selection of rows: every one takes the same checkbox step, no box → empty → ticked → no box (renderer/edit.js
// cycleCheckboxes), in one write, and the rows stay selected for the next press
async function cycleSel(keys) {
  const its = keys.map((k) => items.get(k));
  if (!its.some(checkable)) return showError(new Error('Checkboxes require writable text rows'));
  const kept = { keys: new Set(sel.keys), anchor: sel.anchor, focus: sel.focus };
  await cycleCheckboxes(its);
  sel = kept;
  render();
}
function selKey(e) { // keys while a selection is active (nothing focused); document nodes: delete/move ignored
  const mod = e.metaKey || e.ctrlKey, keys = selKeys();
  if (!keys.length) return false;
  const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (e.shiftKey && !mod && vert) extendSel(items.get(sel.focus), e.key === 'ArrowUp' ? -1 : 1);
  else if (e.key === 'Backspace' && (!mod || e.shiftKey)) { if (blockSelection(keys, false, 'Remove', false)) removeSel(keys); }
  else if (mod && e.shiftKey && vert) { if (blockSelection(keys, true, 'Move')) moveSel(keys, e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (e.key === 'Tab' && !mod) { if (blockSelection(keys, true, e.shiftKey ? 'Outdent' : 'Indent')) indentSel(keys, e.shiftKey ? 'outdent' : 'indent'); }
  else if (e.key === ' ' && !mod && keys.length === 1) openSelectedRow(items.get(keys[0])); // Space on one selected row zooms into it, or opens what it references or is about
  else if (e.key === 'Enter' && !mod && keys.length === 1 && canEditText(items.get(keys[0])) && !timelineRow(items.get(keys[0])) && (!topListRow(items.get(keys[0])) || typesInto(items.get(keys[0])))) clearSel(keys[0]); // Enter starts editing the selected row, caret at the end — the way a second click on it does
  else if (e.key === 'Enter' && !mod && keys.length === 1 && (topListRow(items.get(keys[0])) || timelineRow(items.get(keys[0])))) openSelectedRow(items.get(keys[0])); // a list or Timeline row that cannot be typed in: Enter goes in, as a second click on it does
  else if (comboOf(e) === hotkeyFor('toggleDone') && keys.every((k) => items.get(k)?.node.kind === 'block')) cycleSel(keys); // a selection of tasks leaves ⌘↩ to its own row (renderer/tasks.js)
  // ⌘C: the rows as text to paste elsewhere; a Timeline row has no text of its own, so there ⌘C stays Copy link
  else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && !keys.some((k) => timelineRow(items.get(k)))) copyText(selectionMarkdown(keys), keys.length === 1 ? 'Row copied' : keys.length + ' rows copied').catch(showError);
  else if (e.key === 'Escape' || (e.key.startsWith('Arrow') && !mod)) clearSel(sel.focus);
  else return false;
  return true;
}
// One row's words as markdown: the marks around the words they cover (spaces outside, or the markdown breaks), a
// mention as [label](uri), the form a paste reads back as a mention (renderer/edit.js pasteMarkdown, sdk/chat.js).
// ponytail: a literal * or ` in the words is not escaped; add it when a copy pastes back with a stray mark.
function inlineMarkdown(segs) {
  return segs.map((s) => {
    if ('mention' in s) return '[' + s.mention.label + '](' + s.mention.uri + ')';
    const m = s.marks || {}, [, lead, core, trail] = s.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (!core) return s.text;
    let t = m.code ? '`' + core + '`' : core;
    for (const [mark, d] of [['italic', '*'], ['bold', '**'], ['strike', '~~']]) if (m[mark]) t = d + t + d;
    return lead + (m.link ? '[' + t + '](' + m.link + ')' : t) + trail;
  }).join('');
}
// The selected rows as markdown, each with the rows open under it, as they are drawn: a child indented to its
// parent's words (a numbered parent's are wider than a bullet's), so the list nests wherever it is pasted.
function selectionMarkdown(keys) {
  const picked = new Set(keys), pads = new Map(), count = new Map(), lines = [];
  for (const item of items.values()) {
    let top = null;
    for (let p = item; p; p = p.parent) if (picked.has(p.key)) top = p;
    if (!top || !nodeElOf(item.key)) continue;
    const node = item.node, type = blockTypeOf(node), parent = item === top ? null : item.parent.key;
    const pad = parent ? pads.get(parent) ?? '' : '', n = type === 'numbered' ? (count.get(parent) || 0) + 1 : 0;
    count.set(parent, n);
    if (type === 'code') { lines.push(pad + '```', ...plainOf(node).split('\n').map((l) => pad + l), pad + '```'); continue; }
    if (isDivider(node)) { lines.push(pad + '---'); continue; }
    const mark = node.done != null || isTask(node) ? (node.done ? '- [x] ' : '- [ ] ') : n ? n + '. ' : type === 'bullet' ? '- '
      : type === 'quote' ? '> ' : headingOf(node) ? '#'.repeat(headingOf(node)) + ' ' : '';
    const inner = pad + ' '.repeat(n ? mark.length : 2);
    pads.set(item.key, inner);
    lines.push(pad + mark + inlineMarkdown(segsOf(node)).replace(/\n/g, '\n' + inner));
  }
  return lines.join('\n');
}
