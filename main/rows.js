'use strict';
const { editable, readNode, STATE_TYPES } = require('../sdk/node');
const { hm } = require('../sdk/chat'); // the same H:MM a chat message is stamped with; it takes a Date too
const { typeIconName } = require('./icons');
const settings = require('./settings');
const { PLAIN_KINDS, S, TAG, docStates, editability, hueLoaded, idKind, isSpace, iso, memberTitle, nodeCreators, nodeHues, nodeMeta, now, typeHues, typeTitles } = require('./state');

// The search index can trail a write by seconds, and every index result becomes a row through graphRow and records its
// state in rememberMeta. A task this app holds live already has the newer state, so that one wins: a list refresh, a
// search, a reference target or a sidebar row must not put back the state from before (set to Inbox, grey again two
// seconds later). A document still bootstrapping reads no state and leaves the index's alone.
function liveState(n) {
  if (!n || !n.state) return n; // a Loro data map rather than an index row: there is no index answer to correct here
  const sync = S.client && S.client.sync;
  const doc = sync && typeof sync.getDocument === 'function' ? sync.getDocument(n.id) : null;
  // The handle is not always there to ask — a task changed from a list is not necessarily one sync still hands back —
  // and then the index's older answer used to win, putting In Progress back a couple of seconds after Set status to
  // Inbox. docStates remembers what the document itself last said, so the write survives either way.
  const live = doc ? readNode(doc).stateType : docStates.get(n.id);
  return STATE_TYPES.includes(live) && live !== n.state.type ? { ...n, state: { ...n.state, type: live } } : n;
}
function rememberMeta(n) {
  n = liveState(n);
  const createdAt = iso(n.createTime ?? n.createdAt) || (nodeMeta.get(n.id) || {}).createdAt;
  // updateTime exists on graph nodes only — a Loro data map never carries one — so, like the hue, the graph is the
  // one source and a document read must not erase it. Without this a row built without a cached SQLite row (a saved
  // search's rows, a live update patching one) came back with no updatedAt at all and lost its "Updated ..." line.
  const updatedAt = iso(n.updateTime) || (nodeMeta.get(n.id) || {}).updatedAt;
  const state = (n.state && n.state.type) || n.stateType;
  const stateType = STATE_TYPES.includes(state) ? state : undefined;
  // n.stateType means this came from a Loro data map rather than the search index: the document is the source of
  // truth, so that answer is kept apart from nodeMeta, which any lagging index row overwrites.
  if (stateType && n.stateType !== undefined) docStates.set(n.id, stateType);
  if (createdAt || updatedAt || stateType) nodeMeta.set(n.id, { createdAt, updatedAt, stateType });
}
const rememberType = (n) => { typeTitles.set(n.id, n.title || ''); if (n.appearance && typeof n.appearance.hue === 'number') typeHues.set(n.id, n.appearance.hue); };
const ownHue = (n) => n && n.appearance && typeof n.appearance.hue === 'number' ? n.appearance.hue : undefined;
// appearance lives on graph nodes only: a Loro data map never carries it (verified read-only for spaces and typed
// documents), so a node without an appearance key says nothing about the hue and must not erase what the graph told us.
// ponytail: a hue removed in Tana therefore stays cached until the next app start; the graph is the only source.
const hueOf = (n) => { if (n && typeHueOverrides()[n.id] !== undefined) return typeHue(n.id); const hue = ownHue(n); return hue === undefined && n ? nodeHues.get(n.id) : hue; };
// This app's own colour for a type, kept in the settings document (docs/SETTINGS.md) so it follows you between
// machines without touching the hue Tana keeps on the type: a number is a hue of our own, 'grey' is no tint at all
// (Tana has no grey: every hue it stores is a colour), and no entry means Tana's own hue shows through.
const typeHueOverrides = () => { const v = settings.get('typeHues'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
const typeHue = (uri) => { const own = typeHueOverrides()[uri]; return own === 'grey' ? undefined : typeof own === 'number' ? own : typeHues.get(uri); };
function rememberNodeHue(n) {
  editability.set(n.id, editable(n, S.me && S.me.userUri));
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
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Mon 9:00–9:30" in local time; all-day events come as UTC (or local) midnight with a whole-day span: "Mon, all day".
// withDate (search results, any week or year): "Fri 11 Sep 9:00–10:00", with the year added outside the current one.
function eventMeta(start, end, withDate, allDayFlag) {
  if (!start) return undefined;
  const s = new Date(start), e = end ? new Date(end) : null;
  const midnight = s.getUTCHours() + s.getUTCMinutes() === 0 || s.getHours() + s.getMinutes() === 0;
  const allDay = allDayFlag === true || (e && midnight && (e - s) % 864e5 === 0); // Tana now says so: calendarEvent.allDay
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
  const { nodes } = await S.client.graph.listNodes({ nodeIds: missing, limit: missing.length });
  nodes.forEach(rememberType);
}
// { label, hue, uri } when the type node has appearance.hue, else grey (docs/OUTLINER.md addendum 12).
// uri lets a row find its type again through the cache, for the type's hue and its app-local icon.
const typeTag = (uri) => (uri && typeTitles.get(uri) ? [typeHue(uri) !== undefined ? { label: typeTitles.get(uri), hue: typeHue(uri), uri } : { label: typeTitles.get(uri), color: 'grey', uri }] : []);
const typeUriOf = (r) => (r.tags || []).map((t) => t && t.uri).find(Boolean); // the row's type, from its type tag
// a node without its own appearance.hue inherits the hue of its type, so icon and tag match (docs/OUTLINER.md addendum 14)
const hueWithType = (own, typeUri) => (own === undefined && typeUri !== undefined ? typeHue(typeUri) : own);
// A document opened straight from Loro (pins, zoom, spaces) has no appearance in its data map, so its colour needs
// one graph lookup. Cached per id including "no hue", like resolveTypes caches titles.
async function resolveHue(id) {
  if (hueLoaded.has(id) || !S.client) return;
  hueLoaded.add(id);
  try { (await S.client.graph.listNodes({ nodeIds: [id], limit: 1 })).nodes.forEach(rememberNodeHue); }
  catch { hueLoaded.delete(id); }
}
// plain untyped document (no state, no type): 'doc' icon + chip; typed documents keep their type tag and the plain bullet
// createdAt is trailing so the other callers of these builders keep the shape they pass today. A row that is handed
// a creation time has to carry it: nodeMeta is the backfill for a cached row, not a substitute for what the graph
// just said, and without this Sort by Created silently did nothing for every kind that is not a task or a meeting.
const plainRow = (id, title, updatedAt, typeUri, hue, createdAt) => (isSpace(id)
  ? { id, title, done: 0, icon: 'space', hue, tags: [hue === undefined ? TAG.space : { ...TAG.space, hue }], sortKey: updatedAt, updatedAt, createdAt }
  // a typed document without its own icon shows the generic type glyph, tinted with its type's hue
  // A type can be given a glyph of its own (main/icons.js), and a document wears its type's: the row's icon is what
  // every other surface reads — the bullet, the rail, a breadcrumb, and the chip an inline mention of it draws
  // (resolveReferences hands the target's icon to the mention) — so one name here reaches all of them.
  : { id, title, done: 0, icon: typeUri ? typeIconName(typeUri) || 'type' : 'doc', hue: hueWithType(hue, typeUri), tags: typeUri ? typeTag(typeUri) : [hue === undefined ? TAG.doc : { ...TAG.doc, hue }], sortKey: updatedAt, updatedAt, createdAt });
const memberRow = (id, title, updatedAt, hue, createdAt) => ({ id, title, done: 0, icon: 'member', hue, tags: [hue === undefined ? TAG.member : { ...TAG.member, hue }], sortKey: updatedAt, updatedAt, createdAt });
// chat, canvas, agent and skill each have their own glyph in the renderer's icon set, so the kind is the icon
const kindRow = (id, kind, title, updatedAt, hue, createdAt) => ({ id, title, done: 0, icon: (kind === 'type' && typeIconName(id)) || (PLAIN_KINDS.has(kind) ? kind : null), hue, tags: [hue === undefined ? { label: kind, color: 'grey' } : { label: kind, hue }], sortKey: updatedAt, updatedAt, createdAt });
// lowercase type title -> uri for #Type search filters; the type list is loaded once per S.session (and seeds typeTitles)
async function typesByTitle() {
  S.typesLoaded ||= S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 }).then(({ nodes }) => { nodes.forEach(rememberType); }, () => { S.typesLoaded = null; });
  await S.typesLoaded;
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
    id: n.id, title: n.title || '', done: 0, icon: 'meeting', meta: eventMeta(ev.startTime, ev.endTime, withDate, ev.allDay), createdAt: n.createTime,
    hue: hueWithType(hueOf(n), n.entityType), tags: [nodeTag(TAG.meeting, n), ...typeTag(n.entityType)], sortKey: ev.startTime || now(), updatedAt: n.updateTime || now(),
    // the event window itself, beside the text that displays it: anything that orders meetings by time has to read
    // these rather than parse `meta`, which is a label and says "Fri 08:20" for six days either side of today
    start: ev.startTime, end: ev.endTime,
  };
};

// updatedAt/createdAt (ISO) and stateType are optional sort/group data: the row carries what it knows, the rest
// comes from nodeMeta, so a cached SQLite row sorts like a fresh graph row. done keeps its own meaning.
// An event also carries its own window (`start`/`end`), and only an event does: the keys are added rather than always
// present, so every other kind of node keeps the shape it had. A row restored from the SQLite cache has no window —
// the cache stores the label, not the times — so a consumer that needs one asks the graph, as the meeting picker does.
const toNode = (r) => ({ id: r.id, title: r.title, text: r.title, kind: 'document', editable: editability.has(r.id) ? editability.get(r.id) : editable(r, S.me && S.me.userUri), done: r.icon === 'task' ? r.done : undefined, hasChildren: true, icon: PLAIN_KINDS.has(idKind(r.id)) ? (typeIconName(r.id) || idKind(r.id)) : r.icon || undefined, hue: r.hue === undefined ? (nodeHues.has(r.id) ? nodeHues.get(r.id) : cachedNodeHue(r)) : r.hue, tags: r.tags, meta: r.meta || undefined, updatedAt: r.updatedAt || (nodeMeta.get(r.id) || {}).updatedAt, createdAt: r.createdAt || (nodeMeta.get(r.id) || {}).createdAt, createdBy: nodeCreators.get(r.id), stateType: r.stateType || (nodeMeta.get(r.id) || {}).stateType, ...(r.start ? { start: r.start, end: r.end } : {}), ...(r.fields ? { fields: r.fields } : {}) });
// A typed node's field values as the graph lists them (`attributes`, keyed "<type uri>?attribute=<key>"): one string
// per value, which is what a row shows of a field (renderer/views.js fieldValues). Verified live on Goal 2026-09-25.
function fieldValues(n) {
  const out = {};
  for (const [key, a] of Object.entries(n.attributes || {})) {
    const items = (a && Array.isArray(a.listItems) && a.listItems.length ? a.listItems : [a && a.text]).filter((v) => typeof v === 'string' && v.trim());
    if (items.length) out[key] = items;
  }
  return Object.keys(out).length ? out : undefined;
}

// Node shape from any graph Node JSON (search results): events, tasks, typed and plain documents.
function graphRow(n, withDate) {
  const row = kindedRow(n, withDate), fields = fieldValues(n);
  return fields ? { ...row, fields } : row;
}
function kindedRow(n, withDate) {
  // every listed node passes through here, so the watch rule's creator lookup is usually already answered
  if (typeof n.createdBy === 'string') nodeCreators.set(n.id, n.createdBy);
  n = liveState(n);
  if (n.calendarEvent || n.id.startsWith('tana:event:')) return meetingRow(n, withDate);
  if (n.userProfile || idKind(n.id) === 'user-profile') return memberRow(n.id, memberTitle(n), n.updateTime || now(), hueOf(n), n.createTime);
  if (PLAIN_KINDS.has(idKind(n.id))) return kindRow(n.id, idKind(n.id), n.title || '', n.updateTime || now(), hueOf(n), n.createTime);
  if (n.state && n.state.type) return taskRow(n);
  return plainRow(n.id, n.title || '', n.updateTime || now(), n.entityType, hueOf(n), n.createTime);
}

// all org members, cached per S.session, by display name
function members() {
  if (!S.client) return Promise.resolve([]);
  S.membersLoaded ||= S.client.graph.listNodes({ nodeTypes: ['user-profile'], limit: 500 })
    .then(({ nodes }) => { nodes.forEach(rememberNodeHue); return nodes.map((n) => ({ ...toNode(graphRow(n)), me: n.id === S.me.userUri || undefined })).sort((a, b) => a.title.localeCompare(b.title)); }, (e) => { S.membersLoaded = null; throw e; });
  return S.membersLoaded;
}

module.exports = { rememberMeta, rememberType, ownHue, hueOf, typeHue, rememberNodeHue, nodeTag, cachedNodeHue, WEEKDAY, MONTH, hm, eventMeta, resolveTypes, typeTag, typeUriOf, hueWithType, resolveHue, plainRow, memberRow, kindRow, typesByTitle, taskRow, meetingRow, toNode, graphRow, members };
