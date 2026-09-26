'use strict';
const pins = require('../sdk/pins');
const { readNode } = require('../sdk/node');
const { isDateUri } = require('../sdk/dates');
const { DOC_URI, NOT_CONNECTED, PIN_HUBS, S, deletedNodes, idKind, isDeleted, scheduleRefresh, send, today } = require('./state');
const { canWriteDoc, createDocument, document, info, onChange } = require('./documents');

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
// findOnly (demo mode, renderer/state.js): the existing node or a refusal, never a write.
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
  if (!existing && findOnly) throw new Error(DEMO_READ_ONLY);
  return existing || makeOwn(title);
}
const DEMO_READ_ONLY = 'Demo mode is on: nothing is saved to Tana';
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
  const fill = async (entry) => {
    const node = entry.uri ? await pinnedNode(entry.uri) : undefined;
    const children = (await Promise.all(entry.children.map(fill))).filter(Boolean);
    if (entry.uri && deletedNodes.has(entry.uri)) return children.length || entry.label ? { label: entry.label, children } : null;
    return { ...entry, node, children };
  };
  return (await Promise.all((await pins.sidebarTree(S.client.sync, S.me.userUri)).map(fill))).filter(Boolean);
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
// findOnly (demo mode): the existing node as it is, unpinned or not, and a refusal where one would have been created.
async function todayNode(offset = 0, findOnly = false) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const date = typeof offset === 'string' ? offset : today(offset);
  const existing = await ownNode(date, date);
  if (findOnly) { if (existing) return existing.id; throw new Error(DEMO_READ_ONLY); }
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
  // The node for today: a document titled with today's date, pinned to today. Created and pinned when missing,
  // so "Show today node" always lands somewhere. Matching is by exact title, the same string the pin uses.
  // A 'YYYY-MM-DD' day instead of the offset is the page a date mention opens.
  'doc:todayNode': (_e, offset, findOnly) => todayNode(isDateUri('tana:plaindate:' + offset) ? offset : offset === 1 ? 1 : 0, findOnly === true),
  'doc:weekNode': async (_e, findOnly) => (await weekNode(new Date(), findOnly === true)).id,
};

module.exports = { weekTitle, weekNode, pinTarget, pinnedNode, pinnedUris, pinnedDates, pinHubs, pinTree, pinState, setPin, nodePin, todayNode, ipc };
