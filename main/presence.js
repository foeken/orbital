'use strict';
// Presence in the app (issue #14), over sdk/presence.js: who else is in the document on screen and on which block, and
// being seen there ourselves. One room per document the renderer has open (refcounted), closed when it leaves.
// Your own other tabs and devices are left out of what is shown: they are you.
const { openPresence, userHashOf } = require('../sdk/presence');
const { S, send, report } = require('./state');

const rooms = new Map(); // docId -> { count, client, handle: Promise<handle>, block }
const myName = () => { const u = (S.me && S.me.user) || {}; return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Orbital'; };
// What the renderer draws: one entry per person, on the block their caret is in (null: in the document, no caret).
function peersOf(handle) {
  const mine = S.client ? userHashOf(S.client.sync.peerId) : null;
  return handle.peers({ exceptUserHash: mine }).map((p) => ({ peer: p.peer, userHash: p.userHash, name: (p.user && p.user.name) || 'Someone',
    blockId: (p.focusBlock && p.focusBlock.blockId) || (p.anchorBlock && p.anchorBlock.blockId) || null, editing: p.hasCursor }));
}
function open(docId) {
  if (!S.client || typeof docId !== 'string') return false;
  let room = rooms.get(docId);
  if (room && room.client !== S.client) { close(docId, true); room = null; } // a new login: the old connection's room is gone
  if (room) { room.count++; return true; }
  room = { count: 1, client: S.client, block: undefined };
  // ponytail: the heartbeat runs while the page is open, not only while the window is visible and you are active (Tana's rule)
  room.handle = openPresence(S.client.sync, docId, { viewing: true }).then((handle) => {
    const tell = () => send('presence:changed', docId, peersOf(handle));
    handle.on('change', tell);
    tell();
    return handle;
  });
  room.handle.catch((e) => { rooms.delete(docId); report(e); });
  rooms.set(docId, room);
  return true;
}
function close(docId, all = false) {
  const room = rooms.get(docId);
  if (!room || (!all && --room.count > 0)) return;
  rooms.delete(docId);
  room.handle.then((h) => h.close(), () => {});
}
// Where your caret is in that document: a block id, or null for "not editing in it" (blurred, window left).
function set(docId, blockId) {
  const room = rooms.get(docId);
  if (!room || room.block === blockId) return;
  room.block = blockId;
  room.handle.then((h) => (blockId ? h.setLocal({ user: { name: myName() }, anchorBlock: { blockId, offset: 0 } }) : h.clearLocal()), () => {});
}

module.exports = { open, close, set, peersOf };
