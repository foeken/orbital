'use strict';
// Presence: who is in a document right now, and where their cursor is. Tana's editor shares cursors over an ephemeral
// channel named by the document uri (subscribeEphemeralChannel on the sync stream): each peer keeps one entry in a
// Loro EphemeralStore, keyed by its peer id, and every change travels as that store's own update bytes. An entry is
// removed when its editor leaves, and expires once it has not been refreshed for the store's timeout (30 s).
//
//   entry = { anchor, focus,            Loro Cursor bytes (Cursor.decode + doc.getCursorPos to resolve), or null
//             anchorBlockId, anchorBlockOffset, focusBlockId, focusBlockOffset,   the same, as block id + offset
//             user: { name, color },    how Tana labels the caret
//             scope }                   which editor on the page (null for the document's own)
//
// A peer id is the user's hash in its top bits and a random tab number in the low 16 (sync.derivePeerId), so every
// entry says which user it is without a lookup: userHash. Nothing here is stored; everything is gone on close.
const { EventEmitter } = require('node:events');
const { EphemeralStore } = require('loro-crdt');

const TIMEOUT_MS = 30000, HEARTBEAT_MS = 10000;
const userHashOf = (peer) => { try { return (BigInt(peer) >> 16n).toString(); } catch { return null; } };
const block = (id, offset) => (id != null && offset != null ? { blockId: id, offset } : null);
function readEntry(peer, s) {
  return { peer, userHash: userHashOf(peer), user: s.user || null, scope: s.scope ?? null,
    hasCursor: !!(s.anchor || s.focus || s.anchorBlockId || s.focusBlockId),
    anchorBlock: block(s.anchorBlockId, s.anchorBlockOffset), focusBlock: block(s.focusBlockId, s.focusBlockOffset),
    anchor: s.anchor || null, focus: s.focus || null };
}

// Opens a document's presence channel. Emits 'change' { added, updated, removed } (peer ids) whenever someone else's
// entry arrives, moves, leaves or expires. { viewing: true } also sends the viewing heartbeat while open.
async function openPresence(sync, documentId, { timeout = TIMEOUT_MS, viewing = false } = {}) {
  const store = new EphemeralStore(timeout), handle = new EventEmitter(), me = String(sync.peerId);
  let local = null, refresh = null, beat = null;
  const onMessage = (id, data) => { if (id === documentId && data && data.length) store.apply(data); };
  const unsubscribe = store.subscribe((e) => { if (e.by !== 'local') handle.emit('change', { added: e.added, updated: e.updated, removed: e.removed, by: e.by }); });
  const offLocal = store.subscribeLocalUpdates((bytes) => { sync.sendEphemeral(documentId, bytes); });
  // after a reconnect the others no longer have our entry: set it again, which sends it
  const onConnected = () => { if (local) store.set(me, local); if (viewing) sync.viewingHeartbeat(documentId); };
  sync.on('ephemeral', onMessage);
  sync.on('connected', onConnected);
  await sync.subscribeEphemeralChannel(documentId);
  if (viewing) { sync.viewingHeartbeat(documentId); beat = setInterval(() => sync.viewingHeartbeat(documentId), HEARTBEAT_MS); }

  handle.documentId = documentId;
  handle.peerId = me;
  // Everyone in the document but this connection; { exceptUserHash } also leaves out your other tabs and devices.
  handle.peers = ({ exceptUserHash } = {}) => Object.entries(store.getAllStates())
    .filter(([peer, s]) => s && peer !== me && (!exceptUserHash || userHashOf(peer) !== String(exceptUserHash)))
    .map(([peer, s]) => readEntry(peer, s));
  // The ones with a caret in it: someone is editing, which is what "wait until they are done" asks.
  handle.editing = (opts) => handle.peers(opts).filter((p) => p.hasCursor);
  // Be seen: a caret at a block (and a selection when focus differs), labelled with user { name, color }. anchor and
  // focus are Loro Cursor bytes (content.cursorAt(...).encode()), which is what Tana draws an exact caret from; the
  // block and offset alone still say where. Refreshed at half the timeout so it does not expire while it stands.
  // clearLocal (or close) takes it away.
  handle.setLocal = ({ user = null, anchorBlock = null, focusBlock = anchorBlock, anchor = null, focus = anchor, scope = null } = {}) => {
    local = { anchor, focus, user, scope,
      anchorBlockId: anchorBlock ? anchorBlock.blockId : null, anchorBlockOffset: anchorBlock ? anchorBlock.offset : null,
      focusBlockId: focusBlock ? focusBlock.blockId : null, focusBlockOffset: focusBlock ? focusBlock.offset : null };
    store.set(me, local);
    clearInterval(refresh);
    refresh = setInterval(() => store.set(me, local), Math.max(1000, timeout / 2));
  };
  handle.clearLocal = () => { clearInterval(refresh); refresh = null; if (local) { local = null; store.delete(me); } };
  handle.close = async () => {
    handle.clearLocal();
    clearInterval(beat);
    sync.off('ephemeral', onMessage); sync.off('connected', onConnected);
    unsubscribe(); offLocal();
    await sync.unsubscribeEphemeralChannel(documentId);
    store.destroy();
  };
  return handle;
}

module.exports = { openPresence, userHashOf, readEntry, TIMEOUT_MS, HEARTBEAT_MS };
