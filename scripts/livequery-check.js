'use strict';
// sdk/livequery.js offline: the query the server receives, the status rule, and the row diff. Run: node scripts/livequery-check.js
const assert = require('node:assert');
const { LoroList } = require('loro-crdt');
const { Document } = require('../sdk/document');
const { openLiveQuery } = require('../sdk/livequery');

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
  console.log('livequery-check ok');
})().catch((e) => { console.error(e); process.exit(1); });
