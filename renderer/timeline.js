'use strict';
// Timeline (issue #135; main/timeline.js): tasks pinned through today, then what happened to the nodes you watch and what
// landed in your Inbox, newest first, in day sections. History rows are events drawn like a notification: the node's
// title in bold, what happened on the grey line under it (subtextOf), and the time. A bell marks watched nodes and a
// tray marks new tasks, blue when newer than your last visit. Opening a row (a click, Enter, Space) goes to its node. The page
// is read afresh on every arrival (renderer/edit.js): main rebuilds it from Tana rather than keeping a history.
const TIMELINE_PAGE = 'orbital:timeline';
extra.set(TIMELINE_PAGE, { id: TIMELINE_PAGE, text: 'Timeline', title: 'Timeline', kind: 'document', icon: 'timeline', editable: false, hasChildren: true, appPage: true });
// An entry with no uri ("An AI agent added 6 tasks to your Inbox") is a heading for the rows under it: not clickable
function openTimeline(node, where = null) { // where: 'tab' or 'float' for a ⌘- or ⌥-click (renderer/palette.js elsewhere)
  const uri = node.timeline && node.timeline.uri;
  if (!uri) return;
  if (zoomable({ id: uri })) { if (where) run(() => openElsewhere(where, uri)); else goTo(uri); }
  else if (tana.nodeLink && tana.openExternal) openInTana(uri);
}
// The node a Timeline row is about (a meeting, the task someone completed), for ⌘K's Copy link on it: the one selected
// row, or the row under the caret. The row itself is the Timeline's own and has no link (renderer/palette.js copyLink).
function timelineUriAt() {
  const s = selKeys(), key = s.length ? s.length === 1 && s[0] : (palette.hidden ? focused() : palReturn)?.key;
  return (key && items.get(key)?.node.timeline?.uri) || null;
}
function timelineViewRow() {
  return { id: 'timeline', group: 'Views', icon: 'timeline', label: 'Timeline', run: () => goTo(TIMELINE_PAGE) };
}
// The Work View: the Timeline in page '' beside My Tasks in page '2', the saved view installed first (renderer/palette.js
// savedViews) and the one a first launch opens (renderer/edit.js). Its layout is main's own ('workView': main.js pair),
// and My Tasks is a place found or made at load (edit.js restorePlace), since its id is yours. Home opens it, the one
// saved under its id if you replaced it, and this one if you removed it.
const WORK_VIEW = { id: 'workView', name: 'Work View', doc: 'workView', keys: {
  place: JSON.stringify({ docId: TIMELINE_PAGE, nodeId: null, title: 'Timeline', icon: 'timeline' }), 'place:2': JSON.stringify({ myTasks: true }) } };
const openWorkView = () => openSavedView(savedViews().find((v) => v.id === WORK_VIEW.id) || WORK_VIEW);
// Sections by local day: Today, Yesterday, then the date. Folded for as long as the window is open, like a group.
const timelineFolded = new Set();
const dayKey = (iso) => isoDay(new Date(iso));
function timelineDay(key) {
  const today = new Date(), yesterday = new Date(Date.now() - 864e5);
  if (key === dayKey(today)) return 'Today';
  if (key === dayKey(yesterday)) return 'Yesterday';
  return new Date(key + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
function timelineGroups(list) {
  list = timelineNoMeetings(list);
  const days = [];
  for (const n of list) { const key = dayKey(n.createdAt); const last = days.at(-1); if (last && last.id === key) last.nodes.push(n); else days.push({ id: key, nodes: [n] }); }
  return days.map((g) => ({ ...g, title: timelineDay(g.id), collapsed: timelineFolded.has(g.id),
    toggle: () => { if (!timelineFolded.delete(g.id)) timelineFolded.add(g.id); render(true); } }));
}
// The rule closes the blocks at the top — Today's Tasks, then the free time and Upcoming meetings when there are any — before the history
const timelineTopEnds = (n, next) => !!(n.timeline?.today || n.timeline?.free || n.timeline?.upcoming) && !(next?.timeline?.free || next?.timeline?.upcoming);
// No meetings left today: main sends neither the free time nor Upcoming meetings, so the page says so itself under
// Today's Tasks, with Plan one after it (timelinePlanEl). The desktop's own row: the phones read the same page from
// main/timeline.js and leave the day without one.
function timelineNoMeetings(list) {
  const i = list.findIndex((n) => n.timeline?.today);
  if (i < 0 || list.some((n) => n.timeline?.free || n.timeline?.upcoming)) return list;
  const none = { id: TIMELINE_PAGE + ':free', text: 'No more meetings today', kind: 'block', block: 'bullet', icon: 'free', editable: false, hasChildren: false, children: [],
    createdAt: list[i].createdAt, unread: false, timeline: { uri: null, time: '', tone: 'new', free: { from: 0, until: 0 } } };
  return [...list.slice(0, i + 1), none, ...list.slice(i + 1)];
}
// The free time before the next meeting (main/timeline.js pageOf): "No meetings for 44 more minutes", in whole minutes
// rounded up, counted down while the page is on screen; the page is read again once the meeting starts, which takes
// the row away. During a meeting it is the gap after it: "No meetings for 30 minutes after this one".
function timelineFreeSegs({ from, until }) {
  if (!until) return [{ text: 'No more meetings today' }]; // timelineNoMeetings
  const later = from > Date.now(), more = later ? '' : 'more ';
  const m = Math.max(1, Math.ceil((until - Math.max(Date.now(), from)) / 6e4)), h = Math.floor(m / 60);
  const unit = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const left = m < 60 ? m + ' ' + more + (m === 1 ? 'minute' : 'minutes') : m % 60 ? unit(h, 'hour') + ' and ' + m % 60 + ' ' + more + (m % 60 === 1 ? 'minute' : 'minutes') : h + ' ' + more + (h === 1 ? 'hour' : 'hours');
  return [{ text: 'No meetings for ' }, { text: left, marks: { bold: true } }, ...(later ? [{ text: ' after this one' }] : [])];
}
setInterval(() => { if (zoom?.docId === TIMELINE_PAGE && kids.get(TIMELINE_PAGE)?.some((n) => n.timeline?.free)) renderSoon(); }, 15e3); // rowSig carries the minutes, so only that row is redrawn
// Join: a meeting still to come or under way is joined from Tana, so its Tana glyph after the title opens the meeting
// there (row.join, the meeting's id; main/timeline.js). Its own click: the row around it opens the meeting here.
function timelineJoinEl(node) {
  // icon only, so its name comes from the label
  return addIcon(quietButton('tl-join', 'Join in Tana', (ev) => { ev.stopPropagation(); openInTana(node.join); }, { tabIndex: -1 }), 'tana');
}
function timelineDividerEl() {
  const el = document.createElement('div'); el.className = 'tl-divider'; el.setAttribute('aria-hidden', 'true'); return el;
}
// Three days a page (main/timeline.js setPages): opening the page starts at the first (renderer/edit.js), and nearing
// its end reads three days more, as the button there does when pressed; it says Loading… while it does. The count is
// set once here too, so a reloaded window and main agree on it. Main stops at MAX_PAGES, and so does the button.
const TIMELINE_MAX_PAGES = 120;
// timelineDry: the last page read added nothing, so scrolling stops asking; the button still reads on when pressed.
// Without it an empty or sparse Timeline kept its end in view and read on, page after page, to the last.
let timelinePages = 1, timelineLoading = false, timelineDry = false;
if (tana.timelinePages) tana.timelinePages(1).catch(() => {});
// The page arrives in parts (main/timeline.js rows): while its first read is still out, each part is the page so far,
// drawn at once with the loader building on under it (renderer/loading.js). A part never stands in for a page that is
// already there — a re-read or three more days keep what is on screen until the whole answer is in (nodes.js reload).
let timelinePartial = false;
if (tana.onTimelinePart) tana.onTimelinePart((rows) => {
  if (!(kids.get(TIMELINE_PAGE) === null || timelinePartial)) return;
  kids.set(TIMELINE_PAGE, rows); timelinePartial = true;
  if (zoom?.docId === TIMELINE_PAGE) renderSoon(true);
});
function timelineOlder(scrolled) {
  if (timelineLoading || timelinePages >= TIMELINE_MAX_PAGES || (scrolled === true && timelineDry)) return;
  timelineLoading = true; renderSoon();
  run(async () => {
    const had = (kids.get(TIMELINE_PAGE) || []).length;
    try { timelinePages = await tana.timelinePages(timelinePages + 1); await reload(TIMELINE_PAGE); } finally { timelineLoading = false; }
    timelineDry = (kids.get(TIMELINE_PAGE) || []).length <= had;
    renderSoon(true);
  });
}
// The button coming within a screen of view is the scroll reaching the end: each render draws a new one, watched in
// place of the last, so a page still too short to scroll keeps reading until it fills the screen.
const timelineEnd = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) timelineOlder(true); }, { root: outline.parentElement, rootMargin: '0px 0px 100% 0px' }) : null;
// The page's own links (Show three more days, Add more, New meeting, Plan one): quiet buttons in its words, label only
// naming one for a screen reader where its words alone would not say enough
function timelineLinkEl(cls, text, onclick, label) {
  const el = quietButton('gmore ' + cls, null, onclick);
  el.textContent = text;
  if (label) el.setAttribute('aria-label', label);
  return el;
}
function timelineOlderEl() {
  const el = timelineLinkEl('tl-older', timelineLoading ? 'Loading…' : 'Show three more days', () => timelineOlder());
  if (timelineEnd) { timelineEnd.disconnect(); timelineEnd.observe(el); }
  return el;
}
const timelineAddMoreEl = (node, inline = false) => timelineLinkEl('tl-add' + (inline ? ' tl-add-inline' : ''), 'Add more', () => openTodayTaskSearch(node), 'Add more tasks pinned to today');
// New meeting under today's meetings, and Plan one when none are left: ⌘K's Create new … → Meeting at its name
// (renderer/palette.js openNamePage), which goes on to when.
function openNewMeeting() {
  run(async () => {
    if (!creationChoices.length) creationChoices = (await tana.creationOptions()).options || [];
    // one that cannot be made here (no rights, or none offered) is Create new …'s greyed row, which says why
    const meeting = creationChoices.find((c) => c.kind === 'meeting');
    if (meeting && meeting.selectable) openNamePage(meeting); else openCreationPalette();
  });
}
const timelineNewMeetingEl = () => timelineLinkEl('tl-add', 'New meeting', openNewMeeting);
// " · Plan one" after "No more meetings today", in the row's own words: its click is the link's, not the row's
function timelinePlanEl() {
  const el = document.createElement('span');
  el.className = 'tl-plan'; el.append(' · ', timelineLinkEl('tl-add-inline', 'Plan one', (e) => { e.stopPropagation(); openNewMeeting(); }, 'Plan a meeting'));
  return el;
}
const timelineTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // a column of times: 24-hour, so they line up
