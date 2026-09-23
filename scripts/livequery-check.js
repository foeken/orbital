'use strict';
// sdk/livequery.js offline: the query the server receives, the status rule, and the row diff. Run: node scripts/livequery-check.js
const assert = require('node:assert');
const { LoroList } = require('loro-crdt');
const { Document } = require('../sdk/document');
const { openLiveQuery, openEdgeQuery, EDGE_TYPES } = require('../sdk/livequery');

(async () => {
  let doc = null, unsubscribed = null;
  let subscribes = 0;
  const sync = { subscribe: async (id, init) => { subscribes++; doc = new Document(id); doc.transact(init); return doc; }, unsubscribe: async (id) => { unsubscribed = id; } };
  // the server: answer the query by rewriting data.result and bumping resultForVersion, as a live update would
  const answer = (rows, version = 1) => doc.transact((loro) => {
    const data = loro.getMap('data'), nodes = data.get('result').setContainer('nodes', new LoroList());
    for (const row of rows) nodes.push(row);
    data.set('state', 'ready'); data.set('resultForVersion', version);
  });
  const task = (uri, state, title = 't') => ({ uri, title, state: { type: state, enteredAt: 1 }, createdAt: 1790083786478 });

  const live = await openLiveQuery(sync, { types: ['text'], stateTypes: ['closed'], stateEnteredAtMin: 5, limit: 20 }, { label: 'probe' });
  assert.match(live.id, /^tana:liveQuery:[0-9a-z]{26}$/);
  const data = doc.data.toJSON();
  assert.deepEqual([data.type, data.queryType, data.label, data.state, data.queryVersion, data.resultForVersion], ['liveQuery', 'nodes', 'probe', 'pending', 1, 0]);
  assert.deepEqual([data.query.types, data.query.stateTypes, data.query.stateEnteredAtMin, data.query.limit, data.query.assignedTo], [['text'], ['closed'], 5, 20, []], 'given fields written, the other lists empty');
  assert.deepEqual(data.result, { nodes: [] });
  assert.equal(live.state().status, 'pending');
  await assert.rejects(openLiveQuery(sync, { titleContains: 'x' }), /unsupported live query field titleContains/);
  assert.equal(subscribes, 1, 'a refused query is never subscribed');

  const seen = [];
  live.on('rows', (e) => seen.push({ initial: e.initial, added: e.added.map((r) => r.uri), changed: e.changed.map((r) => r.uri), removed: e.removed }));
  answer([task('a', 'closed'), task('b', 'closed')]);
  assert.equal(live.state().status, 'ready');
  answer([task('a', 'closed'), task('b', 'closed')]);           // same answer again: nothing to say
  answer([task('a', 'closed', 'renamed'), task('c', 'closed')]); // one changed, one new, one gone
  assert.deepEqual(seen, [
    { initial: true, added: ['a', 'b'], changed: [], removed: [] },
    { initial: false, added: ['c'], changed: ['a'], removed: ['b'] },
  ]);
  doc.transact((loro) => loro.getMap('data').set('queryVersion', 2));
  assert.equal(live.state().status, 'stale', 'an answer to an older query version is stale');

  let failure = null;
  live.on('error', (e) => { failure = e.message; });
  doc.transact((loro) => { const d = loro.getMap('data'); d.set('state', 'error'); d.set('error', { message: 'bad query' }); });
  assert.equal(failure, 'bad query');
  await live.close();
  assert.equal(unsubscribed, live.id);

  // Edges: the same document with queryType 'edges', a subject/predicate/object query, and edges for rows.
  const page = 'tana:text:01m22jrbja1xvgqp9zmnk8fk7c', field = 'tana:type:01m1kr1x38pzszdrgb7f2m2rqx?attribute=aya3gqzt';
  const edges = await openEdgeQuery(sync, { object: { uris: [page] }, predicate: { edgeTypes: [EDGE_TYPES.LINKS_TO, EDGE_TYPES.ATTRIBUTE_LINKS_TO] } }, { label: 'backlinks' });
  const e = doc.data.toJSON();
  assert.deepEqual([e.type, e.queryType, e.label, e.state, e.queryVersion, e.resultForVersion], ['liveQuery', 'edges', 'backlinks', 'pending', 1, 0]);
  assert.deepEqual(e.query.predicate, { edgeTypes: [1, 4] }, 'edge types by number, as Tana writes them');
  assert.deepEqual(e.query.object.uris, [page]);
  assert.deepEqual(e.query.object.assignedTo, [], 'every list of a side written, empty when not given');
  assert.equal(e.query.subject, undefined, 'an absent side is left out');
  assert.deepEqual(e.result, { edges: [] });
  const before = subscribes;
  await assert.rejects(openEdgeQuery(sync, { object: { title: 'x' } }), /unsupported edge query field object.title/);
  await assert.rejects(openEdgeQuery(sync, { predicate: { edgeTypes: ['LINKS_TO'] }, object: { uris: [page] } }), /edgeTypes are numbers/);
  await assert.rejects(openEdgeQuery(sync, { object: { uris: [] } }), /needs a uri/, 'a query that matches nothing is Tana\'s empty resource, never sent');
  assert.equal(subscribes, before, 'a refused edge query is never subscribed');
  const answerEdges = (rows, version = 1) => doc.transact((loro) => {
    const data = loro.getMap('data'), list = data.get('result').setContainer('edges', new LoroList());
    for (const row of rows) list.push(row);
    data.set('state', 'ready'); data.set('resultForVersion', version);
  });
  const mention = (from, label = 'x') => ({ fromNode: from, toNode: page, type: 'EDGE_TYPE_LINKS_TO', properties: { label } });
  const inField = (from) => ({ fromNode: from, toNode: page, type: 'EDGE_TYPE_ATTRIBUTE_LINKS_TO', properties: { attributeUri: field } });
  const moves = [];
  const show = (list) => list.map((x) => x.fromNode + ':' + x.type.slice(10));
  edges.on('rows', (m) => moves.push({ initial: m.initial, added: show(m.added), changed: show(m.changed), removed: show(m.removed) }));
  answerEdges([mention('a'), inField('a')]);
  assert.equal(edges.state().status, 'ready');
  assert.equal(edges.state().edges.length, 2);
  answerEdges([mention('a', 'renamed'), inField('a'), mention('b')]);
  answerEdges([mention('a', 'renamed'), mention('b')]);
  assert.deepEqual(moves, [
    { initial: true, added: ['a:LINKS_TO', 'a:ATTRIBUTE_LINKS_TO'], changed: [], removed: [] },
    { initial: false, added: ['b:LINKS_TO'], changed: ['a:LINKS_TO'], removed: [] },
    { initial: false, added: [], changed: [], removed: ['a:ATTRIBUTE_LINKS_TO'] },
  ], 'an edge is its ends, its type and its field: a mention and a field reference from one document are two edges, removed ones come back whole');
  await edges.close();
  assert.equal(unsubscribed, edges.id);
  console.log('livequery-check ok');
})().catch((e) => { console.error(e); process.exit(1); });
