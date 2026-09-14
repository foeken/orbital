const { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const db = require('./db');
const { createTanaSession, peerIdentity } = require('./tana-session');
const updater = require('./updater');
const { createTanaClient } = require('./sdk');
const { fetchImage } = require('./sdk/assets');
const access = require('./sdk/access');
const { readNode, editable, setTitle, setState, taskMeta, audienceMetadata, setAssignees, ulid, initDocument, STATE_TYPES } = require('./sdk/node');
const { parseQuery, searchParams, needsTypes, viewParams, validViewFilter, viewTypes, VIEW_PRESETS, KIND_VIEWS, hideRules, isHidden } = require('./sdk/query');
const content = require('./sdk/content');
const chat = require('./sdk/chat');
const fields = require('./sdk/fields');
const pins = require('./sdk/pins');

// Order is the Cmd+K Views order: what is waiting on you, then your work, then the calendar, then knowledge,
// then conversations, then people.
const VIEWS = [{ id: 'inbox', title: 'Inbox', icon: 'inbox' }, { id: 'tasks', title: 'Tasks', icon: 'task' }, { id: 'meetings', title: 'Meetings', icon: 'meeting' }, { id: 'library', title: 'Library', icon: 'library' }, { id: 'chats', title: 'Chats', icon: 'chat' }, { id: 'people', title: 'People', icon: 'member' }]
  .map((view) => ({ ...view, kind: KIND_VIEWS.has(view.id) })); // a kind page lists one kind and does not offer the type picker
const TAG = { task: { label: 'task', color: 'grey' }, meeting: { label: 'meeting', color: 'gold' }, space: { label: 'space', color: 'grey' }, doc: { label: 'doc', color: 'grey' }, member: { label: 'member', color: 'grey' } };
const KINDS = { doc: 'tana:text:', task: 'tana:text:', meeting: 'tana:event:', chat: 'tana:chat:' };
const PLAIN_KINDS = new Set(['chat', 'canvas', 'agent', 'skill', 'type']); // tana:<kind>: ids listed read-only: kind icon + kind tag
const PIN_HUBS = new Set(['event', 'space']); // the only schemas with a pinnedItems container (docs/PINNING.md section 4)
const DOC_URI = /^tana:[a-z-]+:[0-9a-z]{26}$/; // a real document id; a renderer draft keeps a local id until it materialises (#112)

// Persisted view filters are merged over their preset; an invalid saved value cannot strand a view across restarts.
const preset = (id) => {
  if (!Object.hasOwn(VIEW_PRESETS, id)) throw new Error('unknown view: ' + id);
  return { ...VIEW_PRESETS[id] };
};
const viewFilter = (id) => {
  const saved = db.setting('viewFilter:' + id);
  return viewTypes(id, validViewFilter(saved) ? { ...preset(id), ...saved } : preset(id));
};
const setViewFilter = (id, filter) => {
  const next = viewTypes(id, validViewFilter(filter) ? { ...preset(id), ...filter } : preset(id));
  db.setSetting('viewFilter:' + id, next);
  return next;
};
// The user's hidden-title patterns ("Block*", "Lunch", …): normalised on every read, so a list written by an older
// build or by a bad renderer call cannot empty a view (sdk/query.js has the matching rule).
const hiddenRules = () => hideRules(db.setting('hiddenTitles'));

const status = { authenticated: null, authChecking: true, connected: false, syncing: false, lastSync: null, error: null };
let win, session, client, me;
let refreshTimer;
let activeView = 'tasks';
let activeFilter;
const subscribed = new Set(); // ids the view refresh subscribed: the only ones it unsubscribes again
const deletedNodes = new Set();
const isDeleted = n => typeof n.deletedAt === 'number' && n.deletedAt > 0;
const visibleGraphNodes = nodes => nodes.filter(n => !deletedNodes.has(n.id) && !isDeleted(n));
const typeTitles = new Map(); // entityType uri -> title, resolved once per session
const typeHues = new Map(); // type uri -> appearance.hue (0-360), for coloured type tags
const nodeHues = new Map(); // document uri -> its own appearance.hue; separate from typeHues
const editability = new Map(); // observed graph/document capabilities, never guessed from ownership
// What the renderer sorts and groups rows by. A graph node carries createTime and state; a Loro data map carries
// createdAt (ms) and stateType; the SQLite view rows (db.js) have a column for neither, so both are cached per id
// and toNode reads them back for cached rows. Times are ISO strings everywhere, so they compare as strings.
const nodeMeta = new Map(); // document uri -> { createdAt?, stateType? }
const iso = (v) => (typeof v === 'number' ? new Date(v).toISOString() : typeof v === 'string' ? v : undefined);
function rememberMeta(n) {
  const createdAt = iso(n.createTime ?? n.createdAt) || (nodeMeta.get(n.id) || {}).createdAt;
  const state = (n.state && n.state.type) || n.stateType;
  const stateType = STATE_TYPES.includes(state) ? state : undefined;
  if (createdAt || stateType) nodeMeta.set(n.id, { createdAt, stateType });
}
const rememberType = (n) => { typeTitles.set(n.id, n.title || ''); if (n.appearance && typeof n.appearance.hue === 'number') typeHues.set(n.id, n.appearance.hue); };
const ownHue = (n) => n && n.appearance && typeof n.appearance.hue === 'number' ? n.appearance.hue : undefined;
// appearance lives on graph nodes only: a Loro data map never carries it (verified read-only for spaces and typed
// documents), so a node without an appearance key says nothing about the hue and must not erase what the graph told us.
// ponytail: a hue removed in Tana therefore stays cached until the next app start; the graph is the only source.
const hueOf = (n) => { const hue = ownHue(n); return hue === undefined && n ? nodeHues.get(n.id) : hue; };
function rememberNodeHue(n) {
  editability.set(n.id, editable(n, me && me.userUri));
  rememberMeta(n); // every graph node and every Loro read passes here, so it is the one place both are learned
  if (!n.appearance) return false;
  const hue = ownHue(n), had = nodeHues.has(n.id), before = nodeHues.get(n.id);
  if (hue === undefined) nodeHues.delete(n.id); else nodeHues.set(n.id, hue);
  return had !== (hue !== undefined) || before !== hue;
}
const nodeTag = (tag, n) => { const hue = hueOf(n); return hue === undefined ? tag : { ...tag, hue }; };
const cachedNodeHue = (r) => {
  const tag = r.tags && r.tags[0];
  return (r.icon || isSpace(r.id) || PLAIN_KINDS.has(idKind(r.id))) && tag && typeof tag.hue === 'number' ? tag.hue : undefined;
};

// Where a document lives in Tana: owner chain root-first as [{ id, title, icon }]; unowned documents are in the Library.
// Ancestors can share a title (a meeting named after its space), so each crumb carries its kind icon to stay distinguishable.
const crumbIcon = (id) => ({ space: 'space', event: 'meeting', 'user-profile': 'member', chat: 'chat', agent: 'agent' })[idKind(id)] || 'doc';
const pathCache = new Map(); // docId -> path (refreshed on every info() call; cheap enough per open)
async function pathOf(id) {
  if (!client) throw new Error(NOT_CONNECTED);
  const { entries = [] } = await client.graph.getOwnerChain(id);
  const owners = entries.map((e) => e.uri).filter((u) => u !== id).reverse();
  const library = { id: 'library', title: 'Library', icon: 'library' }; // every location starts at the Library view
  if (!owners.length) return [library];
  await resolveTypes(owners); // same title cache: any node id -> title
  // A space inside a space adds no location information, so only the innermost space is shown, with whatever it contains.
  const innermost = owners.map(isSpace).lastIndexOf(true);
  const shown = innermost === -1 ? owners : owners.slice(innermost);
  return [library, ...shown.map((u) => ({ id: u, title: typeTitles.get(u) || u, icon: crumbIcon(u) }))];
}
ipcMain.handle('doc:path', async (_e, id) => { try { const p = await pathOf(id); pathCache.set(id, p); return p; } catch (e) { report(e); return pathCache.get(id) || []; } });

const errText = (e) => String((e && e.message) || e);
// Before the session and sync stream are ready, every view/metadata call fails the same benign way. That is a
// startup state, not an error to show or log (#97), so it never reaches setStatus.
const NOT_CONNECTED = 'not connected to Tana';
const notReady = (e) => errText(e) === NOT_CONNECTED;
const report = (e) => { if (!notReady(e)) setStatus({ error: errText(e) }); };
const now = () => new Date().toISOString();

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const hm = (d) => d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
// "Mon 9:00–9:30" in local time; all-day events come as UTC (or local) midnight with a whole-day span: "Mon, all day".
// withDate (search results, any week or year): "Fri 11 Sep 9:00–10:00", with the year added outside the current one.
function eventMeta(start, end, withDate) {
  if (!start) return undefined;
  const s = new Date(start), e = end ? new Date(end) : null;
  const midnight = s.getUTCHours() + s.getUTCMinutes() === 0 || s.getHours() + s.getMinutes() === 0;
  const allDay = e && midnight && (e - s) % 864e5 === 0;
  const year = s.getFullYear() === new Date().getFullYear() ? '' : ' ' + s.getFullYear();
  // A bare weekday reads as "the week ahead", so last Friday must not show as "Fri": anything before today or more
  // than six days out carries its date, wherever it is listed.
  const midnightToday = new Date(); midnightToday.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(s).setHours(0, 0, 0, 0) - midnightToday) / 864e5);
  const dated = withDate || days < 0 || days > 6;
  const day = WEEKDAY[s.getDay()] + (dated ? ' ' + s.getDate() + ' ' + MONTH[s.getMonth()] + year : '');
  return allDay ? day + (dated ? '' : ', all day') : day + ' ' + hm(s) + (e ? '–' + hm(e) : '');
}

async function resolveTypes(uris) {
  const missing = [...new Set(uris.filter((u) => u && !typeTitles.has(u)))];
  if (!missing.length) return;
  const { nodes } = await client.graph.listNodes({ nodeIds: missing, limit: missing.length });
  nodes.forEach(rememberType);
}
// { label, hue, uri } when the type node has appearance.hue, else grey (docs/OUTLINER.md addendum 12).
// uri lets a row find its type again through the cache, for the type's hue and its app-local icon.
const typeTag = (uri) => (uri && typeTitles.get(uri) ? [typeHues.has(uri) ? { label: typeTitles.get(uri), hue: typeHues.get(uri), uri } : { label: typeTitles.get(uri), color: 'grey', uri }] : []);
const typeUriOf = (r) => (r.tags || []).map((t) => t && t.uri).find(Boolean); // the row's type, from its type tag
// a node without its own appearance.hue inherits the hue of its type, so icon and tag match (docs/OUTLINER.md addendum 14)
const hueWithType = (own, typeUri) => (own === undefined && typeUri !== undefined ? typeHues.get(typeUri) : own);
// A document opened straight from Loro (pins, zoom, spaces) has no appearance in its data map, so its colour needs
// one graph lookup. Cached per id including "no hue", like resolveTypes caches titles.
const hueLoaded = new Set();
async function resolveHue(id) {
  if (hueLoaded.has(id) || !client) return;
  hueLoaded.add(id);
  try { (await client.graph.listNodes({ nodeIds: [id], limit: 1 })).nodes.forEach(rememberNodeHue); }
  catch { hueLoaded.delete(id); }
}
// plain untyped document (no state, no type): 'doc' icon + chip; typed documents keep their type tag and the plain bullet
const isSpace = (id) => id.startsWith('tana:space:');
const plainRow = (id, title, updatedAt, typeUri, hue) => (isSpace(id)
  ? { id, title, done: 0, icon: 'space', hue, tags: [hue === undefined ? TAG.space : { ...TAG.space, hue }], sortKey: updatedAt, updatedAt }
  // a typed document without its own icon shows the generic type glyph, tinted with its type's hue
  : { id, title, done: 0, icon: typeUri ? 'type' : 'doc', hue: hueWithType(hue, typeUri), tags: typeUri ? typeTag(typeUri) : [hue === undefined ? TAG.doc : { ...TAG.doc, hue }], sortKey: updatedAt, updatedAt });
const memberRow = (id, title, updatedAt, hue) => ({ id, title, done: 0, icon: 'member', hue, tags: [hue === undefined ? TAG.member : { ...TAG.member, hue }], sortKey: updatedAt, updatedAt });
// chat, canvas, agent and skill each have their own glyph in the renderer's icon set, so the kind is the icon
const kindRow = (id, kind, title, updatedAt, hue) => ({ id, title, done: 0, icon: PLAIN_KINDS.has(kind) ? kind : null, hue, tags: [hue === undefined ? { label: kind, color: 'grey' } : { label: kind, hue }], sortKey: updatedAt, updatedAt });
const idKind = (id) => id.split(':')[1];
const memberTitle = (n) => n.title || (n.userProfile && n.userProfile.name) || '';

// A space's "content" is the documents it owns (graph query), returned as document Nodes.
async function spaceChildren(id) {
  if (!client) throw new Error(NOT_CONNECTED); // a space opened before the connection is a startup state, not an error (#97)
  const { nodes } = await client.graph.listNodes({ ownerIds: [id], limit: 200, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n)));
}
// lowercase type title -> uri for #Type search filters; the type list is loaded once per session (and seeds typeTitles)
// What a meeting carries besides its notes (verified read-only on a real meeting, docs/MEETINGS.md):
//   summary / tagline  the event's own AI summary, on the graph node
//   pinned             EDGE_TYPE_HAS_PIN edges from the event to documents and chats
//   outcomes           documents owned by the event that carry a task state
//   notes              documents owned by the event without a state (the meeting write-up)
// Generic on purpose: any node with pins or owned documents answers the same way.
// Fields are graph-node attributes keyed "<type uri>?attribute=<key>"; the label lives in that type's
// typeDef.attributes. Values carry text, listItems and references (verified on a real typed node).
// Field names come from the type document's template.attributes; the graph's typeDef is not always readable.
const typeAttrTitles = new Map(); // type uri -> { key: title }
async function attributeTitles(typeUri) {
  if (typeAttrTitles.has(typeUri)) return typeAttrTitles.get(typeUri);
  // A failed lookup is not an answer: caching it would blank this type's field labels for the rest of the session.
  try { const titles = fields.templateTitles(await client.sync.subscribe(typeUri)); typeAttrTitles.set(typeUri, titles); return titles; }
  catch { return {}; }
}
// A document's own fields, values included, from its data map (the same place an edit writes to).
async function fieldsOf(id) {
  let document;
  try { document = await client.sync.subscribe(id); } catch { return []; }
  const rows = fields.readFields(document);
  const out = [];
  for (const row of rows) {
    const titles = row.attribute ? await attributeTitles(row.typeUri) : {};
    out.push({ key: row.key, label: (row.attribute && titles[row.attribute]) || undefined, text: row.text });
  }
  return out;
}
// The write-up of an event has no edge of its own: it is the document the event owns whose title is the event's
// tagline (Tana generates both together, and it carries the generated appearance.imageUri). Verified in English
// and Dutch, so the rule is not language-bound. One place: both related() and the navigation redirect use it.
const writeUpOf = (event, owned) => {
  const ev = (event && event.calendarEvent) || {};
  const plain = owned.filter((n) => !(n.state && n.state.type) && idKind(n.id) === 'text' && (n.title || '').trim());
  return (ev.tagline && plain.find((n) => n.title === ev.tagline)) || plain.find((n) => n.appearance && n.appearance.imageUri) || null;
};
// The uri a meeting should open at, or null when it is not an event or has no write-up yet.
const summaryCache = new Map(); // event uri -> write-up uri or null
async function summaryUri(id) {
  if (!client) throw new Error(NOT_CONNECTED);
  if (idKind(id) !== 'event') return null;
  if (summaryCache.has(id)) return summaryCache.get(id);
  const [{ nodes: selfNodes = [] }, { nodes: owned = [] }] = await Promise.all([
    client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({ nodes: [] })),
    client.graph.listNodes({ ownerIds: [id], limit: 200 }).catch(() => ({ nodes: [] })),
  ]);
  const found = writeUpOf(selfNodes[0], owned);
  // Tana writes the summary after the meeting, so "no write-up yet" is a state to re-check, not an answer to cache.
  if (found) summaryCache.set(id, found.id);
  return found ? found.id : null;
}
// The meeting's call link. A calendar location holds the join url for an online meeting (Tana Meet, Google Meet,
// Zoom), a room or address for a physical one, and often both in one semicolon-separated string, so take the first
// http(s) url out of it rather than the whole field. When the location names the room only ('Teams meeting',
// '+Main Building 5-R1 Stairs - Zoom') the provider still carries the join url in calendarEvent.actionUrl, which
// held nothing but Zoom and Teams join links across the calendar (read-only survey, 2026-09-14).
// The label is the human part of the url; a Teams join path is a couple of hundred characters of ids, so a path that
// long is dropped and the host speaks for itself.
function callOf(ev) {
  const found = typeof ev.location === 'string' ? ev.location.match(/https?:\/\/[^\s;,]+/i) : null;
  const url = found ? found[0].replace(/[).,;]+$/, '') : typeof ev.actionUrl === 'string' ? ev.actionUrl : '';
  if (!/^https?:\/\//i.test(url)) return undefined;
  try {
    const u = new URL(url), label = (u.host + u.pathname).replace(/\/+$/, '');
    return { url, label: label.length > 60 ? u.host : label };
  } catch { return undefined; }
}

async function related(id) {
  if (!client) throw new Error(NOT_CONNECTED);
  // The meeting event is the hub: opening its notes document should still show the meeting's pins and outcomes.
  const [self0] = (await client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({ nodes: [] }))).nodes || [];
  const hub = idKind(id) === 'event' ? id : (self0 && typeof self0.ownerUri === 'string' && idKind(self0.ownerUri) === 'event' ? self0.ownerUri : id);
  const [edges, owned, self] = await Promise.all([
    client.graph.listEdges({ fromNodeIds: [hub], edgeTypes: ['EDGE_TYPE_HAS_PIN'] }).catch(() => ({ edges: [] })),
    client.graph.listNodes({ ownerIds: [hub], limit: 200, sortOptions: [{ field: 'SORT_FIELD_CREATE_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] }).catch(() => ({ nodes: [] })),
    hub === id ? Promise.resolve({ nodes: self0 ? [self0] : [] }) : client.graph.listNodes({ nodeIds: [hub], limit: 1 }).catch(() => ({ nodes: [] })),
  ]);
  // HAS_PIN is derived server-side from the hub's own pinnedItems, so read that list too: a pin this app just wrote
  // is in the document before the edge exists, and the hub says whether a new one may be added at all.
  const hubDoc = PIN_HUBS.has(idKind(hub)) ? await client.sync.subscribe(hub).catch(() => null) : null;
  const canPin = hubDoc ? await canWriteDoc(hubDoc).catch(() => false) : false;
  const pinIds = [...new Set([...(hubDoc ? pins.items(hubDoc).map((p) => p.uri) : []), ...(edges.edges || []).map((e) => e.toNodeId).filter(Boolean)])];
  const pinned = pinIds.length ? (await client.graph.listNodes({ nodeIds: pinIds, limit: pinIds.length })).nodes : [];
  const all = [...pinned, ...(owned.nodes || [])];
  all.forEach(rememberNodeHue);
  await resolveTypes(all.map((n) => n.entityType));
  const row = (n) => toNode(graphRow(n, true));
  const event = (self.nodes || [])[0] || {};
  const ev = event.calendarEvent || {};
  const stated = (n) => !!(n.state && n.state.type);
  // never list the open document itself, an untitled draft, or something already shown as a pin
  const pinnedIds = new Set(pinIds);
  const owns = (owned.nodes || []).filter((n) => !PLAIN_KINDS.has(idKind(n.id)) && n.id !== id && !pinnedIds.has(n.id) && (n.title || '').trim());
  const writeUp = writeUpOf(event, owns); // one rule for the rail and for navigation
  return {
    summary: ev.summary || undefined,
    tagline: ev.tagline || undefined,
    // The call link is the event's own: summary, pins and outcomes come from the meeting hub, but a document that
    // merely lives in or was created in the meeting does not inherit its join url, so read it off the zoomed node.
    call: callOf((self0 && self0.calendarEvent) || {}),
    summaryUri: writeUp ? writeUp.id : undefined,
    fields: await fieldsOf(id), // the zoomed node's own fields, not the meeting hub's
    pinHub: canPin ? hub : undefined, // where a new pin would go, when this user may write it
    pinned: pinned.map(row),
    outcomes: owns.filter(stated).map(row),
    notes: owns.filter((n) => !stated(n) && (!writeUp || n.id !== writeUp.id)).map(row),
  };
}
let typesLoaded;
async function typesByTitle() {
  typesLoaded ||= client.graph.listNodes({ nodeTypes: ['type'], limit: 200 }).then(({ nodes }) => { nodes.forEach(rememberType); }, () => { typesLoaded = null; });
  await typesLoaded;
  // typeTitles is the shared id -> title cache (owner chains and entity types land in it too), so a #filter must
  // look at type nodes only: a space or document sharing a type's title would otherwise be searched as that type.
  return new Map([...typeTitles].filter(([uri]) => uri.startsWith('tana:type:')).map(([uri, title]) => [title.toLowerCase(), uri]));
}

// rows for db.replaceSection from graph Node JSON
const taskRow = (n) => ({
  id: n.id, title: n.title || '', done: n.state && n.state.type === 'closed' ? 1 : 0, icon: 'task', stateType: n.state && n.state.type, createdAt: n.createTime,
  hue: hueWithType(hueOf(n), n.entityType), tags: [nodeTag(TAG.task, n), ...typeTag(n.entityType)], sortKey: n.updateTime || now(), updatedAt: n.updateTime || now(),
});
const meetingRow = (n, withDate) => {
  const ev = n.calendarEvent || {};
  return {
    id: n.id, title: n.title || '', done: 0, icon: 'meeting', meta: eventMeta(ev.startTime, ev.endTime, withDate), createdAt: n.createTime,
    hue: hueWithType(hueOf(n), n.entityType), tags: [nodeTag(TAG.meeting, n), ...typeTag(n.entityType)], sortKey: ev.startTime || now(), updatedAt: n.updateTime || now(),
  };
};

// a document's own icon wins; otherwise the icon set on its type applies to every node carrying that type
const iconSvgOf = (r) => { const type = typeUriOf(r); return db.icon(r.id) || (type ? db.icon(type) : null) || undefined; };
// updatedAt/createdAt (ISO) and stateType are optional sort/group data: the row carries what it knows, the rest
// comes from nodeMeta, so a cached SQLite row sorts like a fresh graph row. done keeps its own meaning.
const toNode = (r) => ({ id: r.id, title: r.title, text: r.title, kind: 'document', editable: editability.has(r.id) ? editability.get(r.id) : editable(r, me && me.userUri), done: r.icon === 'task' ? r.done : undefined, hasChildren: true, icon: PLAIN_KINDS.has(idKind(r.id)) ? idKind(r.id) : r.icon || undefined, hue: r.hue === undefined ? (nodeHues.has(r.id) ? nodeHues.get(r.id) : cachedNodeHue(r)) : r.hue, tags: r.tags, meta: r.meta || undefined, iconSvg: iconSvgOf(r), updatedAt: r.updatedAt || undefined, createdAt: r.createdAt || (nodeMeta.get(r.id) || {}).createdAt, stateType: r.stateType || (nodeMeta.get(r.id) || {}).stateType });

// Node shape from any graph Node JSON (search results): events, tasks, typed and plain documents.
function graphRow(n, withDate) {
  if (n.calendarEvent || n.id.startsWith('tana:event:')) return meetingRow(n, withDate);
  if (n.userProfile || idKind(n.id) === 'user-profile') return memberRow(n.id, memberTitle(n), n.updateTime || now(), hueOf(n));
  if (PLAIN_KINDS.has(idKind(n.id))) return kindRow(n.id, idKind(n.id), n.title || '', n.updateTime || now(), hueOf(n));
  if (n.state && n.state.type) return taskRow(n);
  return plainRow(n.id, n.title || '', n.updateTime || now(), n.entityType, hueOf(n));
}

// all org members, cached per session, by display name
let membersLoaded;
function members() {
  if (!client) return Promise.resolve([]);
  membersLoaded ||= client.graph.listNodes({ nodeTypes: ['user-profile'], limit: 500 })
    .then(({ nodes }) => { nodes.forEach(rememberNodeHue); return nodes.map((n) => ({ ...toNode(graphRow(n)), me: n.id === me.userUri || undefined })).sort((a, b) => a.title.localeCompare(b.title)); }, (e) => { membersLoaded = null; throw e; });
  return membersLoaded;
}

const isMcp = (n) => (n.invocationContext && n.invocationContext.intent === 'mcp') || /^MCP:/i.test(n.title || '');

async function viewRows(id, filter) {
  if (!client) return { nodes: [], truncated: false };
  const base = viewFilter(id);
  const f = viewTypes(id, filter === undefined ? base : validViewFilter(filter) ? { ...base, ...filter } : preset(id));
  if (!validViewFilter(f)) throw new Error('invalid view filter');
  const result = await client.graph.listNodes(viewParams(f, me.userUri));
  const docsWithoutTasks = Array.isArray(f.types) && f.types.includes('docs') && !f.types.includes('tasks');
  const rules = hiddenRules();
  const nodes = result.nodes.filter((n) => !(docsWithoutTasks && idKind(n.id) === 'text' && n.state && n.state.type))
    .filter((n) => f.mcp === true || !isMcp(n)).filter((n) => !isHidden(memberTitle(n), rules));
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  const withDate = !(f.types && f.types.length === 1 && f.types[0] === 'meetings');
  const rows = nodes.map((n) => { const row = graphRow(n, withDate); return isMcp(n) ? { ...row, meta: 'MCP' } : row; });
  db.replaceSection(id, rows);
  if (id === activeView && filter === activeFilter) {
    const ids = new Set(nodes.map((n) => n.id));
    for (const nodeId of ids) if (!subscribed.has(nodeId)) { subscribed.add(nodeId); subscribe(nodeId); }
    // Leaving a filtered view must not discard a document whose local undo step still points at its Loro handle.
    for (const nodeId of subscribed) if (!ids.has(nodeId) && !deletedNodes.has(nodeId) && !inHistory(nodeId)) { subscribed.delete(nodeId); client.sync.unsubscribe(nodeId).catch(() => {}); }
  }
  return { nodes: rows.map(toNode), truncated: !!result.truncated };
}

// Live search over all top-level items (graph full-text search, relevance order) with #task/#meeting/#Type filters.
async function search(query) {
  if (!client) return [];
  const parsed = parseQuery(query);
  const params = searchParams(parsed, needsTypes(parsed) ? await typesByTitle() : new Map());
  if (!params) return [];
  // The server ranks by full-text relevance, so a document titled exactly like the query can sit past the first
  // page: fetch wide, rank here, and hand back a page's worth.
  const { nodes } = await client.graph.listNodes({ ...params, limit: 200 });
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

// Resolve native embeds without replacing the containing block identity or loading target content recursively.
async function outlineWithReferences(doc) {
  return resolveReferences(content.readOutline(doc));
}
// The reference rows of any outline (content embeds, chat attachments and proposals) resolved in one place.
async function resolveReferences(nodes) {
  const refs = [];
  const visit = rows => { for (const n of rows) { if (n.type === 'reference') refs.push(n.reference); visit(n.children || []); } };
  visit(nodes);
  const uris = [...new Set(refs.map(r => r.uri).filter(uri => typeof uri === 'string' && DOC_URI.test(uri)))];
  const targets = new Map();
  for (let i = 0; i < uris.length; i += 200) {
    try {
      const result = await client.graph.listNodes({nodeIds: uris.slice(i, i + 200), limit: 200});
      const visible = visibleGraphNodes(result.nodes);
      visible.forEach(rememberNodeHue);
      await resolveTypes(visible.map(n => n.entityType));
      for (const n of visible) targets.set(n.id, toNode(graphRow(n)));
    } catch { /* Keep unresolved reference identity; inaccessible targets must not break the surrounding outline. */ }
  }
  for (const ref of refs) if (targets.has(ref.uri)) ref.node = targets.get(ref.uri);
  return nodes;
}

// A chat has no content outline at all: the conversation is data.messages on the chat document itself
// (docs/CHATS.md). Read only when the chat is opened — a chat document is megabytes of inline tool output.
async function chatOutline(doc) {
  const messages = doc.data.get('messages');
  const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
  return resolveReferences(chat.chatRows(messages ? messages.toJSON() : [], { authorName: (uri) => names.get(uri) }));
}

// New document ('doc' | 'task' | 'meeting'): seeded locally, created on the server by the bootstrap (sdk/sync.js subscribe with init).
async function customCreation(typeUri) {
  if (typeof typeUri !== 'string' || !/^tana:type:[0-9a-z]{26}$/.test(typeUri)) throw new Error('Select a workspace type');
  const type = readNode(await document(typeUri));
  if (type.type !== 'type' || isDeleted(type)) throw new Error('Type is unavailable');
  const appliesTo = type.appliesTo ?? 'docs';
  if (!['docs','events'].includes(appliesTo)) throw new Error('Unsupported type target');
  if (type.ownerUri) {
    if (!/^tana:space:[0-9a-z]{26}$/.test(type.ownerUri)) throw new Error('Unsupported type scope');
    if (!await access.canWrite(readNode(await document(type.ownerUri)), me.userUri, await accessContext())) throw new Error('Type home space write permission is unknown or unavailable');
  }
  return {kind:appliesTo === 'events' ? 'meeting' : 'doc',entityTypeUri:typeUri,ownerUri:type.ownerUri};
}
async function creationOptions() {
  if (!client) throw new Error(NOT_CONNECTED);
  const result = await client.graph.listNodes({nodeTypes:['type'],limit:1000,mode:'LIST_NODES_MODE_WITH_COUNT'});
  const options = [{id:'task',kind:'task',title:'Task',icon:'task',selectable:true},{id:'meeting',kind:'meeting',title:'Meeting',icon:'meeting',selectable:true},{id:'chat',kind:'chat',title:'Chat',icon:'chat',selectable:true}];
  const types = await Promise.all(result.nodes.map(async n => {
    rememberType(n);
    // the chooser shows a type the way its documents render: the type's own hue and its app-local icon
    const look = { hue: ownHue(n) === undefined ? typeHues.get(n.id) : ownHue(n), iconSvg: db.icon(n.id) || undefined };
    try { const config=await customCreation(n.id); return {id:n.id,kind:'custom',typeUri:n.id,title:n.title || '',...look,icon:config.kind === 'meeting' ? 'meeting' : 'doc',ownerUri:config.ownerUri,appliesTo:config.kind === 'meeting' ? 'events' : 'docs',selectable:true}; }
    catch(e) { return {id:n.id,kind:'custom',typeUri:n.id,title:n.title || '',...look,icon:'doc',selectable:false,reason:errText(e)}; }
  }));
  return {options:[...options,...types.sort((a,b)=>a.title.localeCompare(b.title))],complete:result.totalCount !== undefined && result.totalCount === result.nodes.length};
}
async function createDocument(title, opts = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('Keep an empty draft local until it has a title');
  if (!client) throw new Error(NOT_CONNECTED);
  let config = {kind:opts.kind || 'doc'};
  if (config.kind === 'custom') config = await customCreation(opts.typeUri);
  else if (opts.typeUri !== undefined) throw new Error('Custom type requires kind custom');
  if (!Object.hasOwn(KINDS, config.kind)) throw new Error('Unsupported creation kind'); // 'constructor' is a truthy lookup, not a kind
  const id = KINDS[config.kind] + ulid();
  const doc = await subscribe(id, loro => initDocument(loro, title, me.userUri, config));
  if (!doc) throw new Error(status.error || 'could not create ' + id);
  const node = await info(doc); scheduleRefresh(2000); return node; // give GraphService's index time to include the new node
}

// Node shape for any subscribed document: cached row when listed, else derived from the Loro data map.
async function info(doc) {
  const n = readNode(doc), row = db.get(doc.id);
  if (isDeleted(n) || deletedNodes.has(doc.id)) throw new Error('Node has been deleted');
  rememberNodeHue(n);
  // A cached row carries the short list form of an event's meta ("Mon 9:00"); a zoomed node shows the full date
  // like search does (#113), so the meta is rebuilt from the event itself when there is one.
  const ev = n.type === 'event' || doc.id.startsWith('tana:event:') ? eventMeta(n.startTime, n.endTime, true) : undefined;
  if (row) return toNode({ ...row, title: n.title ?? row.title, done: n.stateType === 'closed' ? 1 : 0, meta: ev || row.meta });
  await resolveHue(doc.id); // cached rows already carry the hue the refresh learned from the graph
  if (idKind(doc.id) === 'user-profile') return toNode(memberRow(doc.id, n.title || doc.data.get('name') || doc.data.get('displayName') || '', now(), hueOf(n)));
  if (PLAIN_KINDS.has(idKind(doc.id))) return toNode(kindRow(doc.id, idKind(doc.id), n.title || '', now(), hueOf(n)));
  const isEvent = n.type === 'event' || doc.id.startsWith('tana:event:');
  await resolveTypes([n.entityTypeUri]);
  if (!isEvent && !n.stateType) return toNode(plainRow(doc.id, n.title || '', now(), n.entityTypeUri, hueOf(n)));
  return toNode({
    id: doc.id, title: n.title || '', done: n.stateType === 'closed' ? 1 : 0, icon: isEvent ? 'meeting' : 'task',
    hue: hueWithType(hueOf(n), n.entityTypeUri), meta: isEvent ? eventMeta(n.startTime, n.endTime, true) : null, tags: [nodeTag(isEvent ? TAG.meeting : TAG.task, n), ...typeTag(n.entityTypeUri)],
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- pins (sdk/pins.js over the user's profile/collection/pin-map docs) and app-local icons ----
const today = () => new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
const pinTarget = (target) => { if (target !== 'sidebar' && target !== 'today') throw new Error('pin target must be sidebar or today: ' + target); return target; };

// Sidebar pins as Nodes, in sidebar order; pinned items we cannot subscribe (spaces, types, ...) are skipped quietly.
async function pinnedNode(uri) {
  if (deletedNodes.has(uri)) return undefined;
  const doc = await client.sync.subscribe(uri).catch(() => null); // await bootstrap even when a handle already exists
  if (doc && isDeleted(readNode(doc))) { onChange(uri); return undefined; }
  return doc ? info(doc).catch(() => undefined) : undefined;
}
async function pinned() {
  if (!client) return [];
  const uris = await pins.listSidebar(client.sync, me.userUri);
  return (await Promise.all(uris.map(pinnedNode))).filter(Boolean);
}
async function pinTree() {
  if (!client) return [];
  const fill = async (entry) => {
    const node = entry.uri ? await pinnedNode(entry.uri) : undefined;
    const children = (await Promise.all(entry.children.map(fill))).filter(Boolean);
    if (entry.uri && deletedNodes.has(entry.uri)) return children.length || entry.label ? { label: entry.label, children } : null;
    return { ...entry, node, children };
  };
  return (await Promise.all((await pins.sidebarTree(client.sync, me.userUri)).map(fill))).filter(Boolean);
}
async function pinState(id) {
  if (!client) throw new Error(NOT_CONNECTED);
  return { sidebar: (await pins.listSidebar(client.sync, me.userUri)).includes(id), dates: await pins.dates(client.sync, me.userUri, id) };
}
async function setPin(id, target, on) {
  if (!client) throw new Error(NOT_CONNECTED);
  const sync = client.sync, user = me.userUri;
  if (pinTarget(target) === 'sidebar') await (on ? pins.pinSidebar : pins.unpinSidebar)(sync, user, id);
  else await (on ? pins.pinDate : pins.unpinDate)(sync, user, id, today());
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
function setIcon(id, svg) {
  if (svg != null) {
    if (typeof svg !== 'string' || Buffer.byteLength(svg) >= 65536) throw new Error('icon must be an SVG string under 64 KB');
    svg = svg.trim().replace(/^<\?xml[^>]*\?>\s*/, ''); // FileReader text of a .svg may start with an XML declaration
    if (!svg.startsWith('<svg')) throw new Error('icon must start with <svg');
  }
  db.setIcon(id, svg);
  send('outline:changed', null);
}

function setSensitive(id, on) {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Not a Tana document id');
  if (typeof on !== 'boolean') throw new Error('Sensitive state must be true or false');
  db.setSensitive(id, on);
  return on;
}

function setStatus(patch) {
  Object.assign(status, patch);
  send('sync:status', status);
}

// A failed session probe is unknown, not a confirmed sign-out. The renderer keeps the login button hidden while authChecking.
async function resolveInitialAuth(session) {
  try { return { authenticated: Boolean(await session.isAuthenticated()) }; }
  catch (error) { return { authenticated: null, error }; }
}

// ---- images: tana:image: uri -> data URL, cached in memory and under userData/images/<sha1(uri)> (the data URL as text)
const imageCache = new Map(); // uri -> Promise<data URL>
function image(uri) {
  if (!session) return Promise.reject(new Error('not logged in to Tana'));
  if (!imageCache.has(uri)) imageCache.set(uri, loadImage(uri).catch((e) => { imageCache.delete(uri); throw e; }));
  return imageCache.get(uri);
}
async function loadImage(uri) {
  const dir = path.join(app.getPath('userData'), 'images'), file = path.join(dir, createHash('sha1').update(uri).digest('hex'));
  const cached = await fs.readFile(file, 'utf8').catch(() => null);
  if (cached) return cached;
  const { mime, bytes } = await fetchImage(uri, { getAccessToken: (o) => session.getAccessToken(o) });
  const url = 'data:' + mime + ';base64,' + bytes.toString('base64');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, url);
  return url;
}

async function start() {
  // A second login must not leave the previous stream, its listeners and its subscriptions running: the stale client
  // would keep emitting changes, and the new one would skip every id the old subscription set still claims.
  // The new client's documents start with empty Loro undo managers, so the steps recorded against the old ones are dead.
  if (client) { const previous = client; client = null; subscribed.clear(); undoStack.length = 0; redoStack.length = 0; previous.sync.removeAllListeners(); previous.close().catch(() => {}); }
  me = await session.info();
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: console });
  listFilter(client);
  client.sync.on('connected', () => setStatus({ connected: true, error: null }));
  client.sync.on('disconnected', () => setStatus({ connected: false }));
  client.sync.on('error', (e) => setStatus({ error: errText(e) }));
  client.sync.on('change', onChange);
  setStatus({ authenticated: true });
  await client.sync.connect();
  await refresh();
}

// one refresh at a time; callers that changed the filter await the in-flight run and start a new one
let refreshing = null;
function refresh() {
  if (!client) return Promise.resolve();
  return refreshing ||= doRefresh().finally(() => { refreshing = null; });
}
async function doRefresh() {
  setStatus({ syncing: true, error: null });
  try {
    await viewRows(activeView, activeFilter);
    send('outline:changed', null);
    setStatus({ syncing: false, lastSync: now() });
  } catch (e) {
    setStatus({ syncing: false, error: errText(e) });
  }
}

// Every list and every search asks the graph, so client.graph.listNodes is the one place deleted and hidden nodes
// are dropped. A by-id lookup (nodeIds) resolves a named node — a mention, an owner chain, a pin, a zoomed
// document — and keeps answering: hiding is about lists, not about access.
function listFilter(client) {
  if (!client || !client.graph) return;
  const listNodes = client.graph.listNodes.bind(client.graph);
  client.graph.listNodes = async params => {
    const result = await listNodes(params);
    // Compare the count with the raw response: local delete/title filters must not masquerade as server truncation.
    const truncated = result.totalCount != null ? result.totalCount > result.nodes.length : !!result.truncated;
    const nodes = visibleGraphNodes(result.nodes);
    if (params && params.nodeIds) return { ...result, nodes, truncated };
    const rules = hiddenRules();
    return { ...result, nodes: rules.length ? nodes.filter(n => !isHidden(memberTitle(n), rules)) : nodes, truncated };
  };
}
// Changing the list refreshes like any other filter change: replaceSection drops the rows that are now hidden, so
// nothing comes back from the SQLite cache.
async function setHidden(list) {
  const rules = hideRules(list);
  db.setSetting('hiddenTitles', rules);
  await refreshing; // a run with the old list
  await refresh();
  send('outline:changed', null); // also when there is no connection to refresh with
  return rules;
}

// Subscribing on demand (zoom, create, metadata) does not put a document in a view, and only the refresh unsubscribes:
// a document listed here as well would lose its live updates and its Loro undo history under the open editor.
// ponytail: on-demand subscriptions last for the session; drop the oldest if a long session ever holds too many.
function subscribe(id, init) {
  return client.sync.subscribe(id, init).catch((e) => { subscribed.delete(id); report(e); return null; });
}

function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

function invalidateDeleted(id) {
  deletedNodes.add(id);
  db.remove(id);
  nodeHues.delete(id); hueLoaded.delete(id); editability.delete(id); pathCache.delete(id); nodeMeta.delete(id);
  typeTitles.delete(id); typeHues.delete(id);
  summaryCache.delete(id);
  for (const [event, writeUp] of summaryCache) if (writeUp === id) summaryCache.delete(event); // a deleted write-up is no redirect target
  send('outline:removed', id); // renderer must evict children/search/pin/zoom caches by id
  send('outline:changed', null);
}

function onChange(docId) {
  try {
    const doc = client.sync.getDocument(docId);
    if (!doc) return;
    const n = readNode(doc), row = db.get(docId);
    if (isDeleted(n)) {
      invalidateDeleted(docId);
      return;
    }
    const restored = deletedNodes.delete(docId);
    const hueChanged = rememberNodeHue(n);
    const done = n.stateType === 'closed' ? 1 : 0, title = n.title ?? row?.title;
    const rowChanged = row && (title !== row.title || done !== row.done || hueChanged);
    if (rowChanged) db.upsert({ ...row, title, done, updatedAt: now() });
    // Collection/profile/date-pin changes do not have cached view rows, but invalidate pins globally.
    const pinsChanged = docId === me?.userUri || ['collection', 'pin-map'].includes(idKind(docId));
    send('outline:changed', docId);
    if (pinsChanged || rowChanged || restored) send('outline:changed', null);
    if (restored) scheduleRefresh(0);
  } catch (e) {
    report(e);
  }
}

async function document(id) {
  if (!client || !me) throw new Error(NOT_CONNECTED);
  // A renderer draft carries a local id until it is materialised; subscribing one would create a phantom document
  // whose pending bootstrap then rejects as "unsubscribed <id>" on the next refresh.
  if (!DOC_URI.test(id)) throw new Error(NOT_CONNECTED);
  const doc = await subscribe(id); // getDocument can expose an empty handle before bootstrap completes
  if (!doc) throw new Error(status.error || 'could not subscribe to ' + id);
  return doc;
}

function createWindow() {
  win = new BrowserWindow({
    width: 900, height: 700, title: 'Tana', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('focus', () => refresh());
  win.loadFile(path.join(__dirname, 'index.html'));
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => updater.check({ manual: true }) },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// Run fn on the subscribed Document; the ops transact synchronously, so the result is in Loro (and sent) on resolve.
async function op(id, fn) {
  try {
    const doc = await document(id);
    if (isDeleted(readNode(doc)) || deletedNodes.has(id)) throw new Error('Node has been deleted');
    return await fn(doc);
  } catch (e) {
    report(e);
    throw e;
  }
}

// Mutations: same as op, plus global undo ordering across documents (each Document keeps its own Loro UndoManager).
const undoStack = [], redoStack = [];
// ponytail: a linear scan of an unbounded stack, run once per refresh; index it if either ever grows into the thousands.
const inHistory = (id) => [...undoStack, ...redoStack].some((step) => step === id || step?.id === id || (Array.isArray(step) && step.includes(id)));
async function mut(id, fn, accessMutation = false) {
  if (historyBusy) throw new Error('History operation is still running');
  const result = await op(id, (doc) => {
    if (!accessMutation && editable(readNode(doc), me && me.userUri) === false) throw new Error('This node is read-only in the outliner');
    return fn(doc);
  });
  // Sharing and moves are gated by an audience disclosure and a preview token; a raw CRDT undo would rewrite
  // participants, restricted or ownerUri without either, so those mutations do not enter the undo stack.
  if (!accessMutation) { undoStack.push(id); redoStack.length = 0; }
  return result;
}
// Task metadata lives in separate CRDT documents. Preflight the whole selection, then group those
// per-document transactions into one user-visible history step.
async function mutTasks(ids, fn) {
  if (historyBusy) throw new Error('History operation is still running');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !DOC_URI.test(id))) throw new Error('Select unique task documents');
  const docs = await Promise.all(ids.map((id) => op(id, (doc) => {
    const node = readNode(doc);
    if (!STATE_TYPES.includes(node.stateType)) throw new Error('Task metadata can only be changed on tasks');
    if (editable(node, me && me.userUri) === false) throw new Error('This node is read-only in the outliner');
    return doc;
  })));
  const changed = [];
  try {
    for (const doc of docs) {
      const before = doc.loro.oplogVersion();
      fn(doc);
      if (before.compare(doc.loro.oplogVersion()) !== 0) changed.push(doc.id);
    }
  } finally {
    if (changed.length) { undoStack.push(changed); redoStack.length = 0; }
  }
  return changed.length;
}
// ponytail: one undo step per mutation call across docs; Loro merges steps within 500 ms inside a document.
let historyBusy = false;
async function documentAction(id, action, record = true) {
  if (record && historyBusy) throw new Error('History operation is still running');
  if (record) historyBusy = true;
  try {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Invalid document URI');
  const doc = await document(id), ctx = await accessContext();
  if (!await access.canDelete(doc, me.userUri, ctx, action === 'restore')) throw new Error('Delete/restore permission is unknown or unavailable');
  const response = await client.sync[action](id);
  if (response.responseUnion?.case !== 'documentActionResponse') throw new Error('Document action was not acknowledged');
  if (action === 'softDelete') invalidateDeleted(id);
  // Restore visibility comes from the server's live update, not a fabricated local snapshot.
  if (record) { undoStack.push({ id, documentAction:action }); redoStack.length = 0; }
  scheduleRefresh(0);
  return id;
  } finally { if (record) historyBusy = false; }
}
async function history(from, to, action, can) {
  if (historyBusy) throw new Error('History operation is still running');
  historyBusy = true;
  try {
    while (from.length) {
      const step = from.at(-1);
      if (Array.isArray(step)) {
        let changedId = null;
        for (const id of action === 'undo' ? [...step].reverse() : step) {
          const doc = client && client.sync.getDocument(id);
          if (!doc || !doc[can]() || isDeleted(readNode(doc)) || editable(readNode(doc), me && me.userUri) === false) continue;
          if (doc[action]()) changedId ||= id;
        }
        from.pop();
        if (changedId) { to.push(step); scheduleRefresh(2000); return changedId; }
        continue;
      }
      if (typeof step === 'object') {
        const command = action === 'undo' ? (step.documentAction === 'softDelete' ? 'restore' : 'softDelete') : step.documentAction;
        await documentAction(step.id, command, false);
        from.pop(); to.push(step); return step.id;
      }
      const id = step, doc = client && client.sync.getDocument(id);
      if (!doc || !doc[can]() || isDeleted(readNode(doc)) || editable(readNode(doc), me && me.userUri) === false) { from.pop(); continue; }
      // An undone state change belongs back on its list (unchecking a task returns it to Tasks), which only a refresh knows.
      if (doc[action]()) { from.pop(); to.push(id); scheduleRefresh(2000); return id; }
      from.pop();
    }
    return null;
  } finally { historyBusy = false; }
}

ipcMain.handle('outline:roots', async () => {
  const rows = db.list();
  const rules = hiddenRules(); // a row cached before the rule was added is hidden here too, refresh or no refresh
  return VIEWS.map((view) => ({ ...view, nodes: (rows[view.id] || []).filter((r) => !isHidden(r.title, rules)).map(toNode) }));
});
ipcMain.handle('view:list', async (_e, id, filter) => {
  preset(id); // validate before changing which view the refresh loop owns
  activeView = id;
  activeFilter = filter;
  await refreshing;
  return viewRows(id, filter);
});
ipcMain.handle('view:filter', (_e, id) => viewFilter(id));
ipcMain.handle('view:setFilter', (_e, id, filter) => {
  const stored = setViewFilter(id, filter);
  if (id === activeView) activeFilter = stored;
  return stored;
});
// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (_e, id) => (isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))));
ipcMain.handle('doc:info', (_e, id) => op(id, info));
ipcMain.handle('doc:creationOptions', () => creationOptions());
ipcMain.handle('doc:create', (_e, title, opts) => createDocument(title, opts || {}));
ipcMain.handle('search', (_e, query) => search(query));
ipcMain.handle('history:undo', () => history(undoStack, redoStack, 'undo', 'canUndo'));
ipcMain.handle('history:redo', () => history(redoStack, undoStack, 'redo', 'canRedo'));
ipcMain.handle('doc:delete', (_e, id) => documentAction(id, 'softDelete'));
ipcMain.handle('doc:restore', (_e, id) => documentAction(id, 'restore'));
ipcMain.handle('doc:setTitle', (_e, id, title) => mut(id, (doc) => { setTitle(doc, title); }));
ipcMain.handle('doc:setDone', (_e, id, done) => mut(id, (doc) => {
  setState(doc, done ? 'closed' : 'open', me.userUri);
  scheduleRefresh(2000); // a closed task drops off the open list
}));
ipcMain.handle('doc:setState', (_e, id, state) => mutTasks([id], (doc) => setState(doc, state, me.userUri)).then((count) => { scheduleRefresh(2000); return count; }));
ipcMain.handle('doc:setStateMany', (_e, ids, state) => mutTasks(ids, (doc) => setState(doc, state, me.userUri)).then((count) => { scheduleRefresh(2000); return count; }));
// linkSharing lives on the graph node, never in the document, so public-to-the-internet needs its own lookup
const linkShared = async (id) => {
  try { const { nodes = [] } = await client.graph.listNodes({ nodeIds: [id], limit: 1 }); return !!(nodes[0] && nodes[0].linkSharing && nodes[0].linkSharing.mode); }
  catch { return false; }
};
ipcMain.handle('doc:taskMeta', (_e, id) => op(id, async doc => ({
  ...taskMeta(doc),
  ...await audienceMetadata(doc, me.userUri, client.graph, client.sync),
  linkShared: await linkShared(id),
})));
// Access has native capability checks independent of the outliner's editable-body support.
async function accessContext() {
  const token = await session.getAccessToken();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return {sync:client.sync, graph:client.graph, orgDocUri:me.orgDocUri,
    orgAdmin:claims.org_id === me.orgId && ['admin','owner'].includes(claims.role)};
}
// Native write access to a document: a participant grant or an inherited owner boundary (sdk/access.js), never the
// outliner's editable-body answer, which is about editing a title or content.
const canWriteDoc = async (doc) => access.canWrite(readNode(doc), me.userUri, await accessContext());
ipcMain.handle('doc:accessOptions', (_e, id) => op(id, async doc => access.capabilities(doc, me.userUri, await accessContext())));
ipcMain.handle('doc:setSharing', (_e, id, selection) => mut(id, async doc => {
  await access.setSharing(doc, me.userUri, selection, await accessContext()); scheduleRefresh(2000);
}, true));
ipcMain.handle('spaces:search', async (_e, query = '') => {
  if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid space query');
  if (!client) throw new Error(NOT_CONNECTED);
  const { nodes } = await client.graph.listNodes({ nodeTypes: ['space'], textQuery: query.trim(), limit: 50 });
  const ctx = await accessContext();
  const spaces = await Promise.all(nodes.map(async n => ({ ...toNode(graphRow(n)), selectable: await access.canWrite(n, me.userUri, ctx) })));
  // "Library" moves a document out of every space; it is a target, not a space, so it is added here rather than queried.
  const library = { id: 'library', title: 'Library', text: 'Library', kind: 'document', icon: 'library', editable: false, selectable: true };
  return 'library'.startsWith(query.trim().toLowerCase()) || !query.trim() ? [library, ...spaces] : spaces;
});
async function moveTarget(spaceId) {
  if (spaceId === 'library') return access.LIBRARY;
  if (typeof spaceId !== 'string' || !/^tana:space:[0-9a-z]{26}$/.test(spaceId)) throw new Error('Select a space');
  return document(spaceId);
}
ipcMain.handle('doc:previewMove', (_e, id, spaceId) => op(id, async doc => access.previewMove(doc, await moveTarget(spaceId), me.userUri, await accessContext())));
ipcMain.handle('doc:moveToSpace', (_e, id, spaceId, token) => mut(id, async doc => {
  const result = await access.moveToSpace(doc, await moveTarget(spaceId), me.userUri, await accessContext(), token);
  pathCache.delete(id); send('outline:changed', null); scheduleRefresh(2000); return result;
}, true));
ipcMain.handle('doc:setAssignees', (_e, id, uris) => mut(id, (doc) => {
  setAssignees(doc, uris, me.userUri);
  scheduleRefresh(2000); // reassignment may add or remove this task from the active filter
}));
ipcMain.handle('doc:setAssigneesMany', (_e, ids, uris) => mutTasks(ids, (doc) => setAssignees(doc, uris, me.userUri)).then((count) => { scheduleRefresh(2000); return count; }));
ipcMain.handle('block:setText', (_e, id, nodeId, value) => mut(id, (doc) => { content.setText(doc, nodeId, value); })); // value: string or segments
ipcMain.handle('block:setBlockType', (_e, id, nodeId, type) => mut(id, (doc) => { content.setBlockType(doc, nodeId, type); })); // type: one of content.BLOCK_TYPES
ipcMain.handle('block:insertDivider', (_e, id, nodeId) => mut(id, (doc) => content.insertDivider(doc, nodeId))); // nodeId null appends at the end
ipcMain.handle('block:insertAfter', (_e, id, nodeId, text) => mut(id, (doc) => content.insertAfter(doc, nodeId, text)));
ipcMain.handle('block:insertChild', (_e, id, nodeId, text) => mut(id, (doc) => content.insertChild(doc, nodeId, text)));
ipcMain.handle('block:removeMany', (_e, id, nodeIds) => mut(id, doc => content.removeMany(doc, nodeIds)));
ipcMain.handle('block:moveMany', (_e, id, nodeIds, direction) => mut(id, doc => content.moveMany(doc, nodeIds, direction)));
ipcMain.handle('block:indentMany', (_e, id, nodeIds) => mut(id, doc => content.indentMany(doc, nodeIds)));
ipcMain.handle('block:outdentMany', (_e, id, nodeIds) => mut(id, doc => content.outdentMany(doc, nodeIds)));
ipcMain.handle('block:remove', (_e, id, nodeId) => mut(id, (doc) => { content.remove(doc, nodeId); }));
ipcMain.handle('block:indent', (_e, id, nodeId) => mut(id, (doc) => { content.indent(doc, nodeId); }));
ipcMain.handle('block:outdent', (_e, id, nodeId) => mut(id, (doc) => { content.outdent(doc, nodeId); }));
ipcMain.handle('block:move', (_e, id, nodeId, direction) => mut(id, (doc) => { content.move(doc, nodeId, direction); }));
ipcMain.handle('block:toggleCheckbox', (_e, id, nodeId) => mut(id, (doc) => { content.toggleCheckbox(doc, nodeId); }));
ipcMain.handle('pins:list', () => pinned());
ipcMain.handle('pins:state', (_e, id) => pinState(id));
ipcMain.handle('pins:pin', (_e, id, target) => setPin(id, target, true));
ipcMain.handle('pins:unpin', (_e, id, target) => setPin(id, target, false));
ipcMain.handle('pins:pinTo', (_e, hubId, uri) => nodePin(hubId, uri, true)); // pin a document on a meeting/space
ipcMain.handle('pins:unpinFrom', (_e, hubId, uri) => nodePin(hubId, uri, false));
ipcMain.handle('doc:setIcon', (_e, id, svg) => setIcon(id, svg));
ipcMain.handle('sensitive:list', () => db.sensitiveIds());
ipcMain.handle('sensitive:set', (_e, id, on) => setSensitive(id, on));
ipcMain.handle('doc:related', (_e, id) => related(id)); // { summary, tagline, pinned[], outcomes[], notes[] }
ipcMain.handle('doc:summaryUri', (_e, id) => summaryUri(id)); // where a meeting should actually open, or null
ipcMain.handle('doc:setField', (_e, id, key, text) => mut(id, (doc) => fields.setFieldText(doc, key, text)));
// The web link for a node, the same url home.tana.inc opens: /o/<org>/l/<encoded node uri>
ipcMain.handle('doc:link', (_e, id) => {
  // the path segment is the org *document* ulid (tana:org:01ks7…), not the WorkOS org id in me.orgId
  const org = (me && me.orgDocUri || '').split(':').pop();
  if (!org) throw new Error(NOT_CONNECTED);
  if (!/^tana:[a-z-]+:[0-9a-z]{26}$/.test(id)) throw new Error('Not a Tana document id');
  return 'https://home.tana.inc/o/' + org + '/l/' + encodeURIComponent(id);
});
// A link in node text opens in the user's browser; only http(s), never a file or custom scheme.
ipcMain.handle('shell:open', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  return shell.openExternal(url);
});
// The node for today: a document titled with today's date, pinned to today. Created and pinned when missing,
// so "Show today node" always lands somewhere. Matching is by exact title, the same string the pin uses.
ipcMain.handle('doc:todayNode', async () => {
  if (!client) throw new Error(NOT_CONNECTED);
  const date = today();
  const { nodes = [] } = await client.graph.listNodes({ textQuery: date, nodeTypes: ['text'], limit: 20 }).catch(() => ({ nodes: [] }));
  const existing = nodes.find((n) => (n.title || '').trim() === date);
  if (existing) {
    const pinnedDates = await pins.dates(client.sync, me.userUri, existing.id).catch(() => []);
    if (!pinnedDates.includes(date)) await setPin(existing.id, 'today', true);
    return existing.id;
  }
  const created = await createDocument(date, { kind: 'doc' });
  await setPin(created.id, 'today', true);
  scheduleRefresh(1000);
  return created.id;
});
// macOS appearance, for the renderer's "follow the system" theme: current value on demand, plus live changes
const systemTheme = () => (nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('theme:system', () => systemTheme());
if (nativeTheme) nativeTheme.on('updated', () => send('theme:system', systemTheme()));
ipcMain.handle('image', (_e, uri) => image(uri));
ipcMain.handle('members', () => members());
// Hidden titles: the user's list of patterns, applied to every list and search (see listFilter/sdk-query isHidden).
ipcMain.handle('filters:list', () => hiddenRules());
ipcMain.handle('filters:set', (_e, patterns) => setHidden(patterns));
ipcMain.handle('filters:add', (_e, pattern) => setHidden([...hiddenRules(), pattern]));
ipcMain.handle('filters:remove', (_e, pattern) => setHidden(hiddenRules().filter((p) => p.toLowerCase() !== String(pattern ?? '').trim().toLowerCase())));
ipcMain.handle('sync:refresh', () => refresh());
ipcMain.handle('sync:status', () => status);
ipcMain.handle('sync:login', async () => {
  try {
    await session.login();
    await start();
  } catch (e) {
    report(e);
  }
});

if (process.env.TANA_MAIN_TEST) {
  module.exports = { resolveInitialAuth, graphRow, cachedNodeHue, VIEWS, toNode, outlineWithReferences, chatOutline, op, onChange, documentAction, createDocument, creationOptions, search, viewRows, spaceChildren, start, refresh, related, callOf,
    statusSnapshot: () => ({ ...status }), rememberNodeHue,
    undo: () => history(undoStack, redoStack, 'undo', 'canUndo'), redo: () => history(redoStack, undoStack, 'redo', 'canRedo'), visibleGraphNodes, pinTree,
    nodePin,
    accessContext,
    testRuntime: (runtime) => { client = runtime.client; me = runtime.me; win = runtime.win; session = runtime.session; activeView = runtime.activeView || 'tasks'; activeFilter = undefined; if (client) listFilter(client); } };
} else {
  app.setName('Tana Companion');
  app.setPath('userData', path.join(app.getPath('appData'), 'tana-tasks')); // before 'ready': same session/cache for dev runs, the CLI and the packaged app

  app.whenReady().then(async () => {
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); // packaged builds carry the icon in the bundle
    db.open(path.join(app.getPath('userData'), 'tasks.sqlite'));
    session = createTanaSession();
    createMenu();
    createWindow();
    const auth = await resolveInitialAuth(session);
    setStatus({ authChecking: false, authenticated: auth.authenticated, error: auth.error ? errText(auth.error) : null });
    if (auth.authenticated) {
      try { await start(); }
      catch (e) { setStatus({ error: errText(e) }); }
    }
    // Discovery has no query subscription. Refreshing the active view is one ListNodes call every 30 seconds.
    setInterval(refresh, 30000);
    // Updates: at launch and once a day, silent unless there is one (updater.js swaps the bundle and relaunches).
    updater.check();
    setInterval(() => updater.check(), 24 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (client) client.close().catch(() => {}); });
}
