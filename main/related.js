'use strict';
const fields = require('../sdk/fields');
const pins = require('../sdk/pins');
const { completedInWindow, filterToSearchQuery, searchQueryParams, validViewFilter } = require('../sdk/query');
const { LIVE_ROWS, NOT_CONNECTED, PIN_HUBS, PLAIN_KINDS, S, idKind, isSpace, summaryCache, typeAttrTitles, typeTitles } = require('./state');
const { graphRow, rememberNodeHue, resolveTypes, toNode } = require('./rows');
const { canWriteDoc, op, resolveReferences, subscribe } = require('./documents');

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
  // The completed window is the app's own setting, so it lives in the `view` map beside the sort and the grouping
  // rather than in Tana's query vocabulary — read together, in one pass over the document.
  const { query, view } = await op(id, (doc) => ({ query: doc.loro.getMap('query').toJSON(), view: doc.loro.getMap('view').toJSON() || {} }));
  // Tana's own client always writes every query key when it creates a search (arrays default to `[]`), so a real
  // saved search never reads back as an empty map. An empty result here means the container was missing or
  // unreadable, not that the user saved an unconstrained search — and searchQueryParams({}) would otherwise fall
  // back to "every listable kind", silently showing the wrong rows as if they were this search's results.
  if (!query || !Object.keys(query).length) throw new Error('this saved search has no readable query');
  const answered = await S.client.graph.listNodes(searchQueryParams(query, S.me && S.me.userUri, 200));
  const nodes = answered.nodes.filter((n) => completedInWindow(n, view.completedWithin));
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  // A view keeps the head of its list live (views.js), which is what makes a change someone else makes show up in
  // it. These rows are listed the same way and were not subscribed at all, so a saved search only ever showed what
  // its query answered when the page opened. The same cap applies here, and for the same reason: a search answers
  // up to 200 rows, and these subscriptions are never swept. sync.subscribe is idempotent, and these ids stay out
  // of `subscribed` — that set belongs to the view refresh, which unsubscribes what the active view no longer lists.
  // ponytail: they stay subscribed for the rest of the session, like every other on-demand subscription.
  nodes.slice(0, LIVE_ROWS).forEach((n) => subscribe(n.id));
  return nodes.map((n) => toNode(graphRow(n)));
}
// The rows a filter would find, without storing it: what a saved search shows while its pills are being edited.
// It asks the graph exactly what Save would store — filterToSearchQuery, then the same searchQueryParams the stored
// query goes through — so the preview and the saved result cannot disagree. Saving is then only a write, never a
// second answer to the same question. The untouched page still reads its stored query through searchChildren, which
// keeps the parts of a Tana-authored query the filter vocabulary cannot express.
async function searchPreview(filter) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (!validViewFilter(filter)) throw new Error('invalid view filter');
  const answered = await S.client.graph.listNodes(searchQueryParams(filterToSearchQuery(filter, S.me && S.me.userUri), S.me && S.me.userUri, 200));
  const nodes = answered.nodes.filter((n) => completedInWindow(n, filter.completedWithin)); // as the saved page will show it
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
// A document's fields: every field its type defines, empty or not, so one can be filled in — then any value it
// carries under another type (a type it used to have). Values come from its data map, the same place an edit writes.
async function fieldsOf(id) {
  let document;
  try { document = await S.client.sync.subscribe(id); } catch { return []; }
  const rows = fields.readFields(document);
  const typeUri = document.data.get('entityTypeUri');
  const out = [];
  if (typeUri) {
    const titles = await attributeTitles(typeUri);
    for (const [attribute, label] of Object.entries(titles)) {
      const key = typeUri + '?attribute=' + attribute, row = rows.find((r) => r.key === key);
      out.push({ key, label, text: row ? row.text : '', lines: row ? row.lines : [] });
    }
  }
  for (const row of rows) {
    if (out.some((f) => f.key === row.key)) continue;
    const titles = row.attribute ? await attributeTitles(row.typeUri) : {};
    out.push({ key: row.key, label: (row.attribute && titles[row.attribute]) || undefined, text: row.text, lines: row.lines });
  }
  // the segments beside the text, with every reference in them resolved (icon, colour, gone) the way a line's are
  for (const f of out) { const row = rows.find((r) => r.key === f.key); f.segments = row ? row.segments : []; }
  // every line, not only the first: the page draws them all, and segments is the first line's own array, so it is
  // resolved with them rather than twice
  try { await resolveReferences(out.flatMap((f) => (f.lines && f.lines.length ? f.lines.map((line) => ({ segments: line.segments })) : [{ segments: f.segments }]))); } catch { /* a reference stays a bare link */ }
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

// The fallback history, from the graph node alone, used when the change-summary service has nothing to say.
// It costs no extra request: `editors` is a map of user-profile uri -> { peerUserHash, editTime } (that person's
// last edit), `createTime`/`createdBy` say who made it, and `archivedAt` when it was deleted. That is the whole
// vocabulary the graph keeps — no per-edit log, no actor for a deletion, nothing about what changed — so an entry
// carries only what is there and the renderer leaves out what is missing. `updateTime` stands in for an update
// nobody is named for, and only when the node lists no editors at all, so it can never double-count one.
// newest first; an entry with no time of its own (or an unreadable one) cannot claim a place among the dated ones,
// so it goes last. Both histories sort this way, so neither depends on the order it was handed.
const changeTime = (c) => { const t = c && c.at ? Date.parse(c.at) : NaN; return Number.isNaN(t) ? -Infinity : t; };
const byNewest = (a, b) => (changeTime(a) === changeTime(b) ? 0 : changeTime(b) > changeTime(a) ? 1 : -1);

function changesOf(node) {
  const n = node || {};
  const iso = (t) => (typeof t === 'string' && t ? t : undefined);
  const out = [];
  for (const [uri, editor] of Object.entries(n.editors || {})) out.push({ action: 'Updated', by: uri, at: iso(editor && editor.editTime) });
  if (!out.length && iso(n.updateTime) && n.updateTime !== n.createTime) out.push({ action: 'Updated', at: iso(n.updateTime) });
  if (iso(n.createTime) || iso(n.createdBy)) out.push({ action: 'Created', by: iso(n.createdBy), at: iso(n.createTime) });
  if (iso(n.archivedAt)) out.push({ action: 'Deleted', at: iso(n.archivedAt) });
  return out.sort(byNewest);
}

// What Tana's own Changes panel shows: written summaries from tana.history.v1alpha1.ChangeSummaryService, which
// names each window of edits ("Added dependency on Finish reply document for Works Council") rather than leaving
// the row to repeat the node's title. The service's own order is not relied on — it has answered both ways — so
// the list is sorted by when each window closed, newest on top; the enum default (UPDATED = 0) is omitted from
// protobuf JSON, which is why a missing changeType reads as an update.
// Several people can share one summary: the first is named and the rest are counted, never dropped silently.
const SUMMARY_ACTION = { CHANGE_SUMMARY_TYPE_CREATED: 'Created', CHANGE_SUMMARY_TYPE_DELETED: 'Deleted', CHANGE_SUMMARY_TYPE_UPDATED: 'Updated' };
function summaryChanges(summaries) {
  const iso = (t) => (typeof t === 'string' && t ? t : undefined);
  return (summaries || []).map((s) => {
    const authors = (s.authors || []).filter((a) => typeof a === 'string' && a);
    return {
      action: SUMMARY_ACTION[s.changeType] || 'Updated',
      by: authors[0],
      others: authors.length > 1 ? authors.length - 1 : undefined,
      at: iso(s.endTime) || iso(s.startTime),
      title: (typeof s.title === 'string' && s.title.trim()) || undefined,
      note: (typeof s.description === 'string' && s.description.trim()) || undefined,
    };
  }).sort(byNewest);
}
// The node's history for the sidebar: the written summaries when the service answers, the graph node's own
// editors/creation when it does not (an older server, a node it knows nothing about, or a refusal). A history
// failure must not cost the sidebar its other sections, so it is caught here rather than left to the caller.
async function historyOf(id, node) {
  if (S.client.history) {
    try {
      const { summaries } = await S.client.history.listChanges({ uri: id, limit: 20 });
      const changes = summaryChanges(summaries);
      if (changes.length) return changes;
    } catch { /* fall back to what the node itself says */ }
  }
  return changesOf(node);
}

// Backlinks, grouped the way Tana's own Backlinks panel groups them (read out of their web bundle, 2026-09-20):
// an incoming EDGE_TYPE_LINKS_TO edge is a mention in someone's text and lands under "Mentioned in"; an incoming
// EDGE_TYPE_ATTRIBUTE_LINKS_TO edge is this node sitting in a typed field and carries that field in
// `properties.attributeUri` ("tana:type:<id>?attribute=<key>"), so it lands under "<Type> › <Field>". Tana lists the
// field groups first and "Mentioned in" last, which is the order kept here. A field whose title cannot be read is
// not guessed at: that edge joins the mentions rather than inventing a section name.
const MENTIONED_IN = 'Mentioned in';
async function backlinkLabel(attributeUri) {
  const { typeUri, attribute } = fields.parseKey(attributeUri || '');
  if (!attribute || !typeUri) return MENTIONED_IN;
  const title = (await attributeTitles(typeUri))[attribute];
  if (!title) return MENTIONED_IN;
  const type = typeTitles.get(typeUri);
  return type ? type + ' › ' + title : title;
}
// [{ label, rows }] for the sidebar: one group per field, mentions last, each document listed once per group.
async function backlinkGroups(edges, node, row) {
  const groups = new Map();
  for (const edge of edges) {
    const target = node(edge.fromNodeId);
    if (!target) continue;
    const label = await backlinkLabel(edge.properties && edge.properties.attributeUri);
    if (!groups.has(label)) groups.set(label, new Map());
    groups.get(label).set(target.id, target);
  }
  const mentions = groups.get(MENTIONED_IN);
  groups.delete(MENTIONED_IN);
  if (mentions) groups.set(MENTIONED_IN, mentions);
  return [...groups].map(([label, targets]) => ({ label, rows: [...targets.values()].map(row) }));
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
  // Backlinks are the zoomed node's own, not the meeting hub's: a document created in a meeting is not mentioned by
  // whatever mentions the meeting. A mention is an incoming LINKS_TO edge (verified read-only on a real node: one per
  // mentioning document, carrying the label and the block ids); a field reference is an incoming ATTRIBUTE_LINKS_TO
  // edge, the pair Tana's own client names "@ mentions and inline references" and "field-level references".
  const mentions = await S.client.graph.listEdges({ toNodeIds: [id], edgeTypes: ['EDGE_TYPE_LINKS_TO', 'EDGE_TYPE_ATTRIBUTE_LINKS_TO'] }).catch(() => ({ edges: [] }));
  const mentionEdges = (mentions.edges || []).filter((e) => e.fromNodeId && e.fromNodeId !== id);
  const mentionIds = [...new Set(mentionEdges.map((e) => e.fromNodeId))];
  // HAS_PIN is derived server-side from the hub's own pinnedItems, so read that list too: a pin this app just wrote
  // is in the document before the edge exists, and the hub says whether a new one may be added at all.
  const hubDoc = PIN_HUBS.has(idKind(hub)) ? await S.client.sync.subscribe(hub).catch(() => null) : null;
  const canPin = hubDoc ? await canWriteDoc(hubDoc).catch(() => false) : false;
  const pinIds = [...new Set([...(hubDoc ? pins.items(hubDoc).map((p) => p.uri) : []), ...(edges.edges || []).map((e) => e.toNodeId).filter(Boolean)])];
  const list = (ids) => (ids.length ? S.client.graph.listNodes({ nodeIds: ids, limit: ids.length }).then((r) => r.nodes) : Promise.resolve([]));
  const [pinned, mentioned] = await Promise.all([list(pinIds), list(mentionIds)]);
  const all = [...pinned, ...mentioned, ...(owned.nodes || [])];
  all.forEach(rememberNodeHue);
  // the types of the listed nodes, and the types the field references come from: both are title lookups, one call
  await resolveTypes([...all.map((n) => n.entityType), ...mentionEdges.map((e) => fields.parseKey((e.properties && e.properties.attributeUri) || '').typeUri)]);
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
    // an untitled draft mentions nothing worth listing, and a document already shown as a pin is not listed twice
    backlinks: await backlinkGroups(mentionEdges, (uri) => mentioned.find((n) => n.id === uri && (n.title || '').trim() && !pinnedIds.has(n.id)), row),
    changes: await historyOf(id, self0), // the zoomed node's own history: written summaries, else the node's own record
  };
}

module.exports = { crumbIcon, pathOf, spaceChildren, searchChildren, searchPreview, attributeTitles, fieldsOf, writeUpOf, summaryUri, callOf, changesOf, summaryChanges, historyOf, backlinkGroups, related };
