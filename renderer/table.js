'use strict';
// A table block (docs/OUTLINER.md "Tables"): Tana's table > tableRow > tableHeader|tableCell, drawn as a real table.
// The row is atomic, like an image: it focuses, moves and deletes, and nothing types into the row itself. Its cells
// are what edits — each cell's first paragraph, over api.setCell, which is the text Tana's own updateCell rewrites.
// In a document you cannot write to, the same table is drawn with no editable cell.

// cell id -> { item, segs, timer }: typed and not written yet, drawn instead of the stored text so a rebuild keeps it
const cellPending = new Map();
function tableEl(item) {
  const table = document.createElement('table'), writable = !!tana.setCell && canEditStructure(item);
  for (const row of item.node.table.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement(cell.header ? 'th' : 'td');
      if (cell.colspan > 1) td.colSpan = cell.colspan;
      if (cell.rowspan > 1) td.rowSpan = cell.rowspan;
      const width = (cell.colwidth || []).reduce((sum, w) => sum + (w || 0), 0); // one width per spanned column, once resized in Tana
      if (width) td.style.setProperty('width', width + 'px');
      const el = document.createElement('div');
      el.className = 'cell'; el.dataset.cell = cell.id || ''; el.spellcheck = false;
      renderSegs(el, cellPending.has(cell.id) ? cellPending.get(cell.id).segs : cell.segments);
      if (writable && cell.id) el.contentEditable = 'plaintext-only';
      td.append(el);
      // what else the cell holds (a second paragraph, a list) shows, read-only: only the first paragraph is its text
      for (const b of cell.blocks) if (b.id !== cell.paragraph && b.text) { const more = document.createElement('div'); more.className = 'more'; more.textContent = b.text; td.append(more); }
      tr.append(td);
    }
    table.append(tr);
  }
  table.addEventListener('input', (e) => { if (e.target.classList.contains('cell')) cellInput(item, e.target); });
  table.addEventListener('focusout', (e) => { if (e.target.classList.contains('cell')) saveCell(e.target.dataset.cell); });
  table.addEventListener('keydown', cellKey);
  return table;
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
    try { await tana.setCell(item.docId, id, saveValue(p.segs)); }
    catch (e) { await reload(item.docId); render(true); throw e; }
  });
}
// The editable cell at (row, column) of a table element, or null. Columns count cells as stored, the way Tana's own
// readTable does. ponytail: a rowspan above shifts the column Up/Down lands in; map the grid when merged tables matter.
function cellAt(table, r, c) {
  const tr = table.rows[r], td = tr && tr.cells[Math.min(c, tr.cells.length - 1)], el = td && td.querySelector('.cell');
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
  else if (vert && atEdge(el, dir < 0 ? 'up' : 'down')) { const target = cellAt(table, td.parentElement.rowIndex + dir, td.cellIndex); if (target) setCaret(target, off); else moveTo(text, dir, off); }
  else if (e.key === 'ArrowLeft' && !e.shiftKey && off === 0 && collapsed) { if (cells[i - 1]) setCaret(cells[i - 1], Infinity); else moveTo(text, -1, Infinity); }
  else if (e.key === 'ArrowRight' && !e.shiftKey && off === len && collapsed) { if (cells[i + 1]) setCaret(cells[i + 1], 0); else moveTo(text, 1, 0); }
  else return;
  e.preventDefault();
}
