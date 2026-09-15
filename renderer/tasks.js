'use strict';
// Members, task metadata, the status and assignee palettes, and the Selection actions in Cmd+K.

// main answers [] until its sync client is up, so an empty list means "not yet", never "nobody": keeping it would
// leave every assignee, group heading and Assigned menu showing a raw tana:user-profile: uri for the rest of the
// session. Only a list with someone in it counts as loaded; anything else is asked again.
let membersAsked = 0;
function loadMembers() {
  if ((members && members.length) || !tana.members || Date.now() - membersAsked < META_RETRY_MS) return;
  membersAsked = Date.now();
  tana.members().then((m) => {
    members = m;
    if (!m.length) setTimeout(renderSoon, META_RETRY_MS); // a render asks again, the way loadTaskMeta retries
    if (!$('pills').hidden) renderPills(true); if (!palette.hidden) renderPalette(); renderSoon(); // so the Assigned pill reads "You (<name>)"
  }, showError);
}
const me = () => (members || []).find((m) => m.me);
const memberName = (uri) => { const member = (members || []).find((m) => m.id === uri); return member ? member.title || member.text : uri; };
const AUDIENCES = {
  'only-me': { icon: 'lock', label: 'Visible only to you' },
  people: { icon: 'userLock', label: 'Visible to selected people' },
  space: { icon: 'houseLock', label: 'Visible to space members' },
  everyone: { icon: 'users', label: 'Visible to everyone' },
};
function audienceInfo(audience, audienceSpace) {
  const scope = typeof audience === 'string' ? audience : audience?.scope;
  const info = AUDIENCES[scope];
  if (!info) return null;
  const title = audience?.title || audienceSpace?.title;
  // a space audience names the space, so a row can read "Robin Vega · Platform Guild"
  return scope === 'space' && title ? { ...info, label: 'Visible to members of ' + title, space: title } : info;
}
function loadTaskMeta(docId) {
  // Metadata is supplemental. Calling it before the sync client connects retries on every render.
  const backoff = taskMetaFailed.get(docId);
  if (!connected || !tana.taskMeta || !isRealId(docId) || taskMetaById.has(docId) || taskMetaLoading.has(docId) || (backoff && Date.now() < backoff.until)) return;
  taskMetaLoading.add(docId);
  tana.taskMeta(docId).then((meta) => {
    taskMetaLoading.delete(docId); taskMetaFailed.delete(docId); taskMetaById.set(docId, meta);
    if (!palette.hidden && palDoc && palDoc.id === docId) renderPalette();
    patchMeta(docId);
  }, () => { // a brand-new document can still be settling in main: wait, then let the next render ask again
    taskMetaLoading.delete(docId);
    const wait = Math.min(META_RETRY_MAX, backoff ? backoff.wait * 2 : META_RETRY_MS);
    taskMetaFailed.set(docId, { until: Date.now() + wait, wait });
    setTimeout(() => { if (!taskMetaById.has(docId)) renderSoon(); }, wait);
  });
}
// A metadata answer lands in the rows that show that document — the placeholder swapped for the real icons, the
// space sub-line added — without touching the rest of the outline. The zoomed document shows it in the title area
// and the rail as well, so that one takes the next frame's render.
function patchMeta(docId) {
  if (zoom && zoom.docId === docId) return renderSoon();
  for (const row of outline.querySelectorAll('.node.document')) {
    if (row.dataset.key !== docId) continue;
    const item = items.get(row.dataset.key), body = row.querySelector(':scope > .line > .body');
    if (!item || !body) continue;
    const summary = taskSummary(item.node, true) || documentSummary(item.node, true);
    const old = body.querySelector(':scope > .meta.tmeta');
    if (summary) { const el = taskMetaEl(summary); if (old) old.replaceWith(el); else body.append(el); } else if (old) old.remove();
    if (summary && summary.audience && summary.audience.space && !body.querySelector(':scope > .subtext')) {
      const sub = document.createElement('div'); sub.className = 'subtext'; sub.textContent = summary.audience.space; body.append(sub);
    }
    row.dataset.sig = rowSig(item.node); // the row now matches what a fresh render would build
  }
}
// One metadata read is a document bootstrap plus a graph lookup, so with every row wanting an audience icon the
// request only goes out once the row is on screen. Rows further down stay quiet until they scroll into view.
let metaSeen = null;
function observeMeta(el, node) {
  if (!node || node.kind !== 'document' || !isRealId(node.id) || taskMetaById.has(node.id)) return false;
  metaSeen ||= new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { metaSeen.unobserve(entry.target); loadTaskMeta(entry.target.dataset.metaFor); }
  }, { rootMargin: '150px' });
  el.dataset.metaFor = node.id;
  metaSeen.observe(el);
  return true; // the row is waiting on an answer, so it can hold the icon's place
}
// lazy: read the cache but leave the fetching to observeMeta (list rows); the sidebar asks for its one document itself
function taskSummary(node, lazy) {
  if (!isTask(node) || !tana.taskMeta) return null;
  const meta = taskMetaById.get(node.id);
  if (!meta) { if (!lazy) loadTaskMeta(node.id); return null; }
  if (meta.assignees.length) loadMembers(); // names need the member list; loading it re-renders when it arrives
  const scope = typeof meta.audience === 'string' ? meta.audience : meta.audience?.scope;
  return { assignees: meta.assignees.length ? meta.assignees.map(memberName).join(', ') : 'Unassigned', audience: audienceInfo(meta.audience, meta.audienceSpace), scope, unknownAudience: scope === 'unknown', linkShared: !!meta.linkShared };
}
// the same facts for a document that is not a task: no assignee, but it can be shared or public
function documentSummary(node, lazy) {
  if (node.kind !== 'document' || !tana.taskMeta || !isRealId(node.id)) return null;
  const meta = taskMetaById.get(node.id);
  if (!meta) { if (!lazy) loadTaskMeta(node.id); return null; }
  const audience = audienceInfo(meta.audience, meta.audienceSpace);
  if (!audience && !meta.linkShared) return null;
  return { assignees: '', audience, scope: typeof meta.audience === 'string' ? meta.audience : meta.audience?.scope, unknownAudience: false, linkShared: !!meta.linkShared };
}
function taskMetaEl(summary) {
  const el = document.createElement('span');
  el.className = 'meta tmeta' + (summary.pending ? ' pending' : ''); el.textContent = summary.assignees;
  // the icons stand 6px apart, but the first one needs no gap of its own: a row with no assignee name in front of it
  // (every doc and meeting row) already has the 8px the .meta span carries, and 14px reads as a hole
  const gap = () => (el.textContent || el.children.length ? '6px' : '0');
  // an icon in the 14px slot; no label means it carries no information of its own (the placeholder)
  const iconEl = (name, label) => {
    const icon = document.createElement('span');
    if (label) { icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label); icon.title = label; } else icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'display:inline-block;width:14px;height:14px;margin-left:' + gap() + ';vertical-align:-2px';
    const svg = iconNode(name); if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); icon.append(svg); }
    return icon;
  };
  if (summary.pending) el.append(iconEl('pending', null)); // the answer is still on its way: same slot, same size
  if (summary.assignees === 'Unassigned') {
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true'); icon.title = 'Unassigned';
    icon.style.cssText = 'display:inline-block;width:14px;height:14px;margin-right:4px;vertical-align:-2px';
    const svg = iconNode('unassigned'); if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); icon.append(svg); }
    el.prepend(icon);
  }
  if (summary.audience) el.append(iconEl(summary.audience.icon, summary.audience.label));
  else if (summary.unknownAudience) el.append(' · Visibility unknown');
  // link sharing is separate from the Tana audience: anyone with the url can read it
  if (summary.linkShared) el.append(iconEl('globe', 'Anyone with the link'));
  return el;
}
function setTaskAssignees(doc, assignees) {
  const meta = taskMetaById.get(doc.id);
  if (!meta || !tana.setAssignees) return;
  const frozen = !!(palTaskCtx?.fromSelection && sel);
  if (frozen) selectionFrozen = true;
  run(async () => {
    try {
      await tana.setAssignees(doc.id, assignees);
      taskMetaById.set(doc.id, { ...meta, assignees });
      if (!palette.hidden && palMode === 'assignees' && palDoc?.id === doc.id) closePalette();
      render();
    } catch (e) {
      if (frozen) { selectionFrozen = false; if (renderDeferred) render(); }
      showError(e);
      if (!palette.hidden && palMode === 'assignees' && palDoc?.id === doc.id) renderPalette();
    }
  });
}
function assigneeRows(q) {
  if (!palDoc || !isTask(palDoc)) return [];
  loadMembers(); loadTaskMeta(palDoc.id);
  const meta = taskMetaById.get(palDoc.id), ids = meta ? meta.assignees : [];
  const toggle = (uri) => ids.includes(uri) ? ids.filter((id) => id !== uri) : [...ids, uri];
  const rows = [{ group: 'Assignees', icon: 'unassigned', label: 'Unassigned', hint: ids.length ? '' : '✓', keepOpen: true, run: () => setTaskAssignees(palDoc, []) }];
  for (const member of members || []) if (!q || memberName(member.id).toLowerCase().includes(q)) rows.push({ group: 'Assignees', icon: 'member', label: memberName(member.id), hint: ids.includes(member.id) ? '✓' : '', keepOpen: true, run: () => setTaskAssignees(palDoc, toggle(member.id)) });
  return rows;
}
function openAssigneePalette(doc, ctx) {
  palTaskCtx = ctx || null;
  palDoc = doc; palMode = 'assignees'; palRows = []; palIndex = 0; palBusy = false;
  palette.hidden = false; palInput.placeholder = 'Assign task to…'; palInput.value = '';
  loadMembers(); loadTaskMeta(doc.id); renderPalette(); palInput.focus();
}
function taskActionContext() {
  const keys = selKeys(), fromSelection = keys.length > 0;
  const selected = fromSelection ? keys.map((key) => items.get(key)).filter(Boolean) : palDoc ? [{ node: palDoc, docId: palDoc.id }] : [];
  const docs = [], seen = new Set();
  for (const item of selected) {
    const doc = item.node;
    if (!doc || doc.draft || !isTask(doc) || !canEditNode(doc) || seen.has(item.docId)) continue;
    seen.add(item.docId); docs.push(doc);
  }
  if (!fromSelection && !docs.length) return null;
  return { docs, selected: selected.length, skipped: selected.length - docs.length, fromSelection, multi: keys.length > 1 };
}
function taskResult(ctx, changed) {
  if (!ctx.skipped) return;
  const tasks = changed === 1 ? 'task' : 'tasks', rows = ctx.skipped === 1 ? 'row' : 'rows';
  setTimeout(() => showNote(`Updated ${changed} ${tasks}; skipped ${ctx.skipped} non-task or read-only ${rows}`), 0);
}
function applyTaskChange(ctx, call) {
  const frozen = !!(ctx.fromSelection && sel);
  if (frozen) selectionFrozen = true;
  run(async () => {
    try {
      const changed = await call();
      closePalette(); taskResult(ctx, changed);
    } catch (e) {
      if (frozen) { selectionFrozen = false; if (renderDeferred) render(); }
      throw e;
    }
  });
}
function statusRows(q) {
  if (!palTaskCtx?.docs.length) return [];
  const current = palTaskCtx.docs.length === 1 ? stateOf(palTaskCtx.docs[0]) : null;
  return STATES.filter(([, label]) => !q || label.toLowerCase().includes(q)).map(([state, label]) => ({
    group: 'Status', icon: 'status', label, hint: state === current ? '✓' : '', keepOpen: true,
    run: () => applyTaskChange(palTaskCtx, () => palTaskCtx.multi ? tana.setStateMany(palTaskCtx.docs.map((doc) => doc.id), state) : tana.setState(palTaskCtx.docs[0].id, state)),
  }));
}
function openStatusPalette(ctx) {
  palTaskCtx = ctx; palMode = 'status'; palRows = []; palIndex = 0; palBusy = false;
  palette.hidden = false; palInput.placeholder = 'Set status to…'; palInput.value = '';
  renderPalette(); palInput.focus();
}
function manyAssigneeRows(q) {
  if (!palTaskCtx?.docs.length) return [];
  loadMembers();
  const apply = (uris) => applyTaskChange(palTaskCtx, () => tana.setAssigneesMany(palTaskCtx.docs.map((doc) => doc.id), uris));
  const rows = [{ group: 'Assignees', icon: 'unassigned', label: 'Unassigned', keepOpen: true, run: () => apply([]) }];
  for (const member of members || []) if (!q || memberName(member.id).toLowerCase().includes(q)) rows.push({ group: 'Assignees', icon: 'member', label: memberName(member.id), keepOpen: true, run: () => apply([member.id]) });
  return rows;
}
function openManyAssigneePalette(ctx) {
  palTaskCtx = ctx; palMode = 'assigneesMany'; palRows = []; palIndex = 0; palBusy = false;
  palette.hidden = false; palInput.placeholder = 'Assign tasks to…'; palInput.value = '';
  loadMembers(); renderPalette(); palInput.focus();
}
function taskActionRows(group = 'Actions') {
  const ctx = taskActionContext();
  if (!ctx) return [];
  if (ctx.multi) {
    const count = ctx.docs.length, noun = count === 1 ? 'task' : 'tasks', hint = ctx.skipped ? `${ctx.skipped} skipped` : '';
    return [
      { id: 'status', group, icon: 'status', label: `Set status for ${count} ${noun}`, hint, disabled: !count || !tana.setStateMany, keepOpen: true, run: () => openStatusPalette(ctx) },
      { id: 'assign', group, icon: 'member', label: `Assign ${count} ${noun} to`, hint, disabled: !count || !tana.setAssigneesMany, keepOpen: true, run: () => openManyAssigneePalette(ctx) },
    ];
  }
  if (!ctx.docs.length) return [];
  const doc = ctx.docs[0], rows = [];
  if (tana.setState) rows.push({ id: 'status', group, icon: 'status', label: 'Set status', hint: Object.fromEntries(STATES)[stateOf(doc)] || '', keepOpen: true, run: () => openStatusPalette(ctx) });
  if (tana.taskMeta && tana.setAssignees) {
    loadTaskMeta(doc.id);
    const meta = taskMetaById.get(doc.id), hint = meta && meta.assignees.length ? meta.assignees.map(memberName).join(', ') : meta ? 'Unassigned' : 'Loading…';
    rows.push({ id: 'assign', group, icon: 'member', label: 'Edit assignees', hint, keepOpen: true, run: () => openAssigneePalette(doc, ctx) });
  }
  return rows;
}
// With rows selected, what acts on them comes first: at that moment the palette is about the selection, not the app.
// With nothing selected the same actions apply to the current node — the zoomed document, or the one under the
// caret — under their own heading and without a count in the label.
// Every row carries a stable id even though its label counts the selection, because Cmd+Shift+K records a hotkey per
// id and a hotkey only fires with the palette closed — which is exactly when a selection is live.
function selectionRows() {
  const selected = selKeys(), keys = selected.length ? selected : palDoc && items.has(palDoc.id) ? [palDoc.id] : [];
  if (!keys.length) return [];
  const group = selected.length ? 'Selection' : 'Current node';
  const count = (n, noun) => (selected.length ? ` ${n} ${n === 1 ? noun : noun + 's'}` : '');
  const seen = new Set(), nodes = [];
  for (const key of keys) {
    const node = items.get(key)?.node;
    if (node && !node.draft && isRealId(node.id) && !seen.has(node.id)) { seen.add(node.id); nodes.push(node); }
  }
  const ids = nodes.map((node) => node.id), rows = [];
  // A row you are on but not in: Zoom in opens it, the same as clicking its bullet. The zoomed document itself
  // has nowhere further to go, so the row is absent there.
  if (!selected.length && !zoom && nodes.length === 1 && nodes[0].kind === 'document') {
    const doc = nodes[0];
    rows.push({ id: 'zoomIn', group, icon: 'zoomIn', label: 'Zoom in', run: () => openDoc(doc.id) });
    // the row's own chevron, with the keys the outline already answers to (⌘↓ opens, ⌘↑ closes)
    const item = items.get(doc.id);
    if (item && canExpand(item)) {
      const expanded = hasKids(item) ? isOpen(item) : open.get(item.key) === true;
      if (expanded) rows.push({ id: 'collapse', group, icon: 'collapse', label: 'Collapse', run: () => setOpen(item, false) });
      else rows.push({ id: 'expand', group, icon: 'expand', label: 'Expand', run: () => setOpen(item, true) });
    }
  }
  // the task's own checkbox (⌘↩ in the outline), zoomed or on its row
  if (!selected.length && nodes.length === 1 && isTask(nodes[0]) && canEditNode(nodes[0]) && items.has(nodes[0].id)) {
    const item = items.get(nodes[0].id);
    rows.push({ id: 'toggleDone', group, icon: 'apply', label: item.node.done ? 'Reopen' : 'Complete', run: () => toggleDone(item) });
  }
  rows.push(...taskActionRows(group));
  if (nodes.length && tana.insertAfter && tana.setText) {
    if (tana.todayNode) rows.push({ id: 'addToday', group, icon: 'addTo', label: `Add${count(nodes.length, 'item')} to Today`, run: () => addToDateNode(nodes, 'today') });
    if (tana.weekNode) rows.push({ id: 'addWeek', group, icon: 'addTo', label: `Add${count(nodes.length, 'item')} to This Week`, run: () => addToDateNode(nodes, 'week') });
  }
  if (ids.length && tana.setSensitive && sensitiveIds) {
    const marked = ids.every((id) => sensitiveIds.has(id));
    rows.push({ id: 'sensitive', group, icon: 'hidden', label: `${marked ? 'Unmark' : 'Mark'}${count(ids.length, 'item')} as sensitive`, run: () => setSensitiveMark(ids, !marked) });
  }
  // Destructive, so it sits at the end of the group. Documents are soft-deleted (Cmd+Z restores them), blocks go
  // through the same one-step removal as Cmd+Shift+Backspace. Like the task actions, the row counts what it can
  // actually remove and says how much it is skipping: a read-only row, or a block in a selection that also holds
  // documents, since those two removals are different operations. Whether Tana itself allows the delete is still
  // asked per document in removeSelection, because only the server knows that.
  const its = keys.map((key) => items.get(key)).filter(Boolean);
  if (its.length && tana.deleteDocument) {
    const blocksOnly = its.every((it) => it.node.kind === 'block');
    const able = its.filter((it) => (blocksOnly ? canEditStructure(it) : it.node.kind === 'document' && canEditNode(it.node)));
    const skipped = its.length - able.length;
    // ⇧⌘⌫ deletes the node you are on (outline keydown; the zoomed title; a block selection) — say so on the row
    rows.push({ id: 'delete', group, icon: 'trash', label: `Delete${count(able.length, 'item')}`, hint: !skipped ? '' : selected.length ? `${skipped} skipped` : 'Read-only', kbd: selected.length ? undefined : '⇧⌘⌫', disabled: !able.length, run: () => removeSelection(able.map((it) => it.key)) });
  }
  return rows;
}
// Every selected node lands as a mention at the end of the day's or the week's node — the reference Tana itself
// writes for an @ link, so the two documents stay independent.
function addToDateNode(nodes, target) {
  return run(async () => {
    const docId = target === 'week' ? await tana.weekNode() : await tana.todayNode();
    for (const node of nodes) {
      const block = await tana.insertAfter(docId, null, node.text || '');
      await tana.setText(docId, block, [{ mention: { uri: node.id, label: node.text || '' } }]);
    }
    showNote(`Added ${nodes.length} ${nodes.length === 1 ? 'item' : 'items'} to ${target === 'week' ? 'This Week' : 'Today'}`);
  });
}
// One selection, two kinds of removal: rows that are documents are deleted one by one (each undoable on its own),
// blocks reuse the existing single-step block removal.
async function removeSelection(keys) {
  const its = keys.map((key) => items.get(key)).filter(Boolean);
  if (!its.length) return;
  if (its.every((it) => it.node.kind === 'block')) return removeSel(keys);
  sel = null;
  await run(async () => {
    for (const it of its) {
      if (it.node.kind !== 'document' || !canEditItem(it)) throw new Error('Only writable documents and blocks can be deleted');
      const access = await tana.accessOptions(it.docId);
      if (!access?.deletable) throw new Error(access?.reason || 'This document cannot be deleted');
      await tana.deleteDocument(it.docId); invalidateNode(it.docId);
    }
    await loadRoots();
  });
  render(true);
}
