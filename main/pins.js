'use strict';
const pins = require('../sdk/pins');
const { readNode } = require('../sdk/node');
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
async function weekNode(date = new Date()) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const title = weekTitle(date);
  // Searched without the bracketed year, which is punctuation to a text index; the match below is the exact title.
  const { nodes = [] } = await S.client.graph.listNodes({ textQuery: title.split(' (')[0], nodeTypes: ['text'], limit: 20 }).catch(() => ({ nodes: [] }));
  // An existing node wins over a new one, case-insensitively: "week 38 (2026)" must not gain a second one beside it.
  return nodes.find((n) => (n.title || '').trim().toLowerCase() === title.toLowerCase()) || createDocument(title, { kind: 'doc' });
}
const pinTarget = (target) => { if (target !== 'sidebar' && target !== 'today') throw new Error('pin target must be sidebar or today: ' + target); return target; };

// Sidebar pins as Nodes, in sidebar order; pinned items we cannot subscribe (spaces, types, ...) are skipped quietly.
async function pinnedNode(uri) {
  if (deletedNodes.has(uri)) return undefined;
  const doc = await S.client.sync.subscribe(uri).catch(() => null); // await bootstrap even when a handle already exists
  if (doc && isDeleted(readNode(doc))) { onChange(uri); return undefined; }
  return doc ? info(doc).catch(() => undefined) : undefined;
}
async function pinned() {
  if (!S.client) return [];
  const uris = await pins.listSidebar(S.client.sync, S.me.userUri);
  return (await Promise.all(uris.map(pinnedNode))).filter(Boolean);
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
async function pinState(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  return { sidebar: (await pins.listSidebar(S.client.sync, S.me.userUri)).includes(id), dates: await pins.dates(S.client.sync, S.me.userUri, id) };
}
// Every uri this user has pinned, sidebar or date, for the pin mark a row draws. Ids only: pinned() subscribes and
// reads each pinned document, which is a bootstrap per pin and far more than "is this one pinned". A pointer this
// account has never had (nothing pinned yet) is an empty half, not an error.
async function pinnedUris() {
  if (!S.client) return [];
  const [sidebar, dated] = await Promise.all([
    pins.listSidebar(S.client.sync, S.me.userUri).catch(() => []),
    pins.datePinned(S.client.sync, S.me.userUri).catch(() => []),
  ]);
  return [...new Set([...sidebar, ...dated])];
}
async function setPin(id, target, on, date = today()) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const sync = S.client.sync, user = S.me.userUri;
  if (pinTarget(target) === 'sidebar') await (on ? pins.pinSidebar : pins.unpinSidebar)(sync, user, id);
  else await (on ? pins.pinDate : pins.unpinDate)(sync, user, id, date);
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
// offset 0 is today, 1 tomorrow: the document titled with that date, pinned to it.
async function todayNode(offset = 0) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const date = today(offset);
  const { nodes = [] } = await S.client.graph.listNodes({ textQuery: date, nodeTypes: ['text'], limit: 20 }).catch(() => ({ nodes: [] }));
  const existing = nodes.find((n) => (n.title || '').trim() === date);
  if (existing) {
    const pinnedDates = await pins.dates(S.client.sync, S.me.userUri, existing.id).catch(() => []);
    if (!pinnedDates.includes(date)) await setPin(existing.id, 'today', true, date);
    return existing.id;
  }
  const created = await createDocument(date, { kind: 'doc' });
  await setPin(created.id, 'today', true, date);
  scheduleRefresh(1000);
  return created.id;
}

module.exports = { weekTitle, weekNode, pinTarget, pinnedNode, pinned, pinnedUris, pinTree, pinState, setPin, nodePin, todayNode };
