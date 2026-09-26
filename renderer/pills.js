'use strict';
// The filter pills above a view and their menus; Cmd+K renders the same rows.

// Every type in the workspace ({ uri, title, hue }), for the Type pill and a link field's targets (renderer/fields.js).
// The pill asks once per session; Link to types and Cmd+K (fresh) read it afresh each time they open.
let typeListCache = null, typeListAsked = false;
function loadWorkspaceTypes(fresh) {
  if ((typeListCache && !fresh) || typeListAsked || !tana.typeList) return;
  typeListAsked = true;
  tana.typeList().then((list) => { typeListAsked = false; typeListCache = list; if (pillsDrawn) renderPills(true); if (!palette.hidden) renderPalette(); }, () => { typeListAsked = false; });
}

function pillDefs() {
  const f = filters.get(pillKey());
  if (!f) return [];
  const defs = [], save = onSearchPage() ? setSearchF : onTypePage() ? setTypeF : setViewF, one = f.types && f.types.length === 1 && TYPES.find((t) => t && t[0] === f.types[0]);
  // The kinds, then the workspace's own types (#139). The two sets do not mix: ticking one clears the other, since
  // Tasks and Risk together would mean tasks that are risks (sdk/query.js), never what somebody ticking both meant.
  const kindIds = TYPES.filter(Boolean).map((x) => x[0]), kinds = (f.types || []).filter((x) => kindIds.includes(x)), typed = (f.types || []).filter((x) => !kindIds.includes(x));
  if (typed.length) loadWorkspaceTypes(); // the pill names them
  const typeName = (uri) => ((typeListCache || []).find((t) => t.uri === uri) || {}).title || '…';
  // A kind page (Tasks, Meetings, Chats, People) is that kind: only the Library and the Inbox pick their kinds.
  // A saved search is never a kind page — choosing what it lists is the whole point of it.
  // A type's page is that type, so it has no Type pill: its pills are its fields (fieldPill below).
  // Field filters belong to one type, so a change of type lets go of them.
  if (!onTypePage() && (onSearchPage() || !(views.find((v) => v.id === view) || {}).kind)) defs.push({ id: 'type', command: 'Filter by type', value: [names(TYPES, kinds), ...typed.map(typeName)].filter(Boolean).join(', ') || 'Any type', icon: one ? one[2] : typed.length === 1 && !kinds.length ? typeGlyph(typed[0]) : 'any', rows: () => (loadWorkspaceTypes(), [
    { label: 'Any type', reset: true, icon: 'any', checked: !f.types, run: () => save({ types: null, fields: null }) },
    ...TYPES.map((t) => (t ? { label: t[1], icon: t[2], keepOpen: true, checked: kinds.includes(t[0]), run: () => save({ types: toggleIn(kindIds, kinds.length ? kinds : null, t[0]), fields: null }) } : { div: true })), // multi-select: the menu stays open to tick more
    ...(typeListCache && typeListCache.length ? [{ head: 'Workspace types' }, ...typeListCache.map((t) => ({ label: t.title || 'Untitled type', icon: typeGlyph(t.uri), keepOpen: true, checked: typed.includes(t.uri), run: () => save({ types: toggleIn(typeListCache.map((x) => x.uri), typed.length ? typed : null, t.uri), fields: null }) }))] : []),
  ]) });
  // One workspace type (a type's page, or a search or view picking that type alone): its fields get pills.
  const ft = fieldType();
  if (ft) {
    const pills = typeDefs().map((def) => fieldPill(def, f, save)).filter(Boolean);
    defs.push(...pills);
    // A filter on a field that no longer gets a pill (retyped, removed, lost its link targets) keeps one to clear it
    // with, or the page would stay narrowed by something nobody can see. Only once the definitions are in.
    if ((relatedBy.get(ft) || {}).definitions) for (const key of Object.keys(f.fields || {})) {
      if (pills.some((p) => fieldKey({ key: p.id.slice(6) }) === key)) continue;
      const title = (typeDefs().find((d) => fieldKey(d) === key) || {}).title || 'Removed field';
      defs.push({ id: 'field:' + key.split('?attribute=')[1], label: title, command: 'Clear filter on ' + title, icon: 'field', value: 'Filtered', rows: () => [{ label: 'Any', reset: true, checked: false, run: () => putField(f, save, key, null) }] });
    }
  }
  if (tasksInFilter(f)) {
    defs.push({ id: 'status', label: 'Status', command: 'Filter by status', icon: 'status', value: names(STATES, f.states) || 'Any', rows: () => [
      { label: 'Any status', reset: true, checked: !f.states, run: () => save({ states: null }) },
      ...STATES.map(([v, l]) => ({ label: l, keepOpen: true, checked: !!f.states && f.states.includes(v), run: () => save({ states: toggleIn(STATES.map((s) => s[0]), f.states, v) }) })), // multi-select, like the type list
    ] });
    // Only while the Status filter lets completed tasks in, and never as a second way to keep them out: this says
    // how old a completed task may be and still count (renderer/views.js). Taking Completed out of Status hides the
    // pill and keeps its value, so putting it back shows the same window as before.
    if (showsCompleted(f)) defs.push({ id: 'completed', label: 'Completed', command: 'Filter completed by age', icon: 'task', value: COMPLETED.find(([v]) => v === completedWindow(f))[1], rows: () => COMPLETED.map(([v, l]) => ({ label: l, checked: completedWindow(f) === v, run: () => save({ completedWithin: v }) })) });
    loadMembers();
    const you = 'You' + (me() ? ' (' + memberName(me().id) + ')' : '');
    const a = f.assignee, m = (members || []).find((x) => x.id === a), who = a === 'anyone' ? 'Anyone' : a === 'unassigned' ? 'Unassigned' : a === 'me' || !a ? you : m ? memberName(m.id) : '…';
    defs.push({ id: 'assigned', label: 'Assigned to', command: 'Filter by assignee', icon: 'assigned', value: who, rows: () => [
      { label: 'Anyone', reset: true, checked: a === 'anyone', run: () => save({ assignee: 'anyone' }) },
      { label: you, checked: a === 'me' || !a, run: () => save({ assignee: 'me' }) },
      { label: 'Unassigned', checked: a === 'unassigned', run: () => save({ assignee: 'unassigned' }) },
      { head: 'Members' },
      ...(members || []).filter((x) => !x.me).map((x) => ({ label: memberName(x.id), checked: a === x.id, run: () => save({ assignee: x.id }) })),
    ] });
  }
  // sorting and grouping re-order and re-section rows already loaded, rather than changing which rows are found.
  // A view keeps them in the browser; a saved search stores them in its document, so the arrangement travels with
  // the search and is what it opens on next time.
  defs.push({ id: 'sort', label: 'Sort', command: 'Sort by', icon: 'sort', value: SORTS.find(([id]) => id === sortBy())[1], rows: () => sortList().map(([id, label]) => ({ label, checked: sortBy() === id, run: () => setSortBy(id) })) });
  defs.push({ id: 'group', label: 'Group', command: 'Group by', icon: 'group', value: groupList().find(([id]) => id === groupBy())[1], rows: () => groupList().filter(([id]) => id !== 'responsibility' || tasksInFilter(f)).map(([id, label]) => ({ label, checked: groupBy() === id, run: () => setGroupBy(id) })) });
  // what each row shows of itself; multi-select, so the menu stays open to tick more, like the type and status lists
  // the first two it shows and an ellipsis for the rest, so ticking more does not stretch the pill across the bar
  const shown = displayList().filter(([id]) => displayOn(id)).map(([, label]) => label);
  defs.push({ id: 'display', label: 'Display', command: 'Display', icon: 'field', value: shown.slice(0, 2).join(', ') + (shown.length > 2 ? ', …' : '') || 'Nothing', rows: () => displayList().map(([id, label]) => ({ label, keepOpen: true, checked: displayOn(id), run: () => setDisplay(id) })) });
  return defs;
}
// One pill per field with a closed set of values, filtering in Tana's own terms (sdk/query.js attributeFilters,
// verified live 2026-09-25): an options field by its labels (several are ORed), a link or member field by the nodes it
// points at, a date field by Tana's day presets. A text field has no set of values to offer, so it gets no pill.
const DATE_PRESETS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['past', 'Past']];
// the target types of a link field, joined -> { at, rows } ({ id, text }): asked again after a minute, so a new or
// renamed target turns up without a restart
// ponytail: the first 1,000 of them (searchPreview's cap); ask as the menu is typed into if a target type outgrows that
// null while the list is still being asked, so the menu can say so rather than look empty (menuEl)
const linkChoices = new Map();
function fieldChoices(def) {
  if (def.type === 'options') return (def.options || []).map((o) => [o.label, o.label]);
  if (def.type === 'member') { loadMembers(); return members && members.length ? members.map((m) => [m.id, memberName(m.id)]) : null; }
  const to = (def.to || []).map((t) => t.uri), key = to.join(',');
  if (!to.length) return [];
  const hit = linkChoices.get(key);
  if (!hit || (hit.rows && Date.now() - hit.at > 6e4)) {
    linkChoices.set(key, { at: Date.now(), rows: hit ? hit.rows : null }); // claimed: the renders while it is asked do not ask again
    tana.searchPreview({ types: to }).then((rows) => { linkChoices.set(key, { at: Date.now(), rows }); if (pillsDrawn) renderPills(true); }, () => linkChoices.delete(key));
  }
  const rows = (linkChoices.get(key) || {}).rows;
  return rows ? rows.map((n) => [n.id, n.text || 'Untitled']) : null;
}
function putField(f, save, key, value) {
  const fields = { ...f.fields };
  if (value) fields[key] = value; else delete fields[key];
  save({ fields: Object.keys(fields).length ? fields : null });
}
function fieldPill(def, f, save) {
  if (!PILL_FIELDS.includes(def.type) || (def.type === 'link' && !(def.to || []).length)) return null; // a link to anything has no list to pick from
  const key = fieldKey(def), now = (f.fields || {})[key] || {}, title = def.title || 'Untitled field';
  const put = (value) => putField(f, save, key, value);
  // a link or member field can point at hundreds of nodes, so its menu says it can be searched (menuEl)
  const pill = { id: 'field:' + def.key, label: title, command: 'Filter by ' + title, icon: 'field', search: def.type === 'link' || def.type === 'member' };
  if (def.type === 'date') {
    const preset = now.date && now.date.preset;
    return { ...pill, value: (DATE_PRESETS.find(([p]) => p === preset) || [])[1] || 'Any', rows: () => [
      { label: 'Any', reset: true, checked: !preset, run: () => put(null) },
      ...DATE_PRESETS.map(([p, label]) => ({ label, checked: preset === p, run: () => put({ date: { preset: p } }) })),
    ] };
  }
  // options match their label, links and members the uri they point at; either way a multi-select, like Status
  const byLabel = def.type === 'options', on = byLabel ? (now.textMatches || []).map((m) => m.value) : now.refs || [];
  const asked = fieldChoices(def), choices = asked || [], ids = choices.map(([id]) => id), nameOf = (id) => (choices.find(([x]) => x === id) || [id, '…'])[1];
  return { ...pill, loading: !asked, value: on.map(nameOf).join(', ') || 'Any', rows: () => [
    { label: 'Any', reset: true, checked: !on.length, run: () => put(null) },
    ...choices.map(([id, label]) => ({ label, keepOpen: true, checked: on.includes(id), run: () => {
      const next = toggleIn(ids, on.length ? on : null, id);
      put(next && (byLabel ? { textMatches: next.map((value) => ({ value })) } : { refs: next }));
    } })),
  ] };
}
const pillsApply = () => filters.has(pillKey());
const pillName = (def) => def.label || def.id[0].toUpperCase() + def.id.slice(1);
// In Cmd+K a pill is a row named for what it does ("Sort by", "Filter by status") with its current value as the hint;
// its choices fold in as "Sort by Title", "Filter by status In Progress".
function pillCommandRows() {
  const defs = pillsApply() ? pillDefs() : [];
  const rows = defs.map((def) => ({
    id: 'pill:' + def.id, group: 'View options', icon: /^(Filter|Clear filter)/.test(def.command) ? 'filter' : def.icon, label: def.command, hint: def.value || '',
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
  if (listPage()) rows.push({ id: 'tableView', group: 'View options', icon: tableView() ? 'outline' : 'table', label: tableLabel(), run: () => setTableView(!tableView()) });
  if (tableView() && tableKeys().length) rows.push({ id: 'columnWidths', group: 'View options', icon: 'table', label: 'Column widths …', keepOpen: true, run: openColumnWidths }); // the grips' keyboard way (renderer/views.js)
  return rows;
}
// Let go of the rows a status change kept in place and draw the page the way it is now. The header pill and the
// Cmd+K row are two ways of pressing this one thing.
// A view's rows are re-asked by the refresh loop, so letting go is enough there. A saved search is asked only when
// it is opened, so a row that no longer answers its query would sit there until the page is left: ask again.
function cleanupNow() {
  armGlide(); // the rows held in place slide to where they belong now
  releaseHeld();
  if ((onSearchPage() && !searchRows.has(zoom.docId)) || onTypePage()) { const id = zoom.docId; return run(async () => { await reload(id); render(true); }); }
  render(true);
}
function renderPills(show) {
  const box = $('pills'), search = !!show && onSearchPage();
  pillsDrawn = !!show; // what "this page has pills" means for everyone else: the row itself may be folded away
  renderPillsToggle(!!show);
  // Offered wherever the pills are, folded or not, and on a view as well: a row kept in place by a status change is
  // exactly when it is wanted (needsCleanup, renderer/views.js).
  renderCleanupBtn(!!show && needsCleanup(shownDocs()));
  // Not while the pills are staging an unsaved filter: those rows are a preview of what Save would store, and
  // re-asking the stored query would quietly replace them with something else.
  renderRefreshBtn(search && !searchRows.has(zoom.docId));
  renderTableBtn(!!show);
  if (show && !pillsShown()) return foldPills(box);
  // Folded until now, so the pills come in rather than appear. Only for a press on the button: the movement is what
  // answers that press, and a page you have just arrived at — a reload, a link, the Library — is drawn as it stands
  // rather than assembling itself in front of you.
  const arriving = pillsPressed && (box.hidden || box.classList.contains('out'));
  box.classList.remove('out');
  const defs = show ? pillDefs() : [];
  box.hidden = !defs.length;
  const focusedId = box.contains(document.activeElement) && document.activeElement.closest('.pill') ? document.activeElement.closest('.pill').dataset.id : null;
  if (menu && !defs.some((d) => d.id === menu.id)) menu = null;
  const oldMenu = box.querySelector('.pill > .menu:not(.out)'); // the menu this redraw replaces: it may be leaving (menuMotion)
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
  // a saved search's edits are held back until they are saved, so there has to be something to press
  if (searchDirty()) box.append(savePill());
  // a query worth coming back to becomes a place: keep it as a saved search (a saved search already is one)
  if (defs.length && tana.createSearch && !onSearchPage() && !onTypePage()) box.append(saveSearchPill());
  // The order each pill arrives and leaves in: its place in the row, whatever it is (a filter, Save, Refresh).
  // Arriving is marked on the pills rather than on the row, because every render builds them again: with the mark
  // on the row, a redraw landing while they were still coming in handed it straight back to the new ones and the
  // whole entrance played a second time. A rebuilt pill is simply a pill, so there is nothing to replay.
  [...box.children].forEach((el, i) => { el.style.setProperty('--i', i); if (arriving) el.classList.add('in'); });
  if (arriving && !box.hidden) unfoldPills(box);
  if (oldMenu || menu) menuMotion(oldMenu, box.querySelector('.pill > .menu:not(.out)'), oldMenu && [...box.children].find((p) => p.dataset.id === oldMenu.dataset.for));
  const again = focusedId && box.querySelector('.pill[data-id="' + focusedId + '"]');
  if (again) again.focus();
  const open = box.querySelector('.menu:not(.out)'); // stop before the window edge; the rows scroll inside (not a menu on its way out)
  if (open) open.style.maxHeight = Math.min(360, innerHeight - open.getBoundingClientRect().top - 12) + 'px';
  const active = box.querySelector('.menu:not(.out) .mrow.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
}
// Every page with pills can fold them away behind a button beside back and forward, and each page remembers its own
// choice. A view (the Library, the Inbox) opens with them shown, because its pills are how it is aimed; a saved search
// and a type page open with them folded, because each is read far more often than it is re-aimed and its title
// already says what it lists. Unsaved edits hold the row open whatever the button says, or Save would be behind
// something that does not mention it. The choice follows you between machines, like the sidebar's.
const pillsToggle = $('pillsToggle');
let pillsPressed = false; // the row moves for a press on the button, and for nothing else
let pillsDrawn = false;   // the page the pills belong to, which a folded row no longer says (renderer/render.js, renderer/tasks.js)
const pillsShown = () => (pref('openPills', {})[pillKey()] ?? !(onSearchPage() || onTypePage())) || searchDirty();
pillsToggle.onclick = () => {
  setPref('openPills', { ...pref('openPills', {}), [pillKey()]: !pillsShown() });
  pillsPressed = true;
  try { renderPills(true); } finally { pillsPressed = false; } // renderPills is synchronous, so the flag lasts exactly this draw
};
function renderPillsToggle(available) {
  pillsToggle.hidden = !available;
  if (!available) return;
  const open = pillsShown(), label = open ? 'Hide view options' : 'Show view options';
  pillsToggle.title = label;
  pillsToggle.setAttribute('aria-label', label);
  pillsToggle.setAttribute('aria-pressed', String(open));
  if (!pillsToggle.childNodes.length) { const svg = iconNode('options'); if (svg) pillsToggle.append(svg); } // the glyph never changes, like the nav buttons'
}
// Opening and closing the row: the pills come in one after another, left to right, and leave the same way, and the
// row's own height follows them, so the outline below slides instead of jumping when it goes. Both are CSS
// (styles.css: --i per pill for the stagger, height to and from auto for the row); what is left here is when each
// class goes on and when the row may finally be hidden — the pills' last animation and the height's own transition
// answer that, so no duration is guessed twice. Under reduced motion neither rule is declared, so nothing would
// ever report back: both paths skip straight to the end.
function unfoldPills(box) {
  box.classList.remove('sliding', 'folding'); // whatever a close that was interrupted left behind
  if (stillPreferred()) return;
  box.classList.add('sliding', 'folding');
  void box.offsetWidth; // the closed state has to be laid out, or there is nothing to open from
  box.classList.remove('folding');
  afterSlide(box, () => box.classList.remove('sliding'));
}
function foldPills(box) {
  menu = null;
  if (box.hidden || box.classList.contains('out')) return; // already away, or already on its way out
  box.classList.add('out');
  // Reopened while it was leaving: it is on screen and staying, and renderPills has taken the 'out' class off it.
  const shut = () => { if (!box.classList.contains('out')) return; box.classList.remove('out', 'sliding', 'folding'); box.hidden = true; box.replaceChildren(); };
  const last = stillPreferred() || !pillsPressed ? null : box.lastElementChild;
  if (!last) return shut();
  last.addEventListener('animationend', () => {
    if (!box.classList.contains('out')) return;
    box.classList.add('sliding', 'folding'); // the pills have gone; now the space they were in closes after them
    afterSlide(box, shut); // hidden only at the end: taken away at nought height, it takes nothing with it
  }, { once: true });
}
// The row moves its height and its bottom margin together. The height is the one that says when it is over: the
// margin finishing first would hide a row still a step from closed, which is the jump this is here to remove.
function afterSlide(box, done) {
  const end = (e) => { if (e && e.propertyName !== 'height') return; box.removeEventListener('transitionend', end); done(); };
  box.addEventListener('transitionend', end);
}
// A pill that is a button rather than a menu: the two below are the same element, keys and all, and differ only in
// what they are called and what the press runs. Like the last pill, Left moves back along the row.
function actionPill(cls, id, title, label, go) {
  const pill = document.createElement('div'); pill.className = 'pill ' + cls; pill.tabIndex = 0; pill.dataset.id = id; pill.setAttribute('role', 'button');
  pill.title = title;
  pill.append(label);
  pill.onclick = go;
  pill.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    else if (e.key === 'ArrowLeft' && pill.previousElementSibling) { e.preventDefault(); pill.previousElementSibling.focus(); }
  };
  return pill;
}
// Save: write the pills back to the saved search they came from. A view persists each change as it is made, but a
// saved search is a document other people may be looking at, so its edits are held here until this is pressed —
// which is also why this pill exists at all, and only while there is something to save.
function savePill() {
  return actionPill('save', 'saveQuery', 'Save these changes to this search', 'Save', () => run(async () => {
    const id = zoom.docId, next = filters.get(id), sort = sortBy(), group = groupBy(), display = displayKeys();
    await tana.setSearchFilter(id, next, sort, group, display);
    searchFilters.set(id, { filter: next, sort, group, display });
    searchRows.delete(id); // the stored query is what these rows answer now, so the preview stands down
    await reload(id); // the rows are the query's answer, so saving the query re-asks it
    render(true);
  }));
}
// "Save as search": keep what the pills are showing as a saved search document, so a query worth returning to
// becomes somewhere to go. The renderer sends only the view id — the filter→query vocabulary lives in sdk/query,
// which classic renderer scripts cannot require, and main already holds the canonical filter for every view.
// The new search is opened straight away: saving something you cannot see saved reads as nothing happening.
function saveSearchPill() {
  return actionPill('savesearch', 'saveSearch', 'Keep this query as a saved search', 'Save as search', () => run(async () => {
    const node = await tana.createSearch(view);
    if (!node || !node.id) return;
    addSearch(node); // the Cmd+K Searches group lists it straight away (#141)
    goTo(node.id);
  }));
}
// Clean up: let go of the rows a status change kept in place and draw the view the way it is now. Like the last pill,
// Right moves on to the first row.
// playOnce and stillPreferred, the one-shot class and the reduced-motion question, are renderer/motion.js's.
// Refresh: ask this saved search's query again. Its rows are subscribed (main/related.js), so an edit elsewhere
// reaches the rows it is already showing — but a row that has since started or stopped answering the query is only
// learned by asking again, which nothing else on this page does. It sits beside the fold button rather than among
// the pills: it asks the query rather than describing it, and folding them away must not take it with them.
// The button outlives the redraw its answer brings — the glyph is appended once, like the nav buttons' — so the
// turn runs to the end on its own and the rows land as soon as they arrive rather than waiting for it.
const refreshBtn = $('navRefresh');
function renderRefreshBtn(available) {
  refreshBtn.hidden = !available;
  if (!available) return;
  refreshBtn.title = 'Ask this search again';
  refreshBtn.setAttribute('aria-label', 'Refresh'); // icon only, so the name has to come from here
  if (!refreshBtn.childNodes.length) { const svg = iconNode('reload'); if (svg) refreshBtn.append(svg); }
}
refreshBtn.onmousedown = (e) => e.preventDefault(); // the caret may be in a row with a render waiting on it (cleanupPill)
refreshBtn.onclick = () => {
  playOnce(refreshBtn.firstChild, 'spin');
  const id = zoom.docId;
  releaseHeld();
  run(async () => { await reload(id); render(true); });
};
// Clean up: let go of the rows a status change kept in place and draw the page the way it is now. A header button
// beside the other two rather than a pill, for the same reason Refresh is one — a row kept in place is exactly when
// you want it, and folding the pills away must not take it with them. Icon only; Cmd+K carries the words.
const cleanupBtn = $('navCleanup');
function renderCleanupBtn(available) {
  if (!available) return hideCleanupBtn();
  // it comes and goes with the rows being held: a pop says it has turned up, including when it was on its way out
  const arriving = cleanupBtn.hidden || cleanupBtn.classList.contains('out');
  cleanupBtn.classList.remove('out'); // staying after all
  cleanupBtn.hidden = false;
  keyTitle(cleanupBtn, 'Put every row where it belongs now', 'cleanup');
  cleanupBtn.setAttribute('aria-label', 'Clean up');
  if (!cleanupBtn.childNodes.length) { const svg = iconNode('cleanup'); if (svg) cleanupBtn.append(svg); }
  if (arriving) playOnce(cleanupBtn, 'in');
}
// Leaving: it shrinks away rather than being gone between two frames, and is hidden only once that has played —
// hiding it first would take the animation off screen with it. A button that becomes wanted again while it is
// going stays: the render that keeps it takes the class off, and the animation still running then ends on an
// element that is staying put, which is what the second test is for.
function hideCleanupBtn() {
  if (cleanupBtn.hidden || cleanupBtn.classList.contains('out')) return; // already gone, or already going
  cleanupBtn.classList.remove('in');
  if (stillPreferred()) { cleanupBtn.hidden = true; return; }
  cleanupBtn.classList.add('out');
  cleanupBtn.addEventListener('animationend', () => {
    if (!cleanupBtn.classList.contains('out')) return;
    cleanupBtn.classList.remove('out');
    cleanupBtn.hidden = true;
  }, { once: true });
}
// The caret is in the row whose status just changed, so a render is deferred until it loses focus. Taking focus on
// mousedown ran that render, and the mouseup then landed on what it had drawn — no click at all, and the first
// press did nothing. Keeping the focus where it is (the bullets and menu rows do the same) lets the press through.
cleanupBtn.onmousedown = (e) => e.preventDefault();
cleanupBtn.onclick = cleanupNow; // the same action the Cmd+K "Clean up" row runs
// Typing in an open menu narrows it, so a long list (every member, in Assigned to) is reachable without the mouse.
// Headings and dividers describe a full list, so a narrowed one drops them and shows only what matched.
// A searchable menu draws its first MENU_CAP rows: every render while a page loads rebuilds an open menu, and a link
// field has up to 1,000 targets, which nobody scrolls through when typing finds one.
const MENU_CAP = 100;
function menuRows(d) {
  const all = d.rows(), q = (menu && menu.q || '').trim().toLowerCase();
  const rows = q ? all.filter((r) => r.label && fuzzyMatch(r.label, q)) : all;
  return d.search ? rows.slice(0, MENU_CAP) : rows;
}
function menuEl(d) {
  const rows = menuRows(d), el = document.createElement('div'); el.className = 'menu';
  el.dataset.for = d.id; // which pill it hangs from, so a redraw can tell a new menu from the same one (menuMotion)
  const typed = (menu.q || '').trim();
  // A long list (a link field's targets) shows where the typing goes before anything is typed; the keys stay the pill's,
  // and the caret drawn there (styles.css .mcaret) shows only while the pill has the focus, which is when typing lands
  if (d.search) {
    const s = document.createElement('div'); s.className = 'msearch' + (typed ? '' : ' empty');
    const i = document.createElement('span'); i.className = 'micon'; i.innerHTML = iconSvg('search');
    const c = document.createElement('span'); c.className = 'mcaret';
    s.append(i, typed, c, typed ? '' : 'Search ' + (d.label || 'options') + '…'); el.append(s);
  } else if (typed) { const h = document.createElement('div'); h.className = 'mhead'; h.textContent = typed; el.append(h); }
  const pick = rows.filter((r) => r.label); // navigable rows
  if (d.loading || (d.search && typed && !pick.length)) { const n = document.createElement('div'); n.className = 'mhead'; n.textContent = d.loading ? 'Loading…' : 'No matches'; el.append(n); }
  menu.index = Math.max(0, Math.min(menu.index, pick.length - 1));
  const icons = rows.some((x) => x.icon);
  let at = 0; // this row's place among the navigable ones
  for (const r of rows) {
    const row = document.createElement('div');
    if (r.head) { row.className = 'mhead'; row.textContent = r.head; el.append(row); continue; }
    if (r.div) { row.className = 'mdiv'; el.append(row); continue; }
    row.className = 'mrow' + (r.label && at++ === menu.index ? ' active' : '');
    if (icons) { const i = document.createElement('span'); i.className = 'micon'; i.innerHTML = r.icon ? iconSvg(r.icon) : ''; row.append(i); }
    const l = document.createElement('span'); l.className = 'mlabel'; l.textContent = r.label; row.append(l);
    if (r.checked && !r.reset) { const t = document.createElement('span'); t.className = 'tick'; t.textContent = '✓'; row.append(t); }
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
