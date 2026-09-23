'use strict';
// The filter vocabulary every view shares (states, types), and group-by and sort over rows already loaded.

// ---- filter pills shared by every view ----
const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
// How far back a completed task still counts. Whether completed tasks appear at all is the Status filter's business
// and only its, so this has no "off": it ages them out, which is why the pill is shown only while Completed is in
// Status, and why its value is kept when Completed is taken out — putting Completed back reads the same as before.
// The rule itself is sdk/query.js (the task's own state.enteredAt, applied to what the query answers); here it is
// only the vocabulary the pill speaks.
const COMPLETED = [[3, '3 days'], [7, '7 days'], [30, '30 days'], ['all', 'All']];
const completedWindow = (f) => (COMPLETED.some(([v]) => v === (f || {}).completedWithin) ? f.completedWithin : 7);
const showsCompleted = (f) => !!f && (!f.states || f.states.includes('closed'));
const TYPES = [['meetings', 'Meetings', 'meeting'], ['tasks', 'Tasks', 'task'], ['docs', 'Docs', 'doc'], null, ['chats', 'Chats', 'chat'], ['canvases', 'Canvases', 'canvas'], ['agents', 'Agents', 'agent'], ['skills', 'Skills', 'skill'], ['searches', 'Searches', 'search'], ['spaces', 'Spaces', 'space'], ['people', 'People', 'member'], ['types', 'Types', 'type']];
const toggleIn = (all, list, v) => { if (!list) return [v]; const next = all.filter((x) => list.includes(x) !== (x === v)); return next.length ? next : null; }; // null = any
const names = (pairs, list) => (list ? pairs.filter((p) => p && list.includes(p[0])).map((p) => p[1]).join(', ') : null);
// ---- group by: plain headings over the rows the view already loaded, no extra query ----
const GROUPS = [['none', 'None'], ['status', 'Status'], ['assignee', 'Assignee'], ['responsibility', 'Responsibility'], ['updated', 'Updated'], ['type', 'Type']];
const FALLBACK = { status: 'No status', assignee: 'Unassigned', updated: 'Older', type: 'No type' }; // responsibility has none: see below
// Group by Responsibility: what a row is to you, from who made it (the graph's createdBy, on the row already) and who
// it is assigned to. Made by you and yours to do, made by you and handed to someone else, made by you and waiting for
// somebody to take it, and somebody else's task that landed on you. It is a view of your own work, so a row you are
// no part of — somebody else's task on somebody else, or their unassigned one — has no section here and is left out
// rather than piled under a heading of leftovers, which is what groupRows does with the null. A row whose assignees
// have not arrived yet is left out on the same rule: never shown under a heading it may not belong to, and never
// shown while it might be nobody's business of yours. Rows ask for their metadata when they reach the screen (#155)
// and one that is filtered out never gets there, so this asks for what it is missing itself.
// ponytail: that is one doc:taskMeta per row of the open view while this grouping is chosen; the graph node a view
// lists already carries assignedTo, so a row could be told at list time instead if it ever costs too much.
// The headings run in the order the work wants attention: nobody has taken it, you are waiting on somebody, then
// your own work by its state, then what was handed to you. Your own — made by you and assigned to you — splits
// across the four states the Status menu lists, so each such task sits in exactly one of them. The state is
// stateOf, the reading the Status pill and the Status grouping already use, so a row carrying only the old done
// flag lands in My completed or Mine as that flag says, and one with no state at all reads as under way. The rows
// the grouping leaves out are simply not listed: an empty Other section explaining them was tried and removed.
// Agent sits between Tracking and your own work, for the same reason Tracking does: it is work you are following
// rather than doing. Handing a node to the local agent (⌘K, kept in the app's own settings — never a Tana assignee)
// is an explicit act of tracking, so it decides the section on its own, ahead of every other rule: before "you" is
// known, whatever Tana says about its assignees, and even for a row this grouping would otherwise not list at all,
// since you asked for that one by name. Being first is also what keeps the sections exclusive — nothing handed to
// the agent is drawn a second time under your own work.
// Tracking is what you are still following, so it reads the same watch state the bell does (meta.watched, the
// effective answer: an explicit Cmd+K choice, else the default rule). Silencing a task you handed over takes it out
// of the section and out of the list, like every other row this grouping has no section for.
const MINE_STATES = { proposed: 'My inbox', open: 'Mine', closed: 'My completed', not_now: 'My later' };
// Pinned: a task you pinned to a day is one you asked to see then, whoever has it and whatever its state, so like
// Agent it decides the section on its own (after Agent, which stays first). Date pins are personal (the pin-map), so
// nobody else's pins land here. It sits under My inbox and above Mine, and its rows say the day (pinnedOn below).
// Once completed it is done asking for attention, so it goes to My completed (yours, like the pin) and keeps its pin.
const RESPONSIBILITY = ['Unassigned', 'Tracking', 'Agent', 'My inbox', 'Pinned', 'Mine', 'My completed', 'My later', 'Assigned by others'];
function responsibilityOf(n) {
  if (codexIds.has(n.id)) return 'Agent'; // the local mark the badge is drawn from (renderer/nodes.js loadCodex)
  if (isTask(n) && datePinsById.has(n.id)) return stateOf(n) === 'closed' ? 'My completed' : 'Pinned';
  const uri = me() && me().id, meta = taskMetaById.get(n.id);
  if (!uri) return null; // the member list has not landed, so "you" is not known yet
  if (!meta) { loadTaskMeta(n.id); return null; } // it takes its section once the answer arrives
  const mine = n.createdBy === uri, assigned = meta.assignees.includes(uri);
  if (!meta.assignees.length) return mine ? 'Unassigned' : null; // its own section, never folded into Tracking
  if (mine) return assigned ? MINE_STATES[stateOf(n)] || 'Mine' : (meta.watched ? 'Tracking' : null);
  return assigned ? 'Assigned by others' : null;
}
// Two of those sections are about rows a page filtered to "Assigned to you" can never return — the ones you handed
// to someone else, and the ones nobody has — so grouping by Responsibility over such a page draws two permanently
// empty headings out of an incomplete list. Choosing it therefore widens that one filter to Anyone, and a page that
// arrives with the grouping already chosen (a preference restored at launch, a saved search's own arrangement) is
// widened before its rows are asked for. Status, type and text are left exactly as they are.
const needsAnyone = (key, f) => groupOf(key) === 'responsibility' && !!f && (f.assignee || 'anyone') !== 'anyone';
const widenFilter = (key, f) => (needsAnyone(key, f) ? { ...f, assignee: 'anyone' } : f);
// Group by Updated: how long ago the row last changed, newest first; past a month, or with no time to read, it is Older
const UPDATED_BUCKETS = [[36e5, 'Last hour'], [864e5, 'Last day'], [7 * 864e5, 'Last week'], [30 * 864e5, 'Last month']];
// Library starts arranged as the My Tasks saved search is (#113): by Responsibility, newest change first, showing each
// row's status and assignee. A choice the user makes replaces it; other views start ungrouped, in query order.
const VIEW_ARRANGEMENT = { library: { group: 'responsibility', sort: 'updated', display: ['status', 'assigned'] } };
const arranged = (k, what) => (VIEW_ARRANGEMENT[k] || {})[what];
// Keyed by the page, not the view: a saved search carries its own sort and grouping, stored in the document beside
// its query, so opening one shows the arrangement it was saved with rather than whatever the last view was using.
// A search's key is its document id, so the per-view defaults below simply do not match it.
const groupOf = (k) => { const g = groupPref[k] ?? arranged(k, 'group'); return GROUPS.some(([id]) => id === g) ? g : 'none'; };
const groupBy = () => groupOf(pillKey());
// A saved search's arrangement belongs in its document, so its keys are kept out of the browser-local preference
// blob: without this, changing any view's grouping would flush every search key it had accumulated to disk too.
const persistPref = (key, chosen) => setPref(key, Object.fromEntries(Object.entries(chosen).filter(([k]) => !k.startsWith('tana:'))));
// Stay put: an action that could reorder a view keeps its current group and order until Clean up, so nothing jumps
// away from the pointer. holdRow snapshots the order on screen and the row's group before the change; setView and a
// new Sort or Group let go.
// `view` here is the page key (a view id, or a saved search's document id), the same key the pills and the sort and
// group preferences use: holding rows in place is about the list in front of you, whichever kind of page it is.
let held = null, lastOrder = null; // held: { view, by, order: Map id -> index, groups: Map id -> title }; lastOrder: { view, ids }
function holdRow(n) {
  if (!held || held.view !== pillKey()) held = { view: pillKey(), by: groupBy(), order: new Map((lastOrder && lastOrder.view === pillKey() ? lastOrder.ids : []).map((id, i) => [id, i])), groups: new Map() };
  if (held.groups.has(n.id)) return;
  // Only a group the row has really been given. Before its metadata arrives Responsibility has no section for it and
  // Assignee reads Unassigned, and holding that answer kept the row there — out of the list, for Responsibility —
  // until Clean up. First boot is where it showed: My Tasks sorts by Updated, so the bootstrap each subscribed row
  // announces holds it (renderer/app.js), mostly before its metadata is back, and a third of the page stayed missing.
  const group = groupKey(n, held.by);
  if (group && (held.by !== 'assignee' || taskMetaById.has(n.id))) held.groups.set(n.id, group);
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
// The rows the page in front of you shows before sorting and grouping, as renderOutline lists them (the text filter
// applied): a view's own rows, or the ones a saved search's query returned. Clean up is about the list on screen, so
// on a search page this must not answer with the view waiting behind it.
const shownDocs = () => { const docs = (onSearchPage() ? kids.get(zoom.docId) : (viewOf() || {}).nodes) || [], q = filterEl.value.trim().toLowerCase(); return q ? docs.filter((n) => n.text.toLowerCase().includes(q)) : docs; };
// Forced, like setDisplay: choosing an arrangement is an explicit action whose whole point is to redraw, so it must
// not be deferred because a caret happens to sit in an editable title — which on a saved search page it often does,
// since the title is renameable and there is no draft row to take the focus.
function setGroupBy(id) {
  groupPref[pillKey()] = id; held = null; persistPref('groupBy', groupPref);
  // the same write the Assigned to pill makes: a view persists it and re-asks, a saved search stages it for Save
  if (needsAnyone(pillKey(), filters.get(pillKey()))) (onSearchPage() ? setSearchF : setViewF)({ assignee: 'anyone' });
  render(true);
}
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
  // The same lazily read metadata grouping by assignee uses; null means the row has no section here and is left out.
  if (by === 'responsibility') return responsibilityOf(n);
  return (visibleTags(n)[0] || {}).label || FALLBACK.type;
}
// [{ title, nodes }] in a fixed order: the status sequence as the Status menu lists it, names alphabetically,
// the "nothing here" group last. Only groups with rows are returned.
function groupRows(list, by) {
  const buckets = new Map();
  // no key means this grouping has no section for the row (Responsibility, above): it is left out, and since a
  // grouped page takes its flat list from the sections, it leaves the keyboard order too.
  for (const n of list) { const k = groupKey(n, by); if (!k) continue; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(n); }
  const fixed = by === 'status' ? STATES.map((s) => s[1]) : by === 'updated' ? UPDATED_BUCKETS.map((b) => b[1]) : by === 'responsibility' ? RESPONSIBILITY : [], last = FALLBACK[by]; // Updated: newest first
  const rank = (t) => (t === last ? 2 : fixed.includes(t) ? 0 : 1);
  return [...buckets.keys()]
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? fixed.indexOf(a) - fixed.indexOf(b) : a.localeCompare(b)))
    .map((title) => ({ title, nodes: buckets.get(title) }));
}
function groupsOf(list) {
  const by = groupBy();
  if (by === 'none') return null;
  if (by === 'assignee' || by === 'responsibility') loadMembers(); // the names for the headings, and who you are
  // every section holds rows: folded away (below) the heading stays and its rows are left out
  return groupRows(list, by).map((g) => { const id = groupId(g, by); return { ...g, id, collapsed: groupCollapsed(id) }; }).map(trimTracking)
    .map((g) => (by === 'responsibility' && !(held && held.view === pillKey() && held.by === by) ? latestPinFirst(g) : g));
}
// The Pinned section runs by latest pin date after Clean up; while held, the on-screen order wins like every group.
const latestPin = (n) => [...(datePinsById.get(n.id) || [])].sort().at(-1) || '';
const latestPinFirst = (g) => (g.id === 'Pinned' ? { ...g, nodes: [...g.nodes].sort((a, b) => latestPin(b).localeCompare(latestPin(a))) } : g);
// ---- collapsing a section: the heading stays, its rows fold away, one heading at a time ----
// Keyed by the page, its grouping and the section: Inbox folded away on Tasks says nothing about an Inbox heading on
// another page, and each grouping of a page folds on its own. The page key is a view id or a saved search's document
// id, so a search that is renamed keeps its folded sections.
// A section's own key is not the heading's words wherever the row carries something steadier: an assignee heading is
// a member's name, which arrives late and can be renamed, and a type heading is a type's title, so those two use the
// uri the row already carries. Status, Updated and Responsibility headings are fixed words from the tables above —
// their own key — and so are the fallbacks.
function groupId(g, by) {
  const n = g.nodes[0];
  if (!n) return g.title;
  if (by === 'assignee') { const meta = taskMetaById.get(n.id); return (meta && meta.assignees[0]) || FALLBACK.assignee; }
  if (by === 'type') return (visibleTags(n)[0] || {}).uri || g.title;
  return g.title;
}
// Remembered across launches, the way the sidebar remembers its closed sections (renderer/rail.js): the set itself is
// read at load in renderer/state.js, and only folded sections are in it, so nothing accumulates but what you folded.
const collapseKey = (id) => pillKey() + '\n' + groupBy() + '\n' + id;
const groupCollapsed = (id) => collapsedGroups.has(collapseKey(id));
// Forced, like setGroupBy: the click's whole point is to redraw, and on a saved search page the caret often sits in
// the renameable title, which would otherwise defer the render.
function toggleGroup(id) {
  const key = collapseKey(id);
  if (!collapsedGroups.delete(key)) collapsedGroups.add(key);
  trackingShown.delete(key); // an unfolded Tracking or Pinned section opens short again (trimTracking)
  setPref('collapsedGroups', [...collapsedGroups]);
  render(true);
}
// ---- Tracking: the long tail behind a link ----
// Work you handed over piles up, and most of it has not moved in weeks, so the section opens on what has: the rows
// updated in the last three days. The rest arrives on one click and stays for as long as the section stays open —
// folding it forgets, so it opens short again, which is the whole point of opening short. A row with no update time
// to read is part of the tail. Session state, like holding rows in place: it is about the list in front of you, so
// there is nothing to store and nothing to clean up. Pinned opens short the same way, on what is pinned to a day in
// the coming week or already past; a task pinned only further ahead than that is the tail. Every other section is
// work with your name on it, where a row that has not moved is exactly the one you need to see.
const TRACKING_RECENT = 3 * 864e5;
const trackingShown = new Set(); // collapseKey of a Tracking or Pinned section that has been asked for whole
const movedRecently = (n) => Date.now() - Date.parse(n.updatedAt) < TRACKING_RECENT;
const pinnedSoon = (n) => (datePinsById.get(n.id) || []).some((date) => date <= localDate(7));
const OPENS_ON = { Tracking: movedRecently, Pinned: pinnedSoon };
function trimTracking(g) {
  const keep = OPENS_ON[g.id];
  if (!keep || g.collapsed || trackingShown.has(collapseKey(g.id))) return g;
  const recent = g.nodes.filter(keep);
  // "more" is what the link offers; without one the section is drawn exactly as any other
  return recent.length === g.nodes.length ? g : { ...g, nodes: recent, more: g.nodes.length - recent.length };
}
// Forced, like toggleGroup: the click's whole point is to redraw.
function showAllTracking(id) { trackingShown.add(collapseKey(id)); render(true); }
// ---- sort: the same rows in another order, again without asking the backend for anything ----
// Only what a row actually carries can be sorted on. main.js toNode passes updatedAt and createdAt as ISO 8601
// strings, so they compare as strings; a row that carries neither (an older cached row) keeps its place at the end.
const SORTS = [['default', 'Default'], ['status', 'Status'], ['updated', 'Updated'], ['created', 'Created'], ['title', 'Title']];
// Status sorts by the workflow rather than by the word: Inbox, In Progress, Completed, Later — the order the Status
// menu and the Status grouping already run in, so the rank is that table's own index. A row with no task state has
// nothing to rank and keeps its place at the end, like any other row missing the field it is sorted on.
const statusRank = (n) => { const i = STATES.findIndex(([id]) => id === stateOf(n)); return i < 0 ? undefined : String(i); };
const SORT_KEY = { status: statusRank, updated: (n) => n.updatedAt, created: (n) => n.createdAt, title: (n) => (n.text || n.title || '').toLowerCase() };
const NEWEST_FIRST = new Set(['updated', 'created']); // times read newest first; Title stays A→Z
// Every page, saved searches included, keeps the order its query returned until the user says otherwise; Library's
// starting arrangement above (newest change first) is the one exception.
const sortBy = () => { const k = pillKey(), s = sortPref[k] ?? arranged(k, 'sort'); return SORTS.some(([id]) => id === s) ? s : 'default'; };
function setSortBy(id) { sortPref[pillKey()] = id; held = null; persistPref('sortBy', sortPref); render(true); }
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
const DISPLAY = [['type', 'Type'], ['space', 'Lives in'], ['status', 'Status'], ['assigned', 'Assigned'], ['updated', 'Updated'], ['created', 'Created'], ['creator', 'Created by']];
const DISPLAY_DEFAULT = ['status', 'assigned', 'updated'];
const displayKeys = () => { const k = pillKey(), chosen = displayPref[k] ?? arranged(k, 'display'); return Array.isArray(chosen) ? chosen : DISPLAY_DEFAULT; };
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
// The days a row in the Pinned section is pinned to, first in its grey line: "Pinned to Today · 2026-09-22". Only in
// that section, where the day is why the row is there; groupKey so a row held in place elsewhere does not claim it.
function pinnedOn(n) {
  const dates = datePinsById.get(n.id);
  if (!dates || groupBy() !== 'responsibility' || groupKey(n, 'responsibility') !== 'Pinned') return '';
  return 'Pinned to ' + [...dates].sort().map(pinDateLabel).join(', ');
}
// The grey line under a title: when it was made, when it last moved, where it lives — in that order, bullet separated.
// "Lives in" only has an answer for a document shared with a space, which is the only place a row learns a space name.
function subtextOf(node, taskInfo) {
  const bits = [];
  if (node.proposal) bits.push(node.proposal.note); // where it was proposed, first: it is why the row is on the Proposals page
  const pinned = pinnedOn(node); if (pinned) bits.push(pinned);
  if (displayOn('space') && taskInfo && taskInfo.audience && taskInfo.audience.space) bits.push(taskInfo.audience.space);
  // Who made it joins when it was made rather than repeating the word: "Created 2 days ago by Robin Vega". The name
  // needs the member list, which loads once and re-renders when it lands; until then memberName answers with the uri.
  if (displayOn('creator') && node.createdBy) loadMembers();
  const by = displayOn('creator') && node.createdBy ? ' by ' + memberName(node.createdBy) : '';
  if (displayOn('created') && node.createdAt) bits.push('Created ' + agoText(node.createdAt) + by);
  else if (by) bits.push('Created' + by);
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
  // a folded section's rows are not drawn, so they leave the keyboard order too — Down from the heading above lands
  // on the next section, never on a row nobody can see
  return { list: groups ? groups.flatMap((g) => (g.collapsed ? [] : g.nodes)) : sorted, groups, hidden: list.length - found.length };
}
// a heading is not a node: no key, no bullet, and nodeEls() already skips anything without .node. It is a real button
// so Tab reaches it and Enter or Space folds its section away, with the disclosure triangle drawn in CSS from
// aria-expanded; mousedown is swallowed like a row's chevron does, so clicking a heading cannot take a selection away.
function groupHeadEl(g) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'ghead';
  const chev = iconNode('chevronRight'); // the icon set's own chevron, turned a quarter down by CSS while the section is open
  el.append(...(chev ? [chev] : []), document.createTextNode(g.title));
  el.setAttribute('aria-expanded', g.collapsed ? 'false' : 'true');
  el.title = g.collapsed ? 'Expand' : 'Collapse'; // the words the row chevrons already use
  el.onmousedown = (e) => e.preventDefault();
  el.onclick = () => (g.toggle ? g.toggle() : toggleGroup(g.id)); // a page with sections of its own folds them itself (renderer/proposals.js)
  return el;
}
// The tail of a trimmed section, one click away. A button like the heading rather than a row: no key, no bullet, and
// nodeEls() passes it by, so it is not somewhere the keyboard can land; mousedown is swallowed the same way, so
// clicking it cannot take a selection away.
function groupMoreEl(g) {
  const el = document.createElement('button');
  el.type = 'button'; el.className = 'gmore';
  el.textContent = 'Show ' + g.more + ' more task' + (g.more === 1 ? '' : 's');
  el.onmousedown = (e) => e.preventDefault();
  el.onclick = () => showAllTracking(g.id);
  return el;
}
