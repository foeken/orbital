'use strict';
const db = require('../db');
const path = require('node:path');
const { peerIdentity } = require('../tana-session');
const { createTanaClient } = require('../sdk');
const { parseQuery, searchParams, needsTypes, viewParams, completedInWindow, filterToSearchQuery, validViewFilter, VIEW_PRESETS, hideRules, isHidden } = require('../sdk/query');
const { LIVE_ROWS, NOT_CONNECTED, S, deletedNodes, docStates, errText, idKind, isDeleted, isMcp, memberTitle, now, reading, truncatedViews, typeTitles, redoStack, report, send, setStatus, subscribed, undoStack, visibleGraphNodes } = require('./state');
const { graphRow, rememberNodeHue, resolveTypes, toNode, typesByTitle } = require('./rows');
const { codexIds, createDocument, inHistory, notifySilencedIds, notifyWatchedIds, onChange, subscribe } = require('./documents');
const settings = require('./settings');


// Persisted view filters are merged over their preset; an invalid saved value cannot strand a view across restarts.
const preset = (id) => {
  if (!Object.hasOwn(VIEW_PRESETS, id)) throw new Error('unknown view: ' + id);
  return { ...VIEW_PRESETS[id] };
};
const viewFilter = (id) => {
  const saved = settings.get('viewFilter:' + id);
  return validViewFilter(saved) ? { ...preset(id), ...saved } : preset(id);
};
const setViewFilter = (id, filter) => {
  const next = validViewFilter(filter) ? { ...preset(id), ...filter } : preset(id);
  settings.set('viewFilter:' + id, next);
  return next;
};
// The user's hidden-title patterns ("Block*", "Lunch", …): normalised on every read, so a list written by an older
// build or by a bad renderer call cannot empty a view (sdk/query.js has the matching rule).
const hiddenRules = () => hideRules(settings.get('hiddenTitles'));
// MCP chats (Tana's own MCP writes them) kept out of every list and search: one app-local switch, toggled from Cmd+K.
// Not a view filter: a filter key has to round-trip into a saved search, which is what killed the per-view
// includeMcp toggle (#247). Off unless the setting says otherwise.
const mcpHidden = () => settings.get('hideMcp') === true;
async function viewRows(id, filter) {
  if (!S.client) return { nodes: [], truncated: false };
  const base = viewFilter(id);
  const f = filter === undefined ? base : validViewFilter(filter) ? { ...base, ...filter } : preset(id);
  if (!validViewFilter(f)) throw new Error('invalid view filter');
  const result = await S.client.graph.listNodes(viewParams(f, S.me.userUri));
  const docsWithoutTasks = Array.isArray(f.types) && f.types.includes('docs') && !f.types.includes('tasks');
  const rules = hiddenRules();
  const nodes = result.nodes.filter((n) => !(docsWithoutTasks && idKind(n.id) === 'text' && n.state && n.state.type))
    // the completed window (sdk/query.js): the graph has no field to ask it for, so it is applied to the answer
    .filter((n) => completedInWindow(n, f.completedWithin))
    .filter((n) => !isHidden(memberTitle(n), rules));
  nodes.forEach(rememberNodeHue);
  // Also the spaces the rows live in, for the Types view's subtext. A type node carries its space on the graph node
  // itself (verified: `spaceUri`, the same uri as `ownerUri`), so this is the one nodeIds lookup resolveTypes already
  // does for type titles rather than an owner chain per row.
  await resolveTypes([...nodes.map((n) => n.entityType), ...nodes.filter((n) => idKind(n.id) === 'type').map((n) => n.spaceUri)]);
  const withDate = !(f.types && f.types.length === 1 && f.types[0] === 'meetings');
  const rows = nodes.map((n) => {
    const row = graphRow(n, withDate);
    if (isMcp(n)) return { ...row, meta: 'MCP' };
    // Where a type lives, beside its name: two spaces can hold a type of the same title, and an unowned one is in the Library.
    if (idKind(n.id) === 'type') return { ...row, meta: typeTitles.get(n.spaceUri) || 'Library' };
    return row;
  });
  db.replaceSection(id, rows);
  if (id === S.activeView && filter === S.activeFilter) {
    // The head of the list, not all of it (LIVE_ROWS in main/state.js): a wide Library lists hundreds of rows, and
    // subscribing every one of them meant hundreds of bootstraps on one connection and a redraw per bootstrap.
    // The tail keeps its cached row and is re-read by the 30 s refresh like everything else.
    const ids = new Set(nodes.slice(0, LIVE_ROWS).map((n) => n.id));
    // a node you asked to be told about — or the rule watches, or that was handed to the Codex agent — stays
    // subscribed wherever you are
    const watched = new Set([...notifyWatchedIds(), ...ruleWatched, ...codexIds()]);
    for (const nodeId of ids) if (!subscribed.has(nodeId)) { subscribed.add(nodeId); subscribe(nodeId); }
    // Leaving a filtered view must not discard a document whose local undo step still points at its Loro handle.
    // ...and neither is a document an on-demand read is still waiting for: unsubscribing a bootstrap in flight
    // rejects it as 'unsubscribed <id>' under the reader (main/state.js reading).
    for (const nodeId of subscribed) if (!ids.has(nodeId) && !watched.has(nodeId) && !deletedNodes.has(nodeId) && !inHistory(nodeId) && !reading.has(nodeId)) { subscribed.delete(nodeId); docStates.delete(nodeId); S.client.sync.unsubscribe(nodeId).catch(() => {}); }
  }
  if (result.truncated) truncatedViews.add(id); else truncatedViews.delete(id);
  return { nodes: rows.map(toNode), truncated: !!result.truncated };
}

// Live search over all top-level items (graph full-text search, relevance order) with #task/#meeting/#Type filters.
async function search(query) {
  if (!S.client) return [];
  const parsed = parseQuery(query);
  const params = searchParams(parsed, needsTypes(parsed) ? await typesByTitle() : new Map());
  if (!params) return [];
  // The server ranks by full-text relevance, so a document titled exactly like the query can sit past the first
  // page: fetch wide, rank here, and hand back a page's worth.
  // Members ride in a query of their own: a profile's title is a name, which loses the relevance race to every
  // document that mentions it, so a plain search's 200 never held one and "@" could not find a person.
  const [{ nodes: found }, { nodes: people }] = await Promise.all([
    S.client.graph.listNodes({ ...params, limit: 200 }),
    params.textQuery && params.nodeTypes.includes('user-profile') && params.nodeTypes.length > 1
      ? S.client.graph.listNodes({ ...params, nodeTypes: ['user-profile'], limit: 50 }).catch(() => ({ nodes: [] })) : { nodes: [] },
  ]);
  const seen = new Set(found.map((n) => n.id)), nodes = [...found, ...people.filter((n) => !seen.has(n.id))];
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  // Title matches first (exact, then prefix, then contains), and within a class the title the query covers most:
  // "Tana" beats "The one where Tana meets the team". Full-text hits keep the server's relevance order.
  const q = parsed.text.trim().toLowerCase();
  const rank = (n) => { const t = (n.title || '').toLowerCase(); return t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3; };
  const cover = (n) => { const t = (n.title || '').toLowerCase(); return t.includes(q) && t.length ? q.length / t.length : 0; };
  return nodes.map((n, i) => [rank(n), cover(n), i, n])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2])
    .slice(0, 40)
    .map(([, , , n]) => toNode(graphRow(n, true)));
}

// Saved searches, newest first. Read-only and view-independent: this does not touch S.activeView or the row cache.
async function searchList() {
  if (!S.client) return [];
  const { nodes } = await S.client.graph.listNodes({
    nodeTypes: ['search'], limit: 200,
    sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
  });
  const rules = hiddenRules();
  return nodes.filter((n) => !isHidden(n.title, rules)).map((n) => toNode(graphRow(n)));
}

// "Save this query as a search": the view's own stored filter, in the document vocabulary, as a new saved search.
// The translation happens here rather than in the renderer because the renderer is classic scripts with no require,
// so it cannot reach sdk/query — and main already owns the canonical filter anyway (viewFilter merges the preset
// with whatever the user changed). The renderer therefore sends a view id, never a query it built itself.
const SEARCH_NAME = { inbox: 'Inbox', library: 'Library' };
// A name from what the filter actually says, so a saved search does not arrive called "Untitled". Tana names its
// own searches for the intent rather than the mechanism; this is the closest main can get without the pill labels,
// which live in the renderer.
function searchTitle(id, filter) {
  const base = SEARCH_NAME[id] || 'Search';
  const bits = [];
  if (filter.text && filter.text.trim()) bits.push('"' + filter.text.trim() + '"');
  if (Array.isArray(filter.states) && filter.states.length) bits.push(filter.states.join(', '));
  if (filter.assignee === 'me') bits.push('mine');
  else if (filter.assignee === 'unassigned') bits.push('unassigned');
  return bits.length ? base + ' — ' + bits.join(' · ') : base;
}
async function searchCreate(id, title) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const filter = viewFilter(id); // throws on an unknown view before anything is created
  const query = filterToSearchQuery(filter, S.me && S.me.userUri);
  const name = typeof title === 'string' && title.trim() ? title.trim() : searchTitle(id, filter);
  return createDocument(name, { kind: 'search', query });
}

async function start() {
  // A second login must not leave the previous stream, its listeners and its subscriptions running: the stale S.client
  // would keep emitting changes, and the new one would skip every id the old subscription set still claims.
  // The new S.client's documents start with empty Loro undo managers, so the steps recorded against the old ones are dead.
  if (S.client) { const previous = S.client; S.client = null; subscribed.clear(); undoStack.length = 0; redoStack.length = 0; previous.sync.removeAllListeners(); previous.close().catch(() => {}); }
  S.me = await S.session.info();
  const peer = peerIdentity({ file: path.join(S.userData, 'peer.json'), userExternalId: S.me.userExternalId });
  S.client = createTanaClient({ getAccessToken: (o) => S.session.getAccessToken(o), orgId: S.me.orgId, ...peer, logger: console });
  listFilter(S.client);
  S.client.sync.on('connected', () => setStatus({ connected: true, error: null }));
  S.client.sync.on('disconnected', () => setStatus({ connected: false }));
  S.client.sync.on('error', (e) => setStatus({ error: errText(e) }));
  S.client.sync.on('change', onChange);
  // Tana refused an edit but still lets us read it: say so, and redraw the row, which doc:info now reports read-only.
  S.client.sync.on('write-denied', (id) => { setStatus({ error: 'Tana refused your edits to this node; it is read-only now' }); send('outline:changed', id, { meta: true }); });
  setStatus({ authenticated: true });
  await S.client.sync.connect();
  // The settings document decides before anything is listed: a view's filter, the hidden titles and the MCP switch
  // are all read on the way into the first refresh, and on a new machine this is also what pushes them up.
  try { await settings.hydrate(); } catch (e) { report(e); }
  // Watched nodes are live from boot, listed or not: a deleted or unreachable one is simply not watched any more.
  for (const id of new Set([...notifyWatchedIds(), ...codexIds()])) S.client.sync.subscribe(id).catch(() => {});
  await refresh();
}

// How many nodes are waiting in the Inbox, for the badge on the app icon. A count query rather than the Inbox view's
// cached rows: it is exact whether or not that view has ever been opened, and it is not capped at the row limit.
// Hidden titles are dropped after the query (viewRows filters them client-side), so a hidden node still counts here.
async function inboxCount() {
  if (!S.client) return 0;
  // Yours, not everyone's: a badge is a count of what is waiting on you, so it narrows the Inbox to your own nodes.
  const { totalCount, nodes } = await S.client.graph.listNodes({ ...viewParams({ ...VIEW_PRESETS.inbox, assignee: 'me' }, S.me.userUri), limit: 1 });
  return totalCount != null ? totalCount : (nodes || []).length;
}
// one refresh at a time; callers that changed the filter await the in-flight run and start a new one
function refresh() {
  if (!S.client) return Promise.resolve();
  return S.refreshing ||= doRefresh().finally(() => { S.refreshing = null; });
}
S.refresh = refresh;
// The tasks the watch rule follows: made by you and not assigned to you (main/documents.js notifyDefault). They are
// precisely what no view lists — Inbox and Library are about your own work — so nothing subscribed them and their
// changes never reached onChange: somebody else completing a task you gave them announced nothing at all. One query
// beside the view's own, on the same loop, and the ids it finds are exempt from the unsubscribe sweep above.
// Closed tasks with a previously seen non-closed state stay in the answer: that is how a completion made while the
// app was away reaches the catch-up comparison in documents.js. Old completed work has no stored transition and is
// dropped before subscribing, so it cannot turn this into a history crawl.
// ponytail: capped at 200 recently indexed tasks you created; page it if anyone ever passes that.
const ruleWatched = new Set();
async function refreshWatched() {
  const me = S.me && S.me.userUri;
  if (!me) return;
  const seen = db.setting('notifySeen') || {};
  const silenced = notifySilencedIds(); // an explicit "stop notifying" wins over the rule, here as everywhere else
  const { nodes } = await S.client.graph.listNodes({ nodeTypes: ['text'], createdBy: [me], stateTypes: ['proposed', 'open', 'closed', 'not_now'], limit: 200 });
  ruleWatched.clear();
  for (const n of nodes) {
    if (silenced.has(n.id)) continue; // you turned it off: not watched, and not held subscribed either
    if ((n.assignedTo || []).includes(me)) continue; // yours to look at, so the rule leaves it alone
    if (n.state?.type === 'closed' && (!Array.isArray(seen[n.id]) || seen[n.id][1] === 'closed')) continue;
    ruleWatched.add(n.id);
    if (!subscribed.has(n.id)) { subscribed.add(n.id); subscribe(n.id); }
  }
}
async function doRefresh() {
  setStatus({ syncing: true, error: null });
  try {
    // before the view, so the sweep in viewRows sees the set this refresh found rather than the last one's
    try { await refreshWatched(); } catch { /* the watch set keeps what it had, like the badge keeps its number */ }
    await viewRows(S.activeView, S.activeFilter);
    send('outline:changed', null);
    setStatus({ syncing: false, lastSync: now() });
    // The badge rides the same refresh the views do, in its own try and deliberately silent: a number on the app icon
    // is not worth an error banner over a refresh that worked, so a failed count leaves the badge as it was until the
    // next one. Everything else here reports through setStatus, which is why this exception is called out.
    try { if (S.badge) S.badge(await inboxCount()); } catch { /* the badge keeps its last number */ }
  } catch (e) {
    setStatus({ syncing: false, error: errText(e) });
  }
}

// Every list and every search asks the graph, so S.client.graph.listNodes is the one place deleted and hidden nodes
// are dropped. A by-id lookup (nodeIds) resolves a named node — a mention, an owner chain, a pin, a zoomed
// document — and keeps answering: hiding is about lists, not about access.
function listFilter(c) {
  if (!c || !c.graph) return;
  const listNodes = c.graph.listNodes.bind(c.graph);
  c.graph.listNodes = async params => {
    const result = await listNodes(params);
    // Compare the count with the raw response: local delete/title filters must not masquerade as server truncation.
    const truncated = result.totalCount != null ? result.totalCount > result.nodes.length : !!result.truncated;
    // This is also the only place a deletion nobody told us about arrives: a node deleted on another device, never
    // subscribed here, so no change event ever ran. Remembering the tombstone rather than only dropping the row is
    // what lets a reference to it be drawn as deleted (main/documents.js) instead of merely unreadable.
    for (const n of result.nodes) if (isDeleted(n)) deletedNodes.add(n.id);
    const nodes = visibleGraphNodes(result.nodes);
    if (params && params.nodeIds) return { ...result, nodes, truncated };
    const rules = hiddenRules(), hideMcp = mcpHidden();
    // The app's own settings document is app plumbing, not a note: it is kept out of every list and search the way
    // a hidden title is, and stays reachable by id like everything else that is filtered here.
    const settingsDoc = settings.settingsDocId();
    return { ...result, nodes: nodes.filter(n => n.id !== settingsDoc && !isHidden(memberTitle(n), rules) && !(hideMcp && isMcp(n))), truncated };
  };
}
// Changing the list refreshes like any other filter change: replaceSection drops the rows that are now hidden, so
// nothing comes back from the SQLite cache.
async function setHidden(list) {
  const rules = hideRules(list);
  settings.set('hiddenTitles', rules);
  await S.refreshing; // a run with the old list
  await refresh();
  send('outline:changed', null); // also when there is no connection to refresh with
  return rules;
}
// The MCP switch refreshes the same way: the rows that are now hidden leave the cache with the refresh.
async function setMcpHidden(on) {
  settings.set('hideMcp', !!on);
  await S.refreshing;
  await refresh();
  send('outline:changed', null);
  return mcpHidden();
}

// Subscribing on demand (zoom, create, metadata) does not put a document in a view, and only the refresh unsubscribes:
// a document listed here as well would lose its live updates and its Loro undo history under the open editor.
// ponytail: on-demand subscriptions last for the S.session; drop the oldest if a long S.session ever holds too many.


module.exports = { preset, viewFilter, setViewFilter, hiddenRules, mcpHidden, viewRows, inboxCount, search, searchList, searchCreate, searchTitle, start, refresh, doRefresh, listFilter, setHidden, setMcpHidden };
