'use strict';
// sdk/presence.js + the ephemeral channel commands in sdk/sync.js, offline. Run: node scripts/presence-check.js
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { EphemeralStore } = require('loro-crdt');
const { openPresence, userHashOf } = require('../sdk/presence');
const { SyncConnection } = require('../sdk/sync');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const DOC = 'tana:text:01exampleh0000000000000000';
// two peers of one user (same hash, different tab numbers), and one of somebody else
const peer = (userHash, tab) => ((BigInt(userHash) << 16n) | BigInt(tab)).toString();
const ME = peer(1234567, 1), MY_OTHER_TAB = peer(1234567, 2), OTHER = peer(7654321, 9);

(async () => {
  // a fake sync connection: records what presence asks of it, and hands frames in the way the stream does
  const sync = new EventEmitter();
  Object.assign(sync, { peerId: ME, sent: [], calls: [],
    subscribeEphemeralChannel: async (id) => sync.calls.push(['sub', id]), unsubscribeEphemeralChannel: async (id) => sync.calls.push(['unsub', id]),
    sendEphemeral: async (id, data) => { sync.sent.push([id, data]); return true; }, viewingHeartbeat: async (id) => { sync.calls.push(['view', id]); return true; } });
  // a remote editor, writing its entry the way Tana's (Hf.setLocal) does
  const remote = (peerId, fields, timeout = 30000) => { const s = new EphemeralStore(timeout); const out = []; s.subscribeLocalUpdates((u) => out.push(u)); s.set(peerId, { anchor: null, focus: null, user: null, anchorBlockId: null, anchorBlockOffset: null, focusBlockId: null, focusBlockOffset: null, scope: null, ...fields }); return { s, out }; };

  const room = await openPresence(sync, DOC, { viewing: true, timeout: 200 });
  assert.deepEqual(sync.calls, [['sub', DOC], ['view', DOC]], 'subscribes the channel named by the document, and says it is viewing');
  const changes = [];
  room.on('change', (e) => changes.push(e));

  const typing = remote(OTHER, { user: { name: 'Stan', color: 'red' }, anchorBlockId: 'blk1', anchorBlockOffset: 4, focusBlockId: 'blk1', focusBlockOffset: 4 });
  sync.emit('ephemeral', DOC, typing.out[0]);
  sync.emit('ephemeral', 'tana:text:01otherdoc0000000000000000', remote(peer(5, 5), { user: { name: 'Elsewhere' } }).out[0]);
  const looking = remote(MY_OTHER_TAB, { user: { name: 'Andre' } });
  sync.emit('ephemeral', DOC, looking.out[0]);
  assert.deepEqual(room.peers().map((p) => [p.user.name, p.userHash, p.hasCursor]), [['Stan', '7654321', true], ['Andre', '1234567', false]], 'this document only, each with the user it is');
  assert.deepEqual(room.editing().map((p) => [p.user.name, p.anchorBlock]), [['Stan', { blockId: 'blk1', offset: 4 }]], 'editing = a caret in it');
  assert.deepEqual(room.peers({ exceptUserHash: userHashOf(ME) }).map((p) => p.user.name), ['Stan'], 'and your own other tabs can be left out');
  assert.deepEqual(changes.map((c) => [c.by, c.added]), [['import', [OTHER]], ['import', [MY_OTHER_TAB]]]);

  // an editor leaving is a removal; one that stops refreshing expires after the timeout
  typing.s.delete(OTHER); sync.emit('ephemeral', DOC, typing.out[1]);
  assert.deepEqual(room.editing(), [], 'the caret left');
  await tick(700);
  assert.deepEqual(room.peers(), [], 'an entry nobody refreshes expires');
  assert.ok(changes.some((c) => c.by === 'timeout' && c.removed.includes(MY_OTHER_TAB)));

  // being seen: our entry in Tana's shape, sent as store updates another peer can read, refreshed before it expires
  room.setLocal({ user: { name: 'Orbital', color: 'blue' }, anchorBlock: { blockId: 'blk2', offset: 0 } });
  assert.equal(sync.sent.length, 1);
  const them = new EphemeralStore(30000); them.apply(sync.sent[0][1]);
  assert.deepEqual(them.getAllStates()[ME], { anchor: null, focus: null, user: { name: 'Orbital', color: 'blue' }, scope: null, anchorBlockId: 'blk2', anchorBlockOffset: 0, focusBlockId: 'blk2', focusBlockOffset: 0 });
  assert.equal(room.peers().length, 0, 'we are not one of the others');
  await tick(1100);
  assert.ok(sync.sent.length >= 2, 'refreshed while it stands');
  sync.emit('connected');
  assert.equal(sync.calls.filter((c) => c[0] === 'view').length, 2, 'a reconnect sends the viewing heartbeat again');
  const before = sync.sent.length; sync.emit('connected'); assert.ok(sync.sent.length > before, 'and our entry again');
  await room.close();
  them.apply(sync.sent.at(-1)[1]);
  assert.equal(them.getAllStates()[ME], undefined, 'closing takes our entry away');
  assert.deepEqual(sync.calls.at(-1), ['unsub', DOC]);
  const after = sync.sent.length; sync.emit('ephemeral', DOC, remote(OTHER, { user: { name: 'Late' } }).out[0]); sync.emit('connected');
  assert.equal(sync.sent.length, after, 'a closed handle hears and sends nothing');

  // sdk/sync.js: channels are counted, sent once, dropped at zero, and resent after a reconnect
  const conn = new SyncConnection({ transport: {}, orgId: 'org', peerId: ME, logger: { warn() {}, error() {} } });
  const cmds = []; conn._command = async (c) => { cmds.push([c.case, c.value.channelId || c.value.documentId]); return {}; };
  conn.connected = true;
  await conn.subscribeEphemeralChannel(DOC); await conn.subscribeEphemeralChannel(DOC);
  await conn.unsubscribeEphemeralChannel(DOC);
  assert.deepEqual(cmds, [['subscribeEphemeralChannel', DOC]], 'two holders, one subscription, still held');
  await conn.unsubscribeEphemeralChannel(DOC);
  assert.deepEqual(cmds.at(-1), ['unsubscribeEphemeralChannel', DOC]);
  assert.equal(await conn.sendEphemeral(DOC, new Uint8Array([1])), true);
  conn._command = async () => { throw new Error('refused'); };
  assert.equal(await conn.viewingHeartbeat(DOC), false, 'presence is best effort: a refusal is false, never a throw');
  conn.connected = false;
  assert.equal(await conn.sendEphemeral(DOC, new Uint8Array([1])), false, 'nothing is sent while disconnected');
  console.log('presence-check ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
