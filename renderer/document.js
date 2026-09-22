'use strict';
// The zoomed document: page title editing, pin state, sensitive marks.

// ---- page title (zoomed into a document): edits go through the same debounce as node text; Enter -> first child, Esc restores ----
titleEl.addEventListener('input', () => { const item = items.get(titleEl.dataset.key); if (!item) return; if (item.node.draft) item.node.text = titleEl.textContent; if (item.node.draft && !item.busy) { item.busy = true; materialise(item, titleEl); } else if (!item.node.draft) scheduleSave(item, [{ text: titleEl.textContent }]); });
titleEl.addEventListener('blur', () => { const item = items.get(titleEl.dataset.key); if (item?.node.draft && !item.busy && !titleEl.textContent) { zoom = null; return dropDraft(item); } flush(titleEl.dataset.key); });
titleEl.addEventListener('keydown', (e) => {
  const item = items.get(titleEl.dataset.key);
  if (!titleEl.isContentEditable || !item) return;
  if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); removeDocument(item); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleDone(item); }
  else if (e.key === 'Enter') { e.preventDefault(); flush(item.key); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); dropPending(item.key); titleEl.textContent = item.node.text; titleEl.blur(); }
  else if (e.key === 'ArrowDown' && atEdge(titleEl, 'down')) { const first = fieldValues()[0] || texts()[0]; if (first) { e.preventDefault(); flush(item.key); setCaret(first, 0); } } // down through the fields, then the outline
});
// the document Cmd+K context actions apply to: the zoomed one, else the document whose node is focused
function currentDoc() {
  const f = focused(), item = f && items.get(f.key);
  // A row that is a document in its own right — a task listed in a view, or one referenced from a date page — is the
  // current node ahead of the page holding it. Child rows carry their document's id, so without this the caret in a
  // task under a date resolves to the date, and Cmd+K offers nothing to set a status on.
  const own = item ? referenceTarget(item.node) || (item.node.kind === 'document' ? item.node : null) : null;
  const docId = own ? own.id : zoom ? zoom.docId : item ? item.docId : null;
  const d = (docId && (allDocs().find((x) => x.id === docId) || extra.get(docId))) || own; // the listed copy is fresher; a referenced one may be in neither
  return d && !d.draft ? d : null;
}
// ---- pins (api.pinState / pin / unpin): what the palette needs is whether this document is pinned, not the tree ----
function loadPins() {
  const doc = palDoc;
  loadPinned(true); // a pin was just written, or something changed globally: the marks on the rows are re-read with it
  if (!doc || !tana.pinState) { pinInfo = null; return; }
  tana.pinState(doc.id).then((s) => {
    pinInfo = s ? { docId: doc.id, ...s } : null;
    if (!palette.hidden && (palMode === 'cmd' || palMode === 'pins')) renderPalette();
  }, showError);
}
function pinAction(op, target, date) { run(async () => { await tana[op](pinInfo.docId, target, date); loadPins(); }); } // date: a local YYYY-MM-DD for the 'today' target; omitted means today
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
  if (!pinInfo || !palDoc || pinInfo.docId !== palDoc.id) return [{ group: PIN_GROUP, label: 'Loading…', disabled: true }];
  const listed = [];
  if (pinInfo.sidebar) listed.push({ group: PIN_GROUP, icon: 'pinned', label: 'Sidebar', keepOpen: true, run: () => pinAction('unpin', 'sidebar') });
  for (const date of [...pinInfo.dates].sort()) listed.push({ group: PIN_GROUP, icon: 'pinDate', label: pinDateLabel(date), keepOpen: true, run: () => pinAction('unpin', 'today', date) });
  // and the meetings and spaces it hangs on, which are pins on those documents rather than on yours (api.unpinFrom)
  for (const hub of pinInfo.hubs || []) listed.push({ group: PIN_GROUP, icon: hub.kind === 'space' ? 'space' : 'meeting', label: hub.title || 'Untitled',
    hint: hub.kind === 'space' ? 'Space' : 'Meeting', keepOpen: true, run: () => unpinFromHub(hub.id) });
  // and the other direction from the same page: the sidebar pin is asked for nowhere else, and the two days are the
  // ones ⌘K offers. A day it is already pinned to is listed above instead, so it is not offered twice.
  const adds = [];
  if (!pinInfo.sidebar) adds.push({ group: 'Pin it', icon: 'pinned', label: 'Pin to sidebar', keepOpen: true, run: () => pinAction('pin', 'sidebar') });
  for (const [offset, label] of [[0, 'Pin to today'], [1, 'Pin to tomorrow']]) {
    const date = localDate(offset); // the day is computed here, as the ⌘K rows do it: main defaults to today when none comes with the call
    if (!pinInfo.dates.includes(date)) adds.push({ group: 'Pin it', icon: 'pinDate', label, keepOpen: true, run: () => pinAction('pin', 'today', date) });
  }
  // and onto a meeting, which is a pin on that meeting's own document (docs/PINNING.md §4) rather than one of the
  // three above: the same picker ⌘K opens, told to come back here when Escape leaves it. Offered whatever else is
  // pinned, because a document can hang on more than one meeting.
  if (tana.searchPreview && tana.pinTo && isRealId(palDoc.id)) {
    const doc = palDoc;
    adds.push({ group: 'Pin it', icon: 'pin', label: 'Pin to meeting', hint: 'Choose a meeting', keepOpen: true, run: () => openMeetingPicker(doc, () => openPinsPalette(doc)) });
  }
  // one query over both halves, so typing narrows what can be pinned as well as what is; with no pin left on screen
  // the page says which of the two silences that is — none match what was typed, or there are none at all
  const rows = [...listed, ...adds].filter((row) => fuzzyMatch(row.label, q));
  if (!rows.some((row) => row.group === PIN_GROUP)) rows.unshift({ group: PIN_GROUP, label: listed.length ? 'No pin matches' : 'Not pinned anywhere', disabled: true });
  return rows;
}
function openPinsPalette(doc) {
  palDoc = doc; palMode = 'pins'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Edit pins'; palInput.value = '';
  pinInfo = null; loadPins(); renderPalette(); palInput.focus();
}
// ---- Pin to date: a day typed in words, read by a fixed set of rules rather than a model ----
// The page shows the day it read before Enter, so what gets pinned is always what was on screen, with no key, no
// network and no latency. A weekday is the next one after today ("sunday" on a Sunday is a week on), a day and month
// without a year is the next time it comes round, and numbers are read day first (12/10 is 12 October).
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
function pinDateRows(typed) {
  const doc = pinDateDoc, words = (typed || '').trim(), date = parseDay(words);
  if (!doc) return [];
  if (!words) return [{ group: PIN_DATE_GROUP, icon: 'pinDate', label: 'Type a day: sunday, in 3 days, 12 oct, 12/10', disabled: true }];
  if (!date) return [{ group: PIN_DATE_GROUP, icon: 'pinDate', label: 'No day in \u201C' + words + '\u201D', disabled: true }];
  const long = new Date(date + 'T00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const near = date === localDate() ? 'Today' : date === localDate(1) ? 'Tomorrow' : '';
  const pinned = !!pinInfo && pinInfo.docId === doc.id && pinInfo.dates.includes(date);
  return [{ group: PIN_DATE_GROUP, icon: 'pinDate', label: long, hint: pinned ? 'Already pinned' : near ? near + ' \u21A9' : '\u21A9', disabled: pinned,
    run: () => run(async () => { await tana.pin(doc.id, 'today', date); loadPins(); }) }];
}
function openPinDatePalette(doc) {
  pinDateDoc = doc; palMode = 'pinDate'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Pin to date\u2026'; palInput.value = '';
  renderPalette(); palInput.focus();
}
function invalidatePinCaches(id) {
  if (pinInfo && pinInfo.docId === id) pinInfo = null;
  forgetRecent(id);
}
function invalidateNode(id) {
  invalidatePinCaches(id);
  extra.delete(id); paths.delete(id); kids.delete(id); fresh.delete(id); taskMetaById.delete(id); relatedBy.delete(id);
  for (const section of views) section.nodes = section.nodes.filter((node) => node.id !== id);
  // and wherever a zoomed page lists it as one of its rows (a saved search's results, a space's contents)
  for (const [docId, rows] of kids) if (Array.isArray(rows)) kids.set(docId, rows.filter((node) => node.id !== id));
  palRows = palRows.filter((row) => row.node?.id !== id);
  if (palDoc?.id === id) { palDoc = null; pinInfo = null; }
  if (zoom?.docId === id) zoom = null;
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
  renderSensitiveBtn();
}
// The same switch in the header, left of the search options, on every page: sensitive rows are blurred wherever
// they are listed, so the button that shows them belongs to the app rather than to a page. Icon only, and the
// glyph is the state — an open eye while they are shown, the crossed one while hidden — at the same weight as the
// buttons beside it: a full-black glyph among faded ones read as a different kind of button, not as a switch on.
const sensitiveBtn = $('navSensitive');
function renderSensitiveBtn() {
  const label = sensitiveVisible ? 'Hide sensitive items' : 'Show sensitive items';
  sensitiveBtn.title = label;
  sensitiveBtn.setAttribute('aria-label', label);
  sensitiveBtn.setAttribute('aria-pressed', String(sensitiveVisible));
  const svg = iconNode(sensitiveVisible ? 'visible' : 'hidden');
  if (svg) sensitiveBtn.replaceChildren(svg);
}
sensitiveBtn.onmousedown = (e) => e.preventDefault(); // the caret stays in its row, as with the other header buttons
sensitiveBtn.onclick = toggleSensitiveVisibility; // the same action the Cmd+K row runs
renderSensitiveBtn();
