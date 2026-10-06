'use strict';
const pins = require('../sdk/pins');
const { readNode } = require('../sdk/node');
const { isDateUri } = require('../sdk/dates');
const { DOC_URI, NOT_CONNECTED, PIN_HUBS, S, deletedNodes, idKind, isDeleted, scheduleRefresh, send, today } = require('./state');
const { canWriteDoc, createDocument, document, info, onChange, sensitiveIds } = require('./documents');
const { svgOf } = require('./icons');

// ---- pins (sdk/pins.js over the user's profile/collection/pin-map docs) and app-local icons ----

// "Week 38 (2026)", the title of the week a date sits in. ISO-8601: weeks start on Monday and belong to the year
// holding their Thursday, so 31 December 2026 and 1 January 2027 are both "Week 53 (2026)". The year is in the title
// because the week number alone comes round again every year.
function weekTitle(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // this week's Thursday
  const year = t.getUTCFullYear();
  return 'Week ' + Math.ceil(((t - Date.UTC(year, 0, 1)) / 864e5 + 1) / 7) + ' (' + year + ')';
}
// A plain document beside the day nodes, like today's node and with no link between them.
// findOnly (a lookup: Save view, the Timeline, demo mode in renderer/state.js): the existing node or null, never a write.
// The day and week nodes are yours: found among the documents you made, since a colleague's node with the same title is
// theirs, and a search that fails is an error rather than "there is none", which made a second one in your Tana. The
// text index lists a new document seconds late, so one made here is remembered for the session (#393).
const madeHere = new Map(); // user + title -> the node made on this machine, reused while it still carries that title
async function ownNode(title, textQuery) {
  const made = madeHere.get(S.me.userUri + ' ' + title), doc = made && S.client.sync.getDocument(made.id);
  if (doc && !deletedNodes.has(made.id) && (readNode(doc).title || '').trim().toLowerCase() === title.toLowerCase()) return made;
  const { nodes = [] } = await S.client.graph.listNodes({ textQuery, nodeTypes: ['text'], createdBy: [S.me.userUri], limit: 20 });
  // An existing node wins over a new one, case-insensitively: "week 38 (2026)" must not gain a second one beside it.
  return nodes.find((n) => (n.title || '').trim().toLowerCase() === title.toLowerCase()) || null;
}
async function makeOwn(title) {
  const made = await createDocument(title, { kind: 'doc' });
  madeHere.set(S.me.userUri + ' ' + title, made);
  return made;
}
async function weekNode(date = new Date(), findOnly = false) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const title = weekTitle(date);
  // Searched without the bracketed year, which is punctuation to a text index; the match below is the exact title.
  const existing = await ownNode(title, title.split(' (')[0]);
  return existing || (findOnly ? null : makeOwn(title));
}
const pinTarget = (target) => { if (target !== 'sidebar' && target !== 'today') throw new Error('pin target must be sidebar or today: ' + target); return target; };

// Sidebar pins as Nodes, in sidebar order; pinned items we cannot subscribe (spaces, types, ...) are skipped quietly.
async function pinnedNode(uri) {
  if (deletedNodes.has(uri)) return undefined;
  const doc = await S.client.sync.subscribe(uri).catch(() => null); // await bootstrap even when a handle already exists
  if (doc && isDeleted(readNode(doc))) { onChange(uri); return undefined; }
  return doc ? info(doc).catch(() => undefined) : undefined;
}
async function pinTree() {
  if (!S.client) return [];
  const sensitive = new Set(sensitiveIds());
  const fill = async (entry) => {
    const node = entry.uri ? await pinnedNode(entry.uri) : undefined;
    if (node && sensitive.has(entry.uri)) node.sensitive = true; // the window's sidebar blurs it as the pages do (shell.js)
    if (node && svgOf(node.icon)) node.svg = svgOf(node.icon); // a glyph chosen with Set icon: the shell has only icons.js, not the Nucleo set
    const children = (await Promise.all(entry.children.map(fill))).filter(Boolean);
    if (entry.uri && deletedNodes.has(entry.uri)) return children.length || entry.label ? { label: entry.label, children } : null;
    return { ...entry, node, children };
  };
  const tree = (await Promise.all((await pins.sidebarTree(S.client.sync, S.me.userUri)).map(fill))).filter(Boolean);
  watchSidebar(tree);
  return tree;
}
// The window's sidebar (shell.js) is told when what it draws moves: the collection (a pin or a section added, moved or
// taken off, here or in Tana) or a pinned document (renamed, retyped, deleted). It reads the tree again then; the
// profile is watched too, for the pointer to a collection made since. Told a beat later, so a burst is one read.
const sidebarWatched = new Set(), sidebarClients = new WeakSet();
let sidebarTold = null;
function watchSidebar(tree) {
  const profile = S.client.sync.getDocument && S.client.sync.getDocument(S.me.userUri), walk = (nodes) => nodes.flatMap((n) => [n.uri, ...walk(n.children || [])]);
  sidebarWatched.clear();
  for (const uri of [S.me.userUri, profile && profile.data.get('pinnedCollectionUri'), ...walk(tree)]) if (uri) sidebarWatched.add(uri);
  const client = S.client;
  if (sidebarClients.has(client) || typeof client.sync.on !== 'function') return; // a stand-in sync with no stream (scripts/sdk-check.js) has nothing to hear
  sidebarClients.add(client);
  client.sync.on('change', (id) => {
    if (S.client !== client || !sidebarWatched.has(id) || sidebarTold) return;
    sidebarTold = setTimeout(() => { sidebarTold = null; tellSidebars(); }, 300);
  });
}
function tellSidebars() {
  for (const w of S.windows || []) { const wc = w.shell && w.shell.webContents; if (wc && !wc.isDestroyed()) wc.send('pins:changed'); }
}
// The sections a pin can go in, for ⌘K Pin to sidebar … (renderer/document.js): top-level labels, with how many pins each holds.
async function pinSections() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const tree = await pins.sidebarTree(S.client.sync, S.me.userUri).catch(() => []);
  return tree.filter((n) => !n.uri && typeof n.label === 'string').map((n) => ({ id: n.id, label: n.label, count: n.children.filter((c) => c.uri).length }));
}
// A pin put in a section (null: the top level, under Pinned), or in a new one when a label comes instead; a document
// already pinned moves there, as Tana's placePin does. The window's sidebar hears it through the change above.
async function placeSidebarPin(id, section, label) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (!DOC_URI.test(id || '')) throw new Error('Not a Tana document id');
  const sync = S.client.sync, user = S.me.userUri;
  if (typeof label === 'string' && label.trim()) section = await pins.addSection(sync, user, label.trim());
  return pins.placePin(sync, user, id, { section: typeof section === 'string' ? section : null });
}
// The meetings and spaces this document is pinned *on*: the reverse of the hub's own pinnedItems, which the graph
// derives as EDGE_TYPE_HAS_PIN (docs/PINNING.md §4). One ListEdges for the hubs and one ListNodes for their titles;
// a hub the graph will not name is still listed, by its id, rather than dropped, and a deleted one is left out.
async function pinHubs(id) {
  const { edges = [] } = await S.client.graph.listEdges({ toNodeIds: [id], edgeTypes: ['EDGE_TYPE_HAS_PIN'] }).catch(() => ({ edges: [] }));
  const hubs = [...new Set(edges.map((e) => e.fromNodeId).filter((uri) => uri && !deletedNodes.has(uri)))];
  if (!hubs.length) return [];
  const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: hubs, limit: hubs.length }).catch(() => ({ nodes: [] }));
  return hubs.map((uri) => ({ id: uri, title: (nodes.find((n) => n.id === uri) || {}).title || uri, kind: idKind(uri) }));
}
// Everywhere one document is pinned: your sidebar, your dates, and the meetings and spaces it hangs on. The first
// two are private per-user state, the third is the hub's own list and visible to everyone who can see the hub.
async function pinState(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const [sidebar, dates, hubs] = await Promise.all([
    pins.listSidebar(S.client.sync, S.me.userUri).then((uris) => uris.includes(id)),
    pins.dates(S.client.sync, S.me.userUri, id),
    pinHubs(id),
  ]);
  return { sidebar, dates, hubs };
}
// Every uri this user has pinned, sidebar or date, for the pin mark a row draws. Ids only: reading each
// pinned document would be a bootstrap per pin, and far more than "is this one pinned". A pointer this
// account has never had (nothing pinned yet) is an empty half, not an error.
async function pinnedUris() {
  if (!S.client) return [];
  const [sidebar, dated] = await Promise.all([
    pins.listSidebar(S.client.sync, S.me.userUri).catch(() => []),
    pins.datePinned(S.client.sync, S.me.userUri).catch(() => []),
  ]);
  return [...new Set([...sidebar, ...dated])];
}
// The days each date-pinned document is pinned to, { uri: ['YYYY-MM-DD'] }: the Pinned section of Group by
// Responsibility lists those tasks and says the day under each.
const pinnedDates = () => (S.client ? pins.datePins(S.client.sync, S.me.userUri).catch(() => ({})) : {});
async function setPin(id, target, on, date = today()) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const sync = S.client.sync, user = S.me.userUri;
  if (pinTarget(target) === 'sidebar') await (on ? pins.pinSidebar : pins.unpinSidebar)(sync, user, id);
  else if (on) await pins.pinDate(sync, user, id, date);
  else {
    // A date the document carries as a shared pin stays after the personal one goes: hide it for this user (Tana's
    // mute) rather than unpin it for everyone.
    await pins.unpinDate(sync, user, id, date);
    if ((await pins.dates(sync, user, id)).includes(date)) await pins.muteDate(sync, user, id, date);
  }
}
// Items pinned *on* a meeting or a space: the hub document's own pinnedItems list (docs/PINNING.md section 4), which
// is what the graph reports as EDGE_TYPE_HAS_PIN. Not the sidebar/date pins above, which are private per-user state.
// mut() is deliberately not used: it refuses every event because editable() answers for the title, not for write
// access, and the other pin writes stay out of the undo stack too. The gate is the native write capability.
async function nodePin(hubId, uri, on) {
  if (!DOC_URI.test(hubId || '') || !PIN_HUBS.has(idKind(hubId))) throw new Error('Only a meeting or a space can pin items');
  if (!DOC_URI.test(uri || '')) throw new Error('Not a Tana document id');
  if (uri === hubId) throw new Error('A node cannot pin itself');
  const doc = await document(hubId);
  if (!await canWriteDoc(doc)) throw new Error('Write permission is unknown or unavailable');
  (on ? pins.pinItem : pins.unpinItem)(doc, uri);
  send('outline:changed', hubId);
  return pins.items(doc).map((p) => p.uri);
}
// offset 0 is today, 1 tomorrow, or a 'YYYY-MM-DD' day (a date mention's): the document titled with that date, pinned to it.
// findOnly (a lookup): the existing node as it is, unpinned or not, and null where one would have been created.
async function todayNode(offset = 0, findOnly = false) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const date = typeof offset === 'string' ? offset : today(offset);
  const existing = await ownNode(date, date);
  if (findOnly) return existing ? existing.id : null;
  if (existing) {
    const pinnedDates = await pins.dates(S.client.sync, S.me.userUri, existing.id).catch(() => []);
    if (!pinnedDates.includes(date)) await setPin(existing.id, 'today', true, date);
    return existing.id;
  }
  const created = await makeOwn(date);
  await setPin(created.id, 'today', true, date);
  scheduleRefresh(1000);
  return created.id;
}

// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'pins:state': (_e, id) => pinState(id),
  'pins:ids': () => pinnedUris(), // which documents carry a pin at all, for the mark on a row
  'pins:dates': () => pinnedDates(), // { uri: ['YYYY-MM-DD'] }, for the Pinned section
  'pins:pin': (_e, id, target, date) => setPin(id, target, true, date),
  'pins:unpin': (_e, id, target, date) => setPin(id, target, false, date),
  'pins:pinTo': (_e, hubId, uri) => nodePin(hubId, uri, true), // pin a document on a meeting/space
  'pins:unpinFrom': (_e, hubId, uri) => nodePin(hubId, uri, false),
  'pins:tree': () => pinTree(), // the window's sidebar (shell.js): [{ id, uri?, label?, node?, children }]
  'pins:sections': () => pinSections(),
  'pins:place': (_e, id, section, label) => placeSidebarPin(id, section, label),
  // The node for today: a document titled with today's date, pinned to today. Created and pinned when missing,
  // so "Show today node" always lands somewhere. Matching is by exact title, the same string the pin uses.
  // A 'YYYY-MM-DD' day instead of the offset is the page a date mention opens.
  'doc:todayNode': (_e, offset, findOnly) => todayNode(isDateUri('tana:plaindate:' + offset) ? offset : offset === 1 ? 1 : 0, findOnly === true),
  'doc:weekNode': async (_e, findOnly) => (await weekNode(new Date(), findOnly === true))?.id ?? null,
};

module.exports = { weekTitle, weekNode, pinTarget, pinnedNode, pinnedUris, pinnedDates, pinHubs, pinTree, pinSections, placeSidebarPin, tellSidebars, pinState, setPin, nodePin, todayNode, ipc };
