'use strict';
// Presence in the app (issue #14), over sdk/presence.js: who else is in the documents on screen (the page you have
// open and the document rows listed on it) and on which block, and being seen there ourselves. One room per document,
// counted per holder, closed when the last one lets go. This connection is never shown (it is you, here); your own
// other tabs and devices are, marked as you, which is also how presence can be tried alone: open the node in Tana.
const { openPresence, userHashOf, HEARTBEAT_MS } = require('../sdk/presence');
const { cursorAt } = require('../sdk/content');
const { S, send, report } = require('./state');

const rooms = new Map(); // docId -> { count, client, handle: Promise<handle>, sent }
const myName = () => { const u = (S.me && S.me.user) || {}; return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Orbital'; };
// What the renderer draws: one entry per peer, on the block their caret is in (null: in the document, no caret); me =
// your own other tab or device.
function peersOf(handle) {
  const mine = S.client ? userHashOf(S.client.sync.peerId) : null;
  return handle.peers().map((p) => ({ peer: p.peer, userHash: p.userHash, me: p.userHash === mine, name: (p.user && p.user.name) || 'Someone',
    blockId: (p.focusBlock && p.focusBlock.blockId) || (p.anchorBlock && p.anchorBlock.blockId) || null, editing: p.hasCursor }));
}
function open(docId) {
  if (!S.client || typeof docId !== 'string') return false;
  let room = rooms.get(docId);
  if (room && room.client !== S.client) { close(docId, true); room = null; } // a new login: the old connection's room is gone
  if (room) { room.count++; return true; }
  room = { count: 1, client: S.client, sent: '' };
  room.handle = openPresence(S.client.sync, docId).then((handle) => {
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
// The page on screen gets Tana's viewing heartbeat, and only that one.
// ponytail: it runs while the page is open, not only while the window is visible and you are active (Tana's rule)
let viewed = null, beat = null;
function view(docId) {
  if (docId === viewed) return;
  viewed = typeof docId === 'string' ? docId : null;
  clearInterval(beat); beat = null;
  if (!viewed || !S.client) return;
  const once = () => S.client && S.client.sync.viewingHeartbeat(viewed);
  once(); beat = setInterval(once, HEARTBEAT_MS);
}
// Where your caret is in that document: { blockId, anchor, focus } (character offsets as the outline counts them), or
// null for "not editing in it". Sent with Loro cursors when the document is loaded here, so Tana draws an exact caret.
function set(docId, at) {
  const room = rooms.get(docId), key = JSON.stringify(at || null);
  if (!room || room.sent === key) return;
  room.sent = key;
  room.handle.then((h) => {
    if (!at) return h.clearLocal();
    const doc = S.client && S.client.sync.getDocument(docId);
    const bytes = (offset) => { try { const c = doc && cursorAt(doc, at.blockId, offset); return c ? c.encode() : null; } catch { return null; } };
    h.setLocal({ user: { name: myName() }, anchorBlock: { blockId: at.blockId, offset: at.anchor }, focusBlock: { blockId: at.blockId, offset: at.focus },
      anchor: bytes(at.anchor), focus: bytes(at.focus) });
  }, () => {});
}

module.exports = { open, close, view, set, peersOf };
