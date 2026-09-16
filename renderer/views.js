'use strict';
// The filter vocabulary every view shares (states, types), and group-by and sort over rows already loaded.

// ---- filter pills shared by every view ----
const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
const TYPES = [['meetings', 'Meetings', 'meeting'], ['tasks', 'Tasks', 'task'], ['docs', 'Docs', 'doc'], null, ['chats', 'Chats', 'chat'], ['canvases', 'Canvases', 'canvas'], ['agents', 'Agents', 'agent'], ['skills', 'Skills', 'skill'], ['searches', 'Searches', 'search'], ['spaces', 'Spaces', 'space'], ['people', 'People', 'member']];
const toggleIn = (all, list, v) => { if (!list) return [v]; const next = all.filter((x) => list.includes(x) !== (x === v)); return next.length ? next : null; }; // null = any
const names = (pairs, list) => (list ? pairs.filter((p) => p && list.includes(p[0])).map((p) => p[1]).join(', ') : null);
// ---- group by: plain headings over the rows the view already loaded, no extra query ----
const GROUPS = [['none', 'None'], ['status', 'Status'], ['assignee', 'Assignee'], ['updated', 'Updated'], ['type', 'Type']];
const FALLBACK = { status: 'No status', assignee: 'Unassigned', updated: 'Older', type: 'No type' };
// Group by Updated: how long ago the row last changed, newest first; past a month, or with no time to read, it is Older
const UPDATED_BUCKETS = [[36e5, 'Last hour'], [864e5, 'Last day'], [7 * 864e5, 'Last week'], [30 * 864e5, 'Last month']];
// Tasks reads as its states (Inbox, In Progress, Later) until the user picks another grouping; other views start ungrouped
const groupBy = () => (GROUPS.some(([id]) => id === groupPref[view]) ? groupPref[view] : view === 'tasks' ? 'status' : 'none');
// Stay put: once a task's box is clicked, that row keeps its group and every row keeps its place until the view is left,
// so nothing jumps away from the pointer (an Inbox task moving to In Progress read as "gone" and got undone). holdRow
// snapshots the order on screen and the row's group before its state changes; setView and a new Sort or Group let go.
let held = null, lastOrder = null; // held: { view, by, order: Map id -> index, groups: Map id -> title }; lastOrder: { view, ids }
function holdRow(n) {
  if (!held || held.view !== view) held = { view, by: groupBy(), order: new Map((lastOrder && lastOrder.view === view ? lastOrder.ids : []).map((id, i) => [id, i])), groups: new Map() };
  if (!held.groups.has(n.id)) held.groups.set(n.id, groupKey(n, held.by));
}
const releaseHeld = () => { held = null; };
// The rows as ids per group: once the held layout differs from the one the view would show now (a row that belongs in
// another group, an order a refresh changed), the view offers a Clean up pill (renderer/pills.js) that lets go.
function layoutOf(list) { const sorted = sortRows(list), groups = groupsOf(sorted); return JSON.stringify(groups ? groups.map((g) => [g.title, g.nodes.map((n) => n.id)]) : sorted.map((n) => n.id)); }
function needsCleanup(list) {
  if (!held || held.view !== view) return false;
  const kept = held, order = lastOrder, shown = layoutOf(list);
  held = null;
  const fresh = layoutOf(list);
  held = kept; lastOrder = order; // sortRows records the order it returns; leave the one on screen
  return shown !== fresh;
}
// the view's rows before sorting and grouping, as renderOutline lists them (the text filter applied)
const shownDocs = () => { const docs = (viewOf() || {}).nodes || [], q = filterEl.value.trim().toLowerCase(); return q ? docs.filter((n) => n.text.toLowerCase().includes(q)) : docs; };
function setGroupBy(id) { groupPref[view] = id; held = null; localStorage.setItem('groupBy', JSON.stringify(groupPref)); render(); }
// main.js toNode now passes stateType, so all four states (Inbox, In Progress, Completed, Later) separate here.
// done (0/1 for tasks, undefined otherwise) stays the fallback for rows that carry no state, which can only tell
// Completed from In Progress.
const stateOf = (n) => n.stateType || (n.done == null ? null : n.done ? 'closed' : 'open');
function groupKey(n, by) {
  if (held && held.view === view && held.by === by && held.groups.has(n.id)) return held.groups.get(n.id); // stays put (holdRow)
  if (by === 'status') return Object.fromEntries(STATES)[stateOf(n)] || FALLBACK.status;
  // updatedAt is the ISO time toNode passes; a missing one parses to NaN, which is under no bucket, so the row is Older
  if (by === 'updated') { const age = Date.now() - Date.parse(n.updatedAt); return (UPDATED_BUCKETS.find(([ms]) => age < ms) || [])[1] || FALLBACK.updated; }
  // ponytail: a task with several assignees is filed under the first one, like the row's own summary reads
  if (by === 'assignee') { const meta = taskMetaById.get(n.id), uri = meta && meta.assignees[0]; return uri ? memberName(uri) : FALLBACK.assignee; }
  return (visibleTags(n)[0] || {}).label || FALLBACK.type;
}
// [{ title, nodes }] in a fixed order: the status sequence as the Status menu lists it, names alphabetically,
// the "nothing here" group last. Only groups with rows are returned.
function groupRows(list, by) {
  const buckets = new Map();
  for (const n of list) { const k = groupKey(n, by); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(n); }
  const fixed = by === 'status' ? STATES.map((s) => s[1]) : by === 'updated' ? UPDATED_BUCKETS.map((b) => b[1]) : [], last = FALLBACK[by]; // Updated: newest first
  const rank = (t) => (t === last ? 2 : fixed.includes(t) ? 0 : 1);
  return [...buckets.keys()]
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? fixed.indexOf(a) - fixed.indexOf(b) : a.localeCompare(b)))
    .map((title) => ({ title, nodes: buckets.get(title) }));
}
function groupsOf(list) {
  const by = groupBy();
  if (by === 'none') return null;
  if (by === 'assignee') loadMembers(); // the names for the headings; without them a heading falls back to the member uri
  return groupRows(list, by);
}
// ---- sort: the same rows in another order, again without asking the backend for anything ----
// Only what a row actually carries can be sorted on. main.js toNode passes updatedAt and createdAt as ISO 8601
// strings, so they compare as strings; a row that carries neither (an older cached row) keeps its place at the end.
const SORTS = [['default', 'Default'], ['updated', 'Updated'], ['created', 'Created'], ['title', 'Title']];
const SORT_KEY = { updated: (n) => n.updatedAt, created: (n) => n.createdAt, title: (n) => (n.text || n.title || '').toLowerCase() };
const NEWEST_FIRST = new Set(['updated', 'created']); // times read newest first; Title stays A→Z
// People read as a list of names, so that page sorts A→Z until the user says otherwise; Tasks puts what moved most
// recently first; every other view keeps the order its query returned.
const sortBy = () => (SORTS.some(([id]) => id === sortPref[view]) ? sortPref[view] : view === 'people' ? 'title' : view === 'tasks' ? 'updated' : 'default');
function setSortBy(id) { sortPref[view] = id; held = null; localStorage.setItem('sortBy', JSON.stringify(sortPref)); render(); }
function sortRows(list) {
  const id = sortBy(), key = SORT_KEY[id], desc = NEWEST_FIRST.has(id);
  const sorted = !key ? list : [...list].sort((a, b) => { // no key: Default, the order the view produced
    const x = key(a), y = key(b);
    if (!x || !y) return x ? -1 : y ? 1 : 0; // a row without the field sorts last, in the order it came in
    return desc ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
  });
  // held: every row keeps the place it had when a box was clicked; a row that arrived since goes first, in its own order
  const at = (n) => (held.order.has(n.id) ? held.order.get(n.id) : -1);
  const out = held && held.view === view ? sorted.map((n, i) => [n, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([n]) => n) : sorted;
  lastOrder = { view, ids: out.map((n) => n.id) };
  return out;
}
// a heading is not a node: no key, no caret, no bullet, and nodeEls() already skips anything without .node
function groupHeadEl(title) { const el = document.createElement('div'); el.className = 'ghead'; el.textContent = title; return el; }
