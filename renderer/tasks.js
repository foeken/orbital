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
    if (pillsDrawn) renderPills(true); if (!palette.hidden) renderPalette(); renderSoon(); // so the Assigned pill reads "You (<name>)"
  }, showError);
}
const me = () => (members || []).find((m) => m.me);
function memberName(uri) {
  if (demoMode) return demoPersonName(uri);
  const member = (members || []).find((m) => m.id === uri);
  return member ? member.title || member.text : uri;
}
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
  const named = title && demoText(title, audienceSpace?.uri || 'space'); // a space's name is Tana's: masked in demo mode
  // a space audience names the space, so a row can read "Robin Vega · Platform Guild"
  return scope === 'space' && title ? { ...info, label: 'Visible to members of ' + named, space: named } : info;
}
function loadTaskMeta(docId) {
  // Metadata is supplemental. Calling it before the sync client connects retries on every render.
  const backoff = taskMetaFailed.get(docId);
  // A deleted node answers nothing and never will, so it is not asked: the backoff doubles but never gives up, which
  // is what turned one gone row into a "Node has been deleted" in the log for the rest of the session.
  if (!connected || !tana.taskMeta || !isRealId(docId) || isGone(docId) || taskMetaById.has(docId) || taskMetaLoading.has(docId) || (backoff && Date.now() < backoff.until)) return;
  taskMetaLoading.add(docId);
  tana.taskMeta(docId).then((meta) => {
    taskMetaLoading.delete(docId); taskMetaFailed.delete(docId); taskMetaById.set(docId, meta);
    if (!palette.hidden && palDoc && palDoc.id === docId) renderPalette();
    patchMeta(docId);
  }, (e) => { // a brand-new document can still be settling in main: wait, then let the next render ask again
    taskMetaLoading.delete(docId);
    if (noteGone(docId, e)) return; // gone, not settling: nothing to wait for
    const wait = Math.min(META_RETRY_MAX, backoff ? backoff.wait * 2 : META_RETRY_MS);
    const entry = { until: Date.now() + wait, wait };
    taskMetaFailed.set(docId, entry);
    // The timer is the retry, so it opens the gate itself: a timer is due by the loop's clock, which lags the wall
    // clock on a long tick, and a render arriving a millisecond "early" by Date.now() used to be refused and lost.
    setTimeout(() => { if (taskMetaById.has(docId)) return; entry.until = 0; renderSoon(); }, wait);
  });
}
// A metadata answer lands in the rows that show that document — the placeholder swapped for the real icons, the
// space sub-line added — without touching the rest of the outline. The zoomed document shows it in the title area
// and the rail as well, so that one takes the next frame's render.
function patchMeta(docId) {
  if (zoom && zoom.docId === docId) return renderSoon();
  let patched = false;
  for (const row of outline.querySelectorAll('.node.document')) {
    if (row.dataset.key !== docId) continue;
    const item = items.get(row.dataset.key), body = row.querySelector(':scope > .line > .body');
    if (!item || !body) continue;
    const summary = taskSummary(item.node, true) || documentSummary(item.node, true);
    // anywhere in the body, since fitRowMeta may have moved it onto the subtext line; it is taken out before the
    // subtext is rewritten and put back inline, and the fit is decided again at the end
    const old = body.querySelector('.meta.tmeta'), sep = body.querySelector('.metasep');
    if (old) old.remove();
    if (sep) sep.remove();
    // the same line a full render would build, so a row does not change shape when its metadata arrives late: the
    // facts go before the type chips, where nodeEl appends them, not after them
    const had = body.querySelector(':scope > .subtext'), sub = subtextEl(item.node, summary, had || undefined, tableRow(item.parent));
    if (summary && displayOn('assigned')) body.insertBefore(taskMetaEl(summary, docId, item.node), body.querySelector(':scope > .chip') || had || null);
    if (sub && !had) body.append(sub);
    else if (!sub && had) had.remove();
    row.dataset.sig = rowSig(item.node); // the row now matches what a fresh render would build
    patched = true;
  }
  if (patched) fitRowMetaSoon(); // the row was rebuilt in place, so where its facts belong is decided again, once per frame for a burst
  // The answer can also decide whether a row is shown at all — Group by Responsibility leaves out what it has no
  // section for, including rows whose assignees had not arrived — so one that is not on screen asks for a render
  // rather than being patched. renderSoon coalesces, so a burst of answers still costs one.
  if (!patched) renderSoon();
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
  const hiddenFrom = (meta.hiddenFrom || []).map(memberName).join(', '); // assigned, but outside the audience (sdk/node.js)
  return { assignees: meta.assignees.length ? meta.assignees.map(memberName).join(', ') : 'Unassigned', hiddenFrom, audience: audienceInfo(meta.audience, meta.audienceSpace), people: meta.people || [], peopleCount: meta.peopleCount, scope, unknownAudience: scope === 'unknown', linkShared: !!meta.linkShared, watched: !!meta.watched, pinned: isPinned(node.id) };
}
// the same facts for a document that is not a task: no assignee, but it can be shared or public
function documentSummary(node, lazy) {
  if (node.kind !== 'document' || !tana.taskMeta || !isRealId(node.id)) return null;
  const meta = taskMetaById.get(node.id);
  if (!meta) { if (!lazy) loadTaskMeta(node.id); return null; }
  const audience = audienceInfo(meta.audience, meta.audienceSpace);
  if (!audience && !meta.linkShared && !meta.watched && !isPinned(node.id)) return null;
  return { assignees: '', audience, people: meta.people || [], peopleCount: meta.peopleCount, scope: typeof meta.audience === 'string' ? meta.audience : meta.audience?.scope, unknownAudience: false, linkShared: !!meta.linkShared, watched: !!meta.watched, pinned: isPinned(node.id) };
}
// a click on a row's fact opens its picker and leaves the caret where it is, as every other row control does
function clickable(target, open) {
  target.setAttribute('role', 'button'); // styles.css gives [role="button"] its pointer
  target.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
  target.onclick = (e) => { e.stopPropagation(); open(); };
}
// an icon in the 14px slot (styles.css .ticon, which also spaces it from what stands before it); no label means it
// carries no information of its own (the placeholder)
function iconEl(name, label, tag = 'span') {
  const icon = document.createElement(tag); icon.className = 'ticon';
  const svg = iconNode(name); if (svg) icon.append(svg);
  if (label) { icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label); icon.title = label; } else icon.setAttribute('aria-hidden', 'true');
  return icon;
}
// Assigned to someone who cannot see it: the audience icon itself is the warning, in the stylesheet's colour
// (.hiddenfrom), and says who is shut out. hiddenFrom only comes with a known audience, so there is always one.
function audienceIcon(summary, node) {
  const label = summary.audience.label + (summary.hiddenFrom ? ' — not visible to ' + summary.hiddenFrom : '');
  const icon = iconEl(summary.audience.icon, label);
  if (summary.hiddenFrom) icon.classList.add('hiddenfrom');
  if (node && canEditNode(node) && isRealId(node.id) && tana.accessOptions) { icon.title = label + ' — click to edit visibility'; clickable(icon, () => openVisibility(node, summary.scope)); }
  return icon;
}
// Who can see a row, at the start of its subtext (#461): the audience's glyph, a bubble per person and how many.
// main names them (sdk/node.js audienceMetadata): everyone is the organization's membership, the others the grants.
function audienceUris(summary) { return (summary && summary.audience && displayOn('assigned') && summary.people) || []; }
// a guest's profile is not readable (the graph refuses the kind, a subscribe finds no document), so a guest is named as one
function isGuest(uri) { return uri.startsWith('tana:guest-profile:'); }
function peopleEl(summary, node) {
  const uris = audienceUris(summary);
  // a sensitive node says nothing about who can see it: no glyph, faces or count (back with Toggle sensitive visibility)
  if (!uris.length || (node && sensitiveHidden(node.id))) return null;
  loadMembers(); // the bubbles' names
  const face = (uri) => {
    const f = document.createElement('span'), found = memberName(uri), known = !found.startsWith('tana:');
    const name = known ? found : isGuest(uri) ? 'Guest' : 'Unknown person';
    f.className = 'face'; f.textContent = known || isGuest(uri) ? name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() : '?';
    f.setAttribute('role', 'img'); f.setAttribute('aria-label', name); f.title = name;
    let tone = 0; for (const c of uri) tone = (tone * 31 + c.charCodeAt(0)) % 6; // one of six light greys per person, the same on every row
    f.style.setProperty('--tone', tone);
    return f;
  };
  const faces = document.createElement('span'); faces.className = 'faces';
  const count = summary.peopleCount || uris.length; // main sends the first four and how many (main/documents.js doc:taskMeta)
  faces.append(...uris.slice(0, 4).map(face)); // four bubbles, then the rest: "+n" up to nine people, "and n others" past that
  const rest = count - 4;
  if (rest > 0 && count <= 9) { const more = document.createElement('span'); more.className = 'face more'; more.textContent = '+' + rest; more.setAttribute('role', 'img'); more.setAttribute('aria-label', rest + ' more'); faces.append(more); }
  const el = document.createElement('span'); el.className = 'people'; el.title = count === 1 ? '1 person' : count + ' people';
  el.append(audienceIcon(summary, node), faces, ...(count > 9 ? ['and ' + rest + ' others'] : []));
  return el;
}
// node: the row's document, so its facts open the Cmd+K pickers they describe (Edit assignees, Edit visibility)
function taskMetaEl(summary, docId, node) {
  const el = document.createElement('span');
  el.className = 'meta tmeta' + (summary.pending ? ' pending' : '');
  const writable = node && canEditNode(node) && isRealId(node.id);
  // .mtext: the words, which a table row leaves out (its Assigned column has the name; styles.css .table-view)
  const who = document.createElement('span'); who.className = 'mtext'; who.textContent = summary.assignees;
  if (summary.assignees) el.append(who);
  if (summary.assignees && writable && isTask(node) && tana.setAssignees) { who.title = 'Edit assignees'; clickable(who, () => openAssigneePalette(node)); }
  if (summary.pending) el.append(iconEl('pending', null)); // the answer is still on its way: same slot, same size
  if (summary.assignees === 'Unassigned') { const icon = iconEl('unassigned', null); icon.title = 'Unassigned'; who.prepend(icon); }
  // a list row says who can see it in its subtext (peopleEl); a table row's subtext is its cells, so there it stays here
  if (summary.audience && (tableView() || !audienceUris(summary).length)) el.append(audienceIcon(summary, node));
  else if (summary.unknownAudience) { const t = document.createElement('span'); t.className = 'mtext'; t.textContent = ' · Visibility unknown'; el.append(t); }
  // Pinned, in the same slot and with the same behaviour as the audience icon beside it: the glyph says the node is
  // pinned somewhere, and a click opens the page that says where and takes it off. Pins are personal, so a node you
  // cannot write still carries the mark and still opens the page.
  if (summary.pinned && node && isRealId(node.id)) {
    const icon = iconEl('pinned', 'Pinned');
    if (tana.pinState) { icon.title = 'Pinned — click to edit pins'; clickable(icon, () => openPinsPalette(node)); }
    el.append(icon);
  }
  // link sharing is separate from the Tana audience: anyone with the url can read it
  if (summary.linkShared) el.append(iconEl('globe', 'Anyone with the link'));
  // last of the row's icons: a bell says changes to this node reach you, whether you asked or the rule decided
  if (summary.watched) {
    const bell = iconEl('notify', 'Stop notifying', 'button');
    bell.type = 'button'; bell.setAttribute('role', 'button'); // styles.css button.ticon takes the button's own look off
    bell.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); };
    bell.onclick = (e) => { e.stopPropagation(); run(() => setNodeNotify(docId, false)); };
    el.append(bell);
  }
  return el;
}
// Whether this node's changes are announced. Read once per document, on the same readiness rule loadTaskMeta uses,
// and the palette redraws when the answer lands if it is still showing that node. The default depends on
// participants and assignment, so the answer is main's to give rather than the renderer's to guess.
function loadNotify(docId) {
  if (!connected || !tana.notifyState || notifyById.has(docId) || notifyLoading.has(docId)) return;
  notifyLoading.add(docId);
  tana.notifyState(docId).then((state) => {
    notifyLoading.delete(docId); notifyById.set(docId, state);
    if (!palette.hidden && palDoc?.id === docId) renderPalette();
  }, () => { notifyLoading.delete(docId); });
}
async function setNodeNotify(id, on) {
  const state = await tana.setNotify(id, on);
  notifyById.set(id, state);
  const meta = taskMetaById.get(id); if (meta) taskMetaById.set(id, { ...meta, watched: state.on });
  renderPalette(); patchMeta(id);
  // Group by Responsibility files a handed-over task by that same watch state, so the row has to change section
  // rather than only lose its bell; every other grouping is unaffected and keeps the cheap patch.
  if (groupBy() === 'responsibility') renderSoon();
}
function setTaskAssignees(doc, assignees) {
  const meta = taskMetaById.get(doc.id);
  if (!meta || !tana.setAssignees) return;
  const frozen = !!(palTaskCtx?.fromSelection && sel);
  if (frozen) selectionFrozen = true;
  run(async () => {
    try {
      await tana.setAssignees(doc.id, assignees);
      // Read again rather than patched: who the audience leaves out (hiddenFrom) is main's to say, and a copy of the
      // old metadata with new assignees kept the old warning — and overwrote the fresh read the change event started.
      try { taskMetaById.set(doc.id, await tana.taskMeta(doc.id)); } catch { taskMetaById.delete(doc.id); } // the next render asks
      if (!palette.hidden && palMode === 'assignees' && palDoc?.id === doc.id) closePalette();
      render();
    } catch (e) {
      if (frozen) { selectionFrozen = false; if (renderDeferred) render(); }
      showError(e);
      if (!palette.hidden && palMode === 'assignees' && palDoc?.id === doc.id) renderPalette();
    }
  });
}
// The list both assignee pages are: Unassigned, then every member, matched the way the palette matches anything
// else. Unassigned narrows with the rest — it used to stay at the top whatever was typed, so typing a name and
// pressing Enter ran the highlighted first row and cleared the assignee instead of setting the one that was typed.
// `pick` is given the uri the row names, or null for Unassigned; `ticked` says which of them the document already
// carries, and is left out where there is no single answer to tick (a selection of several tasks).
function memberRows(q, pick, ticked) {
  const tick = (uri) => (ticked && ticked(uri) ? '✓' : '');
  const rows = fuzzyMatch('Unassigned', q) ? [{ group: 'Assignees', icon: 'unassigned', label: 'Unassigned', hint: tick(null), keepOpen: true, run: () => pick(null) }] : [];
  for (const member of members || []) if (fuzzyMatch(memberName(member.id), q)) rows.push({ group: 'Assignees', icon: 'member', label: memberName(member.id), hint: tick(member.id), keepOpen: true, run: () => pick(member.id) });
  return rows;
}
function assigneeRows(q, doc = palDoc) {
  if (!doc || !isTask(doc)) return [];
  loadMembers(); loadTaskMeta(doc.id);
  const meta = taskMetaById.get(doc.id), ids = meta ? meta.assignees : [];
  const toggle = (uri) => ids.includes(uri) ? ids.filter((id) => id !== uri) : [...ids, uri];
  const rows = memberRows(q, (uri) => setTaskAssignees(doc, uri ? toggle(uri) : []), (uri) => (uri ? ids.includes(uri) : !ids.length));
  // The agent belongs in the same list a person is chosen from — it is the same question. It is not a Tana assignee
  // though (those are user profiles), so choosing it goes into the one Agent flow: the prompt page and its model
  // chooser, which owns the writing. Nothing is stored here.
  if (tana.setCodex && isRealId(doc.id) && fuzzyMatch('Agent', q)) {
    rows.push({ group: 'Assignees', icon: 'robot', label: 'Agent', hint: codexIds.has(doc.id) ? '✓' : '', keepOpen: true, run: () => openAgentPrompt(doc) });
  }
  return rows;
}
function openAssigneePalette(doc, ctx) {
  palTaskCtx = ctx || null;
  palDoc = doc; loadMembers(); loadTaskMeta(doc.id);
  openPage('assignees', 'Assign task to…', { rows: (q) => assigneeRows(q) });
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
      render(!frozen); // frozen: chrome only, so the selected rows stay put while their boxes and the Clean up pill catch up
    } catch (e) {
      if (frozen) { selectionFrozen = false; if (renderDeferred) render(); }
      throw e;
    }
  });
}
function statusRows(q, ctx = palTaskCtx) {
  if (!ctx?.docs.length) return [];
  const current = ctx.docs.length === 1 ? stateOf(ctx.docs[0]) : null;
  return STATES.filter(([, label]) => fuzzyMatch(label, q)).map(([state, label]) => ({
    group: 'Status', icon: 'status', label, hint: state === current ? '✓' : '', keepOpen: true,
    run: () => applyTaskChange(ctx, async () => {
      armGlide(); // a row whose group is its status slides to its new section when the hold is let go
      for (const doc of ctx.docs) holdRow(doc); // stays put, like a clicked box (renderer/views.js)
      const changed = await (ctx.multi ? tana.setStateMany(ctx.docs.map((doc) => doc.id), state) : tana.setState(ctx.docs[0].id, state));
      // shown now rather than when the live update lands: the caret is back in this row, where a plain render waits
      for (const doc of ctx.docs) { doc.stateType = state; doc.done = state === 'closed' ? 1 : 0; }
      if (state === 'closed') for (const doc of ctx.docs) justDone.set(doc.id, Date.now());
      return changed;
    }),
  }));
}
function openStatusPalette(ctx) {
  palTaskCtx = ctx; openPage('status', 'Set status to…', { rows: (q) => statusRows(q) });
}
function manyAssigneeRows(q, ctx = palTaskCtx) {
  if (!ctx?.docs.length) return [];
  loadMembers();
  const apply = (uris) => applyTaskChange(ctx, () => tana.setAssigneesMany(ctx.docs.map((doc) => doc.id), uris));
  // no tick: the page acts on several tasks at once, which need not agree on an answer to show one
  return memberRows(q, (uri) => apply(uri ? [uri] : []));
}
function openManyAssigneePalette(ctx) {
  palTaskCtx = ctx; loadMembers(); openPage('assigneesMany', ctx.multi ? 'Assign tasks to…' : 'Assign to…', { rows: (q) => manyAssigneeRows(q) });
}
function taskActionRows(group = 'Actions') {
  const ctx = taskActionContext();
  if (!ctx) return [];
  if (ctx.multi) {
    const count = ctx.docs.length, noun = count === 1 ? 'task' : 'tasks', hint = ctx.skipped ? `${ctx.skipped} skipped` : '';
    if (!count) return []; // no task in the selection: nothing here could run, as for a single row that is not a task
    return [
      { id: 'status', group, icon: 'status', label: `Set status for ${count} ${noun}`, subBase: `Set status for ${count} ${noun} to`, hint, disabled: !count || !tana.setStateMany, keepOpen: true, subAlways: true, run: () => openStatusPalette(ctx), sub: () => statusRows('', ctx) },
      { id: 'assign', group, icon: 'member', label: `Assign ${count} ${noun} to`, hint, disabled: !count || !tana.setAssigneesMany, keepOpen: true, run: () => openManyAssigneePalette(ctx), sub: async () => { await membersLoaded(); return manyAssigneeRows('', ctx); } },
    ];
  }
  if (!ctx.docs.length) return [];
  const doc = ctx.docs[0], rows = [];
  if (tana.setState) rows.push({ id: 'status', group, icon: 'status', label: 'Set status', subBase: 'Set status to', hint: Object.fromEntries(STATES)[stateOf(doc)] || '', keepOpen: true, subAlways: true, run: () => openStatusPalette(ctx), sub: () => statusRows('', ctx) });
  if (tana.taskMeta && tana.setAssignees) {
    loadTaskMeta(doc.id);
    const meta = taskMetaById.get(doc.id), hint = meta && meta.assignees.length ? meta.assignees.map(memberName).join(', ') : meta ? 'Unassigned' : 'Loading…';
    rows.push({ id: 'assign', group, icon: 'member', label: 'Edit assignees', hint, keepOpen: true, run: () => openAssigneePalette(doc, ctx), sub: async () => { await membersLoaded(); if (!taskMetaById.has(doc.id)) taskMetaById.set(doc.id, await tana.taskMeta(doc.id)); return assigneeRows('', doc); } });
  }
  // "Assign to Robin" sets the assignee outright, where Edit assignees toggles one; the members are only fetched once
  // the query reaches the row
  if (tana.setAssigneesMany) rows.push({ id: 'assignTo', group, icon: 'assignTo', label: 'Assign to …', keepOpen: true, run: () => openManyAssigneePalette(ctx), sub: async () => { await membersLoaded(); return manyAssigneeRows('', ctx); } });
  return rows;
}
// the member list as a promise, for a second level offered from the first before anyone opened it
async function membersLoaded() { if (!(members && members.length) && tana.members) members = await tana.members(); }
// With rows selected, what acts on them comes first: at that moment the palette is about the selection, not the app.
// With nothing selected the same actions apply to the current node — the zoomed document, or the one under the
// caret — under their own heading and without a count in the label.
// Every row carries a stable id even though its label counts the selection, because Cmd+Shift+K records a hotkey per
// id and a hotkey only fires with the palette closed — which is exactly when a selection is live.
function selectionRows() {
  const selected = selKeys(), keys = selected.length ? selected : palDoc && !palDoc.appPage && items.has(palDoc.id) ? [palDoc.id] : [];
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
  if (!selected.length && !zoom && nodes.length === 1 && nodes[0].kind === 'document' && zoomable(nodes[0])) {
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
    rows.push({ id: 'toggleDone', group, icon: 'apply', label: item.node.done ? 'Reopen' : 'Complete', run: () => toggleDone(item, true) });
  }
  rows.push(...taskActionRows(group));
  if (nodes.length && tana.insertAfter && tana.setText) {
    if (tana.todayNode) rows.push({ id: 'addToday', group, icon: 'addTo', label: `Add${count(nodes.length, 'item')} to Today`, run: () => addToDateNode(nodes, 'today') });
    if (tana.todayNode) rows.push({ id: 'addTomorrow', group, icon: 'addTo', label: `Add${count(nodes.length, 'item')} to Tomorrow`, run: () => addToDateNode(nodes, 'tomorrow') });
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
  // A type is archived rather than deleted, one at a time, as Tana's own type page does it: it leaves the Types list
  // and every picker, and Cmd+Z or Cmd+K "Archived types" brings it back.
  if (its.length === 1 && tana.archiveDocument && its[0].node.kind === 'document' && TYPE_NODE.test(its[0].docId)) {
    rows.push({ id: 'archive', group, icon: 'type', label: 'Archive type', run: () => archiveType(its[0]) });
  }
  return rows;
}
// Every selected node lands as a mention at the end of the day's or the week's node — the reference Tana itself
// writes for an @ link, so the two documents stay independent.
function addToDateNode(nodes, target) {
  return run(async () => {
    const label = target === 'week' ? 'This Week' : target === 'tomorrow' ? 'Tomorrow' : 'Today';
    const docId = target === 'week' ? await tana.weekNode() : await tana.todayNode(target === 'tomorrow' ? 1 : 0);
    for (const node of nodes) {
      const block = await tana.insertAfter(docId, null, node.text || '');
      await tana.setText(docId, block, [{ mention: { uri: node.id, label: node.text || '' } }]);
    }
    showNote(`Added ${nodes.length} ${nodes.length === 1 ? 'item' : 'items'} to ${label}`);
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
async function archiveType(it) {
  sel = null;
  await run(async () => {
    const access = await tana.accessOptions(it.docId);
    if (!access?.archivable) throw new Error(access?.reason || 'This type cannot be archived');
    await tana.archiveDocument(it.docId); invalidateNode(it.docId);
    await loadRoots();
  });
  render(true);
}
