'use strict';
// The zoomed document: page title editing, pin state, sensitive marks.

// ---- page title (zoomed into a document): edits go through the same debounce as node text; Enter -> first child, Esc restores ----
titleEl.addEventListener('input', () => { const item = items.get(titleEl.dataset.key); if (!item) return; if (item.node.draft) item.node.text = titleEl.textContent; if (item.node.draft && !item.busy) { item.busy = true; materialise(item, titleEl); } else if (!item.node.draft) scheduleSave(item, [{ text: titleEl.textContent }]); });
titleEl.addEventListener('blur', () => { const item = items.get(titleEl.dataset.key); if (item?.node.draft && !item.busy && !titleEl.textContent) { zoom = null; return dropDraft(item); } flush(titleEl.dataset.key); });
titleEl.addEventListener('keydown', (e) => {
  const item = items.get(titleEl.dataset.key);
  if (!titleEl.isContentEditable) { // a read-only title, reached by ↑: ↓ and ↩ go back down, Escape leaves it, ⌘K is the document's
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter') { const first = fieldValues()[0] || texts()[0]; if (first) { e.preventDefault(); setCaret(first, 0); } }
    else if (e.key === 'Escape') { e.preventDefault(); titleEl.blur(); }
    return;
  }
  if (!item) return;
  if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); removeDocument(item); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleDone(item); }
  else if (e.key === 'Enter') { e.preventDefault(); flush(item.key); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); dropPending(item.key); titleEl.textContent = item.node.text; titleEl.blur(); }
  else if (e.key === 'ArrowDown' && atEdge(titleEl, 'down')) { const first = fieldValues()[0] || texts()[0]; if (first) { e.preventDefault(); flush(item.key); setCaret(first, 0); } } // down through the fields, then the outline
});
titleEl.addEventListener('blur', () => titleEl.removeAttribute('tabindex')); // a read-only title is a stop only while ↑ has it (renderer/edit.js focusAbove)
// the document Cmd+K context actions apply to: the zoomed one, else the document whose node is focused
// Rename, on the tab (shell.js) and in Cmd+K: the heading back where a page hides it (a chat), its words selected. Only
// while it can be typed in: titleEl carries a key then (isContentEditable reads false while it is hidden).
function renameTitle() {
  if (zoom && !zoom.nodeId && tana.renameAgentChat && isAgentChat(zoom.docId) && zoom.docId !== AGENT_CHAT_NEW && !agentChatFixed(zoom.docId)) { renameAgentChat(zoom.docId); return true; } // a chat that is a Codex thread: renamed there too
  if (!titleEl.dataset.key) return false;
  document.documentElement.classList.add('renaming');
  titleEl.focus();
  getSelection().selectAllChildren(titleEl);
  return true;
}
// The caret going up into a title a tab bar hides (a saved search's, styles.css html.listing): shown as Rename shows it,
// until the caret leaves it (renderer/app.js), so ↑ never aims at a title that cannot be seen (#764)
function revealTitle() {
  if (titleEl.dataset.key && !titleEl.getClientRects().length) document.documentElement.classList.add('renaming');
}
function currentDoc() {
  const f = focused(), item = f && items.get(f.key);
  // A row that is a document in its own right — a task listed in a view, or one referenced from a date page — is the
  // current node ahead of the page holding it. Child rows carry their document's id, so without this the caret in a
  // task under a date resolves to the date, and Cmd+K offers nothing to set a status on.
  // A saved search's or a type's page is a list of other documents: a caret in a task's own lines there is that
  // task's, never the page's (Assign to Agent handed a Dot the My Tasks search itself).
  const own = item ? referenceTarget(item.node) || (item.node.kind === 'document' ? item.node : null) : null;
  const docId = own ? own.id : zoom && !(item && (onSearchPage() || onTypePage())) ? zoom.docId : item ? item.docId : null;
  const d = (docId && (allDocs().find((x) => x.id === docId) || extra.get(docId))) || own; // the listed copy is fresher; a referenced one may be in neither
  return d && !d.draft ? d : null;
}
// ---- pins (api.pinState / pin / unpin): what the palette needs is whether this document is pinned, not the tree ----
function loadPins() {
  const doc = palDoc;
  loadPinned(true); // a pin was just written, or something changed globally: the marks on the rows are re-read with it
  if (!doc || !tana.pinState || doc.appPage) { pinInfo = null; return; } // a page of the app's own (Notifications) has no pins
  const mine = ++pinRead; // an older read that answers late, for this document or another, changes nothing
  tana.pinState(doc.id).then((s) => {
    if (mine !== pinRead) return;
    pinInfo = s ? { docId: doc.id, ...s } : null;
    pinFailed = null;
    if (!palette.hidden && (palMode === 'cmd' || palMode === 'pins')) renderPalette();
  }, (e) => {
    if (mine !== pinRead) return;
    pinFailed = { docId: doc.id, message: errorText(e) };
    if (pinInfo && pinInfo.docId === doc.id) pinInfo = null; // what it said before is no longer known to hold: the page shows the failure
    showError(e);
    if (!palette.hidden && palMode === 'pins') renderPalette();
  });
}
function holdDatePin(doc) { if (doc && groupBy() === 'responsibility' && isTask(doc)) holdRow(doc); }
function pinAction(op, target, date) { if (target === 'today' && typeof holdDatePin === 'function') holdDatePin(palDoc); run(async () => { await tana[op](pinInfo.docId, target, date); loadPins(); }); } // date: a local YYYY-MM-DD for the 'today' target; omitted means today
// ⌘K Pin to today / tomorrow and their keys: pin that day, or take the pin off when it is there. Whether it is there
// is read at the press, since a key fires with the palette closed and pinInfo is then another node's (#273).
function toggleDatePin(doc, date) {
  holdDatePin(doc);
  return run(async () => {
    const state = await tana.pinState(doc.id);
    await tana[state && (state.dates || []).includes(date) ? 'unpin' : 'pin'](doc.id, 'today', date);
    loadPins();
  });
}
// A pin on a meeting or a space is a write to that hub's own pinnedItems rather than to your sidebar or pin-map, so
// it goes through api.unpinFrom. Both sidebars are re-read: the item leaves a section of the hub's page as it goes.
function unpinFromHub(hubId) {
  const docId = pinInfo.docId;
  run(async () => { await tana.unpinFrom(hubId, docId); refreshRelated(hubId); refreshRelated(docId); loadPins(); render(); });
}
// The other direction on a hub, and the last of the pin writes: putting a document on a meeting or a space. It is
// deliberately not wrapped in run() — every caller already is, and run() chains on one queue, so a run() awaited
// from inside another would wait for itself. One write, and the two sidebar payloads it sends for a re-read.
async function pinDocToMeeting(meetingId, docId) {
  await tana.pinTo(meetingId, docId);
  refreshRelated(meetingId); refreshRelated(docId); render();
}
// The same write from the search palette's pin picker, which carries the hub and the document it was opened for.
function pinResult(ctx, node) {
  return run(async () => {
    await tana.pinTo(ctx.pinHub, node.id);
    refreshRelated(ctx.pinHub); refreshRelated(ctx.docId); render();
  });
}
// ---- Edit pins: where this document is pinned, on a page of its own (⌘K, or the pin mark on the row) ----
// Unpinning is what the page is for, so every pin it lists runs one, and the page stays open to show the rest.
const PIN_GROUP = 'Pinned · ↩ unpins';
const pinDateLabel = (date) => { const near = date === localDate() ? 'Today' : date === localDate(1) ? 'Tomorrow' : date === localDate(-1) ? 'Yesterday' : ''; return near ? near + ' · ' + date : date; };
function editPinRows(q) {
  if (!pinInfo || !palDoc || pinInfo.docId !== palDoc.id) {
    const failed = pinFailed && palDoc && pinFailed.docId === palDoc.id; // a read that failed says why, and stops saying Loading… (#394)
    return [{ group: PIN_GROUP, label: failed ? pinFailed.message : 'Loading…', disabled: true, note: true }];
  }
  const listed = [];
  if (pinInfo.sidebar) listed.push({ group: PIN_GROUP, icon: 'pinned', label: 'Sidebar', keepOpen: true, run: () => pinAction('unpin', 'sidebar') });
  for (const date of [...pinInfo.dates].sort()) listed.push({ group: PIN_GROUP, icon: 'pinDate', label: pinDateLabel(date), keepOpen: true, run: () => pinAction('unpin', 'today', date) });
  // and the meetings and spaces it hangs on, which are pins on those documents rather than on yours (api.unpinFrom)
  for (const hub of pinInfo.hubs || []) listed.push({ group: PIN_GROUP, icon: hub.kind === 'space' ? 'space' : 'meeting', label: demoText(hub.title || 'Untitled', hub.id),
    hint: hub.kind === 'space' ? 'Space' : 'Meeting', keepOpen: true, run: () => unpinFromHub(hub.id) });
  // and the other direction from the same page: the sidebar pin is asked for nowhere else, and the two days are the
  // ones ⌘K offers. A day it is already pinned to is listed above instead, so it is not offered twice.
  const adds = [];
  if (!pinInfo.sidebar && tana.placePin) adds.push({ group: 'Pin it', icon: 'pinned', label: 'Pin to sidebar …', hint: 'Choose a section', keepOpen: true, run: () => openPinSidebarPalette(palDoc, () => openPinsPalette(palDoc)) });
  for (const [offset, label] of [[0, 'Pin to today'], [1, 'Pin to tomorrow']]) {
    const date = localDate(offset); // the day is computed here, as the ⌘K rows do it: main defaults to today when none comes with the call
    if (!pinInfo.dates.includes(date)) adds.push({ group: 'Pin it', icon: 'pinDate', label, keepOpen: true, run: () => pinAction('pin', 'today', date) });
  }
  // and onto a meeting, which is a pin on that meeting's own document (docs/PINNING.md §4) rather than one of the
  // three above: the same picker ⌘K opens, told to come back here when Escape leaves it. Offered whatever else is
  // pinned, because a document can hang on more than one meeting.
  if (tana.searchPreview && tana.pinTo && isRealId(palDoc.id)) {
    const doc = palDoc;
    adds.push({ group: 'Pin it', icon: 'meetingPin', label: 'Pin to meeting …', hint: 'Choose a meeting', keepOpen: true, run: () => openMeetingPicker(doc, () => openPinsPalette(doc)) });
  }
  // one query over both halves, so typing narrows what can be pinned as well as what is; with no pin left on screen
  // the page says which of the two silences that is — none match what was typed, or there are none at all
  const rows = [...listed, ...adds].filter((row) => fuzzyMatch(row.label, q));
  if (!rows.some((row) => row.group === PIN_GROUP)) rows.unshift({ group: PIN_GROUP, label: listed.length ? 'No pin matches' : 'Not pinned anywhere', disabled: true });
  return rows;
}
function openPinsPalette(doc) {
  palDoc = doc; pinInfo = null; pinFailed = null; loadPins();
  openPage('pins', 'Edit pins', { rows: editPinRows, back: BACK_TO_COMMANDS });
}
// ---- Pin to sidebar …: which of the window's sidebar sections it goes in (shell.js draws them) ----
// Pinned is the top level, then your sections as Tana keeps them (main/pins.js pinSections), and a name typed that is
// no section yet makes one. A document already in the sidebar moves to the one picked, as Tana's own placePin does.
const PIN_SIDEBAR_GROUP = 'Pin to sidebar';
let pinSidebarDoc = null, pinSidebarSections = null, pinSidebarFailed = '';
function pinSidebarRows(q, typed) {
  const doc = pinSidebarDoc, words = (typed || '').trim();
  if (!doc) return [];
  if (pinSidebarFailed) return [{ group: PIN_SIDEBAR_GROUP, label: pinSidebarFailed, disabled: true, note: true }];
  if (!pinSidebarSections) return [{ group: PIN_SIDEBAR_GROUP, label: 'Loading…', disabled: true, note: true }];
  const place = (section, label) => () => run(async () => { await tana.placePin(doc.id, section, label); loadPins(); });
  const rows = [{ group: PIN_SIDEBAR_GROUP, icon: 'pinned', label: 'Pinned', hint: 'No section', run: place(null) },
    ...pinSidebarSections.map((s) => ({ group: PIN_SIDEBAR_GROUP, icon: 'group', label: demoText(s.label, 'section'), hint: s.count === 1 ? '1 pin' : s.count + ' pins', run: place(s.id) }))]
    .filter((row) => fuzzyMatch(row.label, q));
  if (words && !pinSidebarSections.some((s) => s.label.toLowerCase() === words.toLowerCase())) rows.push({ group: 'Add', icon: 'createNew', label: 'New section \u201C' + words + '\u201D', run: place(null, words) });
  else if (!words) rows.push({ group: 'Add', icon: 'createNew', label: 'New section …', hint: 'Type its name', disabled: true });
  return rows;
}
function openPinSidebarPalette(doc, back) {
  pinSidebarDoc = doc; pinSidebarSections = null; pinSidebarFailed = '';
  tana.pinSections().then((sections) => { if (pinSidebarDoc !== doc) return; pinSidebarSections = sections; if (!palette.hidden && palMode === 'pinSidebar') renderPalette(); },
    (e) => { if (pinSidebarDoc !== doc) return; pinSidebarFailed = errorText(e); if (!palette.hidden && palMode === 'pinSidebar') renderPalette(); });
  openPage('pinSidebar', 'Pin to sidebar: pick a section, or type a new one', { rows: pinSidebarRows, back: back || BACK_TO_COMMANDS });
}
// ---- Pin to date: a day typed in words, read by a fixed set of rules rather than a model ----
// The page shows the day it read before Enter, so what gets pinned is always what was on screen, with no key, no
// network and no latency. A weekday is the next one after today ("sunday" on a Sunday is a week on), a day and month
// without a year is the next time it comes round, and numbers are read day first (12/10 is 12 October).
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const namedIn = (list, word) => (word && word.length >= 3 ? list.findIndex((name) => name.startsWith(word)) : -1);
function parseDay(text, now = new Date()) {
  const s = String(text || '').trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  const y = now.getFullYear(), mo = now.getMonth(), d = now.getDate(), at = (days) => isoDay(new Date(y, mo, d + days));
  const near = { today: 0, tod: 0, tonight: 0, tomorrow: 1, tmr: 1, tom: 1, yesterday: -1 }[s];
  if (near !== undefined) return at(near);
  if (s === 'next week') return at(((8 - now.getDay()) % 7) || 7); // the coming Monday
  let m = s.match(/^(?:in )?(\d+) ?(d|days?|w|wks?|weeks?|m|months?)$/);
  if (m) {
    const n = +m[1];
    if (m[2][0] === 'd') return at(n);
    if (m[2][0] === 'w') return at(7 * n);
    return isoDay(new Date(y, mo + n, Math.min(d, new Date(y, mo + n + 1, 0).getDate()))); // 31 Jan + 1 month is 28/29 Feb
  }
  const wd = namedIn(WEEKDAYS, s.replace(/^(?:next|this|on) /, ''));
  if (wd >= 0) return at(((wd - now.getDay() + 6) % 7) + 1);
  // a calendar day: its year if one was given, else the next time it comes round
  const day = (yy, mm, dd) => {
    if (mm < 0) return null;
    const year = yy == null ? y : yy < 100 ? 2000 + yy : yy, date = new Date(year, mm, dd);
    if (date.getMonth() !== mm || date.getDate() !== dd) return null; // 31/2 is not a day
    return yy == null && isoDay(date) < at(0) ? isoDay(new Date(year + 1, mm, dd)) : isoDay(date);
  };
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return day(+m[1], m[2] - 1, +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/))) return day(m[3] ? +m[3] : null, m[2] - 1, +m[1]);
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]+)(?: (\d{4}))?$/))) return day(m[3] ? +m[3] : null, namedIn(MONTHS, m[2]), +m[1]);
  if ((m = s.match(/^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/))) return day(m[3] ? +m[3] : null, namedIn(MONTHS, m[1]), +m[2]);
  return null;
}
const PIN_DATE_GROUP = 'Pin to date';
let pinDateDoc = null;
function pinDateRows(q, typed) {
  const doc = pinDateDoc, words = (typed || '').trim(), date = parseDay(words);
  if (!doc) return [];
  if (!words) return [{ group: PIN_DATE_GROUP, icon: 'pinDate', label: 'Type a day: sunday, in 3 days, 12 oct, 12/10', disabled: true }];
  if (!date) return [{ group: PIN_DATE_GROUP, icon: 'pinDate', label: 'No day in \u201C' + words + '\u201D', disabled: true }];
  const long = new Date(date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const near = date === localDate() ? 'Today' : date === localDate(1) ? 'Tomorrow' : '';
  const pinned = !!pinInfo && pinInfo.docId === doc.id && pinInfo.dates.includes(date);
  return [{ group: PIN_DATE_GROUP, icon: 'pinDate', label: long, hint: pinned ? 'Already pinned' : near ? near + ' \u21A9' : '\u21A9', disabled: pinned,
    run: () => { if (typeof holdDatePin === 'function') holdDatePin(doc); return run(async () => { await tana.pin(doc.id, 'today', date); loadPins(); }); } }];
}
function openPinDatePalette(doc) {
  pinDateDoc = doc; openPage('pinDate', 'Pin to date\u2026', { rows: pinDateRows, back: BACK_TO_COMMANDS, typed: true });
}
function invalidatePinCaches(id) {
  if (pinInfo && pinInfo.docId === id) pinInfo = null;
  forgetRecent(id);
}
function invalidateNode(id) {
  invalidatePinCaches(id);
  extra.delete(id); kids.delete(id); fresh.delete(id); taskMetaById.delete(id); relatedBy.delete(id);
  for (const section of views) section.nodes = section.nodes.filter((node) => node.id !== id);
  // and wherever a zoomed page lists it as one of its rows (a saved search's results, a space's contents)
  for (const [docId, rows] of kids) if (Array.isArray(rows)) kids.set(docId, rows.filter((node) => node.id !== id));
  palRows = palRows.filter((row) => row.node?.id !== id);
  if (palDoc?.id === id) { palDoc = null; pinInfo = null; }
  if (zoom?.docId === id) leaveGonePage(id); // the page it was: back to the one before it (edit.js), else the Library
}
function setSensitiveMark(ids, on) {
  run(async () => {
    for (const id of [ids].flat()) {
      await tana.setSensitive(id, on);
      if (on) sensitiveIds.add(id); else sensitiveIds.delete(id);
    }
    refreshSensitive();
  });
}
function toggleSensitiveVisibility() {
  sensitiveVisible = !sensitiveVisible;
  localStorage.setItem('sensitiveVisible', sensitiveVisible ? '1' : '0'); // remembered for the next launch, on this machine
  refreshSensitive();
}
// Its button is the app's, in the window's header (shell.js), which asks the page in front and draws the state from
// the same storage; every other page follows here.
window.addEventListener('storage', (e) => { if (e.key === 'sensitiveVisible' && (e.newValue === '1') !== sensitiveVisible) toggleSensitiveVisibility(); }); // switched in another page
