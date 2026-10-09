'use strict';
const db = require('../db');
const path = require('node:path');
const { peerIdentity } = require('../tana-session');
const { createTanaClient, takeCalls } = require('../sdk');
const { everyoneOnly } = require('../sdk/access');
const { liveTrigger, parseQuery, searchParams, needsTypes, viewParams, completedInWindow, completedWindow, filterToSearchQuery, searchQueryToFilter, validViewFilter, VIEW_PRESETS, hideRules, isHidden, addMeetingChats } = require('../sdk/query');
const { readSearch, searchDisplay, searchSort, setSearchQuery, setSearchView, rowLimit } = require('../sdk/node');
const { DOC_URI, LIVE_ROWS, NOT_CONNECTED, S, VIEWS, deletedNodes, docStates, errText, idKind, inboxFrom, handedAt, isDeleted, isMcp, memberTitle, now, pageOf, reading, truncatedViews, typeTitles, redoStack, report, scheduleRefresh, send, setStatus, subscribed, undoStack, visibleGraphNodes } = require('./state');
const { graphRow, members, rememberNodeHue, resolveMeetings, resolveTypes, toNode, typesByTitle } = require('./rows');
const { agentIds, createDocument, creatorOf, document, forgetOwners, historyIds, isLiveRef, mut, op, notifySilencedIds, notifyWatchedIds, onChange, pruneSeen, releaseOnDemand, reliveRefs, subscribe, workflowTypes } = require('./documents');
const { watchedPages, withSearchHeads } = require('./related');
const presence = require('./presence');
const { tellSidebars } = require('./pins');
const settings = require('./settings');
const { openLiveQuery } = require('../sdk/livequery');


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
// A view's filter as it is asked: its stored filter under what this window sent, the preset if that is unreadable.
const effectiveFilter = (id, filter) => { const base = viewFilter(id); return filter === undefined ? base : validViewFilter(filter) ? { ...base, ...filter } : preset(id); };
async function viewRows(id, filter) {
  if (!S.client) return { nodes: [], truncated: false };
  const f = effectiveFilter(id, filter);
  if (!validViewFilter(f)) throw new Error('invalid view filter');
  const result = await S.client.graph.listNodes(viewParams(f, S.me.userUri, undefined, await workflowTypes(f.types || [])));
  const docsWithoutTasks = Array.isArray(f.types) && f.types.includes('docs') && !f.types.includes('tasks');
  const rules = hiddenRules();
  let nodes = result.nodes.filter((n) => !(docsWithoutTasks && idKind(n.id) === 'text' && n.state && n.state.type))
    // the completed window (sdk/query.js): the graph has no field to ask it for, so it is applied to the answer
    .filter((n) => completedInWindow(n, f.completedWithin))
    .filter((n) => !isHidden(memberTitle(n), rules));
  if (f.audience === 'everyone') nodes = await everyoneOnly(S.client.graph, nodes);
  nodes.forEach(rememberNodeHue);
  // Also the spaces the rows live in, for the Types view's subtext. A type node carries its space on the graph node
  // itself (verified: `spaceUri`, the same uri as `ownerUri`), so this is the one nodeIds lookup resolveTypes already
  // does for type titles rather than an owner chain per row.
  await Promise.all([resolveTypes([...nodes.map((n) => n.entityType), ...nodes.filter((n) => idKind(n.id) === 'type').map((n) => n.spaceUri)]), resolveMeetings(nodes)]);
  const withDate = !(f.types && f.types.length === 1 && f.types[0] === 'meetings');
  const rows = nodes.map((n) => {
    const row = graphRow(n, withDate);
    if (isMcp(n)) return { ...row, meta: 'MCP' };
    // Where a type lives, beside its name: two spaces can hold a type of the same title, and an unowned one is in the Library.
    if (idKind(n.id) === 'type') return { ...row, meta: typeTitles.get(n.spaceUri) || 'Library' };
    return row;
  });
  db.replaceSection(id, rows);
  // Every read of a view settles the live queries (PR #152 review): a changed filter reads the view straight away
  // (view:list), and its trigger has to follow then rather than at the next refresh.
  watchViews();
  if (openViews().some((v) => v.id === id)) {
    // The head of the list, not all of it (LIVE_ROWS in main/state.js): a wide Library lists hundreds of rows, and
    // subscribing every one of them meant hundreds of bootstraps on one connection and a redraw per bootstrap.
    // The tail keeps its cached row and is re-read by the next refresh like everything else.
    const ids = new Set(nodes.slice(0, LIVE_ROWS).map((n) => n.id));
    // a node you asked to be told about — or the rule watches, or that was handed to the Codex agent — stays
    // subscribed wherever you are
    const watched = new Set([...notifyWatchedIds(), ...ruleWatched, ...agentIds()]);
    liveIds.set(id, ids);
    for (const nodeId of ids) if (!subscribed.has(nodeId)) { subscribed.add(nodeId); subscribe(nodeId); }
    // ...and so does what another window's view lists (issue #137)
    const shown = new Set(openViews().flatMap((v) => [...(liveIds.get(v.id) || [])]));
    // ...and the page on screen in any window, which a list it has dropped out of must not take its live edits from
    const onScreen = new Set(withSearchHeads([...presence.openIds(), ...watchedPages()])), history = historyIds();
    // Leaving a filtered view must not discard a document whose local undo step still points at its Loro handle.
    // ...and neither is a document an on-demand read is still waiting for: unsubscribing a bootstrap in flight
    // rejects it as 'unsubscribed <id>' under the reader (main/state.js reading).
    const held = (nodeId) => shown.has(nodeId) || watched.has(nodeId) || deletedNodes.has(nodeId) || history.has(nodeId) || reading.has(nodeId) || onScreen.has(nodeId) || isLiveRef(nodeId);
    const gone = [];
    for (const nodeId of subscribed) if (!held(nodeId)) { subscribed.delete(nodeId); docStates.delete(nodeId); S.client.sync.unsubscribe(nodeId).catch(() => {}); gone.push(nodeId); }
    gone.push(...releaseOnDemand(held)); // what reads opened, oldest first, past LIVE_ROWS of them (main/documents.js)
    gone.forEach(forgetOwners); // and the owners their audience was read through no longer answer for them (#477)
    // No change to these reaches a page any more: an outline a page keeps for one would go stale unnoticed (#389)
    if (gone.length) send('outline:released', gone);
  }
  if (result.truncated) truncatedViews.add(id); else truncatedViews.delete(id);
  return { nodes: rows.map(toNode), truncated: !!result.truncated };
}

// The views on screen: one per outliner window (S.windowViews, main.js), the same view once however many show it.
// Without a window (the checks, the CLI) it is the one the last view:list asked for, as it always was.
const liveIds = new Map(); // view id -> the head of its last answer, the rows kept subscribed while a window shows it
function openViews() {
  const byId = new Map();
  for (const v of (S.windowViews && S.windowViews.values()) || []) if (!byId.has(v.id)) byId.set(v.id, v);
  return byId.size ? [...byId.values()] : [{ id: S.activeView, filter: S.activeFilter }];
}

// Live search over all top-level items (graph full-text search, relevance order) with #task/#meeting/#Type filters.
// Tana's own search page adds the documents only a semantic search found, fetched by id under the same filters and
// listed after the rest; here they come last and carry `related: true` (issue #20).
// scope narrows it for a link field (issue #33), the way Tana's link picker asks: { types } is the field's target
// types (entityTypes), { members } a member field. With a scope an empty query lists what fits, newest first.
async function search(query, scope) {
  if (!S.client) return [];
  const parsed = parseQuery(query);
  let params = searchParams(parsed, needsTypes(parsed) ? await typesByTitle() : new Map());
  if (scope && typeof scope === 'object') {
    params = params || { nodeTypes: ['text', 'event', 'user-profile', 'space', 'search'], limit: 20, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] };
    if (scope.members) { params.nodeTypes = ['user-profile']; delete params.entityTypes; }
    else if (Array.isArray(scope.types) && scope.types.length) params.entityTypes = scope.types.filter((t) => typeof t === 'string');
  }
  if (!params) return [];
  const text = parsed.text.trim();
  // The server ranks by full-text relevance, so a document titled exactly like the query can sit past the first
  // page: fetch wide, rank here, and hand back a page's worth.
  // Members ride in a query of their own: a profile's title is a name, which loses the relevance race to every
  // document that mentions it, so a plain search's 200 never held one and "@" could not find a person.
  const [{ nodes: found }, { nodes: people }, semantic] = await Promise.all([
    S.client.graph.listNodes({ ...params, limit: 200 }),
    params.textQuery && params.nodeTypes.includes('user-profile') && params.nodeTypes.length > 1
      ? S.client.graph.listNodes({ ...params, nodeTypes: ['user-profile'], limit: 50 }).catch(() => ({ nodes: [] })) : { nodes: [] },
    // Tana asks from four characters on, and reads a failure (FailedPrecondition: not enabled) as no related results.
    text.length >= 4 ? S.client.search.semanticSearch({ query: text, limit: 20 }).catch(() => []) : [],
  ]);
  const seen = new Set(found.map((n) => n.id)), nodes = [...found, ...people.filter((n) => !seen.has(n.id))];
  nodes.forEach((n) => seen.add(n.id));
  const ids = [...new Set(semantic.map((r) => r.documentId))].filter((id) => DOC_URI.test(id) && !seen.has(id));
  let related = [];
  if (ids.length) {
    // by id, but under the search's own filters, so "#task budget" relates only tasks; no text left to rank by
    const byId = { ...params, nodeIds: ids, limit: ids.length };
    delete byId.textQuery; delete byId.sortOptions;
    const got = new Map((await S.client.graph.listNodes(byId).catch(() => ({ nodes: [] }))).nodes.filter(listed()).map((n) => [n.id, n]));
    related = ids.map((id) => got.get(id)).filter(Boolean);
  }
  [...nodes, ...related].forEach(rememberNodeHue);
  await Promise.all([resolveTypes([...nodes, ...related].map((n) => n.entityType)), resolveMeetings([...nodes, ...related])]);
  // Title matches first (exact, then prefix, then contains), and within a class the title the query covers most:
  // "Tana" beats "The one where Tana meets the team". Full-text hits keep the server's relevance order.
  const q = text.toLowerCase();
  const rank = (n) => { const t = (n.title || '').toLowerCase(); return t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3; };
  const cover = (n) => { const t = (n.title || '').toLowerCase(); return t.includes(q) && t.length ? q.length / t.length : 0; };
  return nodes.map((n, i) => [rank(n), cover(n), i, n])
    .sort((a, b) => a[0] - b[0] || b[1] - a[1] || a[2] - b[2])
    .slice(0, 40)
    .map(([, , , n]) => toNode(graphRow(n, true)))
    .concat(related.map((n) => ({ ...toNode(graphRow(n, true)), related: true })));
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
  const query = filterToSearchQuery(filter, S.me && S.me.userUri, await workflowTypes(filter.types || []));
  const name = typeof title === 'string' && title.trim() ? title.trim() : searchTitle(id, filter);
  return createDocument(name, { kind: 'search', query, view: { completedWithin: filter.completedWithin, audience: filter.audience, limit: filter.limit } });
}
// My Tasks, the right half of the Work View (renderer/timeline.js): the search the synced setting 'myTasks' names, so a
// rename in Tana keeps it and two machines share it; without one, your own saved search of that name (the oldest, so
// two machines that made one at once settle on the same); else one made from the My Tasks preset (VIEW_PRESETS.library)
// and shown the way the Library shows it. The one made here is also remembered for the session and its client (another
// login is another account), because the graph's index lags a creation and would not list it yet. A deleted one is
// dropped by the graph wrapper, so the next ask makes a fresh one. findOnly (demo mode) never makes one.
let myTasksAsk = null, myTasksMade = null;
async function findMyTasks() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  // The renderer asks the moment sync connects, which can be before start() has read the settings document: on a new
  // machine the id is only there once it has. hydrate is cheap once the document is open.
  try { await settings.hydrate(); } catch (e) { report(e); }
  const known = settings.get('myTasks');
  if (typeof known === 'string' && known) {
    const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: [known] }); // a lookup by id skips hidden titles, not deletions
    if (nodes[0]) return toNode(graphRow(nodes[0]));
  }
  // every saved search of yours, past hidden titles too: hiding "My Tasks" from the lists must not make one per launch
  const raw = S.client.graph.listNodesUnhidden || S.client.graph.listNodes;
  const { nodes = [] } = await raw({ nodeTypes: ['search'], createdBy: [S.me.userUri], limit: 1000 });
  const found = visibleGraphNodes(nodes).filter((n) => /^my tasks$/i.test(String(n.title || '').trim()))
    .sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')))[0];
  if (found) { settings.set('myTasks', found.id); return toNode(graphRow(found)); }
  return myTasksMade && myTasksMade.client === S.client && !deletedNodes.has(myTasksMade.node.id) ? myTasksMade.node : null;
}
function myTasks(findOnly) {
  if (findOnly) return findMyTasks(); // null when there is none yet
  myTasksAsk ||= (async () => {
    const found = await findMyTasks();
    if (found) return found;
    const filter = preset('library'), client = S.client;
    const node = await createDocument('My Tasks', { kind: 'search', query: filterToSearchQuery(filter, S.me && S.me.userUri),
      view: { sortBy: 'updated', groupBy: 'responsibility', display: ['status', 'assigned'], completedWithin: filter.completedWithin } }); // renderer/views.js VIEW_ARRANGEMENT
    myTasksMade = { client, node };
    settings.set('myTasks', node.id);
    return node;
  })().finally(() => { myTasksAsk = null; }); // one question at a time: two halves asking at once make one search
  return myTasksAsk;
}

// This session's first read of the settings document: what must not go by this machine's last copy alone waits for it
// (the Help tour's first start, renderer/overlays.js helpOnce, through settings:ready). Settled whether it worked or not.
let settingsRead = Promise.resolve();
const settingsReady = () => settingsRead;
// The sync client let go of, on a logout or before a second login: the stale S.client would keep emitting changes, and
// a new one would skip every id the old subscription set still claims. The undo steps were recorded against its
// documents' Loro undo managers, so they are dead with it.
function stop() {
  if (!S.client) return;
  const previous = S.client; S.client = null; subscribed.clear(); undoStack.length = 0; redoStack.length = 0; previous.sync.removeAllListeners(); previous.close().catch(() => {});
}
// Once a minute, what this app asked of Tana in it, by method, appended to tana-calls.log in the app's data folder:
// the evidence for what Orbital costs Tana's servers (#579). A quiet minute writes nothing.
let callLog = false;
function logCalls() {
  const counts = takeCalls(), names = Object.keys(counts).sort();
  if (names.length && S.userData) require('node:fs').appendFile(path.join(S.userData, 'tana-calls.log'), new Date().toISOString() + ' ' + names.map((n) => n + '=' + counts[n]).join(' ') + '\n', () => {});
  setTimeout(logCalls, 60000).unref?.();
}
async function start() {
  let read;
  settingsRead = new Promise((resolve) => { read = resolve; });
  stop();
  if (!callLog) { callLog = true; setTimeout(logCalls, 60000); }
  S.me = await S.session.info();
  const peer = peerIdentity({ file: path.join(S.userData, 'peer.json'), userExternalId: S.me.userExternalId });
  S.client = createTanaClient({ getAccessToken: (o) => S.session.getAccessToken(o), orgId: S.me.orgId, ...peer, logger: console, userAgent: require('../source').userAgent('Orbital') });
  listFilter(S.client);
  S.client.sync.on('connected', () => setStatus({ connected: true, error: null }));
  S.client.sync.on('disconnected', () => setStatus({ connected: false }));
  S.client.sync.on('error', (e) => setStatus({ error: errText(e) }));
  reliveRefs(); // the references on screen, live on the old login's stream, subscribed on this one (#413)
  S.client.sync.on('change', onChange);
  // Tana refused an edit but still lets us read it: say so, and redraw the row, which doc:info now reports read-only.
  S.client.sync.on('write-denied', (id) => { setStatus({ error: 'Tana refused your edits to this node; it is read-only now' }); send('outline:changed', id, { meta: true }); });
  setStatus({ authenticated: true });
  await S.client.sync.connect();
  // The settings document decides before anything is listed: a view's filter, the hidden titles and the MCP switch
  // are all read on the way into the first refresh, and on a new machine this is also what pushes them up.
  try { await settings.hydrate(); } catch (e) { report(e); } finally { read(); }
  settings.hydrateWorkspace().catch(report); // the workspace's own settings (its MCP server), beside yours
  tellSidebars(); // the windows' sidebars, read before this login connected, read your pins now (shell.js)
  // Watched nodes are live from boot, listed or not: a deleted or unreachable one is simply not watched any more. What
  // this app deleted is known before any of them is asked for (the in-memory set starts empty on every launch).
  for (const { id } of db.deletedList(1000)) deletedNodes.add(id);
  for (const id of new Set([...notifyWatchedIds(), ...agentIds()])) S.client.sync.subscribe(id).catch(() => {});
  watchInbox().catch(report); // new Inbox tasks, pushed by Tana as they land
  watchMine().catch(report); // the tasks you made for others, which the watch rule follows
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
// One refresh at a time: a caller that only wants the lists current shares the run in flight. A caller that has just
// changed what the rows are built from (the hidden titles, a type's icon or colour) asks for `after`: the run in
// flight may have built its rows before the change, so it waits that run out and starts its own (#390).
function refresh({ after = false } = {}) {
  if (!S.client) return Promise.resolve();
  if (after && S.refreshing) return S.refreshing.then(() => refresh(), () => refresh());
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
// A new task in your Inbox is announced unless you made it yourself (issue #133). Your mail agent writes through Tana's
// MCP with your login, so createdBy is you for its tasks too; what gives it away is data.createdInUri, the chat the
// task was written in ("MCP: …", invocationContext.intent 'mcp'). A task you made by hand has no creating chat. Every
// MCP client counts: Tana does not record which one wrote. The first answer is a baseline, a task over a day old is
// not new whatever state it comes back in, and a burst (back from a week away) is capped rather than buried on screen.
// The Inbox arrives as a live query (sdk/livequery.js, opened in start): Tana pushes a new row the moment a task lands, so
// nothing polls. Its rows carry no creator, which creatorOf answers from the graph (cached).
// ponytail: seen = the newest 50 Inbox ids of the last answer; a task leaving and re-entering the Inbox within its
// first day is announced twice. Keep a dated set if that ever happens in practice.
// "New" is when it reached your Inbox: made then, or handed to you as a task by someone since (handedAt), so a draft a
// colleague wrote yesterday and gives you today is announced today. Newest change first, so such a task is among the 50.
const NEW_TASK_MS = 24 * 60 * 60 * 1000, NEW_TASK_MAX = 3;
const INBOX_QUERY = (me) => ({ types: ['text'], stateTypes: ['proposed'], assignedTo: [me], orderBy: ['-updatedAt'], limit: 50 });
async function watchInbox() {
  const client = S.client, me = S.me && S.me.userUri;
  if (!client || !me) return;
  // The badge rides the same answer: a task entering or leaving your Inbox moves it, so the count is asked then.
  // A plain function: `this` is the live query, which a warm first answer reaches before openLiveQuery has resolved.
  const live = await openLiveQuery(client.sync, INBOX_QUERY(me), { label: 'Orbital new Inbox tasks', onRows: function onRows() {
    if (S.client !== client) return;
    announceNewInbox(this.state().nodes).catch(report);
    updateBadge();
  } });
  if (S.client !== client) return live.close().catch(() => {}); // a second login got here first
  live.on('error', report);
}
// A number on the app icon is not worth an error banner, so a failed count leaves the badge as it was.
function updateBadge() { if (S.badge && S.client) inboxCount().then(S.badge, () => {}); }

// Keeping lists current (#148, PR #152): Tana pushes a live query's answer whenever it moves, so every list here has
// one, and its answers wake the one query that decides the rows. The views get one each, opened and closed whenever a
// view is read (viewRows), which is where a switched view, a changed filter or a closed window settles; the tasks you
// made for someone else (refreshWatched) get one of their own. What woke them is only ever a trigger: the lists are
// still read by ListNodes, so what a live query cannot say (text, owners, the meeting chats) is still applied.
const viewLive = new Map(); // the trigger query as JSON -> { client, handle }
function watchViews() {
  const client = S.client, me = S.me && S.me.userUri;
  const want = new Map();
  if (client && me) for (const v of openViews()) {
    const f = effectiveFilter(v.id, v.filter);
    if (!validViewFilter(f)) continue;
    const q = liveTrigger(viewParams(f, me));
    want.set(JSON.stringify(q), q);
  }
  for (const [k, w] of viewLive) if (!want.has(k) || w.client !== client) { viewLive.delete(k); w.handle.then((h) => h && h.close()).catch(() => {}); }
  for (const [k, q] of want) if (!viewLive.has(k)) {
    const handle = openLiveQuery(client.sync, q, { label: 'Orbital view', onRows: () => { if (S.client === client) scheduleRefresh(500); } })
      .then((h) => { h.on('error', () => {}); return h; }, () => null); // refused: the backstop refresh still reads it
    viewLive.set(k, { client, handle });
  }
}
async function watchMine() {
  const client = S.client, me = S.me && S.me.userUri;
  if (!client || !me) return;
  const query = { types: ['text'], createdBy: [me], stateTypes: ['proposed', 'open', 'closed', 'not_now'], orderBy: ['-updatedAt'], limit: 200 };
  const live = await openLiveQuery(client.sync, query, { label: 'Orbital tasks you made', onRows: () => { if (S.client === client) refreshWatched().catch(() => {}); } });
  if (S.client !== client) return live.close().catch(() => {});
  live.on('error', () => {});
}
// rows: the live query's answer, newest first ({ uri, title, createdAt } in epoch ms)
async function announceNewInbox(rows) {
  const me = S.me && S.me.userUri;
  if (!me || !S.notify) return;
  const stored = db.setting('inboxSeen');
  db.setSetting('inboxSeen', rows.map((r) => r.uri)); // before any wait: a second answer arriving meanwhile compares against this one
  if (!Array.isArray(stored)) return;
  const seen = new Set(stored);
  const unseen = rows.filter((r) => !seen.has(r.uri));
  if (!unseen.length) return;
  // the rows carry no state: one graph read says who last moved each, and when
  const graph = new Map((await S.client.graph.listNodes({ nodeIds: unseen.map((r) => r.uri), limit: unseen.length }).catch(() => ({ nodes: [] }))).nodes.map((n) => [n.id, n]));
  const fresh = unseen.filter((r) => Date.now() - Math.max(r.createdAt, handedAt(graph.get(r.uri), me)) < NEW_TASK_MS).map((r) => ({ id: r.uri, title: r.title }));
  let shown = 0; // counts banners, not candidates: your own quiet tasks do not use up the cap
  for (const n of fresh) try {
    if (shown >= NEW_TASK_MAX) break;
    const creator = await creatorOf(n.id);
    const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
    const chatUri = creator && creator !== me ? null : (await document(n.id)).data.get('createdInUri');
    const chat = chatUri ? (await S.client.graph.listNodes({ nodeIds: [chatUri], nodeTypes: ['chat'], includeOwnedChats: true, limit: 1 })).nodes[0] || {} : null;
    const from = inboxFrom(me, creator, chat, names);
    if (!from) continue; // yours, by hand
    S.notify(n.id, n.title || 'Untitled', 'New in Inbox · ' + from);
    shown++;
  } catch { /* one unreadable task costs its own banner, not the ones after it */ }
}
async function doRefresh() {
  setStatus({ syncing: true, error: null });
  try {
    // before the view, so the sweep in viewRows sees the set this refresh found rather than the last one's
    let watching = true;
    try { await refreshWatched(); } catch { watching = false; /* the watch set keeps what it had, like the badge keeps its number */ }
    for (const v of openViews()) await viewRows(v.id, v.filter); // each window's view, once, each settling its live query
    // now that the watch rule and the views have subscribed what they follow (#427), counting what they found
    // rather than only what subscribed: a failed subscribe is retried, and its pair is what the retry compares with
    if (watching) pruneSeen(new Set([...ruleWatched, ...openViews().flatMap((v) => [...(liveIds.get(v.id) || [])])]));
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
// document — and keeps answering: hiding is about lists, not about access. A by-id lookup that fills a list (the
// related search results) applies listed() itself.
// The app's own settings document is app plumbing, not a note: it is kept out of every list and search the way
// a hidden title is, and stays reachable by id like everything else that is filtered here.
// It is also the one place meeting chats are added (issue #39, sdk/query.js addMeetingChats).
function listed() {
  const rules = hiddenRules(), hideMcp = mcpHidden(), appDocs = new Set(settings.appDocIds()); // the settings document, and any it took over from
  return (n) => !appDocs.has(n.id) && !isHidden(memberTitle(n), rules) && !(hideMcp && isMcp(n));
}
function listFilter(c) {
  if (!c || !c.graph) return;
  const listNodes = c.graph.listNodes.bind(c.graph);
  c.graph.listNodesUnhidden = listNodes; // past Hidden titles and Hide MCP: for reads that are not a list you see (main/timeline.js)
  const answer = async (params) => {
    const result = await listNodes(params);
    // Compare the count with the raw response: local delete/title filters must not masquerade as server truncation.
    const truncated = result.totalCount != null ? result.totalCount > result.nodes.length : !!result.truncated;
    // This is also the only place a deletion nobody told us about arrives: a node deleted on another device, never
    // subscribed here, so no change event ever ran. Remembering the tombstone rather than only dropping the row is
    // what lets a reference to it be drawn as deleted (main/documents.js) instead of merely unreadable.
    for (const n of result.nodes) if (isDeleted(n)) deletedNodes.add(n.id);
    const nodes = visibleGraphNodes(result.nodes);
    if (params && params.nodeIds) return { ...result, nodes, truncated };
    return { ...result, nodes: nodes.filter(listed()), truncated };
  };
  c.graph.listNodes = addMeetingChats(answer);
}
// Changing the list refreshes like any other filter change: replaceSection drops the rows that are now hidden, so
// nothing comes back from the SQLite cache.
async function setHidden(list) {
  const rules = hideRules(list);
  settings.set('hiddenTitles', rules);
  await refresh({ after: true }); // not a run with the old list
  send('outline:changed', null); // also when there is no connection to refresh with
  return rules;
}
// The MCP switch refreshes the same way: the rows that are now hidden leave the cache with the refresh.
async function setMcpHidden(on) {
  settings.set('hideMcp', !!on);
  await refresh({ after: true });
  send('outline:changed', null);
  return mcpHidden();
}

// Subscribing on demand (zoom, create, metadata) does not put a document in a view: the refresh lets go of those
// oldest first past LIVE_ROWS of them, under the same rule as its own rows (main/documents.js releaseOnDemand).

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'outline:roots': async () => {
    const rows = db.list();
    const rules = hiddenRules(); // a row cached before the rule was added is hidden here too, refresh or no refresh
    return VIEWS.map((view) => ({ ...view, truncated: truncatedViews.has(view.id), nodes: (rows[view.id] || []).filter((r) => !isHidden(r.title, rules)).map(toNode) }));
  },
  'view:list': async (e, id, filter) => {
    // the Graph pane (#462) shows no list: no query, no live query, no refresh, and never the view the refresh owns
    if (pageOf(e)?.links) return { nodes: [], truncated: false };
    preset(id); // validate before changing which view the refresh loop owns
    S.activeView = id;
    S.activeFilter = filter;
    const page = pageOf(e);
    if (page) S.windowViews.set(page.id, { id, filter }); // this page's view (the checks call with no event)
    await S.refreshing;
    return viewRows(id, filter);
  },
  'view:filter': (_e, id) => viewFilter(id),
  'view:setFilter': (e, id, filter) => {
    const stored = setViewFilter(id, filter);
    if (id === S.activeView) S.activeFilter = stored;
    for (const v of S.windowViews.values()) if (v.id === id) v.filter = stored; // every window showing it
    settings.tellOthers(pageOf(e)); // and every other page's copy: one left with the old filter wrote it back with its next pill
    return stored;
  },
  'search': (_e, query, scope) => search(query, scope),
  'search:list': () => searchList(),
  // The renderer sends a view id, never a query: the filter→query vocabulary lives in sdk/query, which classic
  // renderer scripts cannot require, and main already holds the canonical filter for every view.
  'search:create': (_e, id, title) => searchCreate(id, title),
  'search:myTasks': (_e, findOnly) => myTasks(findOnly === true),
  // The same filter vocabulary in both directions, so the pills that edit a view can edit a saved search (readSearch
  // and setSearchQuery/setSearchView). Writing replaces it wholesale rather than patching: what the pills are showing
  // is what the document ends up saying.
  'search:filter': (_e, id) => op(id, (doc) => {
    const { query, view: arrangement } = readSearch(doc); // how it is shown lives beside the query, not inside it
    return {
      // the completed window is the app's own, so it is stored beside the query and handed back as part of the filter
      // the pills edit; absent, it reads as the default the pill shows the first time Completed is asked for
      filter: { ...searchQueryToFilter(query, S.me && S.me.userUri), completedWithin: completedWindow(arrangement.completedWithin), audience: arrangement.audience === 'everyone' ? 'everyone' : null, limit: rowLimit(arrangement.limit) },
      sort: searchSort(arrangement.sortBy),
      group: arrangement.groupBy,
      // Tana's record of key -> { shown, order } (or the comma-joined string earlier builds wrote)
      display: searchDisplay(arrangement.display),
    };
  }),
  'search:setFilter': async (_e, id, filter, sort, group, display) => {
    if (!validViewFilter(filter)) throw new Error('invalid view filter'); // never let a bad filter empty a saved search
    const flows = await workflowTypes(filter.types || []);
    return mut(id, (doc) => {
      setSearchQuery(doc, filterToSearchQuery(filter, S.me && S.me.userUri, flows));
      setSearchView(doc, { sortBy: sort, groupBy: group, display, completedWithin: filter.completedWithin, audience: filter.audience, limit: filter.limit }); // saved together: one press, one state of the page
    });
  },
  // Hidden titles: the user's list of patterns, applied to every list and search (see listFilter/sdk-query isHidden).
  'filters:list': () => hiddenRules(),
  'filters:add': (_e, pattern) => setHidden([...hiddenRules(), pattern]),
  'filters:remove': (_e, pattern) => setHidden(hiddenRules().filter((p) => p.toLowerCase() !== String(pattern ?? '').trim().toLowerCase())),
  // MCP chats: one switch over every list and search, applied in the same listFilter the hidden titles go through.
  'mcp:hidden': () => mcpHidden(),
  'sync:refresh': () => refresh(),
};

module.exports = { announceNewInbox, watchInbox, watchMine, preset, viewFilter, setViewFilter, hiddenRules, mcpHidden, viewRows, inboxCount, search, searchList, searchCreate, searchTitle, myTasks, start, stop, settingsReady, refresh, doRefresh, listFilter, setHidden, setMcpHidden, ipc };
