'use strict';
// Timeline (issue #135; main/timeline.js): tasks pinned through today, then what happened to the nodes you watch and what
// landed in your Inbox, newest first, in day sections. History rows are events drawn like a notification: the node's
// title in bold, what happened on the grey line under it (subtextOf), and the time. A bell marks watched nodes and a
// tray marks new tasks, blue when newer than your last visit. Opening a row (a click, Enter, Space) goes to its node. The page
// is read afresh on every arrival (renderer/edit.js): main rebuilds it from Tana rather than keeping a history.
const TIMELINE_PAGE = 'orbital:timeline';
extra.set(TIMELINE_PAGE, { id: TIMELINE_PAGE, text: 'Timeline', title: 'Timeline', kind: 'document', icon: 'timeline', editable: false, hasChildren: true, appPage: true });
// An entry with no uri ("An AI agent added 6 tasks to your Inbox") is a heading for the rows under it: not clickable
function openTimeline(node) {
  const uri = node.timeline && node.timeline.uri;
  if (!uri) return;
  if (zoomable({ id: uri })) goTo(uri);
  else if (tana.nodeLink && tana.openExternal) run(async () => tana.openExternal(await tana.nodeLink(uri)));
}
function timelineViewRow() {
  return { id: 'timeline', group: 'Views', icon: 'timeline', label: 'Timeline', run: () => goTo(TIMELINE_PAGE) };
}
// The Work View (Cmd+K, and where a first launch opens, renderer/edit.js): the Timeline on the left and My Tasks on
// the right of one window. Both halves' places are stored first; main then opens the right half, which reads its own
// at load, or sends a half already open to its own (onToPlace, renderer/app.js). This half goes to its own.
async function openWorkView() {
  const tasks = await tana.myTasks(); // yours, or made the first time (main/views.js myTasks)
  addSearch(tasks);
  const places = { '': { docId: TIMELINE_PAGE, nodeId: null, title: 'Timeline', icon: 'timeline' }, ':2': { docId: tasks.id, nodeId: null, title: tasks.text || tasks.title, icon: tasks.icon } };
  for (const [side, place] of Object.entries(places)) localStorage.setItem('place' + side, JSON.stringify(place));
  await tana.workView();
  await goTo(places[SIDE].docId);
}
function workViewRow() {
  return { id: 'workView', group: 'Views', icon: 'splitPanes', label: 'Work View', hint: 'Timeline and My Tasks', run: () => run(openWorkView) };
}
// Sections by local day: Today, Yesterday, then the date. Folded for as long as the window is open, like a group.
const timelineFolded = new Set();
const dayKey = (iso) => new Date(iso).toLocaleDateString('sv-SE');
function timelineDay(key) {
  const today = new Date(), yesterday = new Date(Date.now() - 864e5);
  if (key === dayKey(today)) return 'Today';
  if (key === dayKey(yesterday)) return 'Yesterday';
  return new Date(key + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}
function timelineGroups(list) {
  const days = [];
  for (const n of list) { const key = dayKey(n.createdAt); const last = days.at(-1); if (last && last.id === key) last.nodes.push(n); else days.push({ id: key, nodes: [n] }); }
  return days.map((g) => ({ ...g, title: timelineDay(g.id), collapsed: timelineFolded.has(g.id),
    toggle: () => { if (!timelineFolded.delete(g.id)) timelineFolded.add(g.id); render(true); } }));
}
function timelineDividerEl() {
  const el = document.createElement('div'); el.className = 'tl-divider'; el.setAttribute('aria-hidden', 'true'); return el;
}
// A week a page (main/timeline.js setWeeks): opening the page starts at one week (renderer/edit.js), and the button at
// its end reaches one week further back. The count is set once here too, so a reloaded window and main agree on it.
let timelineWeeks = 1;
if (tana.timelineWeeks) tana.timelineWeeks(1).catch(() => {});
function timelineOlder() {
  run(async () => { timelineWeeks = await tana.timelineWeeks(timelineWeeks + 1); await reload(TIMELINE_PAGE); renderSoon(true); });
}
function timelineOlderEl() {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'gmore tl-older';
  el.textContent = 'Show the week before ' + new Date(Date.now() - timelineWeeks * 7 * 864e5).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  el.onmousedown = (e) => e.preventDefault();
  el.onclick = timelineOlder;
  return el;
}
function timelineAddMoreEl(node, inline = false) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'gmore tl-add' + (inline ? ' tl-add-inline' : ''); el.textContent = 'Add more';
  el.setAttribute('aria-label', 'Add more tasks pinned to today');
  el.onmousedown = (e) => e.preventDefault();
  el.onclick = () => openTodayTaskSearch(node);
  return el;
}
const timelineTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // a column of times: 24-hour, so they line up
