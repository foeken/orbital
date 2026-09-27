'use strict';
// The right rail: what a zoomed node is linked to (api.related). Rows here are edges, not nodes: they open, a task row toggles, nothing takes a caret.

// ---- right rail: what a zoomed node is linked to (api.related). These rows are edges, not nodes:
// they open, and a task row toggles, but nothing here ever takes a caret (docs/OUTLINER.md §18).
const railEl = $('rail');
const railGrip = $('railGrip');
const RAIL_MIN = 200, RAIL_MAX = 620;
const railWidth = () => Math.min(RAIL_MAX, Math.max(RAIL_MIN, Number(localStorage.getItem('railWidth')) || 272));
railEl.style.width = railWidth() + 'px';
const railToggle = $('railToggle');
// The sidebar can be put away by hand; the preference persists like the width and the collapsed sections.
// Hiding wins over content: a sidebar the user closed must not reappear because the next document has pins.
// Only the "nothing to show" case composes with it — a node with no sidebar at all stays hidden regardless.
let railHidden = pref('railHidden', false) === true;
// A pane narrower than this leaves the sidebar out, and its button with it: beside 272px of sidebar the outline would be
// cramped (issue #444). Crossing it as the pane is resized draws the page again.
const RAIL_ROOM = 720;
const railNarrow = () => typeof innerWidth === 'number' && innerWidth < RAIL_ROOM;
let railWasNarrow = railNarrow();
if (typeof addEventListener === 'function') addEventListener('resize', () => { if (railNarrow() !== railWasNarrow) { railWasNarrow = !railWasNarrow; renderSoon(); } });
function railOff(empty) { return railHidden || empty || railNarrow(); }
function toggleRail() {
  railHidden = !railHidden;
  setPref('railHidden', railHidden);
  // Cmd+K closes the palette before running the row, which puts the caret back in the row being edited, so a plain
  // render would be deferred until the caret left. Showing or hiding the sidebar cannot drop that row, so it forces.
  slideRail(!railHidden, () => render(true)); // it slides out and back in (renderer/motion.js)
}
railToggle.addEventListener('click', toggleRail);
// The button only appears when there is a sidebar to toggle; its glyph is the direction it will move the panel.
function renderRailToggle(available) {
  railToggle.hidden = !available;
  if (!available) return;
  const label = railHidden ? 'Show sidebar' : 'Hide sidebar';
  keyTitle(railToggle, label, 'railToggle');
  railToggle.setAttribute('aria-label', label);
  railToggle.setAttribute('aria-pressed', railHidden ? 'true' : 'false');
  railToggle.replaceChildren();
  addIcon(railToggle, railHidden ? 'railShow' : 'railHide');
}
// drag the grip to resize the sidebar; the width persists like the other view preferences
railGrip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startX = e.clientX, startWidth = railEl.getBoundingClientRect().width;
  railGrip.classList.add('dragging'); railGrip.setPointerCapture(e.pointerId);
  const move = (ev) => { railEl.style.width = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startWidth - (ev.clientX - startX))) + 'px'; };
  const up = () => {
    railGrip.classList.remove('dragging');
    railGrip.removeEventListener('pointermove', move); railGrip.removeEventListener('pointerup', up);
    localStorage.setItem('railWidth', String(Math.round(railEl.getBoundingClientRect().width)));
  };
  railGrip.addEventListener('pointermove', move); railGrip.addEventListener('pointerup', up);
});
const relatedBy = new Map(); // docId -> related payload, or null while the first one is loading
const relatedStale = new Set(); // ids whose payload is known to be behind: re-read, but keep showing the old one
const railClosed = new Set(pref('railClosed', []));
// api.related for the zoomed document, fetched once per id; a failure simply leaves the rail empty.
// Not before the sync client exists: main answers then with "not connected to Tana" and logs the throw
// (the same readiness rule loadAccess and ensureLoaded follow); the render the connection brings asks again.
// A document that changed is re-read the same way, but its payload stays on screen until the new one lands: adding
// a row to a page is a change to that page, and dropping the cache made the whole sidebar blank and come back on
// every edit. The mark is consumed when the fetch starts, so a render during that fetch does not ask again.
function loadRelated(docId) {
  if (!connected || !tana.related || !isRealId(docId)) return;
  const stale = relatedStale.delete(docId);
  if (relatedBy.has(docId) && !stale) return;
  if (!relatedBy.has(docId)) relatedBy.set(docId, null); // nothing to show yet: this is the first read
  const since = releases;
  tana.related(docId).then((data) => {
    relatedBy.set(docId, data);
    // it names a document main let go of while it was read: shown, and read again at the next draw (#406 review)
    if (releasedDocs.size && releasedSince(since, [docId, data && data.pinHub, ...railGroups(data).flatMap(([, rows]) => (rows || []).map((row) => row && row.id))])) relatedStale.add(docId);
    // The answer usually lands while the caret sits in the page's tail row (a zoom parks it there), and a render
    // with the caret in a row waits for focus to leave — so the fields under the title and the sidebar, which are
    // outside the outline, are drawn now rather than at the next click.
    const page = zoom && zoom.docId === docId && !zoom.nodeId ? items.get(docId) : null;
    if (page && (editingRow() || selectionFrozen)) { renderFields(page); renderRail(page); }
    // Expansion can leave the caret on the parent row; show its newly loaded fields without waiting for blur.
    renderSoon(!selectionFrozen && !!queryRow('.inline-fields[hidden][data-doc-id="' + CSS.escape(docId) + '"]'));
  }, () => { if (!relatedBy.get(docId)) relatedBy.delete(docId); });
}
// This document's relations have moved on (an edit, a pin): read them again without taking the sidebar down. Only a
// sidebar this page has read: one it never read is read fresh when it is drawn (loadRelated), and every document a
// view subscribes announces its first bootstrap as a change, which read the sidebars of ~94 documents per page at boot.
// always: read it even so, for the page on screen whose first read may have failed (main's push, below).
function refreshRelated(docId, always) { if (docId && (always || relatedBy.has(docId))) { relatedStale.add(docId); loadRelated(docId); } }
// Kept live (main/related.js watchRelated): main follows the page the sidebar is drawn for, and says so when a mention
// or a pin of it is added or taken away anywhere; the sidebar is then read again the way a pin re-reads it. Asked again
// at the next render until main has taken it: before the connection there is nothing to watch on.
let railWatched = null, railWatching = false;
function watchRail(docId) {
  if (!tana.relatedWatch) return;
  if (!isRealId(docId)) docId = null; // a local draft has nothing in Tana to watch: the last page's queries close as for none
  if (docId !== railWatched) { railWatched = docId; railWatching = false; if (!docId) tana.relatedWatch(null); }
  if (!docId || railWatching || !connected) return;
  railWatching = true;
  Promise.resolve(tana.relatedWatch(docId)).then((ok) => { if (!ok && railWatched === docId) railWatching = false; }, () => { if (railWatched === docId) railWatching = false; });
}
if (tana.onRelatedChanged) tana.onRelatedChanged((docId) => refreshRelated(docId, true)); // only ever the watched page
function railRow(node) {
  const row = document.createElement('div');
  row.className = 'rrow' + (node.done ? ' done' : '');
  row.tabIndex = -1; row.dataset.id = node.id;
  if (isTask(node)) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!node.done; check.tabIndex = -1;
    if (node.stateType === 'proposed') check.classList.add('inbox');
    check.disabled = demoMode || !canEditNode(node);
    check.onmousedown = (e) => e.preventDefault();
    check.onclick = (e) => { e.stopPropagation(); toggleRelated(node); };
    row.append(check);
  } else {
    const icon = document.createElement('span');
    icon.className = 'ricon ' + (node.icon || 'doc') + (node.hue != null ? ' hue' : '');
    if (node.hue != null) icon.style.setProperty('--hue', String(node.hue));
    row.append(addIcon(icon, node.icon || 'doc'));
  }
  const title = document.createElement('span');
  title.className = 'rtitle'; title.textContent = demoText(node.text || node.title || 'Untitled', node.id);
  blurSensitive(title, node.id);
  row.append(title);
  appendTags(row, node);
  // the sidebar is narrow: a tag shows as its "#" in the type's colour and expands on hover (CSS), with the full
  // label available to the pointer and to assistive tech
  for (const chip of row.querySelectorAll('.chip')) { chip.title = chip.textContent.trim(); blurSensitive(chip, node.id); }
  // that expansion narrows the title, which could re-wrap it and jump the row under the pointer: hold the title to
  // the line count it already has, so the label truncates instead and the row keeps its height
  const holdLines = () => { const lh = parseFloat(getComputedStyle(title).lineHeight) || 19; title.style.webkitLineClamp = String(Math.max(1, Math.round(title.offsetHeight / lh))); };
  const freeLines = () => { title.style.webkitLineClamp = ''; };
  row.onmouseenter = holdLines; row.onmouseleave = freeLines;
  row.onfocus = holdLines; row.onblur = freeLines;
  row.onclick = () => goTo(node.id);
  row.onkeydown = (e) => railKey(e, node, row);
  return row;
}
function toggleRelated(node) {
  if (demoMode || !canEditNode(node) || !tana.setDone) return;
  // node is the row's own copy (railRow(asDoc(…))): the sidebar is drawn again from relatedBy, so that changes too
  if (acceptsFirst(node)) { node.stateType = 'open'; patchCopies(node.id, { stateType: 'open' }); run(async () => { await tana.setState(node.id, 'open'); }); return render(true); } // Inbox: accept first, complete next
  const done = node.done ? 0 : 1;
  node.done = done; node.stateType = done ? 'closed' : 'open';
  if (done) justDone.set(node.id, Date.now());
  patchCopies(node.id, { done, stateType: node.stateType });
  run(async () => { await tana.setDone(node.id, !!done); });
  render(true);
}
const railRowEls = () => [...railEl.querySelectorAll('.rrow')];
function focusRail(index = 0) {
  const rows = railRowEls();
  if (!rows.length) return false;
  rows[Math.max(0, Math.min(rows.length - 1, index))].focus();
  return true;
}
// Up/Down/Escape work the same on every sidebar row, including the task metadata rows above Pinned
function railMove(e, row) {
  const rows = railRowEls(), i = rows.indexOf(row);
  if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)].focus(); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) rows[i - 1].focus(); return true; }
  if (e.key === 'Escape' || (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.focus(); return true; }
  return false;
}
function railKey(e, node, row) {
  if (railMove(e, row)) return;
  if (e.key === 'Enter') { e.preventDefault(); goTo(node.id); }
  else if (e.key === ' ') { e.preventDefault(); toggleRelated(node); }
  else if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleRailSection(row.dataset.section); } // collapse the section the focused row is in
  else if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (railClosed.has(row.dataset.section)) toggleRailSection(row.dataset.section); }
}
// A meeting's call link (api.related().call), at the very top of the sidebar so it can be joined from there.
function railCallRow(data) {
  const call = data && data.call;
  if (!call || !call.url || !tana.openExternal) return null; // no call, no row
  return { id: 'call', icon: 'video', label: demoText(call.label || call.url, 'call'), run: () => run(() => tana.openExternal(call.url)) }; // a call link names the meeting: masked in demo mode
}
// The zoomed task's own metadata, at the top of the sidebar: who it is assigned to and who can see it. Both open the
// pickers the palette already uses (api.setAssignees / api.setSharing). Nothing known, nothing shown.
function railMetaRows(node, accessNode = node) {
  // The sidebar describes any document, not only tasks: a doc can be link-shared or live in a space too.
  const summary = taskSummary(node) || documentSummary(node);
  const writable = canEditNode(node);
  const rows = summary?.assignees ? [{
    id: 'assignees',
    icon: summary.assignees === 'Unassigned' ? 'unassigned' : 'member',
    label: summary.assignees === 'Unassigned' ? 'Unassigned' : 'Assigned to ' + summary.assignees,
    run: writable && tana.taskMeta && tana.setAssignees ? () => openAssigneePalette(node) : null,
  }] : [];
  if (summary?.hiddenFrom) rows.push({ // the same warning a list row carries, opening the same picker
    id: 'hiddenFrom', icon: 'userAlert', label: 'Not visible to ' + summary.hiddenFrom,
    run: tana.accessOptions ? () => openVisibility(accessNode, summary.scope) : null,
  });
  if (summary?.audience) rows.push({ // an unverifiable audience is not a row: there is nothing to show or change
    id: 'visibility', icon: summary.audience.icon, label: summary.audience.label,
    run: tana.accessOptions ? () => openVisibility(accessNode, summary.scope) : null,
  });
  // link sharing is a separate fact from the Tana audience, and read-only here: Tana owns that switch
  if (summary?.linkShared) rows.push({ id: 'linkShared', icon: 'globe', label: 'Anyone with the link', run: null });
  // Pinned to the sidebar or to a date, like the mark on a list row: the row opens the page that lists those pins
  // and takes them off. A pin is personal, so write access to the node has nothing to do with it.
  if (isPinned(node.id)) rows.push({ id: 'pinned', icon: 'pinned', label: 'Pinned', run: tana.pinState ? () => openPinsPalette(node) : null });
  if (tana.nodeLink && tana.openExternal && isRealId(node.id)) rows.push({
    id: 'showInTana', icon: 'tana', label: 'Show in Tana',
    run: () => run(async () => tana.openExternal(await tana.nodeLink(node.id))),
  });
  return rows;
}
function railMetaEl(row) {
  const el = document.createElement('div');
  el.className = 'rrow rmeta' + (row.run ? '' : ' fixed'); // not .meta: that is the grey inline meta text of an outline row
  el.tabIndex = -1; el.dataset.id = 'meta:' + row.id;
  const icon = document.createElement('span'); icon.className = 'ricon'; addIcon(icon, row.icon);
  const title = document.createElement('span'); title.className = 'rtitle'; title.textContent = row.label;
  el.append(icon, title);
  el.onclick = row.run || null;
  el.onkeydown = (e) => { if (railMove(e, el)) return; if (row.run && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.run(); } };
  return el;
}
function toggleRailSection(label) {
  if (railClosed.has(label)) railClosed.delete(label); else railClosed.add(label);
  setPref('railClosed', [...railClosed]);
  render(true);
}
function railGroups(data) {
  return data ? [
    ['Pinned', data.pinned || [], data.pinHub],
    ['Outcomes', data.outcomes],
    ['Proposals', data.proposals],
    ['References', data.notes],
    // the documents that mention this one: one section per typed field, "Mentioned in" last, named by main the way
    // Tana's own Backlinks panel names them
    ...(data.backlinks || []).map((group) => [group.label, group.rows]),
  ].filter(([, rows, action]) => (rows && rows.length) || action) : [];
}
// One entry of the zoomed node's own history (api.related().changes, newest first). The first line is what the
// change was — Tana writes that sentence itself ("Added dependency on …") and the row falls back to the node's
// title when the history service named nothing. Under it: who made it and when. The kind of change is the glyph
// rather than a word, and the glyph names it for the pointer and for assistive tech, so the line reads
// "who · when". Only what is known is written: an entry with no actor or no time simply has fewer parts, since
// neither may be guessed, extra authors are counted rather than dropped, and a kind with no glyph of its own falls
// back to saying itself rather than going unsaid. These rows open nothing and change nothing.
const CHANGE_ICON = { Updated: 'updated', Created: 'created', Deleted: 'trash', Archived: 'trash' };
function railChangeEl(change, title, docId) {
  const el = document.createElement('div');
  el.className = 'rrow rchange';
  el.tabIndex = -1; el.dataset.id = 'change:' + [change.action, change.by || '', change.at || ''].join(':');
  if (change.note) el.title = demoText(change.note, docId); // the longer description, for the pointer only: the row stays one line of its own
  const glyph = iconNode(CHANGE_ICON[change.action]);
  const icon = document.createElement('span');
  icon.className = 'ricon';
  if (glyph) { icon.append(glyph); icon.title = change.action; icon.setAttribute('aria-label', change.action); }
  const text = document.createElement('span');
  text.className = 'rtext';
  const head = document.createElement('span');
  head.className = 'rtitle'; head.textContent = demoText(change.title || title, docId);
  blurSensitive(head, docId);
  const sub = document.createElement('span');
  sub.className = 'rsub';
  if (change.by) loadMembers(); // names come with the member list, which re-renders when it lands (memberName answers with the uri until then)
  const who = change.by ? memberName(change.by) + (change.others ? ' +' + change.others : '') : '';
  sub.textContent = [glyph ? '' : change.action, who, agoText(change.at)].filter(Boolean).join(' · ');
  text.append(head, sub);
  el.append(icon, text);
  el.onkeydown = (e) => railMove(e, el);
  return el;
}
function railPinAction(pinHub, docId) {
  const row = railMetaEl({ id: 'pinNew', icon: 'pin', label: 'Pin something …', run: () => togglePalette('search', null, { pinHub, docId }) });
  row.dataset.id = 'action:pinNew';
  return row;
}
// Pinned, Outcomes, Proposals and References for the zoomed document; a writable pin hub keeps Pinned available when empty.
// A saved search is a list, like the views: no sidebar, and so no button to show one (issue #234).
function renderRail(parent) {
  const active = document.activeElement, keep = active && active.classList && active.classList.contains('rrow') ? active.dataset.id : null;
  railEl.replaceChildren();
  const docId = parent && parent.node.kind === 'document' && !parent.node.draft && !String(parent.docId).startsWith(SEARCH_ID) ? parent.docId : null;
  watchRail(docId);
  if (!docId) { railEl.hidden = railGrip.hidden = true; renderRailToggle(false); return; }
  loadRelated(docId);
  const data = relatedBy.get(docId);
  // Event views immediately follow their write-up document. Sharing still belongs to the event itself.
  const accessNode = data?.pinHub?.startsWith('tana:event:') ? { id: data.pinHub } : parent.node;
  const meta = railMetaRows(parent.node, accessNode);
  if (sensitiveIds?.has(docId)) meta.unshift({ id: 'sensitive', icon: 'hidden', label: 'Sensitive', run: null });
  const call = railCallRow(data);
  if (call) meta.unshift(call);
  // "Notes" is what api.related calls them; in the sidebar they read as References
  const groups = railGroups(data);
  const changes = (data && data.changes) || [];
  const empty = !groups.length && !meta.length && !changes.length;
  railEl.hidden = railGrip.hidden = railOff(empty);
  renderRailToggle(!empty && !railNarrow()); // there is a sidebar to toggle even while it is hidden, so the button stays reachable (not in a narrow pane, which has no room for it)
  const sectionHead = (label) => { // every sidebar section collapses the same way, Details included
    const head = document.createElement('button');
    head.className = 'rhead' + (railClosed.has(label) ? ' closed' : '');
    head.tabIndex = -1; head.innerHTML = CHEV; head.append(label);
    head.setAttribute('aria-expanded', railClosed.has(label) ? 'false' : 'true'); // the caret is a disclosure, and says so
    head.onclick = () => foldSection(head, () => toggleRailSection(label), () => [...railEl.querySelectorAll('.rhead')].find((h) => h.textContent === label));
    railEl.append(head);
    return !railClosed.has(label);
  };
  if (meta.length && sectionHead('Details')) for (const row of meta) { const el = railMetaEl(row); el.dataset.section = 'Details'; railEl.append(el); }
  for (const [label, rows, pinHub] of groups) {
    if (!sectionHead(label)) continue;
    for (const node of rows) { const row = railRow(asDoc(node)); row.dataset.section = label; railEl.append(row); }
    if (pinHub) { const row = railPinAction(pinHub, docId); row.dataset.section = label; railEl.append(row); }
  }
  // Last section: the node's history, which is about the page itself rather than about anything it is linked to.
  if (changes.length && sectionHead('Changes')) {
    const title = parent.node.text || parent.node.title || 'Untitled';
    for (const change of changes) { const row = railChangeEl(change, title, docId); row.dataset.section = 'Changes'; railEl.append(row); }
  }
  if (keep) { const again = railEl.querySelector('.rrow[data-id="' + keep + '"]'); if (again) again.focus(); }
}
