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
  // one listener per connection however many rooms are open (a list opens one per row)
  const many = await Promise.all(Array.from({ length: 25 }, (_, i) => openPresence(sync, 'tana:text:01row' + String(i).padStart(22, '0'))));
  assert.deepEqual([sync.listenerCount('ephemeral'), sync.listenerCount('connected')], [1, 1], 'rooms share the connection listeners');
  await Promise.all(many.map((r) => r.close()));
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
  // a subscribe the server refuses is not held: the next holder sends it again rather than counting on a channel it never got
  const ok = conn._command, refuse = async () => { throw new Error('refused'); };
  conn._command = refuse;
  await assert.rejects(conn.subscribeEphemeralChannel(DOC), /refused/);
  assert.equal(conn.channels.has(DOC), false, 'a refused subscribe leaves no count behind');
  conn._command = ok;
  await conn.subscribeEphemeralChannel(DOC);
  assert.deepEqual(cmds.at(-1), ['subscribeEphemeralChannel', DOC], 'and the next holder subscribes it');
  await conn.unsubscribeEphemeralChannel(DOC);
  // ...and openPresence leaves no room behind to answer frames and reconnects for a handle nobody has
  const failing = new EventEmitter();
  Object.assign(failing, { peerId: ME, calls: [], subscribeEphemeralChannel: refuse, viewingHeartbeat: async (id) => failing.calls.push(id), sendEphemeral: async () => true });
  await assert.rejects(openPresence(failing, DOC, { viewing: true }), /refused/);
  failing.emit('connected');
  assert.deepEqual(failing.calls, [], 'a room that never opened sends no viewing heartbeat on a reconnect');
  assert.equal(await conn.sendEphemeral(DOC, new Uint8Array([1])), true);
  conn._command = async () => { throw new Error('refused'); };
  assert.equal(await conn.viewingHeartbeat(DOC), false, 'presence is best effort: a refusal is false, never a throw');
  // presence commands queue behind four in flight, however many rooms open at once
  let busy = 0, peak = 0; const release = [];
  conn._command = () => { busy++; peak = Math.max(peak, busy); return new Promise((r) => release.push(() => { busy--; r({}); })); };
  const burst = Array.from({ length: 12 }, (_, i) => conn.subscribeEphemeralChannel('tana:text:01burst' + String(i).padStart(20, '0')));
  while (release.length || busy || conn._light.length || conn._lightBusy) { await tick(1); release.splice(0).forEach((f) => f()); }
  await Promise.all(burst);
  assert.equal(peak, 4, 'at most four presence commands in flight');
  conn.connected = false;
  assert.equal(await conn.sendEphemeral(DOC, new Uint8Array([1])), false, 'nothing is sent while disconnected');
  // main/presence.js: rooms are counted per document, a caret is told once per move, and your own other tabs are not shown
  {
    const state = require('../main/state'), presence = require('../main/presence');
    const sent = [], wire = new EventEmitter();
    // a real document holding the block the caret is in, so the caret can go out as Loro cursors
    const { Document } = require('../sdk/document'), content = require('../sdk/content');
    const page = new Document(DOC), b3 = content.insertAfter(page, null, 'x');
    content.setText(page, b3, [{ text: 'Hi ' }, { mention: { label: 'Rob', uri: 'tana:user-profile:rob' } }, { text: ' there' }]);
    Object.assign(wire, { peerId: ME, subscribeEphemeralChannel: async () => {}, unsubscribeEphemeralChannel: async (id) => sent.push(['unsub', id]),
      sendEphemeral: async (id, data) => { sent.push(['send', id, data]); return true; }, viewingHeartbeat: async (id) => { sent.push(['view', id]); return true; }, getDocument: (id) => (id === DOC ? page : undefined) });
    state.S.client = { sync: wire }; state.S.me = { user: { firstName: 'Andre', lastName: 'Foeken' } };
    const told = []; state.S.win = { isDestroyed: () => false, webContents: { send: (...a) => told.push(a) } };
    const client = state.S.client; state.S.client = null;
    assert.equal(await presence.open(DOC), false, 'no connection yet: refused, so the renderer asks again');
    state.S.client = client;
    assert.equal(await presence.open(DOC), true); assert.equal(await presence.open(DOC), true);
    await tick();
    wire.emit('ephemeral', DOC, remote(OTHER, { user: { name: 'Stan' }, anchorBlockId: 'b1', anchorBlockOffset: 0 }).out[0]);
    wire.emit('ephemeral', DOC, remote(MY_OTHER_TAB, { user: { name: 'Andre' }, anchorBlockId: 'b2', anchorBlockOffset: 0 }).out[0]);
    const last = told.filter((t) => t[0] === 'presence:changed').at(-1);
    assert.deepEqual(last[2].map((p) => [p.name, p.blockId, p.editing, p.me]), [['Stan', 'b1', true, false], ['Andre', 'b2', true, true]], 'everyone on their block, your own other tab marked as you; this connection never');
    presence.set(DOC, { blockId: b3, anchor: 8, focus: 8 }); presence.set(DOC, { blockId: b3, anchor: 8, focus: 8 }); await tick();
    const mine = sent.filter((s) => s[0] === 'send');
    assert.equal(mine.length, 1, 'one send per caret move');
    const them = new EphemeralStore(30000); them.apply(mine[0][2]);
    const entry = them.getAllStates()[ME];
    assert.deepEqual([entry.user, entry.anchorBlockId, entry.anchorBlockOffset, entry.focusBlockOffset], [{ name: 'Andre Foeken' }, b3, 6, 6], 'seen under your name, on your block, at Tana\'s position (the mention counts one)');
    // the exact caret: a Loro cursor Tana can resolve, in the second text run ('Hi ' + 'Rob' + ' t|here')
    const pos = page.loro.getCursorPos(require('loro-crdt').Cursor.decode(entry.anchor));
    assert.equal(pos.offset, 2, 'offset 8 is two characters into the text after the mention');
    // a Tana caret arrives in its positions and is drawn at the outline's character: 4 (just after the mention) is 6
    wire.emit('ephemeral', DOC, remote(OTHER, { user: { name: 'Stan' }, anchorBlockId: b3, anchorBlockOffset: 4, focusBlockId: b3, focusBlockOffset: 5 }).out[0]);
    const stan = told.filter((x) => x[0] === 'presence:changed').at(-1)[2].find((p) => p.name === 'Stan');
    assert.deepEqual([stan.blockId, stan.offset], [b3, 7], 'the head of the selection, converted to the outline\'s count');
    assert.deepEqual([0, 3, 4, 5, 10, 99].map((p) => content.charOffset(page, b3, p)), [0, 3, 6, 7, 12, 12], 'Tana position -> character');
    assert.deepEqual([0, 3, 4, 6, 8, 12].map((o) => content.blockOffset(page, b3, o)), [0, 3, 3, 4, 6, 10], 'character -> Tana position (inside a mention: before it)');
    assert.equal(content.charOffset(page, 'nope', 1), null);
    // Tana does not re-send while you type on (its cursor is anchored to a character), so its block offset goes stale;
    // the cursor bytes are read instead, and an edit to the document redraws without any presence message
    await tick(2); // a second store for the same peer: in the same millisecond EphemeralStore keeps the older entry
    const typing = remote(OTHER, { user: { name: 'Stan' }, anchor: content.cursorAt(page, b3, 8).encode(), anchorBlockId: b3, anchorBlockOffset: 0, focusBlockId: b3, focusBlockOffset: 0 });
    wire.emit('ephemeral', DOC, typing.out[0]);
    const heard = () => told.filter((x) => x[0] === 'presence:changed').at(-1)[2].find((p) => p.name === 'Stan');
    assert.deepEqual([heard().blockId, heard().offset], [b3, 8], 'the cursor, not the stale offset 0');
    const run = page.content.get('children').get(0).get('children').get(2);
    page.transact(() => run.insert(1, 'XX'));
    wire.emit('change', DOC, { origin: 'remote' });
    assert.equal(heard().offset, 10, 'text typed before it moves it, on the edit alone');
    assert.deepEqual(content.cursorOffset(page, content.cursorAt(page, b3, 4).encode()), { blockId: b3, offset: 3 }, 'a cursor at a mention reads as just before it');
    assert.equal(content.cursorOffset(page, new Uint8Array([1, 2, 3])), null, 'bytes that are no cursor here: null');
    presence.set(DOC, null); await tick();
    them.apply(sent.filter((s) => s[0] === 'send').at(-1)[2]);
    assert.equal(them.getAllStates()[ME], undefined, 'leaving the outline takes the caret away');
    presence.view(DOC); presence.view(DOC);
    assert.equal(sent.filter((s) => s[0] === 'view').length, 1, 'the page on screen gets the heartbeat, once per change of page');
    presence.view(null);
    // a split (issue #159): the heartbeat is the last asker's. The other half letting go leaves it running; the half that
    // has it letting go stops it and asks every page to say again what it views, and the one still on screen takes it.
    const beats = () => sent.filter((s) => s[0] === 'view').length;
    presence.view('tana:text:left', 1); presence.view(DOC, 2);
    const running = beats(); told.length = 0;
    presence.view(null, 1); presence.view(DOC, 2);
    assert.equal(beats(), running, 'the left half closing leaves the right half beating: no restart, no stop');
    assert.equal(told.some((t) => t[0] === 'presence:ask'), false, 'nothing to hand over');
    presence.view(null, 2);
    assert.ok(told.some((t) => t[0] === 'presence:ask'), 'the half with the heartbeat closing asks the others back');
    presence.view('tana:text:left', 1);
    assert.deepEqual(sent.filter((s) => s[0] === 'view').at(-1), ['view', 'tana:text:left'], 'and the half left on screen takes it');
    presence.view(null, 1);
    // content.cursorAt: text runs, a mention counted as its label, and past the end
    const at = (o) => { const c = content.cursorAt(page, b3, o); return c && page.loro.getCursorPos(c).offset; };
    assert.deepEqual([at(0), at(3), at(4), at(6), at(12), at(99)], [0, 3, 1, 0, 6, 3], 'text run, end of run, inside the mention (list index), right after it, end, past the end');
    assert.equal(content.cursorAt(page, 'nope', 1), null);
    presence.close(DOC); await tick();
    assert.equal(sent.some((s) => s[0] === 'unsub'), false, 'still held once');
    presence.close(DOC); await tick();
    assert.deepEqual(sent.at(-1), ['unsub', DOC], 'closed with the last holder');
  }
  console.log('presence-check ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
