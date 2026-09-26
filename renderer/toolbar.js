'use strict';
// @ linking, the floating selection toolbar (marks and block styles) and the "/" menu.

// ---- @ linking: replace the selection with a mention chosen (or created) in the search palette ----
// document titles are plain strings in Tana: there the picked item's title goes in as text (setTitle), no mention segment
// copy to the clipboard and say so where errors already appear, since a copy has no other visible result
// A notice ("Link copied", "Classified as …") is a toast at the foot of the window that fades on its own. The line
// under the title is for errors only: it holds the relogin button, which writing a notice into it used to wipe out
// (#123), and with it the #errorText every later showError needs.
let toastTimer = null;
function showNote(note) {
  const el = $('toast');
  el.textContent = note; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2500); // a newer notice gets its own 2.5 s
}
async function copyText(text, note) { await navigator.clipboard.writeText(text); showNote(note); }
function startLink(item, el, [start, end]) {
  // A row still being written into Tana has no block id yet (materialise), so there is nothing to link into: the "@"
  // stays a character, which is what typing one into a brand-new row otherwise tried to save under no id at all.
  if (item.node.kind === 'block' && (item.node.draft || item.busy || typeof item.node.id !== 'string' || !item.node.id)) { insertAtCaret(el, '@'); return; }
  flush(item.key);
  const segs = readSegs(el);
  // where the dropdown hangs: under the selection (or caret), at its left edge; an empty row has no text box, so the row's own box
  const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null, rects = range ? range.getClientRects() : [];
  const box = el.getBoundingClientRect(), rect = rects.length ? { left: rects[0].left, top: rects[0].top, bottom: rects[rects.length - 1].bottom } : box;
  togglePalette('search', { item, segs, start, end, text: plainOf(segs).slice(start, end), rect });
}
async function linkTo(ctx, mention) {
  const { item, segs, start, end } = ctx;
  const isDoc = item.node.kind === 'document';
  const next = [...splitSegs(segs, start)[0], isDoc ? { text: mention.label } : { mention }, ...splitSegs(segs, end)[1]];
  item.node.text = plainOf(next); item.node.segments = isDoc ? undefined : next;
  await run(async () => { if (isDoc) await tana.setTitle(item.docId, item.node.text); else { await tana.setText(item.docId, item.node.id, next); await reload(item.docId); } });
  render(true); // the caret is back in the row by now, and a plain render would wait for it to leave
  placeCaret(item.key, start + mention.label.length);
}
function createAndLink(ctx, title = ctx.text) {
  tana.createDocument(title).then((n) => { extra.set(n.id, { ...n, text: n.title || '', hasChildren: true }); return linkTo(ctx, { label: n.title, uri: n.id, ...(n.icon ? { icon: n.icon } : {}) }); }, showError);
}
function cancelLink() { const c = linkCtx; linkCtx = null; if (c) placeCaret(c.item.key, c.end); }

// ---- selection toolbar: marks and block styles for the current selection, like Tana's floating toolbar ----
// Keyboard first: ⌘B / ⌘I / ⇧⌘S / ⌘E toggle the marks, "@" links, Tab moves into the toolbar (Left/Right between
// buttons, Down opens the style menu, Enter runs, Escape hands the caret back with the selection still there).
const toolbarEl = $('toolbar');
const MARK_KEYS = { b: 'bold', i: 'italic', e: 'code' };
const TOOL_MARKS = [['bold', 'B', 'b', 'Bold ⌘B'], ['italic', 'I', 'i', 'Italic ⌘I'], ['strike', 'S', 's', 'Strikethrough ⇧⌘S'], ['code', '', 'c', 'Code ⌘E']];
let toolCtx = null;       // { key, start, end }: the selection every toolbar action applies to
let toolMenu = null;      // open style dropdown: { index }
let toolDismissed = null; // the selection Escape dismissed; it comes back when the selection changes
const toolItem = () => (toolCtx ? items.get(toolCtx.key) : null);
const toolSegs = () => { const el = toolCtx && textEl(toolCtx.key); return el ? readSegs(el) : []; };
const sameRange = (a, b) => !!a && !!b && a.key === b.key && a.start === b.start && a.end === b.end;
function hideToolbar(dismiss) { toolbarEl.hidden = true; toolMenu = null; toolDismissed = dismiss ? toolCtx : null; }
function updateToolbar() {
  if (!toolbarEl.hidden && toolbarEl.contains(document.activeElement)) return; // the toolbar has the keyboard: leave it alone
  const el = document.activeElement;
  const item = el && el.classList && el.classList.contains('text') && inRows(el) ? items.get(keyOfEl(el)) : null;
  const range = item && canEditText(item) && item.node.kind === 'block' && !isAtomic(item.node) ? selectionOffsets(el) : null;
  if (!range) return hideToolbar();
  const next = { key: item.key, start: range[0], end: range[1] };
  if (sameRange(toolDismissed, next)) return;
  toolDismissed = null; toolCtx = next;
  renderToolbar();
}
document.addEventListener('selectionchange', updateToolbar);
function renderToolbar() {
  const item = toolItem();
  if (!item) return hideToolbar();
  const segs = toolSegs();
  toolbarEl.replaceChildren();
  const style = document.createElement('button');
  style.type = 'button'; style.className = 'tbtn style' + (toolMenu ? ' open' : ''); style.dataset.id = 'style';
  style.title = 'Text style'; style.append(BLOCK_LABEL.get(blockTypeOf(item.node)) || 'Text');
  const caret = document.createElement('span'); caret.className = 'tcaret'; caret.innerHTML = CHEV; style.append(caret);
  style.onclick = toggleStyleMenu;
  toolbarEl.append(style);
  if (toolMenu) style.append(styleMenuEl(item));
  for (const [mark, label, cls, title] of TOOL_MARKS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = mark; b.title = title;
    if (label) b.textContent = label; else b.innerHTML = iconSvg('code'); // code uses the icon, the rest are letters
    b.className = 'tbtn ' + cls + (hasMark(segs, toolCtx.start, toolCtx.end, mark) ? ' on' : '');
    b.setAttribute('aria-pressed', String(b.className.includes(' on')));
    b.onclick = () => applyMark(mark);
    toolbarEl.append(b);
  }
  const at = document.createElement('button');
  at.type = 'button'; at.className = 'tbtn at'; at.dataset.id = 'link'; at.title = 'Link to a document (@)'; at.textContent = '@';
  at.onclick = linkSelection;
  toolbarEl.append(at);
  toolbarEl.hidden = false;
  placeToolbar();
}
// Where the style menu opens and how tall it may be, from the room on each side of its button and the height it
// wants. It stays under the button while it fits there, flips above when that side is roomier, and is capped to
// the side it uses — a menu capped to the window instead would hang off the bottom edge with rows that scrolling
// cannot reach, which is exactly what it used to do near the end of a page.
function menuFit(below, above, want) {
  const up = below < want && above > below;
  return { up, maxHeight: Math.max(96, Math.min(400, up ? above : below)) };
}
function fitMenu() {
  const menu = toolbarEl.querySelector('.menu'), button = menu && menu.parentElement;
  if (!menu || !button.getBoundingClientRect) return;
  const r = button.getBoundingClientRect();
  const { up, maxHeight } = menuFit(innerHeight - r.bottom - 14, r.top - 14, menu.scrollHeight + 8);
  menu.classList.toggle('up', up);
  menu.style.maxHeight = maxHeight + 'px';
  menu.querySelector('.mrow.active')?.scrollIntoView({ block: 'nearest' }); // arrowing past the fold brings the row with it
}
function placeToolbar() {
  const sel = getSelection();
  if (!sel.rangeCount || !toolbarEl.getBoundingClientRect) return;
  const rects = sel.getRangeAt(0).getClientRects(), r = rects[0] || sel.getRangeAt(0).getBoundingClientRect();
  if (!r) return;
  const width = toolbarEl.getBoundingClientRect().width || 280;
  toolbarEl.style.left = Math.max(8, Math.min(innerWidth - width - 8, r.left)) + 'px';
  toolbarEl.style.top = Math.max(8, r.top - 44) + 'px';
  fitMenu();
}
// The one type a row can be refused: plain text for a child node (sdk/content.js atRoot).
const blockedType = (item, type) => type === 'paragraph' && nestedRow(item);
function styleMenuEl(item) {
  const el = document.createElement('div'); el.className = 'menu';
  BLOCK_TYPES.forEach(([type, label], i) => {
    const row = document.createElement('div'); row.className = 'mrow' + (i === toolMenu.index ? ' active' : '');
    const icon = document.createElement('span'); icon.className = 'micon'; icon.innerHTML = glyphSvg(type);
    const text = document.createElement('span'); text.className = 'mlabel'; text.textContent = label;
    row.append(icon, text);
    if (blockTypeOf(item.node) === type) { const tick = document.createElement('span'); tick.className = 'tick'; tick.textContent = '✓'; row.append(tick); }
    // Text is not offered to a child node: its place in Tana is inside its parent's listItem, which cannot hold a
    // bare paragraph. The row stays in the menu, greyed, so the list does not shift under the keyboard.
    if (blockedType(item, type)) row.classList.add('disabled');
    else row.onclick = () => applyBlockType(type);
    el.append(row);
  });
  return el;
}
function focusToolbar() { const b = toolbarEl.querySelector('.tbtn'); if (b) b.focus(); }
function toggleStyleMenu() {
  const item = toolItem();
  const at = item ? BLOCK_TYPES.findIndex(([type]) => type === blockTypeOf(item.node)) : 0;
  toolMenu = toolMenu ? null : { index: Math.max(0, at) };
  renderToolbar(); focusToolbar();
}
// the caret goes back where it was, selection intact, so Escape never costs the user their selection
function returnToSelection() { const ctx = toolCtx; hideToolbar(true); if (ctx) selectRange(ctx.key, ctx.start, ctx.end); }
toolbarEl.addEventListener('mousedown', (e) => e.preventDefault()); // clicking a button must not drop the selection it acts on
toolbarEl.addEventListener('keydown', (e) => {
  const buttons = [...toolbarEl.querySelectorAll('.tbtn')], i = Math.max(0, buttons.indexOf(document.activeElement));
  if (toolMenu) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); toolMenu.index = (toolMenu.index + (e.key === 'ArrowDown' ? 1 : BLOCK_TYPES.length - 1)) % BLOCK_TYPES.length; renderToolbar(); focusToolbar(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const type = BLOCK_TYPES[toolMenu.index][0]; if (!blockedType(toolItem(), type)) applyBlockType(type); }
    else if (e.key === 'Escape') { e.preventDefault(); toolMenu = null; renderToolbar(); focusToolbar(); }
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]; if (next) next.focus(); }
  else if (e.key === 'ArrowDown' && buttons[i] && buttons[i].dataset.id === 'style') { e.preventDefault(); toggleStyleMenu(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (buttons[i]) buttons[i].click(); }
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); returnToSelection(); }
});
// a mark toggle re-sends the whole block with the marks split at the selection (the renderer never computes Loro offsets)
async function applyMark(mark, value) {
  const ctx = toolCtx, item = toolItem(), el = ctx && textEl(ctx.key);
  if (!ctx || !item || !el || item.node.kind !== 'block' || !canEditText(item)) return;
  dropPending(ctx.key);
  const segs = readSegs(el);
  const next = markRange(segs, ctx.start, ctx.end, mark, value === undefined ? (hasMark(segs, ctx.start, ctx.end, mark) ? null : true) : value);
  item.node.text = plainOf(next); item.node.segments = next;
  renderSegs(el, next); // the mark shows before the round trip finishes
  await run(() => tana.setText(item.docId, item.node.id, saveValue(next)));
  render(true);
  selectRange(ctx.key, ctx.start, ctx.end);
}
function toggleMarkKey(item, el, mark) {
  const range = selectionOffsets(el);
  if (!range) return; // no selection: nothing to mark (and the browser's own bold never runs)
  toolCtx = { key: item.key, start: range[0], end: range[1] };
  applyMark(mark);
}
async function applyBlockType(type) {
  const ctx = toolCtx, item = toolItem();
  toolMenu = null;
  if (!item || item.node.kind !== 'block' || !tana.setBlockType) return renderToolbar();
  flush(item.key);
  await run(async () => { await tana.setBlockType(item.docId, item.node.id, type); await reload(item.docId); });
  render(true);
  if (ctx) selectRange(ctx.key, ctx.start, ctx.end);
}
// Backspace at the start of a row takes its bullet off instead of deleting the row: the outliner is the default
// mode, so plain text is what is left when the bullet goes. (Tana works the other way round — a row is plain text
// until "- " starts a list.) Pressing it again on the plain row removes it, as it always did.
// ponytail: a row with children keeps its bullet, because a plain paragraph cannot own an outline in Tana's schema
// and setBlockType would outdent them; "/" -> Text still converts one by hand.
function unbullet(item) {
  if (!item || item.node.kind !== 'block' || item.node.draft || !tana.setBlockType || !canEditItem(item)) return false;
  if (nestedRow(item)) return false; // a child node cannot be plain text, so Backspace leaves its bullet alone

  if (!['bullet', 'numbered'].includes(blockTypeOf(item.node))) return false;
  if (hasKids(item) || item.node.hasChildren) return false;
  const { docId, node, key } = item;
  flush(key);
  run(async () => { await tana.setBlockType(docId, node.id, 'paragraph'); await reload(docId); render(true); placeCaret(key, 0); });
  return true;
}
// The other direction, from the keyboard: "- " typed at the start of a row with no marker starts a list there, the
// way Tana starts one, so the two modes are reversible without leaving the row. The dash is the command, not text,
// so it is dropped and whatever else the row holds stays — typing it in front of a line that is already written
// bullets that line. It has to be typed there: a dash further in, a pasted list and a sentence containing one all
// arrive without the caret sitting just past a leading dash (startsList, renderer/segments.js). A code block is
// content, not prose: "- " there stays "- ".
function rebullet(item, el, indent = false) {
  if (!item || item.node.kind !== 'block' || item.node.draft || !tana.setBlockType || !canEditItem(item)) return false;
  const type = blockTypeOf(item.node);
  if (type === 'code' || ['bullet', 'numbered'].includes(type)) return false;
  const { docId, node, key } = item;
  dropPending(key); // the "- " is never written: the pending save for it goes with it
  const rest = el ? listRest(readSegs(el), caretOffset(el)) : []; // everything but the marker just typed
  node.segments = rest; node.text = plainOf(rest);
  run(async () => {
    await tana.setText(docId, node.id, rest.length ? saveValue(rest) : []);
    await tana.setBlockType(docId, node.id, 'bullet');
    if (indent) await tana.indent(docId, node.id); // under the list row above, which Tab means everywhere else
    await reload(docId); render(true); placeCaret(key, 0);
  });
  return true;
}
// Tab on a plain line: it becomes a bullet, and when the row above is already a list row the new bullet joins it
// as its child, which is what Tab does to any other row. A plain line above owns nothing — a paragraph cannot
// hold an outline in Tana's schema — so the line becomes a bullet and stays where it is rather than turning the
// row above into a parent.
function bulletOrIndent(item, el) {
  if (!item || item.node.kind !== 'block') return false;
  const siblings = childrenOf(item.parent) || [];
  const above = siblings[siblings.indexOf(item.node) - 1];
  const under = !!above && ['bullet', 'numbered'].includes(blockTypeOf(above));
  if (under) open.set(keyFor(item.docId, above), true); // it is about to have a child: show it
  return rebullet(item, el, under);
}
function linkSelection() { // the @ button runs the same linking flow as typing "@" over a selection
  const ctx = toolCtx, item = toolItem(), el = ctx && textEl(ctx.key);
  hideToolbar();
  if (item && el) startLink(item, el, [ctx.start, ctx.end]);
}

// ---- "/" at the start of an empty node: block types, a divider, a table, an image, then what api.creationOptions offers ----
let slashCtx = null; // { key } the node holding the "/"; kept until another palette mode opens
function slashTarget() { return slashCtx ? items.get(slashCtx.key) : null; }
function openSlash(item) {
  slashCtx = { key: item.key };
  togglePalette('slash');
  loadCreationChoices();
}
function slashRows(q) {
  const rows = [...BLOCK_TYPES.filter(([type]) => type !== 'paragraph'), ['divider', 'Divider'], ['table', 'Table'], ['image', 'Image']].map(([type, label]) => ({
    group: 'Blocks', svg: glyphSvg(type), label,
    disabled: type === 'divider' ? !tana.insertDivider : type === 'image' ? !tana.insertImage : type === 'table' ? !tana.insertTable : !tana.setBlockType,
    run: () => (type === 'image' ? pickImages() : runSlashBlock(type)),
  }));
  // Doc and Task are always offered; the workspace types come from the same source as the Cmd+K "Create new …" list
  const choices = creationChoices.some((c) => c.kind === 'doc') ? creationChoices : [{ kind: 'doc', title: 'Doc', icon: 'doc', selectable: true }, ...creationChoices];
  for (const choice of choices) rows.push({
    group: choice.kind === 'custom' ? 'Workspace types' : 'Create', icon: choice.icon,
    label: 'Create ' + choice.title, hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable,
    run: () => createFromSlash(choice),
  });
  if (palBusy) rows.push({ group: 'Create', label: 'Loading choices…', disabled: true });
  return rows.filter((r) => fuzzyMatch(r.label, q) || (r.label === 'Image' && /^(pic|pho|upl)/.test(q))); // Image: also picture, photo, upload
}
// "/" Image: the native file dialog, images only, several at once. The "/" row is left as it was until files are
// picked (Esc in the dialog changes nothing), then it empties and the images land behind it, as Divider does.
function pickImages() {
  const item = slashTarget();
  if (!item || item.node.kind !== 'block') return;
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.accept = 'image/*,.heic,.heif';
  input.onchange = () => {
    const files = imageFiles(input.files);
    if (!files.length) return;
    dropPending(item.key);
    item.node.text = ''; item.node.segments = [];
    run(() => tana.setText(item.docId, item.node.id, [])).then(() => uploadImages(item.docId, item.node.id, files)).catch(showError);
  };
  input.click();
}
async function runSlashBlock(type) {
  const item = slashTarget();
  if (!item || item.node.kind !== 'block') return;
  dropPending(item.key);
  const { docId, node } = item;
  // A table takes the place of the "/" row, as Tana's does, unless that row holds rows of its own
  const bare = !node.hasChildren && !node.children?.length;
  let cell = null;
  await run(async () => {
    await tana.setText(docId, node.id, []); // the "/" was the command, not text
    if (type === 'divider') await tana.insertDivider(docId, node.id);
    else if (type === 'table') { cell = await tana.insertTable(docId, node.id); if (bare) await tana.remove(docId, node.id); }
    else await tana.setBlockType(docId, node.id, type);
    await reload(docId);
  });
  node.text = ''; node.segments = [];
  render();
  const el = cell && queryRow('.cell[data-cell="' + CSS.escape(cell) + '"]');
  if (el) setCaret(el, 0); else placeCaret(item.key, 0);
}
function createFromSlash(choice) {
  const item = slashTarget();
  if (item && item.node.kind === 'block') {
    dropPending(item.key);
    item.node.text = ''; item.node.segments = [];
    run(() => tana.setText(item.docId, item.node.id, []));
  }
  startCreation(choice);
}
