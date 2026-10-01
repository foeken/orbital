'use strict';
// A saved search's rows in the order and sections the desktop shows them (renderer/views.js groupKey, groupRows,
// SORT_KEY), by the sort and grouping stored in the search (view.sortBy, view.groupBy): read only, nothing to choose
// on the phone. n: { id, state, updated, created, title, createdBy, assignees, type }; c: { me, now, names (uri ->
// name), pinned / watched / silenced (sets of ids) }. Answers [{ n, group }] in order, group null when ungrouped.
// ponytail: a field as the sort or the grouping reads as the query's order, ungrouped; add the field values when wanted.
const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
const UPDATED = [[36e5, 'Last hour'], [864e5, 'Last day'], [7 * 864e5, 'Last week'], [30 * 864e5, 'Last month']];
const MINE = { proposed: 'My inbox', open: 'Mine', closed: 'My completed', not_now: 'My later' };
const RESPONSIBILITY = ['Unassigned', 'Agent', 'My inbox', 'Pinned', 'Mine', 'Tracking', 'My later', 'My completed', 'Assigned by others'];
const FALLBACK = { status: 'No status', assignee: 'Unassigned', updated: 'Older', type: 'No type' };
const FIXED = { status: STATES.map((s) => s[1]), updated: UPDATED.map((b) => b[1]), responsibility: RESPONSIBILITY };

function groupOf(n, by, c) {
  if (by === 'status') return Object.fromEntries(STATES)[n.state] || FALLBACK.status;
  if (by === 'updated') { const age = c.now - Date.parse(n.updated); return (UPDATED.find(([ms]) => age < ms) || [])[1] || FALLBACK.updated; }
  if (by === 'assignee') return n.assignees.length ? c.names.get(n.assignees[0]) || 'Someone' : FALLBACK.assignee;
  if (by === 'type') return n.type || FALLBACK.type;
  // what a row is to you (renderer/views.js responsibilityOf); a row you are no part of has no section and is left out
  if (n.state && c.pinned.has(n.id)) return n.state === 'closed' ? 'My completed' : 'Pinned';
  const mine = n.createdBy === c.me, assigned = n.assignees.includes(c.me);
  if (!n.assignees.length) return mine ? 'Unassigned' : null;
  // yours on someone else: watched unless you silenced it (main/documents.js notifyDefault)
  if (mine) return assigned ? MINE[n.state] || 'Mine' : c.watched.has(n.id) || (n.state && !c.silenced.has(n.id)) ? 'Tracking' : null;
  return assigned ? 'Assigned by others' : null;
}
const SORT = { status: (n) => { const i = STATES.findIndex(([s]) => s === n.state); return i < 0 ? undefined : i; }, updated: (n) => n.updated, created: (n) => n.created, title: (n) => (n.title || '').toLowerCase() };
const NEWEST_FIRST = new Set(['updated', 'created']);

function arrange(nodes, view, c) {
  const sortBy = typeof view.sortBy === 'string' ? view.sortBy.replace(/^-/, '') : '', by = Object.hasOwn(FALLBACK, view.groupBy) || view.groupBy === 'responsibility' ? view.groupBy : null;
  let list = [...nodes];
  const key = SORT[sortBy];
  if (key) { // rows missing the key keep their order, after the rest
    const sign = NEWEST_FIRST.has(sortBy) ? -1 : 1;
    list.sort((a, b) => { const x = key(a), y = key(b); return x == null ? (y == null ? 0 : 1) : y == null ? -1 : x < y ? -sign : x > y ? sign : 0; });
  }
  if (!by) return list.map((n) => ({ n, group: null }));
  const buckets = new Map();
  for (const n of list) { const g = groupOf(n, by, c); if (g == null) continue; if (!buckets.has(g)) buckets.set(g, []); buckets.get(g).push(n); }
  const fixed = FIXED[by] || [], rank = (t) => (t === FALLBACK[by] ? 2 : fixed.includes(t) ? 0 : 1);
  return [...buckets.keys()].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? fixed.indexOf(a) - fixed.indexOf(b) : a.localeCompare(b)))
    .flatMap((g) => buckets.get(g).map((n) => ({ n, group: g })));
}

module.exports = { arrange };
