'use strict';
const fields = require('../sdk/fields');
const pins = require('../sdk/pins');
const { dateUri, isDateUri } = require('../sdk/dates');
const { openEdgeQuery, openLiveQuery, EDGE_TYPES } = require('../sdk/livequery');
const { completedInWindow, filterToSearchQuery, liveTrigger, searchQueryParams, validViewFilter } = require('../sdk/query');
const { everyoneOnly } = require('../sdk/access');
const { readSearch } = require('../sdk/node');
const { callOf, writeUpOf } = require('../sdk/events');
const { DOC_URI, LIVE_ROWS, NOT_CONNECTED, PIN_HUBS, PLAIN_KINDS, S, idKind, isSpace, send, summaryCache, typeAttrTitles, typeTitles } = require('./state');
const { graphRow, rememberNodeHue, resolveTypes, toNode } = require('./rows');
const { canWriteDoc, op, readOnDemand, resolveReferences, subscribe } = require('./documents');
const { rows: proposalRows } = require('./proposals');

// A space's "content" is the documents it owns (graph query), returned as document Nodes.
async function spaceChildren(id) {
  if (!S.client) throw new Error(NOT_CONNECTED); // a space opened before the connection is a startup state, not an error (#97)
  const { nodes } = await S.client.graph.listNodes({ ownerIds: [id], limit: 200, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n)));
}
// A saved search's "content" is the rows its stored query returns (sdk/node.js readSearch).
// Both per page (the key watchRelated uses: the renderer that asked), since two windows showing one search each hold
// the rows their own newest read installed (renderer/nodes.js), and each window's head has to stay live.
const searchReads = new Map(); // "<page>\n<search id>" -> the number the last read of it was given
const headRead = new Map(); // "<page>\n<search id>" -> the number of the read its head came from
async function searchChildren(id, page = 'main') {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const read = page + '\n' + id, seq = (searchReads.get(read) || 0) + 1;
  searchReads.set(read, seq);
  // The completed window is the app's own setting, so it lives in the `view` map beside the sort and the grouping
  // rather than in Tana's query vocabulary — read together, in one pass over the document.
  const { query, view } = await op(id, readSearch);
  // Tana's own client always writes every query key when it creates a search (arrays default to `[]`), so a real
  // saved search never reads back as an empty map. An empty result here means the container was missing or
  // unreadable, not that the user saved an unconstrained search — and searchQueryParams({}) would otherwise fall
  // back to "every listable kind", silently showing the wrong rows as if they were this search's results.
  if (!query || !Object.keys(query).length) throw new Error('this saved search has no readable query');
  const nodes = await searchRows(query, view, 1000); // a view's 1,000, as its preview asks: My Tasks lists every task and groups afterwards
  // A view keeps the head of its list live (views.js), which is what makes a change someone else makes show up in
  // it. These rows are listed the same way and were not subscribed at all, so a saved search only ever showed what
  // its query answered when the page opened. The same cap applies here, and for the same reason: a search answers
  // up to 1,000 rows, the first LIVE_ROWS of them subscribed. They are reads like any other (main/documents.js
  // releaseOnDemand), held while the search's page is on screen (withSearchHeads) and let go oldest first after that.
  // The newest read that answered decides the head: one from before a Save that lands after it would put the old rows
  // back in the head and let the sweep release the ones on screen (the renderer drops its rows the same way,
  // renderer/nodes.js). A newer read that failed decides nothing, so an older one that answered still keeps its rows live.
  // And only for what the search asks now: an older read that answered after a Save asked what came before. That is
  // the query and the two view settings searchRows narrows the answer by (completed window, audience).
  const asks = (q, v) => JSON.stringify([q, (v || {}).completedWithin, (v || {}).audience]);
  const same = await op(id, readSearch).then((now) => asks(now.query, now.view) === asks(query, view), () => false);
  if (same && seq > (headRead.get(read) || 0)) {
    headRead.set(read, seq);
    const head = nodes.slice(0, LIVE_ROWS).map((n) => n.id);
    if (!searchHeads.has(id)) searchHeads.set(id, new Map());
    searchHeads.get(id).set(page, head);
    for (const uri of head) subscribe(uri).then((doc) => { if (doc) readOnDemand(uri); });
  }
  return nodes.map((n) => toNode(graphRow(n)));
}
const searchHeads = new Map(); // saved search id -> page -> the ids of the head that page keeps live
// The documents on screen, and the head of any saved search among them: its page's rows stay live while it is shown.
const withSearchHeads = (ids) => [...ids, ...ids.flatMap((id) => [...(searchHeads.get(id) || new Map()).values()].flat())];
// A page that closed holds no head (main.js removePane). One that only moved on keeps its last one, which counts only
// while another page shows that search, and is replaced when it opens the search again.
const dropSearchHeads = (page) => {
  for (const heads of searchHeads.values()) heads.delete(page);
  // and a read it still has out keeps no head when it answers: page ids are never reused, so the mark stays
  for (const read of searchReads.keys()) if (read.startsWith(page + '\n')) headRead.set(read, Infinity);
};
// The rows a filter would find, without storing it: what a saved search shows while its pills are being edited.
// It asks the graph exactly what Save would store — filterToSearchQuery, then the same searchQueryParams the stored
// query goes through — so the preview and the saved result cannot disagree. Saving is then only a write, never a
// second answer to the same question. The untouched page still reads its stored query through searchChildren, which
// keeps the parts of a Tana-authored query the filter vocabulary cannot express.
async function searchPreview(filter) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (!validViewFilter(filter)) throw new Error('invalid view filter');
  // A type page is this too (renderer/nodes.js reload), a whole list rather than a preview: it gets a view's 1000 rows.
  const nodes = await searchRows(filterToSearchQuery(filter, S.me && S.me.userUri), filter, 1000); // as the saved page will show it
  return nodes.map((n) => toNode(graphRow(n)));
}
// The one runner behind both: a stored query's rows, completed ones outside the window dropped. A search scoped to a
// space also covers every space beneath it, as in Tana (searchOwners), so the org's spaces are listed first — only
// when a space is in scope, which leaves every other search at one graph call.
// ponytail: spaces are listed on each run, not cached; cache them when a scoped search's latency shows.
// `narrow` is what Orbital keeps beside Tana's query and applies to its answer: { completedWithin, audience }.
async function searchRows(query, narrow, limit = 200) {
  const scoped = Array.isArray(query.ownerUris) && query.ownerUris.some((u) => typeof u === 'string' && isSpace(u));
  const spaces = scoped ? (await S.client.graph.listNodes({ nodeTypes: ['space'], limit: 1000 })).nodes : [];
  const answered = await S.client.graph.listNodes(searchQueryParams(query, S.me && S.me.userUri, limit, undefined, spaces));
  let nodes = answered.nodes.filter((n) => completedInWindow(n, narrow.completedWithin));
  if (narrow.audience === 'everyone') nodes = await everyoneOnly(S.client.graph, nodes);
  nodes.forEach(rememberNodeHue);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes;
}
// What a meeting carries besides its notes (verified read-only on a real meeting, docs/MEETINGS.md):
//   summary / tagline  the event's own AI summary, on the graph node
//   pinned             EDGE_TYPE_HAS_PIN edges from the event to documents and chats
//   outcomes           documents owned by the event that carry a task state
//   notes              documents owned by the event without a state (the meeting write-up)
//   proposals          pending proposals from chats owned by the event, shown on its write-up only (issue #106)
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
// A type's field definitions as its document holds them now ({ key, title, type?, cardinality?, options?, to? }), each
// link target named after its type. The kind is what decides how a value is edited (issue #33), so it is read fresh
// rather than cached with the titles: the subscribed type document is live.
async function fieldDefs(typeUri) {
  let defs;
  try { defs = fields.definitions(await S.client.sync.subscribe(typeUri)); } catch { return []; }
  defs = defs.filter((d) => d && d.key);
  await resolveTypes(defs.flatMap((d) => (d.to || []).map((t) => t.uri)));
  return defs.map((d) => (d.to ? { ...d, to: d.to.map((t) => ({ ...t, name: typeTitles.get(t.uri) || t.title || '' })) } : d));
}
// A document's fields: every field its type defines, empty or not, so one can be filled in — then any value it
// carries under another type (a type it used to have). Values come from its data map, the same place an edit writes.
// A field of its type carries its kind too: { type, cardinality, options, to }, as fieldDefs reads them.
async function fieldsOf(id) {
  let document;
  try { document = await S.client.sync.subscribe(id); readOnDemand(id); } catch { return []; } // a read: let go past LIVE_ROWS like any other (#395)
  const rows = fields.readFields(document);
  const typeUri = document.data.get('entityTypeUri');
  const out = [];
  if (typeUri) {
    for (const def of await fieldDefs(typeUri)) {
      const key = typeUri + '?attribute=' + def.key, row = rows.find((r) => r.key === key);
      out.push({ key, label: def.title || def.key, text: row ? row.text : '', lines: row ? row.lines : [], type: def.type, cardinality: def.cardinality, options: def.options, to: def.to });
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
// The write-up rule is sdk/events.js writeUpOf; one place, both related() and the navigation redirect use it.
// A write-up can be moved out of its meeting into a space, and the meeting then owns it no longer (live 2026-09-26,
// "Datadog & Nedap - executive alignment"). The tagline still names it, so with nothing owned it is looked up by that
// exact title; only by that: any document can carry a sketch, so the sketch rule stays with what the meeting owns.
async function writeUpFor(event, owned) {
  const found = writeUpOf(event, owned), tagline = event && event.calendarEvent && event.calendarEvent.tagline;
  if (found || !tagline || !S.client) return found;
  const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['text'], textQuery: tagline, limit: 20 }).catch(() => ({}));
  const named = nodes.filter((n) => n.title === tagline && !(n.state && n.state.type) && idKind(n.id) === 'text');
  return named.length === 1 ? named[0] : null; // two pages of that title (a recurring meeting, a reused name): no telling which
}
// The uri a meeting should open at, or null when it is not an event or has no write-up yet.
async function summaryUri(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  if (idKind(id) !== 'event') return null;
  if (summaryCache.has(id)) return summaryCache.get(id);
  const [{ nodes: selfNodes = [] }, { nodes: owned = [] }] = await Promise.all([
    S.client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({ nodes: [] })),
    S.client.graph.listNodes({ ownerIds: [id], limit: 200 }).catch(() => ({ nodes: [] })),
  ]);
  const found = await writeUpFor(selfNodes[0], owned);
  // Tana writes the summary after the meeting, so "no write-up yet" is a state to re-check, not an answer to cache.
  if (found) summaryCache.set(id, found.id);
  return found ? found.id : null;
}

// The fallback history, from the graph node alone, used when the change-summary service has nothing to say.
// It costs no extra request: `editors` is a map of user-profile uri -> { peerUserHash, editTime } (that person's
// last edit), `createTime`/`createdBy` say who made it, and `archivedAt` when it was archived (Tana's archive(), not its
// softDelete(): the graph has no deletion field). That is the whole vocabulary the graph keeps — no per-edit log, no
// actor for an archive, nothing about what changed — so an entry
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
  if (iso(n.archivedAt)) out.push({ action: 'Archived', at: iso(n.archivedAt) });
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
// A day page — the document todayNode keeps for a date, titled with it — answers for its date as well: whatever
// mentions that day (tana:plaindate:, sdk/dates.js) is listed with its own backlinks, the way Tana's day view lists it.
function backlinkUris(id, node) {
  const title = ((node && node.title) || '').trim();
  return isDateUri('tana:plaindate:' + title) ? [id, dateUri(title)] : [id];
}
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

// The meeting event is the hub: opening its notes document should still show the meeting's pins and outcomes.
const hubOf = (id, self) => (idKind(id) === 'event' ? id : (self && typeof self.ownerUri === 'string' && idKind(self.ownerUri) === 'event' ? self.ownerUri : id));
async function related(id) {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const [self0] = (await S.client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({ nodes: [] }))).nodes || [];
  const hub = hubOf(id, self0);
  const [edges, owned, self] = await Promise.all([
    S.client.graph.listEdges({ fromNodeIds: [hub], edgeTypes: ['EDGE_TYPE_HAS_PIN'] }).catch(() => ({ edges: [] })),
    S.client.graph.listNodes({ ownerIds: [hub], limit: 200, sortOptions: [{ field: 'SORT_FIELD_CREATE_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] }).catch(() => ({ nodes: [] })),
    hub === id ? Promise.resolve({ nodes: self0 ? [self0] : [] }) : S.client.graph.listNodes({ nodeIds: [hub], limit: 1 }).catch(() => ({ nodes: [] })),
  ]);
  // Backlinks are the zoomed node's own, not the meeting hub's: a document created in a meeting is not mentioned by
  // whatever mentions the meeting. A mention is an incoming LINKS_TO edge (verified read-only on a real node: one per
  // mentioning document, carrying the label and the block ids); a field reference is an incoming ATTRIBUTE_LINKS_TO
  // edge, the pair Tana's own client names "@ mentions and inline references" and "field-level references".
  const mentions = await S.client.graph.listEdges({ toNodeIds: backlinkUris(id, self0), edgeTypes: ['EDGE_TYPE_LINKS_TO', 'EDGE_TYPE_ATTRIBUTE_LINKS_TO'] }).catch(() => ({ edges: [] }));
  const mentionEdges = (mentions.edges || []).filter((e) => e.fromNodeId && e.fromNodeId !== id);
  const mentionIds = [...new Set(mentionEdges.map((e) => e.fromNodeId))];
  // HAS_PIN is derived server-side from the hub's own pinnedItems, so read that list too: a pin this app just wrote
  // is in the document before the edge exists, and the hub says whether a new one may be added at all.
  // a read as well: a write-up's meeting and a space are read by nothing else, and were held for the session (#395)
  const hubDoc = PIN_HUBS.has(idKind(hub)) ? await S.client.sync.subscribe(hub).then((doc) => { readOnDemand(hub); return doc; }, () => null) : null;
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
  const writeUp = await writeUpFor(event, owned.nodes || []); // one rule for the rail and for navigation
  const proposals = idKind(hub) === 'event' && writeUp && id === writeUp.id ? proposalRows(hub).catch(() => []) : Promise.resolve([]);
  const pendingProposals = await proposals;
  return {
    summary: ev.summary || undefined,
    tagline: ev.tagline || undefined,
    // The call link is the event's own: summary, pins and outcomes come from the meeting hub, but a document that
    // merely lives in or was created in the meeting does not inherit its join url, so read it off the zoomed node.
    call: callOf((self0 && self0.calendarEvent) || {}),
    summaryUri: writeUp ? writeUp.id : undefined,
    fields: await fieldsOf(id), // the zoomed node's own fields, not the meeting hub's
    definitions: idKind(id) === 'type' ? await fieldDefs(id) : undefined, // a type's page lists the fields it defines
    pinHub: canPin ? hub : undefined, // where a new pin would go, when this user may write it
    pinned: pinned.map(row),
    outcomes: owns.filter(stated).map(row),
    proposals: pendingProposals,
    notes: owns.filter((n) => !stated(n) && (!writeUp || n.id !== writeUp.id)).map(row),
    // an untitled draft mentions nothing worth listing, and a document already shown as a pin is not listed twice
    backlinks: await backlinkGroups(mentionEdges, (uri) => mentioned.find((n) => n.id === uri && (n.title || '').trim() && !pinnedIds.has(n.id)), row),
    changes: await historyOf(id, self0), // the zoomed node's own history: written summaries, else the node's own record
  };
}

// The sidebar of the page on screen, kept live (issue #21) with Tana's own edge live queries (sdk/livequery.js): the
// edges into the page that its backlink sections are made of (LINKS_TO + ATTRIBUTE_LINKS_TO, as Tana's "Mentioned in"
// asks), and, when the page lives in a meeting or a space, the hub's HAS_PIN edges its Pinned section lists (as Tana's
// EventPins asks). An edge added or taken away says 'related:changed' for the page, and the renderer reads related()
// again. Only for one page at a time, like the presence room: a new page, or none, closes the last one's queries.
// The first answer says nothing — related() has just read the same edges — and neither does a changed edge: a mention's
// properties move with every edit of the text around it, and no section is drawn from them.
// One per window (issue #137): each window's page keeps its own sidebar live, keyed by the window's webContents id.
const watching = new Map(); // window -> { id, client, ready: Promise<boolean>, handles: Promise<[handle|null]> }
// The saved search's live query, rebuilt whenever the query stored on the search document changes: a Save that widens
// the search while it is open must widen what wakes it too (PR #152 review). The first answer counts as well: a
// query that matches nothing stays pending rather than answering empty (live 2026-09-25), so when a search's scope
// starts empty its first row arrives as the initial answer. That costs one re-read just after opening a search that
// has rows; the answers after it come only when something moved.
async function searchTrigger(id, w, key) {
  const doc = await w.client.sync.subscribe(id); // the page's own document, already open: this only takes a handle
  let asked = null, live = null;
  const reread = () => { if (watching.get(key) === w) send('outline:changed', id); };
  const follow = async () => {
    const { query } = readSearch(doc), json = JSON.stringify(query || {});
    if (json === asked) return; // a change to the title, the sort or the grouping: the same question
    asked = json;
    if (live) { live.close().catch(() => {}); live = null; }
    if (!query || !Object.keys(query).length) return;
    const next = await openLiveQuery(w.client.sync, liveTrigger(searchQueryParams(query, S.me && S.me.userUri)), { label: 'Orbital saved search', onRows: reread });
    next.on('error', () => {}); // a refused query leaves the page as it was: it still re-reads on opening and on Refresh
    if (asked !== json) return next.close().catch(() => {}); // superseded while it opened, or closed
    live = next;
  };
  const changed = () => { follow().catch(() => {}); };
  await follow();
  doc.on('change', changed);
  return { close: () => { doc.off('change', changed); asked = '#closed'; return live ? live.close() : Promise.resolve(); } };
}
function unwatchRelated(key = 'main') {
  const w = watching.get(key);
  watching.delete(key);
  if (w) w.handles.then((hs) => hs.forEach((h) => h && h.close().catch(() => {})));
}
function watchRelated(id, key = 'main') {
  const current = watching.get(key);
  if (current && current.id === id && current.client === S.client) return current.ready;
  unwatchRelated(key);
  if (!S.client || !DOC_URI.test(id || '')) return Promise.resolve(false);
  const w = { id, client: S.client };
  watching.set(key, w);
  const moved = ({ added, removed, initial }) => { if (!initial && (added.length || removed.length) && watching.get(key) === w) send('related:changed', id); };
  const open = (query, label) => openEdgeQuery(w.client.sync, query, { label }).then((h) => { h.on('rows', moved); return h; });
  const self = w.client.graph.listNodes({ nodeIds: [id], limit: 1 }).then(({ nodes = [] }) => nodes[0]);
  const openBacklinks = (node) => open({ object: { uris: backlinkUris(id, node) }, predicate: { edgeTypes: [EDGE_TYPES.LINKS_TO, EDGE_TYPES.ATTRIBUTE_LINKS_TO] } }, 'Orbital sidebar backlinks');
  const backlinks = self.then(openBacklinks, () => openBacklinks(undefined));
  const pinned = self.then((node) => {
    const hub = hubOf(id, node);
    return PIN_HUBS.has(idKind(hub)) ? open({ subject: { uris: [hub] }, predicate: { edgeTypes: [EDGE_TYPES.HAS_PIN] } }, 'Orbital sidebar pins') : null;
  });
  // A saved search on screen is kept current the way Tana keeps its own lists (#148): a live query over what the
  // search can list, and every answer it pushes re-reads the page through searchChildren, which stays the one that
  // decides the rows. Without it the page only knew what its query answered when it was opened.
  // ponytail: scoped by the query stored when the page opened; a Save while it is open narrows the rows, not this.
  // A type's page is the list of its instances (renderer/render.js), kept current the same way.
  const search = idKind(id) === 'search' ? searchTrigger(id, w, key)
    // watching as many rows as the page shows (searchPreview), so a change or deletion anywhere in it is heard
    // ponytail: the newest 1,000 of the type, unfiltered; a type past that with a field filter on can miss a change to
    // an older matching row until the page is reopened. Watch the filtered query instead if a type ever gets that big.
    : idKind(id) === 'type' ? openLiveQuery(w.client.sync, { ...liveTrigger(searchQueryParams({ entityTypeUris: [id] }, S.me && S.me.userUri)), limit: 1000 }, { label: 'Orbital type page', onRows: () => { if (watching.get(key) === w) send('outline:changed', id); } })
      .then((h) => { h.on('error', () => {}); return h; }) : null;
  // each on its own: one that fails must not leave the others open and unclosable
  w.handles = Promise.all([backlinks, pinned, search].map((p) => p && p.catch(() => null)));
  w.ready = backlinks.then(() => true, () => { if (watching.get(key) === w) unwatchRelated(key); return false; }); // refused: asked again at the next render
  return w.ready;
}

const watchedPages = () => [...watching.values()].map((w) => w.id); // each page's document, whose sidebar is on screen
// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  'doc:related': (_e, id) => related(id), // { summary, tagline, pinned[], outcomes[], proposals[], notes[], backlinks[] }
  'doc:watchRelated': (e, id) => watchRelated(id, e && e.sender ? e.sender.id : 'main'), // the page on screen (null: none): its sidebar's edges pushed as 'related:changed'
  'doc:summaryUri': (_e, id) => summaryUri(id), // where a meeting should actually open, or null
  // what the pills would find if they were saved: a staged edit has to change the rows, or the pills read as broken
  'search:preview': (_e, filter) => searchPreview(filter),
};

module.exports = { spaceChildren, searchChildren, searchPreview, attributeTitles, fieldsOf, summaryUri, changesOf, summaryChanges, historyOf, backlinkGroups, related, watchRelated, unwatchRelated, watchedPages, withSearchHeads, dropSearchHeads, ipc };
