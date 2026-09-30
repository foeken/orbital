'use strict';
// The Graph pane (issue #462): what the document on screen is linked to (api.related). Rows here are edges, not nodes:
// they open, and a task row toggles, but nothing here ever takes a caret (docs/OUTLINER.md §18).
// A window has at most one: a page the shell opened with links=1 (shell.js), which draws only #rail, full width, for
// the document of the pane it follows — the focused one. Every other page draws no rail and tells the shell which
// document it is on (tellDoc), which the shell passes to the Graph pane (follow).
const railEl = $('rail');
const toShell = (msg) => { if (window.frameElement) window.parent.postMessage(msg, '*'); };
if (LINKS) {
  document.documentElement.classList.add('links'); // styles.css: the outline column goes, the rail fills the page
  addEventListener('focus', () => { if (!railEl.contains(document.activeElement)) focusRail(); }); // the keys arrive in its rows (Focus graph, a click on its tab)
  // With no row to hold the keys (nothing linked, every section folded, rows still coming) Escape gives them back all the
  // same, before the page's own Escape (renderer/events.js) steps the workspace out instead; a row answers it itself (railMove)
  document.addEventListener('keydown', (e) => {
    const at = document.activeElement;
    if (e.key !== 'Escape' || !(at === document.body || (railEl.contains(at) && !at.classList.contains('rrow')))) return;
    e.preventDefault(); e.stopImmediatePropagation(); toShell({ orbital: 'open' });
  }, true);
}
// A page tells the shell which document it is on, once per change, with the row it has for it, so the Graph pane can
// open it without asking main. A view, a saved search, an app page or a draft is none. Focus says which page to follow.
let toldDoc;
function tellDoc(docId) {
  if (docId === toldDoc) return;
  toldDoc = docId;
  const doc = docId && docOf(docId);
  toShell({ orbital: 'doc', docId, doc: doc ? JSON.parse(JSON.stringify(doc)) : null }); // data only: a row is plain, and postMessage throws on anything else
}
if (!LINKS && typeof addEventListener === 'function') addEventListener('focus', () => toShell({ orbital: 'focus' }));
// The shell hears a page only once its iframe has loaded (shell.js windowOf), so what the first render told before that
// was lost; its layout message, sent at that load and after every change, has the title and the document told again.
function retell() {
  retellTitle(true); // with the tab glyph it told (renderer/render.js)
  toldPlace = undefined; tellPlace(); // and where it is, so the other panes know (renderer/edit.js, #533)
  if (toldDoc !== undefined) { const docId = toldDoc; toldDoc = undefined; tellDoc(docId); }
}
// The Graph pane goes where the followed page is: its document, or, for a page on no document, the empty rail. Only
// this moves it: anywhere else it is asked to go (Cmd+K, a search, a view) is the followed page's move (openDoc, setView).
// A follow that has to read its document first applies only if no newer one began meanwhile (followSeq): a pane focused
// while an older read was on its way must not be taken over by it (#463 review).
let followingNow = false, followSeq = 0;
async function follow(docId, doc) {
  if (typeof docId !== 'string' || !docId || docId.startsWith('orbital:')) docId = null; // an app page (Timeline, …) is no document
  const seq = ++followSeq; // before the check below: back on the document on screen, an older read still on its way is dropped too
  if ((zoom && !zoom.nodeId ? zoom.docId : null) === docId) return;
  if (docId && doc && typeof doc === 'object' && !docOf(docId)) extra.set(docId, doc);
  if (docId && !docOf(docId)) { // no row sent: read the one the followed page is on, as goTo would
    try { const n = await tana.node(docId); if (!docOf(docId)) extra.set(docId, { ...n, text: n.title || '', hasChildren: true }); } catch { return; } // unreadable: the followed page says why
    if (seq !== followSeq) return;
  }
  followingNow = true;
  try { if (docId) openDoc(docId); else setView(view); } finally { followingNow = false; }
}
// A row opens in the page being followed, which takes the keys; outside the shell (the mock) here.
const openLink = (id) => (LINKS && window.frameElement ? toShell({ orbital: 'open', id }) : goTo(id));
const relatedBy = new Map(); // docId -> related payload, or null while the first one is loading
const relatedStale = new Set(); // ids whose payload is known to be behind: re-read, but keep showing the old one
const railClosed = new Set(pref('railClosed', []));
// api.related for the zoomed document, fetched once per id; a failure simply leaves the rail empty.
// Not before the sync client exists: main answers then with "not connected to Tana" and logs the throw
// (the same readiness rule loadAccess and ensureLoaded follow); the render the connection brings asks again.
// A document that changed is re-read the same way, but its payload stays on screen until the new one lands: adding
// a row to a page is a change to that page, and dropping the cache made the whole sidebar blank and come back on
// every edit. The mark is consumed when the fetch starts, so a render during that fetch does not ask again.
// lite: a row opened in a list, which draws its fields and nothing of the sidebar (main/related.js related, #579). A
// lite answer on hand does for another lite read; the sidebar, asking for the whole, reads again over it.
function loadRelated(docId, lite = false) {
  if (!connected || !tana.related || !isRealId(docId)) return;
  const have = relatedBy.get(docId), upgrade = !lite && !!have && have.lite === true;
  const stale = relatedStale.delete(docId);
  if (relatedBy.has(docId) && !stale && !upgrade) return; // null: a read is out, and the render its answer asks for comes back here
  const whole = !lite || (!!have && !have.lite); // a page read whole stays whole
  if (!relatedBy.has(docId)) relatedBy.set(docId, null); // nothing to show yet: this is the first read
  const since = releases;
  tana.related(docId, whole ? undefined : { lite: true }).then((data) => {
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
    // a type's definitions are Group choices on a mixed list (renderer/views.js pageFieldDefs): an open ⌘K asked for
    // them before they were in, and keeps its folded choices, so it is told to ask again
    if (data && data.definitions && !palette.hidden) { subCache.clear(); renderPalette(); }
  }, () => { if (!relatedBy.get(docId)) relatedBy.delete(docId); });
}
// This document's relations have moved on (an edit, a pin): read them again without taking the sidebar down. Only a
// sidebar this page has read: one it never read is read fresh when it is drawn (loadRelated), and every document a
// view subscribes announces its first bootstrap as a change, which read the sidebars of ~94 documents per page at boot.
// always: read it even so, for the page on screen whose first read may have failed (main's push, below).
function refreshRelated(docId, always) { if (docId && (always || relatedBy.has(docId))) { relatedStale.add(docId); loadRelated(docId, !always && relatedBy.get(docId)?.lite === true); } } // read again as it was read: a list row's fields stay fields
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
  row.onclick = () => openLink(node.id);
  row.onkeydown = (e) => railKey(e, node, row);
  return row;
}
function toggleRelated(node) {
  if (demoMode || !canEditNode(node) || !tana.setDone) return;
  // node is the row's own copy (railRow(asDoc(…))): the sidebar is drawn again from relatedBy, so that changes too
  if (acceptsFirst(node)) { node.stateType = 'open'; patchCopies(node.id, { stateType: 'open' }); run(async () => { await tana.setState(node.id, 'open'); }); return render(true); } // Inbox: accept first, complete next
  const done = node.done ? 0 : 1;
  node.done = done; node.stateType = done ? 'closed' : 'open';
  if (done) { justDone.set(node.id, Date.now()); popSound(); }
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
  if (e.key === 'Escape' || (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); toShell({ orbital: 'open' }); return true; } // back to the page it follows
  return false;
}
function railKey(e, node, row) {
  if (railMove(e, row)) return;
  if (e.key === 'Enter') { e.preventDefault(); openLink(node.id); }
  else if (e.key === ' ') { e.preventDefault(); toggleRelated(node); }
  else if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleRailSection(row.dataset.section); } // collapse the section the focused row is in
  else if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (railClosed.has(row.dataset.section)) toggleRailSection(row.dataset.section); }
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
// A saved search is a list, like the views: no links (issue #234).
function renderRail(parent) {
  const docId = parent && parent.node.kind === 'document' && !parent.node.draft && !String(parent.docId).startsWith(SEARCH_ID) ? parent.docId : null;
  // a page is no Graph pane, but its fields under the title come with the same read (api.related): still asked for here
  if (!LINKS) { railEl.hidden = true; if (docId) loadRelated(docId); drawMeetingBtn(docId); drawLinksBtn(docId); return tellDoc(docId); }
  const active = document.activeElement, keep = active && active.classList && active.classList.contains('rrow') ? active.dataset.id : null;
  railEl.replaceChildren();
  railEl.hidden = false;
  watchRail(docId);
  const note = (text) => { const el = document.createElement('div'); el.className = 'rempty'; el.textContent = text; railEl.append(el); };
  if (!docId) return note('Open a document to see its graph.');
  loadRelated(docId);
  const data = relatedBy.get(docId);
  // No Details: who it is for and who can see it are fields under the title (renderer/fields.js), and opening it in
  // Tana, joining its call and its pins are Cmd+K rows (renderer/palette.js)
  // "Notes" is what api.related calls them; in the sidebar they read as References
  const groups = railGroups(data);
  const changes = (data && data.changes) || [];
  if (!groups.length && !changes.length) return note(data === undefined || data === null ? '' : 'Nothing links here yet.');
  const sectionHead = (label) => { // every sidebar section collapses the same way
    const head = document.createElement('button');
    head.className = 'rhead' + (railClosed.has(label) ? ' closed' : '');
    head.tabIndex = -1; head.innerHTML = CHEV; head.append(label);
    head.setAttribute('aria-expanded', railClosed.has(label) ? 'false' : 'true'); // the caret is a disclosure, and says so
    head.onclick = () => foldSection(head, () => toggleRailSection(label), () => [...railEl.querySelectorAll('.rhead')].find((h) => h.textContent === label));
    railEl.append(head);
    return !railClosed.has(label);
  };
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

// The Graph switch is the page's own, among its buttons at the top right (index.html .navbtns, which the shell copies
// into the tab bar or the window's header), since what it shows is this page's links: there on a page with a document
// (renderRail's docId), gone on a view or a saved search, and pressed while the window has a Graph pane. It runs Cmd+K's
// Show/Hide graph row (renderer/palette.js railToggle), so the pane opens beside this page.
const linksBtn = $('navLinks');
let linksDoc = null;
function drawLinksBtn(docId = linksDoc) {
  linksDoc = docId;
  linksBtn.hidden = !docId || !isRealId(docId);
  const label = windowPanes.links ? 'Hide graph' : 'Show graph';
  keyTitle(linksBtn, label, 'railToggle');
  linksBtn.setAttribute('aria-label', label);
  linksBtn.setAttribute('aria-pressed', String(!!windowPanes.links));
  if (!linksBtn.childNodes.length) addIcon(linksBtn, 'graph'); // the glyph never changes, like the other buttons'
}
linksBtn.onmousedown = (e) => e.preventDefault(); // the caret stays in its row, as with the other header buttons
linksBtn.onclick = () => runAction('railToggle');
// The meeting the page belongs to (#630): a task Tana's AI filed under it, a note written in it. Left of the Graph
// switch, in the words of the meeting glyph on a task's row (renderer/meeting.js meetingLinkEl), and a click opens the
// meeting, which forwards to its write-up. main names it with the page's read (main/related.js), never on the write-up.
const meetingBtn = $('navMeeting');
function drawMeetingBtn(docId) {
  const m = docId && isRealId(docId) ? (relatedBy.get(docId) || {}).meeting : null;
  meetingBtn.hidden = !m;
  if (!m) return;
  const day = m.start ? new Date(m.start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const label = 'From ' + (m.title ? demoText(m.title, m.id) : 'a meeting') + (day ? ' · ' + day : '');
  meetingBtn.title = label; meetingBtn.setAttribute('aria-label', label); // icon only, so the name comes from here
  meetingBtn.dataset.meeting = m.id;
  if (!meetingBtn.childNodes.length) addIcon(meetingBtn, 'meeting');
}
meetingBtn.onmousedown = (e) => e.preventDefault();
meetingBtn.onclick = () => { const id = meetingBtn.dataset.meeting; if (id && !meetingBtn.hidden) run(() => goTo(id)); };
