'use strict';
// main/automations.js: the gate, the node-added trigger (a live query + presence), if/named outputs, one run per node. Run: node scripts/automations-check.js
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const A = require('../main/automations');

const born = '2026-09-22T10:00:00Z';
const added = (filter, extra = {}) => ({ type: 'tana.nodeAdded', typeVersion: 1, parameters: { filter, ...extra } });
const TASKS = { types: ['text'], stateTypes: ['proposed', 'open', 'closed', 'not_now'] };
// The Discuss-with example, as the AI is asked to write it.
const discuss = { v: 1, id: 'd', name: 'Discussion points', createdAt: born, trigger: added(TASKS), nodes: [
  { type: 'if', typeVersion: 1, parameters: { condition: { ai: 'the title says it should be discussed with someone' } }, then: [
    { type: 'tana', typeVersion: 1, parameters: { resource: 'item', operation: 'setType', typeName: 'Discussion Task' } },
    { name: 'Who', type: 'ai', typeVersion: 1, parameters: { resource: 'text', operation: 'extract', ask: 'the people or teams to discuss it with' } },
    { type: 'tana', typeVersion: 1, parameters: { resource: 'field', operation: 'set', field: 'Discuss with', value: { node: 'Who' } } },
  ] },
] };
const done = { v: 1, id: 'c', name: 'Done', createdAt: born, trigger: added({ assignedTo: ['me'] }, { typeNames: ['Decision'] }), nodes: [
  { type: 'orbital', typeVersion: 1, parameters: { resource: 'user', operation: 'notify', text: { ref: 'item.title' } } }] };

// the gate
assert.equal(A.invalid(discuss), null);
assert.equal(A.invalid(done), null);
assert.match(A.invalid({ ...done, nodes: [{ type: 'tana', typeVersion: 2, parameters: { resource: 'item', operation: 'setState', state: 'open' } }] }), /bad node/, 'unknown typeVersion');
assert.match(A.invalid({ ...done, nodes: [{ type: 'shell', typeVersion: 1, parameters: {} }] }), /bad node/);
assert.match(A.invalid({ ...done, trigger: added({}) }), /must narrow/, 'the filter is not optional');
assert.match(A.invalid({ ...done, trigger: added({ types: [], unassigned: false }) }), /must narrow/, 'and an empty one is no filter');
assert.match(A.invalid({ ...done, trigger: { type: 'tana.nodeAdded', typeVersion: 1, parameters: {} } }), /needs a filter/);
assert.match(A.invalid({ ...done, trigger: { type: 'tana.liveQuery', typeVersion: 1, parameters: { on: 'entered', query: TASKS } } }), /must be tana.nodeAdded/, 'node added is the only trigger');
assert.match(A.invalid({ ...done, trigger: added({ titleContains: 'x' }) }), /unknown filter field titleContains/);
assert.match(A.invalid({ ...done, trigger: added({ types: ['text'], createdAtMin: 0 }) }), /set by the app/);
assert.match(A.invalid({ ...done, trigger: added({ stateTypes: ['done'] }) }), /unknown state/);
// what the page draws
const flat = (a) => A.describe(a).steps.map((s) => (s.branch ? s.depth + ' ' + s.branch : [s.depth, s.icon, s.title, s.var ? '@' + s.var : s.text, s.output].join('|')));
assert.equal(A.describe(discuss).when, 'a task is added');
assert.equal(A.describe(done).when, 'a #[Decision] assigned to me is added');
assert.equal(A.describe({ ...done, trigger: added({ types: ['text'], stateTypes: ['proposed'] }) }).when, 'a task is added to Inbox');
assert.deepEqual(flat(discuss), ['0|branch|If|the title says it should be discussed with someone|', '1|type|Set type|#[Discussion Task]|', '1|sparkle|Extract|the people or teams to discuss it with|Who', '1|field|Set Discuss with|@Who|']);

(async () => {
  // The real path: watch() opens one live query per automation (faked here), and rows the server pushes run it.
  const tick = () => new Promise((r) => setTimeout(r, 25));
  let opened = [];
  const watchIo = (io) => ({ client: () => ({}), me: () => 'tana:user-profile:me', typeUri: async (t) => 'tana:type:' + t.toLowerCase(), typeTitle: (u) => u && u.split(':')[2],
    openLiveQuery: async (query, label) => { const h = new EventEmitter(); Object.assign(h, { query, label, close: async () => { h.closed = true; } }); opened.push(h); return h; }, ...io });
  const start = async (io) => { opened = []; await A.watch(watchIo(io)); return opened; };
  const push = async (h, rows, kind = 'added') => { h.emit('rows', { added: kind === 'added' ? rows : [], changed: kind === 'changed' ? rows : [], removed: [], initial: false }); await tick(); };
  const row = (uri, title, state = 'open', enteredAt = 1) => ({ uri, title, state: { type: state, enteredAt }, createdAt: Date.now() });

  const log = [];
  let answer = true;
  const io = { automations: () => [discuss, done], judge: async () => answer, extract: async () => 'Stan and the NLT',
    setType: async (id, t) => log.push(['type', id, t]), setField: async (id, f, v) => log.push(['field', id, f, v]),
    setState: async () => {}, addLine: async () => {}, notify: (id, name, body) => log.push(['notify', id, body]) };
  const [dq, cq] = await start(io);
  // each automation's query: its own fields, "me" filled in, type titles resolved, and the floor at its creation
  assert.deepEqual(dq.query, { ...TASKS, createdAtMin: Date.parse(born), orderBy: ['-createdAt'], limit: 200 });
  assert.deepEqual(cq.query, { assignedTo: ['tana:user-profile:me'], entityTypeUris: ['tana:type:decision'], createdAtMin: Date.parse(born), orderBy: ['-createdAt'], limit: 200 });
  await push(dq, [row('tana:text:a', 'Discuss budget with Stan and the NLT')]);
  assert.deepEqual(log, [['type', 'tana:text:a', 'Discussion Task'], ['field', 'tana:text:a', 'Discuss with', 'Stan and the NLT']]);
  await push(dq, [row('tana:text:a', 'Discuss budget with Stan and the NLT, renamed')], 'changed'); // our own write echoing back
  assert.equal(log.length, 2, 'nothing runs twice for one node');
  await push(cq, [row('tana:text:c', 'Decide')]);
  assert.deepEqual(log[2], ['notify', 'tana:text:c', 'Decide']);
  await push(cq, [row('tana:text:c', 'Decide', 'closed')], 'changed');
  assert.equal(log.length, 3, 'one run per node, whatever it does later');
  answer = false;
  await push(dq, [row('tana:text:b', 'Buy milk')]);
  assert.equal(log.length, 3, 'the if said no');
  // done = quiet AND nobody has a caret in it: a colleague still in the node holds the run until they leave
  const room = new EventEmitter(); room.carets = 1; room.editing = () => Array.from({ length: room.carets }, () => ({ hasCursor: true })); room.close = async () => { room.closed = true; };
  const waited = [];
  const [pq] = await start({ ...io, automations: () => [{ ...discuss, id: 'p' }], judge: async () => true, setType: async (id) => waited.push(id), setField: async () => {}, openPresence: async () => room });
  await push(pq, [row('tana:text:p', 'Talk to Rob about')]);
  await tick();
  assert.deepEqual(waited, [], 'quiet, but someone still has a caret in it');
  room.carets = 0; room.emit('change', { removed: ['peer'] }); await tick();
  assert.deepEqual(waited, ['tana:text:p'], 'their caret left: it runs');
  assert.ok(room.closed, 'and the presence channel is closed again');
  const stuck = new EventEmitter(); stuck.editing = () => [{ hasCursor: true }]; stuck.close = async () => {};
  const [mq] = await start({ ...io, automations: () => [{ ...discuss, id: 'm' }], judge: async () => true, setType: async (id) => waited.push(id), setField: async () => {}, openPresence: async () => stuck, maxWaitMs: 60 });
  await push(mq, [row('tana:text:m', 'Left open in a tab')]);
  await tick(); await tick(); await tick();
  assert.deepEqual(waited.at(-1), 'tana:text:m', 'a caret that never leaves holds it only up to maxWaitMs');
  // a node still being typed: nothing until the title has settled, then once, on the whole title
  const typed = [];
  const [tq] = await start({ ...io, settleMs: 30, automations: () => [{ ...discuss, id: 't' }], judge: async () => true, setType: async (id) => typed.push(id), setField: async () => {} });
  tq.emit('rows', { added: [row('tana:text:typing', '')], changed: [], removed: [] });
  tq.emit('rows', { added: [], changed: [row('tana:text:typing', 'D')], removed: [] });
  await push(tq, [row('tana:text:typing', 'Discuss with Rob')], 'changed');
  await tick();
  assert.deepEqual(typed, ['tana:text:typing'], 'one run, after the typing stopped');
  await push(tq, [row('tana:text:blank', ' ')]);
  assert.equal(typed.length, 1, 'an untitled node is not run yet');
  // a failing node is recorded on the execution, and stops only that run
  const [fq] = await start({ ...io, automations: () => [{ ...discuss, id: 'f' }], judge: async () => true, setType: async () => { throw new Error('No type called Discussion Task'); } });
  await push(fq, [row('tana:text:x', 'Talk to Rob')]);
  const failed = A.executions[0];
  assert.equal(failed.ok, false); assert.match(failed.error, /No type called/);
  assert.deepEqual(failed.nodes.map((n) => [n.name, n.ok]), [['if', true], ['tana', false]]);
  // the app hands in its own record of what ran (synced), and is told when a run starts and ends
  const store = new Set(['k|tana:text:kept|added']), runs = [], wrote = [];
  // linking is a step of its own: text.link makes segments, field.set writes them as they are
  const linked = { ...done, id: 'k', trigger: added(TASKS), nodes: [
    { name: 'Linked', type: 'tana', typeVersion: 1, parameters: { resource: 'text', operation: 'link', text: { ref: 'item.title' }, types: ['Person', 'Team'] } },
    { type: 'tana', typeVersion: 1, parameters: { resource: 'field', operation: 'set', field: 'Discuss with', value: { node: 'Linked' } } }] };
  const segs = [{ mention: { label: 'Rob', uri: 'tana:user-profile:rob' } }, { text: ' and Ria' }], linkedWith = [];
  const [kq] = await start({ ...io, automations: () => [linked], fired: store, running: (...a) => runs.push(a), link: async (...args) => { linkedWith.push(args); return segs; }, setField: async (...args) => wrote.push(args) });
  await push(kq, [row('tana:text:kept', 't')]);
  assert.equal(wrote.length, 0, 'a key already in the store (a restart, another machine) does not run again');
  await push(kq, [row('tana:text:fresh', 'Rob and Ria')]);
  assert.ok(store.has('k|tana:text:fresh|added'));
  assert.deepEqual(runs, [['tana:text:fresh', 'k', true], ['tana:text:fresh', 'k', false]], 'the running bolt is switched on and off around the run');
  assert.deepEqual(linkedWith, [['Rob and Ria', ['Person', 'Team'], 'unique']], 'text.link gets the text, the types and the default match');
  assert.deepEqual(wrote[0].slice(1), ['Discuss with', segs], 'field.set writes the linked segments as they are');
  assert.match(A.invalid({ ...linked, nodes: [{ type: 'tana', typeVersion: 1, parameters: { resource: 'field', operation: 'set', field: 'F', value: 'x', link: { types: ['Team'] } } }] }), /bad node/, 'linking is no longer a field.set setting');
  // watch keeps one query per enabled automation: unchanged stays, changed or switched off is closed
  const client = {};
  opened = [];
  await A.watch(watchIo({ ...io, client: () => client, automations: () => [linked, discuss] }));
  const first = opened.slice();
  await A.watch(watchIo({ ...io, client: () => client, automations: () => [linked, { ...discuss, enabled: false }] }));
  assert.equal(opened.length, 2, 'nothing reopened');
  assert.deepEqual(first.map((h) => !!h.closed), [false, true], 'the switched-off one is closed');
  // FAST unless a node or an expression asks for SMART; anything else is refused before it can run
  const tiers = [];
  const smart = { ...done, id: 's', trigger: added(TASKS), nodes: [
    { type: 'if', typeVersion: 1, parameters: { condition: { ai: 'is it urgent?', model: 'smart' } }, then: [
      { name: 'Why', type: 'ai', typeVersion: 1, parameters: { resource: 'text', operation: 'extract', ask: 'the reason' } }] }] };
  assert.equal(A.invalid(smart), null);
  assert.match(A.invalid({ ...smart, nodes: [{ type: 'ai', typeVersion: 1, parameters: { resource: 'text', operation: 'judge', ask: 'x', model: 'huge' } }] }), /bad node/);
  assert.deepEqual([A.describe(smart).steps[0].title, A.describe(smart).steps[0].text, A.describe(smart).steps[0].model], ['If yes to', 'is it urgent?', 'smart'], 'a question reads "If yes to", with the model as a label');
  assert.equal(A.describe({ ...smart, nodes: [{ type: 'if', typeVersion: 1, parameters: { condition: { ai: 'Does it name a person? Answer yes or no.' } }, then: smart.nodes[0].then }] }).steps[0].text, 'Does it name a person?', 'the instruction to the model is not shown');
  const [sq] = await start({ ...io, automations: () => [smart], judge: async (q, i, m) => { tiers.push(m); return true; }, extract: async (q, i, m) => { tiers.push(m); return 'x'; } });
  await push(sq, [row('tana:text:s', 'Urgent thing')]);
  assert.deepEqual(tiers, ['smart', 'fast']);
  assert.match(A.invalid({ ...linked, nodes: [{ ...linked.nodes[0], parameters: { ...linked.nodes[0].parameters, match: 'fuzzy' } }] }), /bad node/);
  assert.deepEqual(A.describe(linked).steps.map((s) => [s.icon, s.title, s.text, s.after, s.note, s.output, s.var]), [['link', 'Link names', 'item.title', 'to #[Person|member] or #[Team]', 'unique first names too', 'Linked', undefined], ['field', 'Set Discuss with', undefined, undefined, undefined, '', 'Linked']], 'a step of its own, its output the pill the write reads');
  // Linking names to Tana nodes: members and a Team type, three ways of being sure (main/documents.js linkNames)
  const { linkNames } = require('../main/documents');
  const cands = [{ id: 'rj', title: 'Rob Jansen' }, { id: 'rv', title: 'Rob Visser' }, { id: 'pl', title: 'Peter Leppers' }, { id: 'nlt', title: 'NLT' }];
  const refs = (s) => (typeof s === 'string' ? [] : s.filter((x) => x.mention).map((x) => x.mention.label + '=' + x.mention.uri));
  assert.deepEqual(refs(linkNames('Rob and Peter', cands, 'exact')), [], 'exact: first names are words');
  assert.deepEqual(refs(linkNames('Rob Visser and Peter Leppers', cands, 'exact')), ['Rob Visser=rv', 'Peter Leppers=pl']);
  assert.deepEqual(refs(linkNames('Rob and Peter', cands, 'unique')), ['Peter=pl'], 'unique: two Robs, so Rob stays words');
  assert.deepEqual(refs(linkNames('Rob and Peter', cands, 'loose')), ['Rob=rj', 'Peter=pl'], 'loose: any Rob, the first listed');
  assert.deepEqual(refs(linkNames('Stan and the NLT', cands, 'unique')), ['NLT=nlt'], 'a team after an article still links');
  assert.deepEqual(refs(linkNames('the NLTX board', cands, 'loose')), [], 'never inside a longer word');
  console.log('automations-check ok');
  process.exit(0); // the fake queries hold no timers, but the settle timers of skipped rows may
})().catch((e) => { console.error(e); process.exit(1); });
