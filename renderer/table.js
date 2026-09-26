'use strict';
// A table block (docs/OUTLINER.md "Tables"): Tana's table > tableRow > tableHeader|tableCell, drawn as a real table.
// The row is atomic, like an image: it focuses, moves and deletes, and nothing types into the row itself. Its cells
// are what edits — each cell's first paragraph, over api.setCell, which is the text Tana's own updateCell rewrites.
// In a document you cannot write to, the same table is drawn with no editable cell.

// cell id -> { item, segs, timer }: typed and not written yet, drawn instead of the stored text so a rebuild keeps it
const cellPending = new Map();
function tableEl(item) {
  const table = document.createElement('table'), writable = !demoMode && !!tana.setCell && canEditStructure(item);
  for (const row of item.node.table.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement(cell.header ? 'th' : 'td');
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      const width = (cell.colwidth || []).reduce((sum, w) => sum + (w || 0), 0); // one width per spanned column, once resized in Tana
      if (width) td.style.setProperty('width', width + 'px');
      const el = document.createElement('div');
      el.className = 'cell'; el.dataset.cell = cell.id || ''; el.dataset.para = cell.paragraph || ''; el.spellcheck = false; // para: the block presence names
      renderSegs(el, cellPending.has(cell.id) ? cellPending.get(cell.id).segs : cell.segments, cell.id);
      if (writable && cell.id) el.contentEditable = 'plaintext-only';
      td.append(el);
      // what else the cell holds shows under its text, read-only: an image as the picture (a click opens it, as on an
      // image row), anything else (a second paragraph, a list) as grey text; only the first paragraph is the cell's text
      for (const b of cell.blocks) {
        if (b.type === 'image' && b.image) td.append(cellImage(b));
        else if (b.id !== cell.paragraph && b.text) { const more = document.createElement('div'); more.className = 'more'; more.textContent = demoText(b.text, b.id); td.append(more); }
      }
      tr.append(td);
    }
    table.append(tr);
  }
  table.addEventListener('input', (e) => { if (e.target.classList.contains('cell')) cellInput(item, e.target); });
  table.addEventListener('focusout', (e) => { if (e.target.classList.contains('cell')) saveCell(e.target.dataset.cell); });
  table.addEventListener('keydown', cellKey);
  table.addEventListener('paste', (e) => cellPaste(item, e));
  return table;
}
function cellImage(b) {
  const img = document.createElement('img'), uri = b.image.uri, cached = images.get(uri);
  img.className = 'cellimg';
  if (demoMode) { img.classList.add('demo'); return img; } // demo mode: a grey block where the picture is, nothing fetched
  if (b.image.alt) img.alt = img.title = b.image.alt;
  if (typeof cached === 'string') img.src = cached;
  else (cached || images.set(uri, tana.image(uri)).get(uri)).then((url) => { images.set(uri, url); img.src = url; }, (e) => { images.delete(uri); showError(e); });
  img.onclick = (e) => { e.stopPropagation(); openImage(b); };
  return img;
}
// Images pasted into a cell are uploaded and go into that cell, after its text, as Tana's addImageToCell puts them;
// anything else pastes as text, which is all a cell's paragraph takes.
function cellPaste(item, e) {
  const el = e.target.closest && e.target.closest('.cell');
  const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/'));
  if (!el || !el.isContentEditable || !files.length || !tana.insertImage) return;
  e.preventDefault();
  saveCell(el.dataset.cell);
  (async () => {
    for (const f of files) await tana.insertImage(item.docId, el.dataset.cell, { bytes: new Uint8Array(await f.arrayBuffer()), filename: f.name || 'image', mimeType: f.type });
    await reload(item.docId); render();
  })().catch(showError);
}
function cellInput(item, el) {
  const id = el.dataset.cell, p = cellPending.get(id);
  if (p) clearTimeout(p.timer);
  cellPending.set(id, { item, segs: readSegs(el), timer: setTimeout(() => saveCell(id), 400) });
}
function saveCell(id) {
  const p = cellPending.get(id);
  if (!p) return;
  clearTimeout(p.timer); cellPending.delete(id);
  const item = p.item, cell = item.node.table.rows.flat().find((c) => c.id === id);
  if (!cell || JSON.stringify(p.segs) === JSON.stringify(cell.segments)) return;
  cell.segments = p.segs; cell.text = plainOf(p.segs); // what the row is drawn from until the write comes back
  run(async () => {
    try { await tana.setCell(item.docId, id, saveValue(p.segs), true); } // typed here: its echo is this page's own (#265)
    catch (e) { await reload(item.docId); render(true); throw e; }
  });
}
// The table as the eye reads it: grid[row][column] is the td covering that spot, spans filled in, so Up/Down stay in the
// column you see even past a cell merged across rows or columns.
function tableGrid(table) {
  const grid = [];
  for (const tr of table.rows) {
    const r = tr.rowIndex, line = grid[r] || (grid[r] = []);
    let x = 0;
    for (const td of tr.cells) {
      while (line[x]) x++;
      for (let i = 0; i < (td.rowSpan || 1); i++) for (let j = 0; j < (td.colSpan || 1); j++) (grid[r + i] || (grid[r + i] = []))[x + j] = td;
      x += td.colSpan || 1;
    }
  }
  return grid;
}
// The editable cell straight above (dir -1) or below (1) td, in its column; a shorter row gives its last cell.
function cellBeside(table, td, dir) {
  const grid = tableGrid(table), r = td.parentElement.rowIndex, x = grid[r].indexOf(td);
  const row = grid[dir < 0 ? r - 1 : r + (td.rowSpan || 1)], other = row && (row[x] || row[row.length - 1]), el = other && other.querySelector('.cell');
  return el && el.isContentEditable ? el : null;
}
// Enter on the focused table row: the caret goes into its first cell.
function enterTable(text) {
  const el = text.querySelector('.cell[contenteditable]');
  if (el) setCaret(el, 0);
}
function placeCell(key, id, offset) { // after a rebuild: the same cell, where the caret was
  const el = queryRow('.node[data-key="' + CSS.escape(key) + '"] .cell[data-cell="' + CSS.escape(id) + '"]');
  if (el) setCaret(el, offset ?? 0, true); else placeCaret(key, 0, true);
}
// Keys inside a cell: Tab/Shift+Tab to the next/previous cell, arrows across cell edges, Escape back to the table row,
// and out of the table past its first or last cell. Enter adds nothing: a cell's text is one paragraph. Every ⌘ key
// goes on to the document handler; the row's own keydown handler (renderer/events.js) leaves cells alone.
function cellKey(e) {
  const el = e.target.closest && e.target.closest('.cell');
  if (!el || !el.isContentEditable || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const table = el.closest('table'), text = table.parentElement, td = el.parentElement;
  const cells = [...table.querySelectorAll('.cell')].filter((c) => c.isContentEditable), i = cells.indexOf(el);
  const off = caretOffset(el), len = unanchored(el.textContent).length, collapsed = getSelection().isCollapsed;
  const vert = (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey, dir = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1;
  if (e.key === 'Tab') { const next = cells[i + (e.shiftKey ? -1 : 1)]; if (next) setCaret(next, 0); else text.focus(); }
  else if (e.key === 'Escape') text.focus();
  else if (e.key === 'Enter') { /* one paragraph per cell */ }
  else if (vert && atEdge(el, dir < 0 ? 'up' : 'down')) { const target = cellBeside(table, td, dir); if (target) setCaret(target, off); else moveTo(text, dir, off); }
  else if (e.key === 'ArrowLeft' && !e.shiftKey && off === 0 && collapsed) { if (cells[i - 1]) setCaret(cells[i - 1], Infinity); else moveTo(text, -1, Infinity); }
  else if (e.key === 'ArrowRight' && !e.shiftKey && off === len && collapsed) { if (cells[i + 1]) setCaret(cells[i + 1], 0); else moveTo(text, 1, 0); }
  else return;
  e.preventDefault();
}
// ⌘K in a cell: the rows and columns around it, as Tana's table menu offers them. What cannot run where the caret is
// (above the header, the header itself, the last row or column, past an edge) is listed disabled, so every row keeps
// its id for ⇧⌘K; sdk/content.js tableOp keeps the same rules.
const TABLE_ROWS = [['rowBefore', 'Add row above'], ['rowAfter', 'Add row below'], ['rowUp', 'Move row up'], ['rowDown', 'Move row down'], ['deleteRow', 'Delete row'],
  ['columnBefore', 'Add column left'], ['columnAfter', 'Add column right'], ['columnLeft', 'Move column left'], ['columnRight', 'Move column right'], ['deleteColumn', 'Delete column']];
function tableRows() {
  const at = palReturn && palReturn.cell, item = at && items.get(palReturn.key), t = item && item.node.table;
  if (!t || !tana.tableOp || !canEditStructure(item)) return [];
  const r = t.rows.findIndex((row) => row.some((c) => c.id === at));
  if (r < 0) return [];
  const c = t.rows[r].findIndex((x) => x.id === at), header = (y) => !!(t.rows[y] && t.rows[y][0] && t.rows[y][0].header);
  const body = t.rows.length - (header(0) ? 1 : 0), width = Math.max(...t.rows.map((row) => row.length));
  const off = { rowBefore: header(r), rowUp: header(r) || r === 0 || header(r - 1), rowDown: header(r) || r === t.rows.length - 1, deleteRow: header(r) || body <= 1,
    columnLeft: c === 0, columnRight: c >= width - 1, deleteColumn: width <= 1 };
  return TABLE_ROWS.map(([op, label]) => ({ id: 'table:' + op, group: 'Table', icon: op.startsWith('delete') ? 'trash' : 'table', label, disabled: !!off[op], run: () => tableAction(item, at, op) }));
}
function tableAction(item, cellId, op) {
  saveCell(cellId); // what is typed in the cell is written first, so the operation acts on what is on screen
  run(async () => {
    const next = await tana.tableOp(item.docId, cellId, op);
    await reload(item.docId); render(true);
    placeCell(item.key, next || cellId, 0);
  });
}
