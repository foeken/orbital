'use strict';
// Presence in the app (issue #14), over sdk/presence.js: who else is in the page on screen and
// on which block, and being seen there ourselves. One room per document,
// counted per holder, closed when the last one lets go. This connection is never shown (it is you, here); your own
// other tabs and devices are, marked as you, which is also how presence can be tried alone: open the node in Tana.
const { openPresence, userHashOf, HEARTBEAT_MS } = require('../sdk/presence');
const { cursorAt, cursorOffset, charOffset, blockOffset } = require('../sdk/content');
const { S, pageKey, send, report } = require('./state');

const rooms = new Map(); // docId -> { count, client, handle: Promise<handle>, sent }
const myName = () => { const u = (S.me && S.me.user) || {}; return [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Orbital'; };
// What the renderer draws: one entry per peer, on the block their caret is in (null: in the document, no caret), at
// offset (the head of their selection, as the outline counts characters; null when the document is not loaded here to
// convert Tana's position with); me = your own other tab or device.
function peersOf(handle, docId) {
  const mine = S.client ? userHashOf(S.client.sync.peerId) : null, doc = S.client && S.client.sync.getDocument(docId);
  return handle.peers().map((p) => {
    // The Loro cursor first: it is anchored to a character, so it is right after text typed since it was set. Tana only
    // re-sends an entry when that cursor changes, so its block offset stays where the caret entered a node (0 in a new
    // one) while you type on. The block offset is the fallback: no cursor, or its container not synced here yet.
    const at = p.focusBlock || p.anchorBlock;
    let where = null;
    try { where = doc && (p.focus || p.anchor) ? cursorOffset(doc, p.focus || p.anchor) : null; } catch { where = null; }
    if (!where && at && doc) { try { const offset = charOffset(doc, at.blockId, at.offset); where = offset == null ? null : { blockId: at.blockId, offset }; } catch { where = null; } }
    return { peer: p.peer, userHash: p.userHash, me: p.userHash === mine, name: (p.user && p.user.name) || 'Someone',
      blockId: where ? where.blockId : at ? at.blockId : null, offset: where ? where.offset : null, editing: p.hasCursor };
  });
}
// Resolves to whether the room is open, so the renderer can ask again: before the connection exists (a launch that
// restores a page renders it first) there is nothing to open it on, and a room that failed to open is not one.
function open(docId) {
  if (!S.client || typeof docId !== 'string') return Promise.resolve(false);
  let room = rooms.get(docId);
  if (room && room.client !== S.client) { close(docId, true); room = null; } // a new login: the old connection's room is gone
  if (room) { room.count++; return room.handle.then(() => true, () => false); }
  room = { count: 1, client: S.client, sent: '' };
  hookEdits(S.client);
  room.handle = openPresence(S.client.sync, docId).then((handle) => {
    let empty = false;
    // said on every presence change, and on every edit of the document while anyone is in it (hookEdits)
    room.tell = () => { const peers = peersOf(handle, docId); if (!peers.length && empty) return; empty = !peers.length; send('presence:changed', docId, peers); };
    handle.on('change', room.tell);
    room.tell();
    return handle;
  });
  room.handle.catch((e) => { if (rooms.get(docId) === room) rooms.delete(docId); report(e); });
  rooms.set(docId, room);
  return room.handle.then(() => true, () => false);
}
// Typing moves a caret without a presence message (its cursor is anchored to a character), and a new node's caret can
// arrive before the node does: so an edit to a document with a room redraws its carets. One listener per connection.
const hooked = new WeakSet();
function hookEdits(client) {
  if (hooked.has(client)) return;
  hooked.add(client);
  client.sync.on('change', (id) => { const room = rooms.get(id); if (room && room.tell) room.tell(); });
}
function close(docId, all = false) {
  const room = rooms.get(docId);
  if (!room || (!all && --room.count > 0)) return;
  rooms.delete(docId);
  room.handle.then((h) => h.close(), () => {});
}
// The page on screen gets Tana's viewing heartbeat, and only that one.
// ponytail: it runs while the page is open, not only while the window is visible and you are active (Tana's rule)
// by: the page asking (its page id, main/state.js pageKey). A page's null ends only a heartbeat it started, so a split half or another
// window closing leaves the one on screen beating. When a page does end it, every page is asked to say again what it
// views ('presence:ask', renderer/presence.js): the one still on screen and in use takes the heartbeat back.
let viewed = null, beat = null, viewer = null;
function view(docId, by = null) {
  if (docId == null && by !== viewer) return;
  viewer = by;
  if (docId === viewed) return;
  const ended = viewed && docId == null;
  viewed = typeof docId === 'string' ? docId : null;
  clearInterval(beat); beat = null;
  if (ended) send('presence:ask');
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
    // the block offsets in Tana's own units (a mention is one position), which is what its editor falls back to
    const tanaAt = (offset) => { try { const p = doc && blockOffset(doc, at.blockId, offset); return p == null ? offset : p; } catch { return offset; } };
    h.setLocal({ user: { name: myName() }, anchorBlock: { blockId: at.blockId, offset: tanaAt(at.anchor) }, focusBlock: { blockId: at.blockId, offset: tanaAt(at.focus) },
      anchor: bytes(at.anchor), focus: bytes(at.focus) });
  }, () => {});
}

const openIds = () => [...rooms.keys()]; // the documents on screen in some page, which the refresh never lets go of
// What the renderer asks this module (preload.js names each channel for the page; main.js registers the table).
const ipc = {
  // the renderer opens a room per document on screen, names the one being viewed, and says where its caret is
  'presence:open': (_e, id) => open(id),
  'presence:close': (_e, id) => close(id),
  'presence:view': (e, id) => view(id, pageKey(e)), // per page: one half going away cannot end the other's heartbeat
  'presence:set': (_e, id, at) => set(id, at && typeof at.blockId === 'string' ? { blockId: at.blockId, anchor: Number(at.anchor) || 0, focus: Number(at.focus) || 0 } : null),
};

module.exports = { open, close, view, set, peersOf, openIds, ipc };
