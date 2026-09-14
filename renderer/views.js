'use strict';
// The filter vocabulary every view shares (states, types), and group-by and sort over rows already loaded.

// ---- filter pills shared by every view ----
const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
const TYPES = [['meetings', 'Meetings', 'meeting'], ['tasks', 'Tasks', 'task'], ['docs', 'Docs', 'doc'], null, ['chats', 'Chats', 'chat'], ['canvases', 'Canvases', 'canvas'], ['agents', 'Agents', 'agent'], ['skills', 'Skills', 'skill'], ['spaces', 'Spaces', 'space'], ['people', 'People', 'member']];
const toggleIn = (all, list, v) => { if (!list) return [v]; const next = all.filter((x) => list.includes(x) !== (x === v)); return next.length ? next : null; }; // null = any
const names = (pairs, list) => (list ? pairs.filter((p) => p && list.includes(p[0])).map((p) => p[1]).join(', ') : null);
// ---- group by: plain headings over the rows the view already loaded, no extra query ----
const GROUPS = [['none', 'None'], ['status', 'Status'], ['assignee', 'Assignee'], ['type', 'Type']];
const FALLBACK = { status: 'No status', assignee: 'Unassigned', type: 'No type' };
const groupBy = () => (GROUPS.some(([id]) => id === groupPref[view]) ? groupPref[view] : 'none');
function setGroupBy(id) { groupPref[view] = id; localStorage.setItem('groupBy', JSON.stringify(groupPref)); render(); }
// main.js toNode now passes stateType, so all four states (Inbox, In Progress, Completed, Later) separate here.
// done (0/1 for tasks, undefined otherwise) stays the fallback for rows that carry no state, which can only tell
// Completed from In Progress.
const stateOf = (n) => n.stateType || (n.done == null ? null : n.done ? 'closed' : 'open');
function groupKey(n, by) {
  if (by === 'status') return Object.fromEntries(STATES)[stateOf(n)] || FALLBACK.status;
  // ponytail: a task with several assignees is filed under the first one, like the row's own summary reads
  if (by === 'assignee') { const meta = taskMetaById.get(n.id), uri = meta && meta.assignees[0]; return uri ? memberName(uri) : FALLBACK.assignee; }
  return (visibleTags(n)[0] || {}).label || FALLBACK.type;
}
// [{ title, nodes }] in a fixed order: the status sequence as the Status menu lists it, names alphabetically,
// the "nothing here" group last. Only groups with rows are returned.
function groupRows(list, by) {
  const buckets = new Map();
  for (const n of list) { const k = groupKey(n, by); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(n); }
  const fixed = by === 'status' ? STATES.map((s) => s[1]) : [], last = FALLBACK[by];
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
// People read as a list of names, so that page sorts A→Z until the user says otherwise; every other view keeps the
// order its query returned.
const sortBy = () => (SORTS.some(([id]) => id === sortPref[view]) ? sortPref[view] : view === 'people' ? 'title' : 'default');
function setSortBy(id) { sortPref[view] = id; localStorage.setItem('sortBy', JSON.stringify(sortPref)); render(); }
function sortRows(list) {
  const id = sortBy(), key = SORT_KEY[id];
  if (!key) return list; // Default: the order the view produced
  const desc = NEWEST_FIRST.has(id);
  return [...list].sort((a, b) => {
    const x = key(a), y = key(b);
    if (!x || !y) return x ? -1 : y ? 1 : 0; // a row without the field sorts last, in the order it came in
    return desc ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
  });
}
// a heading is not a node: no key, no caret, no bullet, and nodeEls() already skips anything without .node
function groupHeadEl(title) { const el = document.createElement('div'); el.className = 'ghead'; el.textContent = title; return el; }
