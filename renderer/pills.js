'use strict';
// The filter pills above a view and their menus; Cmd+K renders the same rows.

function pillDefs() {
  const f = filters.get(pillKey());
  if (!f) return [];
  const defs = [], save = onSearchPage() ? setSearchF : setViewF, one = f.types && f.types.length === 1 && TYPES.find((t) => t && t[0] === f.types[0]);
  // A kind page (Tasks, Meetings, Chats, People) is that kind: only the Library and the Inbox pick their kinds.
  // A saved search is never a kind page — choosing what it lists is the whole point of it.
  if (onSearchPage() || !(views.find((v) => v.id === view) || {}).kind) defs.push({ id: 'type', command: 'Filter by type', value: names(TYPES, f.types) || 'Any type', icon: one ? one[2] : 'any', rows: () => [
    { label: 'Any type', icon: 'any', checked: !f.types, run: () => save({ types: null }) },
    ...TYPES.map((t) => (t ? { label: t[1], icon: t[2], keepOpen: true, checked: !!f.types && f.types.includes(t[0]), run: () => save({ types: toggleIn(TYPES.filter(Boolean).map((x) => x[0]), f.types, t[0]) }) } : { div: true })), // multi-select: the menu stays open to tick more
  ] });
  if (!f.types || f.types.includes('tasks')) {
    defs.push({ id: 'status', label: 'Status', command: 'Filter by status', icon: 'status', value: names(STATES, f.states) || 'Any', rows: () => [
      { label: 'Any status', checked: !f.states, run: () => save({ states: null }) },
      ...STATES.map(([v, l]) => ({ label: l, keepOpen: true, checked: !!f.states && f.states.includes(v), run: () => save({ states: toggleIn(STATES.map((s) => s[0]), f.states, v) }) })), // multi-select, like the type list
    ] });
    loadMembers();
    const you = 'You' + (me() ? ' (' + me().title + ')' : '');
    const a = f.assignee, m = (members || []).find((x) => x.id === a), who = a === 'anyone' ? 'Anyone' : a === 'unassigned' ? 'Unassigned' : a === 'me' || !a ? you : m ? m.title : '…';
    defs.push({ id: 'assigned', label: 'Assigned to', command: 'Filter by assignee', icon: 'assigned', value: who, rows: () => [
      { label: 'Anyone', checked: a === 'anyone', run: () => save({ assignee: 'anyone' }) },
      { label: you, checked: a === 'me' || !a, run: () => save({ assignee: 'me' }) },
      { label: 'Unassigned', checked: a === 'unassigned', run: () => save({ assignee: 'unassigned' }) },
      { head: 'Members' },
      ...(members || []).filter((x) => !x.me).map((x) => ({ label: x.title, checked: a === x.id, run: () => save({ assignee: x.id }) })),
    ] });
  }
  // sorting and grouping are view preferences, not queries: they re-order and re-section the rows the view already has.
  // A saved search is only the query, and the zoomed page it draws neither sorts nor groups, so it is not offered a
  // control that would do nothing — the pills on a search are the ones that change what it finds.
  if (!onSearchPage()) {
    defs.push({ id: 'sort', label: 'Sort', command: 'Sort by', icon: 'sort', value: SORTS.find(([id]) => id === sortBy())[1], rows: () => SORTS.map(([id, label]) => ({ label, checked: sortBy() === id, run: () => setSortBy(id) })) });
    defs.push({ id: 'group', label: 'Group', command: 'Group by', icon: 'group', value: GROUPS.find(([id]) => id === groupBy())[1], rows: () => GROUPS.map(([id, label]) => ({ label, checked: groupBy() === id, run: () => setGroupBy(id) })) });
  }
  return defs;
}
const pillsApply = () => filters.has(pillKey());
const pillName = (def) => def.label || def.id[0].toUpperCase() + def.id.slice(1);
// In Cmd+K a pill is a row named for what it does ("Sort by", "Filter by status") with its current value as the hint;
// its choices fold in as "Sort by Title", "Filter by status In Progress".
function pillCommandRows() {
  return (pillsApply() ? pillDefs() : []).map((def) => ({
    id: 'pill:' + def.id, group: 'View options', icon: def.icon, label: def.command, hint: def.value || '',
    keepOpen: !!def.rows, run: def.rows ? () => openPillPalette(def.id) : def.toggle,
    sub: def.rows ? () => pillRowsFor(def, '') : undefined,
  }));
}
function renderPills(show) {
  const box = $('pills'), defs = show ? pillDefs() : [];
  box.hidden = !defs.length;
  const focusedId = box.contains(document.activeElement) && document.activeElement.closest('.pill') ? document.activeElement.closest('.pill').dataset.id : null;
  if (menu && !defs.some((d) => d.id === menu.id)) menu = null;
  box.replaceChildren(...defs.map((d) => {
    const pill = document.createElement('div'); pill.className = 'pill' + (d.active ? ' active' : '') + (menu && menu.id === d.id ? ' open' : ''); pill.tabIndex = 0; pill.dataset.id = d.id; pill.setAttribute('role', 'button');
    if (d.toggle) pill.setAttribute('aria-pressed', String(!!d.active));
    if (d.icon) { const s = document.createElement('span'); s.innerHTML = iconSvg(d.icon); pill.append(s.firstChild); }
    if (d.label) pill.append(d.label);
    if (d.value) { const b = document.createElement('b'); b.textContent = d.value; pill.append(b); }
    pill.onmousedown = (e) => { if (e.target.closest('.menu')) e.preventDefault(); }; // menu clicks keep the pill focused
    pill.onclick = (e) => { if (d.toggle) d.toggle(); else if (!e.target.closest('.menu')) { menu = menu && menu.id === d.id ? null : { id: d.id, index: 0 }; renderPills(true); pill.focus(); } };
    pill.onkeydown = (e) => pillKeys(e, d, pill);
    if (menu && menu.id === d.id) pill.append(menuEl(d));
    return pill;
  }));
  // rows kept in place (holdRow) no longer match the view: offer to redraw it as it is now. shownDocs() is the
  // active view's rows, which on a saved search page is the view waiting behind it — not what is on screen.
  if (defs.length && !onSearchPage() && needsCleanup(shownDocs())) box.append(cleanupPill());
  // a saved search's edits are held back until they are saved, so there has to be something to press
  if (searchDirty()) box.append(savePill());
  // a query worth coming back to becomes a place: keep it as a saved search (a saved search already is one)
  if (defs.length && tana.createSearch && !onSearchPage()) box.append(saveSearchPill());
  const again = focusedId && box.querySelector('.pill[data-id="' + focusedId + '"]');
  if (again) again.focus();
  const open = box.querySelector('.menu'); // stop before the window edge; the rows scroll inside
  if (open) open.style.maxHeight = Math.min(360, innerHeight - open.getBoundingClientRect().top - 12) + 'px';
  const active = box.querySelector('.menu .mrow.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
}
// Save: write the pills back to the saved search they came from. A view persists each change as it is made, but a
// saved search is a document other people may be looking at, so its edits are held here until this is pressed —
// which is also why this pill exists at all, and only while there is something to save.
function savePill() {
  const pill = document.createElement('div'); pill.className = 'pill save'; pill.tabIndex = 0; pill.dataset.id = 'saveQuery'; pill.setAttribute('role', 'button');
  pill.title = 'Save these changes to this search';
  const s = document.createElement('span'); s.innerHTML = iconSvg('apply'); pill.append(s.firstChild, 'Save');
  const go = () => run(async () => {
    const id = zoom.docId, next = filters.get(id);
    await tana.setSearchFilter(id, next);
    searchFilters.set(id, next);
    await reload(id); // the rows are the query's answer, so saving the query re-asks it
    render(true);
  });
  pill.onclick = go;
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    else if (e.key === 'ArrowLeft' && pill.previousElementSibling) { e.preventDefault(); pill.previousElementSibling.focus(); }
  };
  return pill;
}
// "Save as search": keep what the pills are showing as a saved search document, so a query worth returning to
// becomes somewhere to go. The renderer sends only the view id — the filter→query vocabulary lives in sdk/query,
// which classic renderer scripts cannot require, and main already holds the canonical filter for every view.
// The new search is opened straight away: saving something you cannot see saved reads as nothing happening.
function saveSearchPill() {
  const pill = document.createElement('div'); pill.className = 'pill savesearch'; pill.tabIndex = 0; pill.dataset.id = 'saveSearch'; pill.setAttribute('role', 'button');
  pill.title = 'Keep this query as a saved search';
  const s = document.createElement('span'); s.innerHTML = iconSvg('search'); pill.append(s.firstChild, 'Save as search');
  const go = () => run(async () => {
    const node = await tana.createSearch(view);
    if (!node || !node.id) return;
    if (typeof loadSearches === 'function') loadSearches(); // the Cmd+K Searches group should list it without a relaunch
    goTo(node.id);
  });
  pill.onclick = go;
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    else if (e.key === 'ArrowLeft' && pill.previousElementSibling) { e.preventDefault(); pill.previousElementSibling.focus(); }
  };
  return pill;
}
// Clean up: let go of the rows a status change kept in place and draw the view the way it is now. Like the last pill,
// Right moves on to the first row.
function cleanupPill() {
  const pill = document.createElement('div'); pill.className = 'pill cleanup'; pill.tabIndex = 0; pill.dataset.id = 'cleanup'; pill.setAttribute('role', 'button');
  pill.title = 'Put every row where it belongs now';
  const s = document.createElement('span'); s.innerHTML = iconSvg('cleanup'); pill.append(s.firstChild, 'Clean up');
  const go = () => { releaseHeld(); render(true); };
  pill.onclick = go;
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    else if (e.key === 'ArrowLeft' && pill.previousElementSibling) { e.preventDefault(); pill.previousElementSibling.focus(); }
    else if (e.key === 'ArrowRight' && texts()[0]) { e.preventDefault(); setCaret(texts()[0], 0); }
    else if (e.key === 'Escape') { e.preventDefault(); pill.blur(); }
  };
  return pill;
}
function menuEl(d) {
  const rows = d.rows(), el = document.createElement('div'); el.className = 'menu';
  const pick = rows.filter((r) => r.label); // navigable rows
  menu.index = Math.max(0, Math.min(menu.index, pick.length - 1));
  for (const r of rows) {
    const row = document.createElement('div');
    if (r.head) { row.className = 'mhead'; row.textContent = r.head; el.append(row); continue; }
    if (r.div) { row.className = 'mdiv'; el.append(row); continue; }
    row.className = 'mrow' + (pick.indexOf(r) === menu.index ? ' active' : '');
    if (rows.some((x) => x.icon)) { const i = document.createElement('span'); i.className = 'micon'; i.innerHTML = r.icon ? iconSvg(r.icon) : ''; row.append(i); }
    const l = document.createElement('span'); l.className = 'mlabel'; l.textContent = r.label; row.append(l);
    if (r.checked && r.label !== 'Any status' && r.label !== 'Any type' && r.label !== 'Anyone') { const t = document.createElement('span'); t.className = 'tick'; t.textContent = '✓'; row.append(t); }
    row.onclick = () => pickMenuRow(r, pick);
    el.append(row);
  }
  return el;
}
// Choosing an option closes the menu, so it stops covering the list it just filtered. Multi-select rows (the type
// and status ticks) keep it open; the single-choice row that ends the selection ("Any type", "Any status", an
// assignee) closes it like every other choice.
function pickMenuRow(r, pick) {
  if (!r || !menu) return;
  menu.index = pick.indexOf(r);
  if (!r.keepOpen) menu = null;
  r.run();
  renderPills(true);
}
function pillKeys(e, d, pill) {
  const open = menu && menu.id === d.id, pick = open ? d.rows().filter((r) => r.label) : [];
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : pick.length - 1)) % pick.length; renderPills(true); }
  else if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickMenuRow(pick[menu.index], pick); }
  else if (open && e.key === 'Escape') { e.preventDefault(); menu = null; renderPills(true); }
  else if (open && e.key === 'Tab') { menu = null; renderPills(true); }
  else if (d.toggle && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d.toggle(); }
  else if (!open && !d.toggle && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) { e.preventDefault(); menu = { id: d.id, index: 0 }; renderPills(true); }
  else if (!open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const s = e.key === 'ArrowLeft' ? pill.previousElementSibling : pill.nextElementSibling;
    if (s) s.focus();
    else if (e.key === 'ArrowRight' && texts()[0]) setCaret(texts()[0], 0); // past the last pill (Group): the first node, where Up from that node comes back
  }
  else if (!open && e.key === 'Escape') { e.preventDefault(); pill.blur(); }
}
document.addEventListener('mousedown', (e) => { if (menu && !(e.target.closest && e.target.closest('.pill'))) { menu = null; renderPills(true); } });
