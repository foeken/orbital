'use strict';
// The right rail: what a zoomed node is linked to (api.related). Rows here are edges, not nodes: they open, a task row toggles, nothing takes a caret.

// ---- right rail: what a zoomed node is linked to (api.related). These rows are edges, not nodes:
// they open, and a task row toggles, but nothing here ever takes a caret (docs/OUTLINER.md addendum 15).
const railEl = $('rail');
const railGrip = $('railGrip');
const RAIL_MIN = 200, RAIL_MAX = 620;
const railWidth = () => Math.min(RAIL_MAX, Math.max(RAIL_MIN, Number(localStorage.getItem('railWidth')) || 272));
railEl.style.width = railWidth() + 'px';
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
const relatedBy = new Map(); // docId -> related payload, or null while loading
const railClosed = new Set(JSON.parse(localStorage.getItem('railClosed') || '[]'));
// api.related for the zoomed document, fetched once per id; a failure simply leaves the rail empty
function loadRelated(docId) {
  if (!tana.related || !isRealId(docId) || relatedBy.has(docId)) return;
  relatedBy.set(docId, null);
  tana.related(docId).then((data) => { relatedBy.set(docId, data); renderSoon(); }, () => { relatedBy.delete(docId); });
}
function railRow(node) {
  const row = document.createElement('div');
  row.className = 'rrow' + (node.done ? ' done' : '');
  row.tabIndex = -1; row.dataset.id = node.id;
  if (isTask(node)) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!node.done; check.tabIndex = -1;
    check.disabled = !canEditNode(node);
    check.onmousedown = (e) => e.preventDefault();
    check.onclick = (e) => { e.stopPropagation(); toggleRelated(node); };
    row.append(check);
  } else {
    const icon = document.createElement('span');
    icon.className = 'ricon ' + (node.icon || 'doc') + (node.hue != null ? ' hue' : '');
    if (node.hue != null) icon.style.setProperty('--hue', String(node.hue));
    icon.innerHTML = node.iconSvg || iconSvg(node.icon || 'doc');
    row.append(icon);
  }
  const title = document.createElement('span');
  title.className = 'rtitle'; title.textContent = node.text || node.title || 'Untitled';
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
  if (!canEditNode(node) || !tana.setDone) return;
  const done = node.done ? 0 : 1;
  node.done = done;
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
  return { id: 'call', icon: 'video', label: call.label || call.url, run: () => run(() => tana.openExternal(call.url)) };
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
  if (summary?.audience) rows.push({ // an unverifiable audience is not a row: there is nothing to show or change
    id: 'visibility', icon: summary.audience.icon, label: summary.audience.label,
    run: tana.accessOptions ? () => openVisibility(accessNode, summary.scope) : null,
  });
  // link sharing is a separate fact from the Tana audience, and read-only here: Tana owns that switch
  if (summary?.linkShared) rows.push({ id: 'linkShared', icon: 'globe', label: 'Anyone with the link', run: null });
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
  const icon = document.createElement('span'); icon.className = 'ricon'; icon.innerHTML = iconSvg(row.icon);
  const title = document.createElement('span'); title.className = 'rtitle'; title.textContent = row.label;
  el.append(icon, title);
  el.onclick = row.run || null;
  el.onkeydown = (e) => { if (railMove(e, el)) return; if (row.run && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.run(); } };
  return el;
}
function toggleRailSection(label) {
  if (railClosed.has(label)) railClosed.delete(label); else railClosed.add(label);
  localStorage.setItem('railClosed', JSON.stringify([...railClosed]));
  render(true);
}
function railGroups(data) {
  return data ? [
    ['Pinned', data.pinned || [], data.pinHub],
    ['Outcomes', data.outcomes],
    ['References', data.notes],
  ].filter(([, rows, action]) => (rows && rows.length) || action) : [];
}
function railPinAction(pinHub, docId) {
  const row = railMetaEl({ id: 'pinNew', icon: 'pin', label: 'Pin something…', run: () => togglePalette('search', null, { pinHub, docId }) });
  row.dataset.id = 'action:pinNew';
  return row;
}
// Pinned / Outcomes / References for the zoomed document; a writable pin hub keeps Pinned available when empty.
function renderRail(parent) {
  const active = document.activeElement, keep = active && active.classList && active.classList.contains('rrow') ? active.dataset.id : null;
  railEl.replaceChildren();
  const docId = parent && parent.node.kind === 'document' && !parent.node.draft ? parent.docId : null;
  if (!docId) { railEl.hidden = railGrip.hidden = true; return; }
  loadRelated(docId);
  const data = relatedBy.get(docId);
  // Event views immediately follow their write-up document. Sharing still belongs to the event itself.
  const accessNode = data?.pinHub?.startsWith('tana:event:') ? { id: data.pinHub } : parent.node;
  const meta = railMetaRows(parent.node, accessNode);
  if (sensitiveIds?.has(docId)) meta.unshift({ id: 'sensitive', icon: 'lock', label: 'Sensitive', run: null });
  const call = railCallRow(data);
  if (call) meta.unshift(call);
  // "Notes" is what api.related calls them; in the sidebar they read as References
  const groups = railGroups(data);
  railEl.hidden = railGrip.hidden = !groups.length && !meta.length;
  const sectionHead = (label) => { // every sidebar section collapses the same way, Details included
    const head = document.createElement('button');
    head.className = 'rhead' + (railClosed.has(label) ? ' closed' : '');
    head.tabIndex = -1; head.innerHTML = CHEV; head.append(label);
    head.onclick = () => toggleRailSection(label);
    railEl.append(head);
    return !railClosed.has(label);
  };
  if (meta.length && sectionHead('Details')) for (const row of meta) { const el = railMetaEl(row); el.dataset.section = 'Details'; railEl.append(el); }
  for (const [label, rows, pinHub] of groups) {
    if (!sectionHead(label)) continue;
    for (const node of rows) { const row = railRow(asDoc(node)); row.dataset.section = label; railEl.append(row); }
    if (pinHub) { const row = railPinAction(pinHub, docId); row.dataset.section = label; railEl.append(row); }
  }
  if (keep) { const again = railEl.querySelector('.rrow[data-id="' + keep + '"]'); if (again) again.focus(); }
}
