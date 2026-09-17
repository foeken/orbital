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
// Keyed by the page, not the view: a saved search carries its own sort and grouping, stored in the document beside
// its query, so opening one shows the arrangement it was saved with rather than whatever the last view was using.
// A search's key is its document id, so the per-view defaults below simply do not match it.
const groupBy = () => { const k = pillKey(); return GROUPS.some(([id]) => id === groupPref[k]) ? groupPref[k] : 'none'; };
// A saved search's arrangement belongs in its document, so its keys are kept out of the browser-local preference
// blob: without this, changing any view's grouping would flush every search key it had accumulated to disk too.
const persistPref = (key, pref) => localStorage.setItem(key, JSON.stringify(Object.fromEntries(Object.entries(pref).filter(([k]) => !k.startsWith('tana:')))));
// Stay put: once a task's box is clicked, that row keeps its group and every row keeps its place until the view is left,
// so nothing jumps away from the pointer (an Inbox task moving to In Progress read as "gone" and got undone). holdRow
// snapshots the order on screen and the row's group before its state changes; setView and a new Sort or Group let go.
// `view` here is the page key (a view id, or a saved search's document id), the same key the pills and the sort and
// group preferences use: holding rows in place is about the list in front of you, whichever kind of page it is.
let held = null, lastOrder = null; // held: { view, by, order: Map id -> index, groups: Map id -> title }; lastOrder: { view, ids }
function holdRow(n) {
  if (!held || held.view !== pillKey()) held = { view: pillKey(), by: groupBy(), order: new Map((lastOrder && lastOrder.view === pillKey() ? lastOrder.ids : []).map((id, i) => [id, i])), groups: new Map() };
  if (!held.groups.has(n.id)) held.groups.set(n.id, groupKey(n, held.by));
}
const releaseHeld = () => { held = null; };
// The rows as ids per group: once the held layout differs from the one the view would show now (a row that belongs in
// another group, an order a refresh changed), the view offers a Clean up pill (renderer/pills.js) that lets go.
function layoutOf(list) { const sorted = sortRows(list), groups = groupsOf(sorted); return JSON.stringify(groups ? groups.map((g) => [g.title, g.nodes.map((n) => n.id)]) : sorted.map((n) => n.id)); }
function needsCleanup(list) {
  if (!held || held.view !== pillKey()) return false;
  const kept = held, order = lastOrder, shown = layoutOf(list);
  held = null;
  const fresh = layoutOf(list);
  held = kept; lastOrder = order; // sortRows records the order it returns; leave the one on screen
  return shown !== fresh;
}
// the view's rows before sorting and grouping, as renderOutline lists them (the text filter applied)
const shownDocs = () => { const docs = (viewOf() || {}).nodes || [], q = filterEl.value.trim().toLowerCase(); return q ? docs.filter((n) => n.text.toLowerCase().includes(q)) : docs; };
function setGroupBy(id) { groupPref[pillKey()] = id; held = null; persistPref('groupBy', groupPref); render(); }
// main.js toNode now passes stateType, so all four states (Inbox, In Progress, Completed, Later) separate here.
// done (0/1 for tasks, undefined otherwise) stays the fallback for rows that carry no state, which can only tell
// Completed from In Progress.
const stateOf = (n) => n.stateType || (n.done == null ? null : n.done ? 'closed' : 'open');
function groupKey(n, by) {
  if (held && held.view === pillKey() && held.by === by && held.groups.has(n.id)) return held.groups.get(n.id); // stays put (holdRow)
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
// Every page, saved searches included, keeps the order its query returned until the user says otherwise. Tasks was
// the one exception (most recently moved first) and it is gone.
const sortBy = () => { const k = pillKey(); return SORTS.some(([id]) => id === sortPref[k]) ? sortPref[k] : 'default'; };
function setSortBy(id) { sortPref[pillKey()] = id; held = null; persistPref('sortBy', sortPref); render(); }
function sortRows(list) {
  const id = sortBy(), key = SORT_KEY[id], desc = NEWEST_FIRST.has(id);
  const sorted = !key ? list : [...list].sort((a, b) => { // no key: Default, the order the view produced
    const x = key(a), y = key(b);
    if (!x || !y) return x ? -1 : y ? 1 : 0; // a row without the field sorts last, in the order it came in
    return desc ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
  });
  // held: every row keeps the place it had when a box was clicked; a row that arrived since goes first, in its own order
  const at = (n) => (held.order.has(n.id) ? held.order.get(n.id) : -1);
  const out = held && held.view === pillKey() ? sorted.map((n, i) => [n, i]).sort((a, b) => at(a[0]) - at(b[0]) || a[1] - b[1]).map(([n]) => n) : sorted;
  lastOrder = { view: pillKey(), ids: out.map((n) => n.id) };
  return out;
}
// ---- display: which of a row's facts it shows ----
// When it was made, when it last moved and where it lives read as one grey sub-line under the title, because they are
// all answers to "what is this row"; the rest stay where they already are — the type chips, the assignee, the box.
const DISPLAY = [['type', 'Type'], ['space', 'Lives in'], ['status', 'Status'], ['assigned', 'Assigned'], ['updated', 'Updated'], ['created', 'Created']];
const DISPLAY_DEFAULT = ['status', 'assigned', 'updated'];
const displayKeys = () => { const chosen = displayPref[pillKey()]; return Array.isArray(chosen) ? chosen : DISPLAY_DEFAULT; };
const displayOn = (id) => displayKeys().includes(id);
function setDisplay(id) {
  const on = displayKeys(), next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
  displayPref[pillKey()] = DISPLAY.map(([key]) => key).filter((key) => next.includes(key)); // stored in the menu's order
  persistPref('display', displayPref);
  render(true); // every row is built differently now, and rowSig carries the choice so none is reused
}
// "4 hours ago". Nothing else in the app says an age in words, so this is the one place that turns a time into one.
function agoText(iso) {
  const at = Date.parse(iso || '');
  if (!at) return '';
  const age = Math.max(0, Date.now() - at);
  if (age < 60e3) return 'just now';
  for (const [limit, size, unit] of [[36e5, 60e3, 'minute'], [864e5, 36e5, 'hour'], [30 * 864e5, 864e5, 'day'], [365 * 864e5, 30 * 864e5, 'month'], [Infinity, 365 * 864e5, 'year']]) {
    if (age >= limit) continue;
    const n = Math.max(1, Math.floor(age / size));
    return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
  }
  return '';
}
// The grey line under a title: when it was made, when it last moved, where it lives — in that order, bullet separated.
// "Lives in" only has an answer for a document shared with a space, which is the only place a row learns a space name.
function subtextOf(node, taskInfo) {
  const bits = [];
  if (displayOn('space') && taskInfo && taskInfo.audience && taskInfo.audience.space) bits.push(taskInfo.audience.space);
  if (displayOn('created') && node.createdAt) bits.push('Created ' + agoText(node.createdAt));
  if (displayOn('updated') && node.updatedAt) bits.push('Updated ' + agoText(node.updatedAt));
  return bits.join(' · ');
}
// What a page shows, from the rows it has already loaded: the ⌘F text filter, then the arrangement its page key asks
// for. A view and a saved search do exactly this and differ only in where that arrangement is stored, so both
// branches of renderOutline go through here rather than repeating it — and this is the part of drawing a page that
// can be checked without a DOM, which is why it is a function rather than three lines inlined twice.
function pageRows(list, q) {
  const found = q ? list.filter((n) => String(n.text || '').toLowerCase().includes(q)) : list;
  const sorted = sortRows(found);
  const groups = groupsOf(sorted); // null when the page is not grouped: one flat list
  return { list: groups ? groups.flatMap((g) => g.nodes) : sorted, groups, hidden: list.length - found.length };
}
// a heading is not a node: no key, no caret, no bullet, and nodeEls() already skips anything without .node
function groupHeadEl(title) { const el = document.createElement('div'); el.className = 'ghead'; el.textContent = title; return el; }
