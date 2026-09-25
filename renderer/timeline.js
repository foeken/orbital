'use strict';
// Timeline (issue #135; main/timeline.js): what happened to the nodes you watch and what landed in your Inbox, newest
// first, in day sections. A row is an event, drawn like a notification: the node's title in bold, what happened on the
// grey line under it (subtextOf), the time on the right, a bell for a watched node and a tray for a new task, blue
// while it is newer than your last visit. Opening a row (a click, Enter, Space) goes to the node it is about. The page
// is read afresh on every arrival (renderer/edit.js): main rebuilds it from Tana rather than keeping a history.
const TIMELINE_PAGE = 'orbital:timeline';
extra.set(TIMELINE_PAGE, { id: TIMELINE_PAGE, text: 'Timeline', title: 'Timeline', kind: 'document', icon: 'timeline', editable: false, hasChildren: true, appPage: true });
function openTimeline(node) {
  const uri = node.timeline && node.timeline.uri;
  if (!uri) return;
  if (zoomable({ id: uri })) goTo(uri);
  else if (tana.nodeLink && tana.openExternal) run(async () => tana.openExternal(await tana.nodeLink(uri)));
}
function timelineViewRow() {
  return { id: 'timeline', group: 'Views', icon: 'timeline', label: 'Timeline', run: () => goTo(TIMELINE_PAGE) };
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
const timelineTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); // a column of times: 24-hour, so they line up

