'use strict';
// The documents the phone holds subscribed for what it shows (index.js). One a page opened or wrote to (hold) stays while
// it is among the last KEEP, then is let go of, as the desktop lets its on-demand reads go (main/documents.js onDemand): a
// subscription holds the whole document, and a chat can be megabytes. One held for something else (the Timeline's) is
// never ours to let go. One only looked at (peek: a type, a saved search's query as the menu lists them) is let go of
// once read and never takes a page's place: listed through hold, the menu's every saved search pushed the page on screen
// out, and its changes (an answer being written, live.js) stopped.
const KEEP = 12;

// sync(): the client's SyncConnection now; within(what, promise): the engine's give-up (stand-ins.js)
function createHeld(sync, within) {
  const kept = [], peeking = new Set();
  // init makes a new document (sdk/sync.js subscribe); it is counted before the wait, so one that times out is still let go.
  // One a peek has open is ours: the peek leaves it subscribed.
  async function hold(id, init) {
    const had = !!sync().getDocument(id) && !peeking.has(id), at = kept.indexOf(id);
    if (at >= 0) kept.splice(at, 1);
    if (at >= 0 || !had) kept.push(id); // newest last
    while (kept.length > KEEP) sync().unsubscribe(kept.shift()).catch(() => {}); // drains queued writes first
    return within('opening ' + id, sync().subscribe(id, init));
  }
  // read(document): what is wanted of it
  async function peek(id, read) {
    const mine = !sync().getDocument(id);
    if (mine) peeking.add(id);
    try { return read(await within('reading ' + id, sync().subscribe(id))); } finally {
      if (mine) { peeking.delete(id); if (!kept.includes(id)) sync().unsubscribe(id).catch(() => {}); }
    }
  }
  return { hold, peek, forget: () => { kept.length = 0; } }; // forget: another account's client
}

module.exports = { createHeld, KEEP };
