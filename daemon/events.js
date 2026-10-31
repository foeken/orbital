'use strict';
// The Tana events the daemon offers (MCP Events, docs/DAEMON.md) and how a live query's changes become them. Every event
// takes a filter as its arguments, which is a live query Tana's server keeps answering over the sync stream
// (sdk/livequery.js): no polling, and anything the server can filter on can be watched. Subscriptions with the same
// filter share one live query. The first answer is what is there already: it is remembered, never announced.
const { EDGE_TYPES } = require('../sdk/livequery');

const EDGE_NAMES = Object.fromEntries(Object.entries(EDGE_TYPES).map(([name, n]) => [n, name]));
const list = (description, items = { type: 'string' }) => ({ type: 'array', items, maxItems: 50, description });
// The node filter: the live query fields a person would filter on (sdk/livequery.js LISTS and SCALARS)
const NODE_LISTS = { uris: 'These nodes, by Tana id', types: 'Node kinds: text, event, chat, space, type, …', ownerUris: 'Owned by these spaces, events or documents',
  entityTypeUris: 'Of these types (tana:type:…)', stateTypes: 'In these states: proposed (Inbox), open (In Progress), closed (Completed), not_now (Later)',
  stateWorkflowUris: 'In these workflows', assignedTo: 'Assigned to these people (tana:user-profile:…)', createdBy: 'Made by these people', hasParticipantUris: 'With these participants' };
const NODE_SCALARS = { unassigned: { type: 'boolean', description: 'Only nodes nobody is assigned to' }, includeArchived: { type: 'boolean', description: 'Archived nodes too' },
  eventStartTimeMin: { type: 'number', description: 'Meetings starting at or after (epoch ms)' }, eventStartTimeMax: { type: 'number', description: 'Meetings starting before (epoch ms)' } };
const nodeFilter = Object.fromEntries([...Object.entries(NODE_LISTS).map(([k, d]) => [k, list(d)]), ...Object.entries(NODE_SCALARS)]);
const SIDE = ['uris', 'types', 'ownerUris', 'entityTypeUris', 'stateTypes', 'assignedTo'];
const side = (d) => ({ type: 'object', description: d, additionalProperties: false, properties: Object.fromEntries(SIDE.map((k) => [k, list(NODE_LISTS[k])])) });
const edgeFilter = { edgeTypes: list('Link kinds: ' + Object.keys(EDGE_TYPES).join(', '), { type: 'string', enum: Object.keys(EDGE_TYPES) }),
  from: side('Where the link starts (for a mention: the document that mentions)'), to: side('Where the link ends (for a mention: what is mentioned)') };
const schema = (properties, extra = {}) => ({ type: 'object', properties: { ...properties, ...extra }, additionalProperties: false });

const STATES = ['proposed', 'open', 'closed', 'not_now'];
const FIELDS = ['title', 'state', 'assignedTo', 'type', 'owner', 'archived', 'content'];
const nodePayload = { type: 'object', description: 'The node as Tana lists it: uri, title, kind, type, owner, state, assignees, times (epoch ms)' };
const EVENTS = [
  { name: 'tana.node.added', title: 'Node added', description: 'A node starts to match the filter: made, moved in, retyped, assigned, or its state changed into it.',
    inputSchema: schema(nodeFilter), payloadSchema: schema({ node: nodePayload }) },
  { name: 'tana.node.changed', title: 'Node changed', description: 'A node matching the filter changed: its title, state, assignees, type, owner, archived, or anything else (content).',
    inputSchema: schema(nodeFilter, { fields: list('Only when one of these changed: ' + FIELDS.join(', '), { type: 'string', enum: FIELDS }) }),
    payloadSchema: schema({ node: nodePayload, fields: { type: 'array', items: { type: 'string' } }, before: nodePayload }) },
  { name: 'tana.node.removed', title: 'Node removed', description: 'A node stops matching the filter: deleted, moved out, retyped, unassigned, or its state changed out of it.',
    inputSchema: schema(nodeFilter), payloadSchema: schema({ node: { type: 'string' }, last: nodePayload }) },
  { name: 'tana.task.state_changed', title: 'Task state changed', description: 'A node matching the filter moved from one state to another (Inbox proposed, In Progress open, Completed closed, Later not_now).',
    inputSchema: schema(nodeFilter, { from: list('Only from these states', { type: 'string', enum: STATES }), to: list('Only to these states', { type: 'string', enum: STATES }) }),
    payloadSchema: schema({ node: nodePayload, from: { type: ['string', 'null'] }, to: { type: ['string', 'null'] } }) },
  { name: 'tana.task.assigned', title: 'Task assigned', description: 'Someone was assigned to a node matching the filter (a node that arrives already assigned counts too).',
    inputSchema: schema(nodeFilter, { assignee: { type: 'string', description: 'Only when this person (tana:user-profile:…) is the one assigned' } }),
    payloadSchema: schema({ node: nodePayload, assigned: { type: 'array', items: { type: 'string' } } }) },
  { name: 'tana.edge.added', title: 'Link added', description: 'A link matching the filter appeared: a mention, a field reference, a pin, an attendee, a comment, a proposal, …',
    inputSchema: schema(edgeFilter), payloadSchema: schema({ edge: { type: 'object' } }) },
  { name: 'tana.edge.removed', title: 'Link removed', description: 'A link matching the filter went away.',
    inputSchema: schema(edgeFilter), payloadSchema: schema({ edge: { type: 'object' } }) },
].map((e) => ({ ...e, delivery: ['webhook'] }));

const invalid = (message) => Object.assign(new Error(message), { invalid: true });
const canonical = (v) => (Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v));
const strings = (value, name) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50 || !value.every((s) => typeof s === 'string' && s.length <= 200)) throw invalid(name + ': up to 50 strings');
  return value.length ? [...new Set(value)].sort() : undefined;
};

// An event's arguments as { kind, query, extra }: the live query to run, and what is matched after it
function queryOf(name, args) {
  const event = EVENTS.find((e) => e.name === name);
  if (!event) throw invalid('No event called ' + String(name).slice(0, 60));
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw invalid('arguments: an object');
  const known = Object.keys(event.inputSchema.properties);
  for (const key of Object.keys(args)) if (!known.includes(key)) throw invalid(name + ' takes no argument ' + key.slice(0, 60));
  if (name.startsWith('tana.edge.')) {
    const query = {}, types = strings(args.edgeTypes, 'edgeTypes');
    if (types) { if (!types.every((t) => Object.hasOwn(EDGE_TYPES, t))) throw invalid('edgeTypes: ' + Object.keys(EDGE_TYPES).join(', ')); query.predicate = { edgeTypes: types.map((t) => EDGE_TYPES[t]) }; }
    for (const [arg, key] of [['from', 'subject'], ['to', 'object']]) {
      if (args[arg] == null) continue;
      if (typeof args[arg] !== 'object' || Array.isArray(args[arg])) throw invalid(arg + ': an object');
      const out = {};
      for (const [k, v] of Object.entries(args[arg])) { if (!SIDE.includes(k)) throw invalid(arg + ' takes no field ' + k.slice(0, 60)); const s = strings(v, arg + '.' + k); if (s) out[k] = s; }
      if (Object.keys(out).length) query[key] = out;
    }
    if (!query.subject && !query.object) throw invalid('Say which links: from or to (a node, a kind, a type, an owner …); edgeTypes alone would be every link in the workspace');
    return { kind: 'edges', query, extra: {} };
  }
  const query = {}, extra = {};
  for (const key of Object.keys(NODE_LISTS)) { const s = strings(args[key], key); if (s) query[key] = s; }
  if (!Object.keys(query).length) throw invalid('Give the filter at least one list (uris, types, ownerUris, entityTypeUris, stateTypes, assignedTo, createdBy …): an empty one would be the whole workspace');
  for (const [key, s] of Object.entries(NODE_SCALARS)) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== s.type) throw invalid(key + ': a ' + s.type);
    query[key] = args[key];
  }
  if (args.fields !== undefined) { extra.fields = strings(args.fields, 'fields'); if (extra.fields && !extra.fields.every((f) => FIELDS.includes(f))) throw invalid('fields: ' + FIELDS.join(', ')); }
  for (const key of ['from', 'to']) if (args[key] !== undefined) { extra[key] = strings(args[key], key); if (extra[key] && !extra[key].every((s) => STATES.includes(s))) throw invalid(key + ': ' + STATES.join(', ')); }
  if (args.assignee !== undefined) { if (typeof args.assignee !== 'string') throw invalid('assignee: a tana:user-profile: id'); extra.assignee = args.assignee; }
  return { kind: 'nodes', query, extra };
}

const stateOf = (row) => (row && row.state && row.state.type) || null;
const nodeView = (row) => ({ uri: row.uri, title: row.title || '', kind: row.type || null, type: row.entityType || null, owner: row.ownerUri || null, state: stateOf(row),
  assignedTo: row.assignedTo || [], createdAt: row.createdAt || null, updatedAt: row.updatedAt || null, archived: Date.parse(row.archivedAt) > 0 || Number(row.archivedAt) > 0 });
const edgeView = (e) => ({ from: e.fromNode, to: e.toNode, type: EDGE_NAMES[e.type] || String(e.type), ...(e.properties && e.properties.attributeUri ? { field: e.properties.attributeUri } : {}) });
function changedFields(before, row) {
  const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  const out = [];
  if (!same(before.title, row.title)) out.push('title');
  if (stateOf(before) !== stateOf(row)) out.push('state');
  if (!same(before.assignedTo, row.assignedTo)) out.push('assignedTo');
  if (!same(before.entityType, row.entityType)) out.push('type');
  if (!same(before.ownerUri, row.ownerUri)) out.push('owner');
  if (!same(before.archivedAt, row.archivedAt)) out.push('archived');
  return out.length ? out : ['content'];
}

// What one subscription hears of one change to its live query: a list of [name, data]
function matches(sub, extra, change, before) {
  const out = [];
  if (sub.name === 'tana.edge.added') for (const e of change.added) out.push({ edge: edgeView(e) });
  if (sub.name === 'tana.edge.removed') for (const e of change.removed) out.push({ edge: edgeView(e) });
  if (sub.name === 'tana.node.added') for (const row of change.added) out.push({ node: nodeView(row) });
  if (sub.name === 'tana.node.removed') for (const uri of change.removed) out.push({ node: uri, ...(before.get(uri) ? { last: nodeView(before.get(uri)) } : {}) });
  if (sub.name === 'tana.node.changed') {
    for (const row of change.changed) {
      const was = before.get(row.uri), fields = was ? changedFields(was, row) : ['content'];
      if (change.quiet(row.uri) && fields.length === 1 && fields[0] === 'content') continue; // the daemon's own metadata write
      if (extra.fields && !fields.some((f) => extra.fields.includes(f))) continue;
      out.push({ node: nodeView(row), fields, ...(was ? { before: nodeView(was) } : {}) });
    }
  }
  if (sub.name === 'tana.task.state_changed') {
    for (const row of change.changed) {
      const was = before.get(row.uri), from = stateOf(was), to = stateOf(row);
      if (!was || from === to) continue;
      if ((extra.from && !extra.from.includes(from)) || (extra.to && !extra.to.includes(to))) continue;
      out.push({ node: nodeView(row), from, to });
    }
  }
  if (sub.name === 'tana.task.assigned') {
    for (const row of [...change.added, ...change.changed]) {
      const had = new Set((before.get(row.uri) || {}).assignedTo || []), assigned = (row.assignedTo || []).filter((u) => !had.has(u));
      if (!assigned.length || (extra.assignee && !assigned.includes(extra.assignee))) continue;
      out.push({ node: nodeView(row), assigned });
    }
  }
  return out;
}

// open(kind, query, onRows) -> Promise<{ close }>: a live query (sdk/livequery.js openLiveQuery or openEdgeQuery).
// emit(sub, data): one event for one subscription. quiet(uri): whether the daemon itself just wrote that node.
function createWatch({ open, emit, quiet = () => false, report = () => {} }) {
  const queries = new Map(); // kind + query -> { subs: Map(id -> { sub, extra }), rows: Map(uri -> row), opening }
  function onRows(q, change) {
    const before = q.rows;
    if (q.kind === 'nodes') {
      q.rows = new Map(before);
      for (const row of [...change.added, ...change.changed]) q.rows.set(row.uri, row);
      for (const uri of change.removed) q.rows.delete(uri);
    }
    if (change.initial) return; // what is there already: remembered, never announced
    const c = { ...change, quiet };
    for (const { sub, extra } of q.subs.values()) {
      for (const data of matches(sub, extra, c, before)) { try { emit(sub, data); } catch (e) { report(e); } }
    }
  }
  // A subscription (id, name, args) listens: its live query is opened, or the one already open for its filter is shared
  async function add(sub) {
    const { kind, query, extra } = queryOf(sub.name, sub.args);
    remove(sub.id, { keep: kind + ' ' + canonical(query) }); // the same subscription with a new filter leaves the old one
    const key = kind + ' ' + canonical(query);
    let q = queries.get(key);
    if (!q) {
      q = { kind, subs: new Map(), rows: new Map() };
      queries.set(key, q);
      q.opening = Promise.resolve().then(() => open(kind, query, (change) => onRows(q, change)));
      q.opening.catch(() => { if (queries.get(key) === q) queries.delete(key); });
    }
    q.subs.set(sub.id, { sub, extra });
    await q.opening;
  }
  function remove(id, { keep } = {}) {
    for (const [key, q] of queries) {
      if (key === keep || !q.subs.delete(id) || q.subs.size) continue;
      queries.delete(key);
      q.opening.then((h) => h.close(), () => {}).catch(report);
    }
  }
  const close = () => { for (const [key, q] of queries) { queries.delete(key); q.opening.then((h) => h.close(), () => {}).catch(() => {}); } };
  return { add, remove, close, size: () => queries.size };
}

module.exports = { EVENTS, queryOf, createWatch, nodeView, edgeView, canonical };
