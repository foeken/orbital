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
    // Only while the Status filter lets completed tasks in, and never as a second way to keep them out: this says
    // how old a completed task may be and still count (renderer/views.js). Taking Completed out of Status hides the
    // pill and keeps its value, so putting it back shows the same window as before.
    if (showsCompleted(f)) defs.push({ id: 'completed', label: 'Completed', command: 'Filter completed by age', icon: 'task', value: COMPLETED.find(([v]) => v === completedWindow(f))[1], rows: () => COMPLETED.map(([v, l]) => ({ label: l, checked: completedWindow(f) === v, run: () => save({ completedWithin: v }) })) });
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
  // sorting and grouping re-order and re-section rows already loaded, rather than changing which rows are found.
  // A view keeps them in the browser; a saved search stores them in its document, so the arrangement travels with
  // the search and is what it opens on next time.
  defs.push({ id: 'sort', label: 'Sort', command: 'Sort by', icon: 'sort', value: SORTS.find(([id]) => id === sortBy())[1], rows: () => SORTS.map(([id, label]) => ({ label, checked: sortBy() === id, run: () => setSortBy(id) })) });
  defs.push({ id: 'group', label: 'Group', command: 'Group by', icon: 'group', value: GROUPS.find(([id]) => id === groupBy())[1], rows: () => GROUPS.map(([id, label]) => ({ label, checked: groupBy() === id, run: () => setGroupBy(id) })) });
  // what each row shows of itself; multi-select, so the menu stays open to tick more, like the type and status lists
  defs.push({ id: 'display', label: 'Display', command: 'Display', icon: 'field', value: names(DISPLAY, displayKeys()) || 'Nothing', rows: () => DISPLAY.map(([id, label]) => ({ label, keepOpen: true, checked: displayOn(id), run: () => setDisplay(id) })) });
  return defs;
}
const pillsApply = () => filters.has(pillKey());
const pillName = (def) => def.label || def.id[0].toUpperCase() + def.id.slice(1);
// In Cmd+K a pill is a row named for what it does ("Sort by", "Filter by status") with its current value as the hint;
// its choices fold in as "Sort by Title", "Filter by status In Progress".
function pillCommandRows() {
  const defs = pillsApply() ? pillDefs() : [];
  const rows = defs.map((def) => ({
    id: 'pill:' + def.id, group: 'View options', icon: def.icon, label: def.command, hint: def.value || '',
    keepOpen: !!def.rows, run: def.rows ? () => openPillPalette(def.id) : def.toggle,
    sub: def.rows ? () => pillRowsFor(def, '') : undefined,
  }));
  // The Clean up pill as a command row, and unlike the pill it is always listed: greyed out with "Nothing to clean up"
  // while no row is being kept in place, live the moment one is. A key is recorded against a row that is in the
  // palette, and cleanup is wanted before it is ever needed, so a row that came and went with the pill could only be
  // given a shortcut in the seconds it happened to be offered. Disabled is the whole of "does nothing": runRow and
  // runAction both refuse such a row, so neither the press nor the recorded key reaches cleanupNow.
  if (defs.length) {
    const now = needsCleanup(shownDocs());
    rows.push({ id: 'cleanup', group: 'View options', icon: 'cleanup', label: 'Clean up', hint: now ? '' : 'Nothing to clean up', disabled: !now, run: cleanupNow });
  }
  return rows;
}
// Let go of the rows a status change kept in place and draw the page the way it is now. The header pill and the
// Cmd+K row are two ways of pressing this one thing.
// A view's rows are re-asked by the refresh loop, so letting go is enough there. A saved search is asked only when
// it is opened, so a row that no longer answers its query would sit there until the page is left: ask again.
function cleanupNow() {
  releaseHeld();
  if (onSearchPage() && !searchRows.has(zoom.docId)) { const id = zoom.docId; return run(async () => { await reload(id); render(true); }); }
  render(true);
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
  // rows kept in place (holdRow) no longer match the page: offer to redraw it as it is now. A saved search holds
  // rows the same way a view does, so it gets the same pill — shownDocs() answers with the list on screen.
  if (defs.length && needsCleanup(shownDocs())) box.append(cleanupPill());
  // A view re-asks its query every half minute; a saved search is asked once, when it is opened. This is the button
  // that asks it again. Not while the pills are staging an unsaved filter: those rows are a preview of what Save
  // would store, and re-asking the stored query would quietly replace them with something else.
  if (onSearchPage() && !searchRows.has(zoom.docId)) box.append(refreshPill());
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
  pill.append('Save');
  const go = () => run(async () => {
    const id = zoom.docId, next = filters.get(id), sort = sortBy(), group = groupBy(), display = displayKeys();
    await tana.setSearchFilter(id, next, sort, group, display);
    searchFilters.set(id, { filter: next, sort, group, display });
    searchRows.delete(id); // the stored query is what these rows answer now, so the preview stands down
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
  pill.append('Save as search');
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
// Refresh: ask this saved search's query again. Its rows are subscribed (main/related.js), so an edit elsewhere
// reaches the rows it is already showing — but a row that has since started or stopped answering the query is only
// learned by asking again, which nothing else on this page does.
// One turn of an icon, as the feedback a press gives before its answer arrives. Restartable: dropping the class and
// re-adding it in the same frame does nothing at all, so the reflow read in between is what makes a second press
// start the turn again instead of being swallowed by the one still running. Under reduced motion the rule the class
// selects is not declared, so the icon simply stays where it is.
// It returns when the turn is over, because the caller is about to rebuild the element the turn is running on: an
// answer that arrives in 80 ms would otherwise replace the icon a tenth of the way round, which is what "I can
// hardly see it" was. Keep SPIN_MS and the .75s in styles.css in step — renderer-check compares them.
const SPIN_MS = 750;
const stillPreferred = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
function spinOnce(icon) {
  if (!icon || !icon.classList || stillPreferred()) return Promise.resolve(); // nothing turns, so nothing is waited for
  icon.classList.remove('spin');
  void icon.offsetWidth;
  icon.classList.add('spin');
  return new Promise((done) => setTimeout(done, SPIN_MS));
}
function refreshPill() {
  const pill = document.createElement('div'); pill.className = 'pill refresh'; pill.tabIndex = 0; pill.dataset.id = 'refreshSearch'; pill.setAttribute('role', 'button');
  pill.title = 'Ask this search again';
  pill.setAttribute('aria-label', 'Refresh'); // icon only, so the name has to come from here
  const s = document.createElement('span'); s.innerHTML = iconSvg('reload');
  const icon = s.firstChild;
  pill.append(icon);
  // The answer is a round trip, so the press needs an answer of its own: one turn of the glyph, then back to rest.
  // The query goes out first and is never held back; only the redraw waits, and only until the turn is done — the
  // redraw builds a new pill, so without that the turn would be cut off wherever the answer happened to land.
  const go = () => {
    const turning = spinOnce(icon);
    const id = zoom.docId;
    releaseHeld();
    run(async () => { const answered = reload(id); await Promise.all([answered, turning]); render(true); });
  };
  pill.onmousedown = (e) => e.preventDefault(); // the caret may be in a row with a render waiting on it (cleanupPill)
  pill.onclick = go;
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    else if (e.key === 'ArrowLeft' && pill.previousElementSibling) { e.preventDefault(); pill.previousElementSibling.focus(); }
    else if (e.key === 'ArrowRight' && pill.nextElementSibling) { e.preventDefault(); pill.nextElementSibling.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); pill.blur(); }
  };
  return pill;
}
function cleanupPill() {
  const pill = document.createElement('div'); pill.className = 'pill cleanup'; pill.tabIndex = 0; pill.dataset.id = 'cleanup'; pill.setAttribute('role', 'button');
  pill.title = 'Put every row where it belongs now';
  const s = document.createElement('span'); s.innerHTML = iconSvg('cleanup'); pill.append(s.firstChild, 'Clean up');
  const go = cleanupNow; // the same action the Cmd+K "Clean up" row runs
  // The caret is in the row whose status just changed, so a render is deferred until it loses focus. Taking focus on
  // mousedown ran that render, which rebuilds the pills, and the mouseup then landed on a new element — no click at
  // all, and the first press did nothing. Keeping the focus where it is (the bullets and menu rows do the same) lets
  // the press through.
  pill.onmousedown = (e) => e.preventDefault();
  pill.onclick = go;
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    else if (e.key === 'ArrowLeft' && pill.previousElementSibling) { e.preventDefault(); pill.previousElementSibling.focus(); }
    else if (e.key === 'ArrowRight' && texts()[0]) { e.preventDefault(); setCaret(texts()[0], 0); }
    else if (e.key === 'Escape') { e.preventDefault(); pill.blur(); }
  };
  return pill;
}
// Typing in an open menu narrows it, so a long list (every member, in Assigned to) is reachable without the mouse.
// Headings and dividers describe a full list, so a narrowed one drops them and shows only what matched.
function menuRows(d) {
  const all = d.rows(), q = (menu && menu.q || '').trim().toLowerCase();
  return q ? all.filter((r) => r.label && fuzzyMatch(r.label, q)) : all;
}
function menuEl(d) {
  const rows = menuRows(d), el = document.createElement('div'); el.className = 'menu';
  const typed = (menu.q || '').trim();
  if (typed) { const h = document.createElement('div'); h.className = 'mhead'; h.textContent = typed; el.append(h); }
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
  // the same rows the menu is showing: navigating a list the user has narrowed must not highlight a row that is not there
  const open = menu && menu.id === d.id, pick = open ? menuRows(d).filter((r) => r.label) : [];
  const typing = open && (menu.q || '') !== '';
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); if (pick.length) menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : pick.length - 1)) % pick.length; renderPills(true); }
  // Space selects an unnarrowed list, but types into one being narrowed: member names have spaces in them
  else if (open && (e.key === 'Enter' || (e.key === ' ' && !typing))) { e.preventDefault(); pickMenuRow(pick[menu.index], pick); }
  else if (open && e.key === 'Backspace') { e.preventDefault(); menu.q = (menu.q || '').slice(0, -1); menu.index = 0; renderPills(true); }
  // Escape gives the full list back before it closes the menu, so a mistyped letter costs one key rather than a reopen
  else if (open && e.key === 'Escape' && typing) { e.preventDefault(); menu.q = ''; menu.index = 0; renderPills(true); }
  else if (open && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); menu.q = (menu.q || '') + e.key; menu.index = 0; renderPills(true); }
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
