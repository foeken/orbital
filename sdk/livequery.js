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
const { EventEmitter } = require('node:events');
const { LoroMap, LoroList } = require('loro-crdt');
const { ulid } = require('./node');

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
// What a row is for "did it change": the parts a trigger or a list redraw cares about.
const rowSig = (row) => JSON.stringify([row.title, row.state && row.state.type, row.state && row.state.enteredAt, row.entityType, row.assignedTo, row.archivedAt]);

// Opens a live query and resolves once the server has taken it (subscribed; the result may still be pending).
// The handle emits 'rows' with { added, removed, changed, initial } every time the answer moves — initial is the
// first answer — and 'error' with an Error when the server refuses the query. state() reads it at any moment.
async function openLiveQuery(sync, query = {}, { label = 'orbital' } = {}) {
  checkQuery(query); // before subscribing: a refused query must not leave a half-made document on the connection
  const id = 'tana:liveQuery:' + ulid();
  const handle = new EventEmitter();
  let seen = null, failed = false; // uri -> signature, null until the first answer
  const doc = await sync.subscribe(id, (loro) => {
    const data = loro.getMap('data');
    for (const [key, value] of Object.entries({ type: 'liveQuery', queryType: 'nodes', label, state: 'pending', queryVersion: 1, resultForVersion: 0 })) data.set(key, value);
    writeQuery(data.setContainer('query', new LoroMap()), query);
    data.setContainer('result', new LoroMap()).setContainer('nodes', new LoroList());
  });
  handle.id = id;
  handle.state = () => {
    const data = doc.data.toJSON();
    return { status: statusOf(data), nodes: (data.result && data.result.nodes) || [], error: data.error || null };
  };
  const update = () => {
    const { status, nodes, error } = handle.state();
    if (status === 'error') { if (!failed) { failed = true; if (handle.listenerCount('error')) handle.emit('error', new Error((error && error.message) || 'live query failed')); } return; }
    failed = false;
    if (status === 'pending') return;
    const now = new Map(nodes.map((row) => [row.uri, rowSig(row)]));
    const initial = seen === null, before = seen || new Map();
    const added = nodes.filter((row) => !before.has(row.uri));
    const changed = nodes.filter((row) => before.has(row.uri) && before.get(row.uri) !== now.get(row.uri));
    const removed = [...before.keys()].filter((uri) => !now.has(uri));
    seen = now;
    if (initial || added.length || changed.length || removed.length) handle.emit('rows', { added, removed, changed, initial });
  };
  doc.on('change', update);
  handle.close = () => { doc.off('change', update); return sync.unsubscribe(id); };
  update(); // the answer may already be in (a warm server answers inside the bootstrap)
  return handle;
}

module.exports = { openLiveQuery, statusOf, LISTS, SCALARS };
