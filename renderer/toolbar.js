'use strict';
// @ linking, the floating selection toolbar (marks and block styles) and the "/" menu.

// ---- @ linking: replace the selection with a mention chosen (or created) in the search palette ----
// document titles are plain strings in Tana: there the picked item's title goes in as text (setTitle), no mention segment
// copy to the clipboard and say so where errors already appear, since a copy has no other visible result
async function copyText(text, note) { await navigator.clipboard.writeText(text); showNote(note); }
function startLink(item, el, [start, end]) {
  // A row still being written into Tana has no block id yet (materialise), so there is nothing to link into: the "@"
  // stays a character, which is what typing one into a brand-new row otherwise tried to save under no id at all.
  if (item.node.kind === 'block' && (item.node.draft || item.busy || typeof item.node.id !== 'string' || !item.node.id)) { insertAtCaret(el, '@'); return; }
  // At a caret the "@" is typed first, as any key is: it stays if the search is let go of, and a pick replaces it
  // (linkTo writes the mention over start..end). A selection is linked as it is, with no "@".
  const at = start === end;
  if (at) { insertAtCaret(el, '@'); end = start + 1; }
  flush(item.key);
  const segs = readSegs(el);
  // where the dropdown hangs: under the selection (or caret), at its left edge; an empty row has no text box, so the row's own box
  const range = getSelection().rangeCount ? getSelection().getRangeAt(0) : null, rects = range ? range.getClientRects() : [];
  const box = el.getBoundingClientRect(), rect = rects.length ? { left: rects[0].left, top: rects[0].top, bottom: rects[rects.length - 1].bottom } : box;
  togglePalette('search', { item, segs, start, end, at, text: at ? '' : plainOf(segs).slice(start, end), rect });
}
async function linkTo(ctx, mention, failed) { // failed(error, linked): the write of linked did not land, told to a caller that has to answer for it ("/" Meeting)
  if (ctx.composer) return chatMention(mention); // "@" in a chat's composer (renderer/chat.js)
  const { item, segs, start, end } = ctx;
  const isDoc = item.node.kind === 'document';
  const next = [...splitSegs(segs, start)[0], isDoc ? { text: mention.label } : { mention }, ...splitSegs(segs, end)[1]];
  item.node.text = plainOf(next); item.node.segments = isDoc ? undefined : next;
  let error = null;
  await run(async () => { try { if (isDoc) await tana.setTitle(item.docId, item.node.text); else { await tana.setText(item.docId, item.node.id, next); await reload(item.docId); } } catch (e) { error = e; throw e; } });
  if (error && failed) return failed(error, next);
  render(true); // the caret is back in the row by now, and a plain render would wait for it to leave
  placeCaret(item.key, start + mention.label.length);
  popMention(item.key, mention.uri); // the chip just made lights up
}
function createAndLink(ctx, title = ctx.text) {
  tana.createDocument(title).then((n) => { extra.set(n.id, { ...n, text: n.title || '', hasChildren: true }); return linkTo(ctx, { label: n.title, uri: n.id, ...(n.icon ? { icon: n.icon } : {}) }); }, showError);
}
// Escape (palette.js) sets typed: what was typed into the search goes in after the "@" already there, to type on
// normally. A selection that "@" was going to link stays as it was.
function cancelLink() {
  const c = linkCtx; linkCtx = null;
  if (!c) return;
  if (c.composer) {
    composerText.focus();
    if (c.typed && composerAt) { composerAt.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(composerAt); } // after the "@", which the range holds for a pick to replace
  } else placeCaret(c.item.key, c.end);
  if (c.typed && (c.composer || c.at)) document.execCommand('insertText', false, c.typed); // fires 'input', so it saves as typing does
}

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
  const oldMenu = toolbarEl.querySelector('.menu:not(.out)');
  toolbarEl.replaceChildren();
  const style = document.createElement('button');
  style.type = 'button'; style.className = 'tbtn style' + (toolMenu ? ' open' : ''); style.dataset.id = 'style';
  style.title = 'Text style'; style.append(BLOCK_LABEL.get(blockTypeOf(item.node)) || 'Text');
  const caret = document.createElement('span'); caret.className = 'tcaret'; caret.innerHTML = CHEV; style.append(caret);
  style.onclick = toggleStyleMenu;
  toolbarEl.append(style);
  if (toolMenu) style.append(styleMenuEl(item));
  menuMotion(oldMenu, toolMenu ? style.querySelector('.menu') : null, style);
  for (const [mark, label, cls, title] of TOOL_MARKS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = mark; b.title = title;
    if (label) b.textContent = label; else addIcon(b, 'code'); // code uses the icon, the rest are letters
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
  el.dataset.for = 'style';
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
// content, not prose: "- " there stays "- ". A numbered row takes it too and becomes a bullet, the way "1. " turns a
// bullet numbered (restyle); a bullet row types it as text.
function rebullet(item, el, indent = false) {
  if (!item || item.node.kind !== 'block' || item.node.draft || !tana.setBlockType || !canEditItem(item)) return false;
  const type = blockTypeOf(item.node);
  if (type === 'code' || type === 'bullet') return false;
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
  if (['bullet', 'numbered'].includes(blockTypeOf(item.node))) return false; // a list row: Tab is the indent it always was
  const siblings = childrenOf(item.parent) || [];
  const above = siblings[siblings.indexOf(item.node) - 1];
  const under = !!above && ['bullet', 'numbered'].includes(blockTypeOf(above));
  if (under) open.set(keyFor(item.docId, above), true); // it is about to have a child: show it
  return rebullet(item, el, under);
}
// The rest of markdown's line starts (#598, lineMarker), typed at the very start of a row the way "- " is: "# " to
// "### " a heading, "1. " numbered, "> " a quote, "```" code, "[] " a checkbox, and "---" on a row with nothing
// else a divider after it, as "/" Divider makes one. The marker is the command, so it goes and the rest of the row
// stays. A code block keeps what is typed in it, and a row already of that kind keeps the marker as text.
function restyle(item, el) {
  const type = lineMarker(el.textContent.slice(0, caretOffset(el) ?? 0));
  if (!type || item.node.draft || !canEditItem(item) || !tana.setBlockType || !tana.toggleCheckbox || !tana.insertDivider) return false;
  const { docId, node, key } = item, now = blockTypeOf(node), rest = listRest(readSegs(el), caretOffset(el));
  if (now === 'code' || now === type || (type === 'todo' && node.done != null) || (type === 'divider' && (rest.length || hasKids(item)))) return false;
  dropPending(key);
  node.segments = rest; node.text = plainOf(rest);
  run(async () => {
    await tana.setText(docId, node.id, rest.length ? saveValue(rest) : []);
    if (type === 'todo') await tana.toggleCheckbox(docId, node.id);
    else if (type === 'divider') await tana.insertDivider(docId, node.id);
    else await tana.setBlockType(docId, node.id, type);
    await reload(docId); render(true); placeCaret(key, 0);
  });
  return true;
}
// Inline markdown as it is typed (#598, typedMark): the mark replaces its delimiters the moment the closing one lands.
// The caret goes just past the marked words and outside them, in a caret anchor readSegs drops, so what is typed next
// is plain, as Tana's marks do not extend (sdk/content.js MARKS). Saved like any other keystroke.
function markTyped(item, el) {
  const off = caretOffset(el), next = off == null || item.node.draft || blockTypeOf(item.node) === 'code' ? null : typedMark(readSegs(el), off);
  if (!next) return false;
  item.node.text = plainOf(next.segs); item.node.segments = next.segs;
  renderSegs(el, next.segs);
  let [at] = textPoint(el, next.caret);
  while (at !== el && at.parentNode !== el) at = at.parentNode;
  const anchor = document.createTextNode(CARET_ANCHOR), r = document.createRange();
  if (at === el) el.append(anchor); else at.after(anchor);
  r.setStart(anchor, 1); r.collapse(true);
  getSelection().removeAllRanges(); getSelection().addRange(r);
  scheduleSave(item, next.segs);
  return true;
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
  const types = BLOCK_TYPES.filter(([type]) => type !== 'paragraph'), lists = types.findIndex(([type]) => type === 'numbered') + 1;
  const rows = [...types.slice(0, lists), ['checklist', 'Checklist'], ...types.slice(lists), ['divider', 'Divider'], ['table', 'Table'], ['image', 'Image']].map(([type, label]) => ({
    group: 'Blocks', svg: glyphSvg(type), label,
    disabled: type === 'divider' ? !tana.insertDivider : type === 'image' ? !tana.insertImage : type === 'table' ? !tana.insertTable : type === 'checklist' ? !tana.toggleCheckbox : !tana.setBlockType,
    run: () => (type === 'image' ? pickImages() : runSlashBlock(type)),
  }));
  // Doc and Task are always offered; the workspace types come from the same source as the Cmd+K "Create new …" list
  const made = creationChoices.filter((c) => c.kind !== 'canvas'); // a canvas has no page to draft here: ⌘K makes one (#620)
  const choices = made.some((c) => c.kind === 'doc') ? made : [{ kind: 'doc', title: 'Doc', icon: 'doc', selectable: true }, ...made];
  for (const choice of choices) rows.push(choice.kind === 'task' || choice.kind === 'meeting' ? { // "/" Task and Meeting: made here and referenced in the row (taskFromSlash, meetingFromSlash)
    group: 'Create', icon: choice.icon, label: choice.kind === 'task' ? 'Task' : 'Meeting', hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable,
    run: () => (choice.kind === 'task' ? taskFromSlash(choice) : meetingFromSlash(choice)),
  } : {
    group: choice.kind === 'custom' ? 'Workspace types' : 'Create', icon: choice.icon,
    label: choice.title, hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable,
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
    else if (type === 'checklist') { if (node.done == null) await tana.toggleCheckbox(docId, node.id); } // a row that has one keeps it
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
// "/" Task (#602): the task is named on a page of its own and takes the row the "/" was typed in, as a reference to it
// (Tana's own "/" Task creates and embeds one). Escape goes back to the menu; until a task is made the "/" stays.
// The page stays open, saying so, until the task exists, so nothing is typed into the row meanwhile. The row is read
// again before the reference goes in: still just the "/", the reference takes its place; anything else is kept and
// the reference goes after it. Not through run(): linkTo queues its own write there, and waiting on it from inside
// the queue would never end.
let slashTaskBusy = false; // one task per Enter
function taskFromSlash(choice) {
  const item = slashTarget();
  if (!item || item.node.kind !== 'block') return;
  openPage('slashTask', 'Name the new task…', { back: () => togglePalette('slash'), typed: true, rows: (q, typed) => {
    const title = String(typed || '').trim();
    if (slashTaskBusy) return [{ group: 'New task', icon: choice.icon, label: 'Creating “' + title + '”…', disabled: true, note: true }];
    return [title ? { group: 'New task', icon: choice.icon, label: 'Create “' + title + '”', keepOpen: true, run: () => taskHere(item, title) }
      : { group: 'New task', icon: choice.icon, label: 'Type a name', disabled: true, note: true }];
  } });
}
function taskHere(item, title) {
  if (slashTaskBusy) return;
  slashTaskBusy = true;
  renderPalette();
  dropPending(item.key);
  return tana.createDocument(title, { kind: 'task' }).then((n) => {
    extra.set(n.id, { ...n, text: n.title || '', hasChildren: true });
    closePalette();
    const el = items.get(item.key) === item && textEl(item.key);
    if (!el) return; // the row went meanwhile: the task stays, in the Library
    const segs = readSegs(el), words = plainOf(segs), at = words.trim() === '/' || !words.trim() ? 0 : words.length;
    return linkTo({ item, segs: at ? segs : [], start: at, end: at }, { label: n.title || title, uri: n.id, ...(n.icon ? { icon: n.icon } : {}) });
  }).catch(showError).finally(() => { slashTaskBusy = false; });
}
// "/" Meeting (#755): named on a page as "/" Task is, then a second page asks when and shows the exact slot before anything
// is made, in ⌘K Change time's words (renderer/meeting.js parseMeetingTime), or, for words those do not read ("tomorrow from
// 3-5", "for an hour"), as the AI reads them (api.readMeetingTime, main/meetings.js readTime), said so on the row. The slot
// is chosen, never assumed: with nothing typed, now for half an hour is a row of its own to press, and words that read as
// no time offer nothing to press until the AI has read them into one. One ↩
// makes one meeting, in the Library with nobody invited (Tana's server puts it in your own calendar, docs/MEETINGS.md;
// Add attendee … is where people are invited), and the row the "/" was typed in becomes its reference, as Task's does.
// Escape goes back a page: when → the name, kept → the menu. A meeting that lands after its page was left (Escape, or
// the palette closed) leaves the row alone: the toast says it was made and opens it.
// ⌘K Create new → Meeting (#765) comes to the same When page with no row (item null): the meeting is opened once made, as
// everything Create new makes is, and Escape goes back to its name page (renderer/palette.js openNamePage).
let slashMeetingBusy = false; // one meeting per ↩, whichever of the two pages it is pressed on
const SLASH_MEETING_LENGTH = 18e5; // a new meeting lasts half an hour, as Tana's own create (sdk/node.js initDocument)
let slashMeetingRead = null; // the AI's reading of the when page's words: { words, busy, answer, error }, one at a time
function meetingFromSlash(choice) {
  const item = slashTarget();
  if (item && item.node.kind === 'block') meetingName(item, choice, '');
}
function meetingName(item, choice, name) {
  openPage('slashMeeting', 'Name the new meeting…', { back: () => togglePalette('slash'), typed: true, rows: (q, typed) => {
    const title = String(typed || '').trim();
    return [title ? { group: 'New meeting', icon: choice.icon, label: 'Choose when for “' + title + '”', keepOpen: true, run: () => meetingWhen(item, choice, title) }
      : { group: 'New meeting', icon: choice.icon, label: 'Type a name', disabled: true, note: true }];
  } }, name);
}
function meetingWhen(item, choice, title) {
  const slot = Math.floor(Date.now() / 6e4) * 6e4, group = 'New meeting · ' + title; // now, to the minute, read once: the row offered does not move under the press
  slashMeetingRead = null;
  openPage('slashMeetingWhen', 'When? 14:00, tomorrow 9:30, fri 10:00-11:30', { back: () => (item ? meetingName(item, choice, title) : openNamePage(choice, title)), typed: true, rows: (q, typed) => {
    if (slashMeetingBusy) return [{ group, icon: choice.icon, label: 'Creating “' + title + '”…', disabled: true, note: true }];
    const words = String(typed || '').trim(), when = words ? parseMeetingTime(words, slot, SLASH_MEETING_LENGTH) : { start: slot, end: slot + SLASH_MEETING_LENGTH };
    const invite = { group, label: 'In your calendar · nobody is invited', disabled: true, note: true };
    if (when) return [{ group, icon: 'calendar', label: meetingSpan(when.start, when.end), hint: words ? '↩ Create' : 'Now, for 30 minutes', keepOpen: true, run: () => meetingHere(item, title, when) }, invite];
    return [...readRows(slashMeetingRead, words, group, () => readWhen(words), (t) => ({ group, icon: 'calendar', label: meetingSpan(t.start, t.end), hint: '↩ Create · read by AI', keepOpen: true, run: () => meetingHere(item, title, t) })), invite];
  } });
}
// The AI's reading of a when page's words, as rows: a row to ask it, a note while it reads, then the time it read to press,
// its question back, or why there is none. Shared by "/" Meeting's when page and Edit meeting details (renderer/meeting.js).
// Only the reading of the words now in the field is shown: words typed since are asked again.
function readRows(read, words, group, ask, timeRow) {
  if (read && read.busy) return [{ group, icon: 'sparkle', spin: true, label: 'Reading “' + read.words + '”…', disabled: true, note: true }]; // spin: the palette's thinking glyph, as Auto-pick type and Discuss with show while the AI reads
  const mine = read && read.words === words ? read : null, again = { group, icon: 'sparkle', label: tana.readMeetingTime ? 'Read “' + words + '” with AI' : 'No time in “' + words + '”', hint: tana.readMeetingTime ? '↩' : '', keepOpen: true, disabled: !tana.readMeetingTime, run: ask };
  if (mine && mine.answer && mine.answer.question) return [{ group, icon: 'sparkle', label: mine.answer.question, hint: 'Add it to your words', disabled: true, note: true }];
  if (mine && mine.answer) return [timeRow(mine.answer), ...zoneNote(mine.answer, group)];
  if (mine && mine.error) return [{ group, label: mine.error, disabled: true, note: true }, again];
  return [again];
}
// Times are drawn on your clock (meetingSpan, this Mac's zone), which is the one words without a zone are read in
// (main/meetings.js resolveTime). When the words named another zone, the same time on that zone's clock goes under it.
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zoneName = (timeZone) => String(timeZone).split('/').pop().replace(/_/g, ' ');
function zoneSpan(timeZone, start, end) {
  const f = (o) => new Intl.DateTimeFormat('en-GB', { timeZone, ...o }), at = f({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f({ weekday: 'short', day: 'numeric', month: 'short' }).format(start) + ' ' + at.format(start) + '\u2013' + at.format(end);
}
function zoneNote(answer, group) {
  if (!answer.timeZone || answer.timeZone === localZone()) return [];
  try { return [{ group, icon: 'globe', label: zoneName(answer.timeZone) + ' time: ' + zoneSpan(answer.timeZone, answer.start, answer.end), hint: 'As you said it', disabled: true, note: true }]; } catch { return []; }
}
// one reading at a time, of the words given; its answer is drawn only on the page it was asked from
function readWords(current, set, words, docId, mode) {
  if (current && current.busy) return;
  const seq = palSeq, mine = { words, busy: true };
  set(mine); renderPalette();
  return tana.readMeetingTime(words, docId).then((answer) => { mine.answer = answer; }, (e) => { mine.error = (e && e.message) || String(e); })
    .then(() => { mine.busy = false; if (seq === palSeq && palMode === mode && !palette.hidden) renderPalette(); });
}
const readWhen = (words) => readWords(slashMeetingRead, (r) => { slashMeetingRead = r; }, words, null, 'slashMeetingWhen');
function meetingHere(item, title, when) {
  if (slashMeetingBusy) return;
  slashMeetingBusy = true;
  renderPalette();
  const seq = palSeq; // the When page as it is now: left (Escape, a closed palette), and the answer leaves the row alone
  return tana.createDocument(title, { kind: 'meeting', start: when.start, end: when.end }).then((n) => {
    extra.set(n.id, { ...n, text: n.title || '', hasChildren: true });
    const stayed = seq === palSeq && !palette.hidden && palMode === 'slashMeetingWhen', el = stayed && item && items.get(item.key) === item && textEl(item.key);
    if (stayed) closePalette();
    if (!item && stayed) return openDoc(n.id); // from ⌘K Create new: no row to refer to it, so the meeting itself opens
    if (!el) return showNote('“' + (n.title || title) + '” created', false, n.id); // the row or its page went meanwhile: the meeting stays, in the Library
    dropPending(item.key); // the reference is the row's words now: a save of the "/" still waiting must not land after it
    const segs = readSegs(el), words = plainOf(segs), at = words.trim() === '/' || !words.trim() ? 0 : words.length;
    // The meeting exists either way: a reference that could not be written puts the row back as it was and says so, with
    // the meeting a click away. Nothing offers to make it again; a new "/" Meeting is a new meeting, asked for again.
    return linkTo({ item, segs: at ? segs : [], start: at, end: at }, { label: n.title || title, uri: n.id, ...(n.icon ? { icon: n.icon } : {}) }, (e, linked) => {
      // Put back only a row that still shows just that link, on this page, with nothing typed waiting to be saved: words
      // typed since the link went in, or a row or page that has gone, are left exactly as they are; the toast says it all.
      const el = items.get(item.key) === item && textEl(item.key);
      if (el && !pending.has(item.key) && plainOf(readSegs(el)) === plainOf(linked)) { item.node.text = words; item.node.segments = segs; render(true); }
      showNote('\u201C' + (n.title || title) + '\u201D was made, but its link could not be written here (' + ((e && e.message) || e) + '). Click to open it', true, n.id);
    });
  }).catch(showError).finally(() => { slashMeetingBusy = false; if (palMode === 'slashMeetingWhen' && !palette.hidden) renderPalette(); });
}
