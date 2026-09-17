'use strict';
const fields = require('../sdk/fields');
const pins = require('../sdk/pins');
const { searchQueryParams } = require('../sdk/query');
const { NOT_CONNECTED, PIN_HUBS, PLAIN_KINDS, S, idKind, isSpace, summaryCache, typeAttrTitles, typeTitles } = require('./state');
const { graphRow, rememberNodeHue, resolveTypes, toNode } = require('./rows');
const { canWriteDoc, op } = require('./documents');

const crumbIcon = (id) => ({ space: 'space', event: 'meeting', 'user-profile': 'member', chat: 'chat', agent: 'agent' })[idKind(id)] || 'doc';
async function pathOf(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const { entries = [] } = await S.client.graph.getOwnerChain(id);
  const owners = entries.map((e) => e.uri).filter((u) => u !== id).reverse();
  const library = { id: 'library', title: 'Library', icon: 'library' }; // every location starts at the Library view
  if (!owners.length) return [library];
  await resolveTypes(owners); // same title cache: any node id -> title
  // A space inside a space adds no location information, so only the innermost space is shown, with whatever it contains.
  const innermost = owners.map(isSpace).lastIndexOf(true);
  const shown = innermost === -1 ? owners : owners.slice(innermost);
  // No hue here on purpose: the crumb bar is one quiet grey line, and a coloured icon in it only shouts.
  return [library, ...shown.map((u) => ({ id: u, title: typeTitles.get(u) || u, icon: crumbIcon(u) }))];
}

// A space's "content" is the documents it owns (graph query), returned as document Nodes.
async function spaceChildren(id) {
  if (!S.client) throw new Error(NOT_CONNECTED); // a space opened before the connection is a startup state, not an error (#97)
  const { nodes } = await S.client.graph.listNodes({ ownerIds: [id], limit: 200, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n)));
}
// A saved search's "content" is the rows its stored query returns. The query lives in a root Loro container of its
// own (`query`), not in `data`, so readNode never sees it — take it off the document directly.
async function searchChildren(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const query = await op(id, (doc) => doc.loro.getMap('query').toJSON());
  // Tana's own client always writes every query key when it creates a search (arrays default to `[]`), so a real
  // saved search never reads back as an empty map. An empty result here means the container was missing or
  // unreadable, not that the user saved an unconstrained search — and searchQueryParams({}) would otherwise fall
  // back to "every listable kind", silently showing the wrong rows as if they were this search's results.
  if (!query || !Object.keys(query).length) throw new Error('this saved search has no readable query');
  const { nodes } = await S.client.graph.listNodes(searchQueryParams(query, S.me && S.me.userUri, 200));
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n)));
}
// What a meeting carries besides its notes (verified read-only on a real meeting, docs/MEETINGS.md):
//   summary / tagline  the event's own AI summary, on the graph node
//   pinned             EDGE_TYPE_HAS_PIN edges from the event to documents and chats
//   outcomes           documents owned by the event that carry a task state
//   notes              documents owned by the event without a state (the meeting write-up)
// Generic on purpose: any node with pins or owned documents answers the same way.
// Fields are graph-node attributes keyed "<type uri>?attribute=<key>"; the label lives in that type's
// typeDef.attributes. Values carry text, listItems and references (verified on a real typed node).
// Field names come from the type document's template.attributes; the graph's typeDef is not always readable.
async function attributeTitles(typeUri) {
  if (typeAttrTitles.has(typeUri)) return typeAttrTitles.get(typeUri);
  // A failed lookup is not an answer: caching it would blank this type's field labels for the rest of the S.session.
  try { const titles = fields.templateTitles(await S.client.sync.subscribe(typeUri)); typeAttrTitles.set(typeUri, titles); return titles; }
  catch { return {}; }
}
// A document's own fields, values included, from its data map (the same place an edit writes to).
async function fieldsOf(id) {
  let document;
  try { document = await S.client.sync.subscribe(id); } catch { return []; }
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
async function summaryUri(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (idKind(id) !== 'event') return null;
  if (summaryCache.has(id)) return summaryCache.get(id);
  const [{ nodes: selfNodes = [] }, { nodes: owned = [] }] = await Promise.all([
    S.client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({ nodes: [] })),
    S.client.graph.listNodes({ ownerIds: [id], limit: 200 }).catch(() => ({ nodes: [] })),
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
  if (!S.client) throw new Error(NOT_CONNECTED);
  // The meeting event is the hub: opening its notes document should still show the meeting's pins and outcomes.
  const [self0] = (await S.client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({ nodes: [] }))).nodes || [];
  const hub = idKind(id) === 'event' ? id : (self0 && typeof self0.ownerUri === 'string' && idKind(self0.ownerUri) === 'event' ? self0.ownerUri : id);
  const [edges, owned, self] = await Promise.all([
    S.client.graph.listEdges({ fromNodeIds: [hub], edgeTypes: ['EDGE_TYPE_HAS_PIN'] }).catch(() => ({ edges: [] })),
    S.client.graph.listNodes({ ownerIds: [hub], limit: 200, sortOptions: [{ field: 'SORT_FIELD_CREATE_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] }).catch(() => ({ nodes: [] })),
    hub === id ? Promise.resolve({ nodes: self0 ? [self0] : [] }) : S.client.graph.listNodes({ nodeIds: [hub], limit: 1 }).catch(() => ({ nodes: [] })),
  ]);
  // HAS_PIN is derived server-side from the hub's own pinnedItems, so read that list too: a pin this app just wrote
  // is in the document before the edge exists, and the hub says whether a new one may be added at all.
  const hubDoc = PIN_HUBS.has(idKind(hub)) ? await S.client.sync.subscribe(hub).catch(() => null) : null;
  const canPin = hubDoc ? await canWriteDoc(hubDoc).catch(() => false) : false;
  const pinIds = [...new Set([...(hubDoc ? pins.items(hubDoc).map((p) => p.uri) : []), ...(edges.edges || []).map((e) => e.toNodeId).filter(Boolean)])];
  const pinned = pinIds.length ? (await S.client.graph.listNodes({ nodeIds: pinIds, limit: pinIds.length })).nodes : [];
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

module.exports = { crumbIcon, pathOf, spaceChildren, searchChildren, attributeTitles, fieldsOf, writeUpOf, summaryUri, callOf, related };
