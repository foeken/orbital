'use strict';
// Live queries: a query the server runs and keeps running. Tana's own client lists things this way
// (NodeQueryResource in home.tana.inc/assets/shared-*.js): it creates a throwaway `tana:liveQuery:<ulid>` document
// holding the query, subscribes it as ephemeral, and the server writes the answer into it and rewrites it whenever the
// answer changes, as ordinary live updates on the sync stream already open. No polling, no per-node subscriptions.
//
//   data = { type: 'liveQuery', queryType: 'nodes', label, query, queryVersion, state: pending|ready|error,
//            resultForVersion, result: { nodes: [row] }, error?: { message, code } }
//   row  = { uri, type, title, entityType, createdAt, updatedAt, ownerUri, state: { type, enteredAt, changedBy },
//            assignedTo, participants, calendarEvent, archivedAt, … }   (times are epoch ms)
//
// The result is stale while resultForVersion < queryVersion, and pending while it is 0: the rule Tana's client uses.
//
// Edge queries (EdgeQueryResource) are the same document with queryType 'edges': who links to what, pushed the same way.
//   query = { subject?: side, predicate?: { edgeTypes: [number] }, object?: side }   side = SIDE_LISTS + SIDE_SCALARS
//   result = { edges: [{ fromNode, toNode, type, properties? }] }                  (properties.attributeUri: a field reference)
// Tana's page Backlinks section asks { object: { uris: [page] } }, its calendar "Mentioned in" adds
// predicate { edgeTypes: [LINKS_TO, ATTRIBUTE_LINKS_TO] }, and its event pins ask { subject: { uris }, predicate: [HAS_PIN] }.
const { EventEmitter } = require('node:events');
const { LoroMap, LoroList } = require('loro-crdt');
const { ulid } = require('./node');
const { files } = require('./proto/descriptors');

// Every list the query map carries, written empty when not given, as Tana's client does (NodeQueryResource #b).
const LISTS = ['uris', 'types', 'ownerUris', 'entityTypeUris', 'stateTypes', 'chatInvocationIntents', 'stateChangedBy', 'stateWorkflowUris',
  'stateWorkflowStateIds', 'assignedTo', 'createdBy', 'recurrenceIds', 'occurrenceKeys', 'orderBy', 'exactParticipantUris', 'hasParticipantUris', 'useFields'];
// Scalars, passed through when given. Times are epoch ms; orderBy entries are field names, '-' for descending.
const SCALARS = ['stateEnteredAtMin', 'stateEnteredAtMax', 'createdAtMin', 'createdAtMax', 'eventStartTimeMin', 'eventStartTimeMax', 'eventEndTimeMin',
  'eventEndTimeMax', 'unassigned', 'limit', 'includeProposals', 'includeArchived', 'archivedOnly', 'modifiedByUserHash', 'uniqueByParticipants', 'restricted', 'linkShared'];

function checkQuery(query) {
  for (const key of Object.keys(query)) if (!LISTS.includes(key) && !SCALARS.includes(key)) throw new Error('unsupported live query field ' + key);
}
function writeQuery(q, query) {
  for (const key of LISTS) {
    const list = q.setContainer(key, new LoroList());
    for (const value of query[key] || []) list.push(value);
  }
  for (const key of SCALARS) if (query[key] !== undefined) q.set(key, query[key]);
  // ponytail: externalIds and attributeFilters are always empty; write their nested maps when a caller needs one
  q.setContainer('externalIds', new LoroMap());
  q.setContainer('attributeFilters', new LoroMap());
}

function statusOf(data) {
  if (data.state === 'error') return 'error';
  if (!data.resultForVersion) return 'pending';
  return data.resultForVersion < data.queryVersion ? 'stale' : 'ready';
}
// What a row is for "did it change": the parts a trigger or a list redraw cares about. updatedAt and the owner too:
// a query used as a trigger (sdk/query.js liveTrigger) cannot say everything its list filters on, so an edit that
// moves a row in or out of the list may change nothing else the row carries (PR #152 review).
const rowSig = (row) => JSON.stringify([row.title, row.state && row.state.type, row.state && row.state.enteredAt, row.entityType, row.assignedTo, row.archivedAt, row.updatedAt, row.ownerUri]);

// The edge types Tana's client knows, by name (LINKS_TO: 1, … COMMENTS_ON: 18): the graph descriptor's EdgeType enum,
// which is the one Tana's client uses too, so a re-extracted descriptor brings new ones along. An edge query names them by number.
const EDGE_TYPES = Object.fromEntries(files.graph.enums.find((e) => e.name === 'EdgeType').values
  .filter((v) => v.number).map((v) => [v.localName, v.number]));
// One side of an edge (subject: where it starts, object: where it ends), EdgeQueryResource #g.
const SIDE_LISTS = ['uris', 'types', 'ownerUris', 'entityTypeUris', 'stateTypes', 'stateChangedBy', 'stateWorkflowUris', 'stateWorkflowStateIds', 'assignedTo'];
const SIDE_SCALARS = ['stateEnteredAtMin', 'stateEnteredAtMax'];
function checkEdgeQuery(query) {
  const lists = [];
  for (const key of Object.keys(query)) {
    if (key === 'predicate') {
      for (const k of Object.keys(query.predicate || {})) if (k !== 'edgeTypes') throw new Error('unsupported edge query field predicate.' + k);
      const types = query.predicate && query.predicate.edgeTypes;
      if (types && !types.every(Number.isInteger)) throw new Error('edgeTypes are numbers (EDGE_TYPES)');
      if (types) lists.push(types);
    } else if (key === 'subject' || key === 'object') {
      for (const k of Object.keys(query[key] || {})) {
        if (!SIDE_LISTS.includes(k) && !SIDE_SCALARS.includes(k)) throw new Error('unsupported edge query field ' + key + '.' + k);
        if (SIDE_LISTS.includes(k)) lists.push(query[key][k]);
      }
    } else throw new Error('unsupported edge query field ' + key);
  }
  // Tana never sends one whose every list is empty: it answers "no edges" itself (the empty-edge-query resource)
  if (!lists.some((list) => list && list.length)) throw new Error('an edge query needs a uri, a type or an edge type to match');
}
function writeEdgeQuery(q, query) {
  for (const side of ['subject', 'object']) {
    if (!query[side]) continue; // an absent side is left out, as Tana's client leaves it
    const map = q.setContainer(side, new LoroMap());
    for (const key of SIDE_LISTS) { const list = map.setContainer(key, new LoroList()); for (const value of query[side][key] || []) list.push(value); }
    for (const key of SIDE_SCALARS) if (query[side][key] !== undefined) map.set(key, query[side][key]);
  }
  if (query.predicate) { const list = q.setContainer('predicate', new LoroMap()).setContainer('edgeTypes', new LoroList()); for (const t of query.predicate.edgeTypes || []) list.push(t); }
}
// An edge has no id of its own: it is its ends, its type and, for a field reference, the field.
const edgeKey = (e) => [e.fromNode, e.type, e.toNode, (e.properties && e.properties.attributeUri) || ''].join(' ');
const edgeSig = (e) => JSON.stringify(e.properties || null);

// Opens a live query and resolves once the server has taken it (subscribed; the result may still be pending).
// The handle emits 'rows' with { added, removed, changed, initial } every time the answer moves — initial is the
// first answer — and 'error' with an Error when the server refuses the query. state() reads it at any moment.
// onRows is attached before anything is read: a warm server answers inside the bootstrap, so the initial answer is
// emitted before this resolves, and a listener added afterwards never heard it (PR #152 review).
async function openLiveQuery(sync, query = {}, { label = 'orbital', onRows } = {}) {
  checkQuery(query); // before subscribing: a refused query must not leave a half-made document on the connection
  return open(sync, 'nodes', (q) => writeQuery(q, query), { key: (row) => row.uri, sig: rowSig, gone: (uri) => uri }, label, onRows);
}
// The same for edges: rows are edges, and removed carries the edges themselves (they have no uri to name them by).
async function openEdgeQuery(sync, query = {}, { label = 'orbital', onRows } = {}) {
  checkEdgeQuery(query);
  return open(sync, 'edges', (q) => writeEdgeQuery(q, query), { key: edgeKey, sig: edgeSig, gone: (key, row) => row }, label, onRows);
}
async function open(sync, queryType, write, { key, sig, gone }, label, onRows) {
  const id = 'tana:liveQuery:' + ulid();
  const handle = new EventEmitter();
  if (onRows) handle.on('rows', onRows);
  let seen = null, failed = false; // key -> { sig, row }, null until the first answer
  const doc = await sync.subscribe(id, (loro) => {
    const data = loro.getMap('data');
    for (const [k, value] of Object.entries({ type: 'liveQuery', queryType, label, state: 'pending', queryVersion: 1, resultForVersion: 0 })) data.set(k, value);
    write(data.setContainer('query', new LoroMap()));
    data.setContainer('result', new LoroMap()).setContainer(queryType, new LoroList());
  });
  handle.id = id;
  handle.state = () => {
    const data = doc.data.toJSON();
    return { status: statusOf(data), [queryType]: (data.result && data.result[queryType]) || [], error: data.error || null };
  };
  const update = () => {
    const { status, [queryType]: rows, error } = handle.state();
    if (status === 'error') { if (!failed) { failed = true; if (handle.listenerCount('error')) handle.emit('error', new Error((error && error.message) || 'live query failed')); } return; }
    failed = false;
    if (status === 'pending') return;
    const now = new Map(rows.map((row) => [key(row), { sig: sig(row), row }]));
    const initial = seen === null, before = seen || new Map();
    const added = [...now].filter(([k]) => !before.has(k)).map(([, e]) => e.row);
    const changed = [...now].filter(([k, e]) => before.has(k) && before.get(k).sig !== e.sig).map(([, e]) => e.row);
    const removed = [...before].filter(([k]) => !now.has(k)).map(([k, e]) => gone(k, e.row));
    seen = now;
    if (initial || added.length || changed.length || removed.length) handle.emit('rows', { added, removed, changed, initial });
  };
  doc.on('change', update);
  handle.close = () => { doc.off('change', update); return sync.unsubscribe(id); };
  update(); // the answer may already be in (a warm server answers inside the bootstrap)
  return handle;
}

module.exports = { openLiveQuery, openEdgeQuery, statusOf, EDGE_TYPES, LISTS, SCALARS, SIDE_LISTS, SIDE_SCALARS };
