'use strict';
// What the phone keeps live while Tana is connected, as the desktop keeps what is on screen live (renderer/app.js
// onChanged, main/related.js watchRelated): a page opened on the phone is read again when it changes, and the Timeline
// when what it lists moves. Nothing polls. A page's own document is held subscribed (index.js hold), so its changes
// arrive on the sync stream; what a page lists (a saved search, a meeting's documents) and what the Timeline follows are
// Tana's live queries (sdk/livequery.js), as on the desktop. The app hears 'changed:<id>' for a page and 'changed' for
// the Timeline (index.js S.win), and reads that again (Engine.swift and Engine.kt said).
const { openLiveQuery } = require('../../sdk/livequery');
const { STATE_TYPES } = require('../../sdk/node');

const PAGES = 12; // the pages heard, the newest opened: as many as held.js keeps (KEEP)
const LISTS = 4; // of those, the newest whose list is kept live by a query of its own
const SETTLE = 300; // ms: a burst of changes (an answer being written) is one read
// what of a task the Timeline shows: its words and its state (an edit's own words come from Tana's summaries, written
// later, so a change to anything else would only read the same page again)
const shown = (r) => JSON.stringify([r.title, r.state && r.state.type, r.archivedAt]);
const moves = (r) => JSON.stringify([r.state && r.state.type, r.state && r.state.enteredAt]);

// sync: the client's SyncConnection; me: your user-profile uri; post(message) tells the app; moved() reads the Timeline
// again; open: openLiveQuery (the checks pass their own)
function createLive({ sync, me, post, moved, open = openLiveQuery }) {
  const pages = new Map(); // page id -> what its list's live query is (a function, asked again as it changes), newest last
  const lists = new Map(), followed = new Map(); // key -> { json, handle }: the pages' queries and the Timeline's
  const timers = new Map();
  let day = null; // today's node, whose tasks are among Today's Tasks

  const tell = (id) => { if (!timers.has(id)) timers.set(id, setTimeout(() => { timers.delete(id); post('changed:' + id); }, SETTLE)); };
  const stop = (map, key) => { const was = map.get(key); map.delete(key); if (was) was.handle.then((h) => h && h.close().catch(() => {})); };
  // The live query behind a key, opened again only when what it asks changed; null closes it. A refusal leaves the page
  // as it is: pulling it still reads it.
  function keep(map, key, query, label, onRows) {
    const json = JSON.stringify(query), was = map.get(key);
    if (was && was.json === json) { map.delete(key); map.set(key, was); return; } // newest last
    if (was) stop(map, key);
    if (!query) return;
    map.set(key, { json, handle: Promise.resolve().then(() => open(sync, query, { label, onRows })).then((h) => { h.on('error', () => {}); return h; }, () => null) });
  }
  // a query's answers that move what is drawn: fn says what of a row counts; the first answer is what was just read
  const changes = (fn) => {
    const seen = new Map();
    return ({ added, removed, changed, initial }) => {
      let moved = !initial && (added.length > 0 || removed.length > 0);
      for (const r of [...added, ...changed]) { const s = fn(r); if (seen.has(r.uri) && seen.get(r.uri) !== s) moved = true; seen.set(r.uri, s); }
      for (const uri of removed) seen.delete(uri);
      return moved;
    };
  };
  function listen(id) {
    // in the sync stream's change listener: a search that cannot be read throws nowhere (the listeners after this one,
    // main/timeline.js's calls among them, would not hear the change), and its page only loses its list's query
    let query = null;
    try { query = pages.get(id)(); } catch { /* unreadable: no list */ }
    keep(lists, id, query, 'Orbital phone page', () => tell(id));
    while (lists.size > LISTS) stop(lists, lists.keys().next().value);
  }

  // The Timeline's own: a task landing in your Inbox, and a task you made moving (someone completing what you gave them)
  const inbox = changes(shown), mine = changes(moves);
  keep(followed, 'inbox', { types: ['text'], stateTypes: ['proposed'], assignedTo: [me], orderBy: ['-createdAt'], limit: 50 }, 'Orbital phone Inbox', (e) => { if (inbox(e)) moved(); });
  keep(followed, 'mine', { types: ['text'], createdBy: [me], stateTypes: STATE_TYPES, orderBy: ['-updatedAt'], limit: 200 }, 'Orbital phone tasks you made', (e) => { if (mine(e)) moved(); });

  sync.on('change', (id) => {
    if (pages.has(id)) { tell(id); listen(id); } // a saved search saved with another query is listened to with that one
    if (id === day || /^tana:pin-map:/.test(id)) moved(); // a task added to today's node or pinned to a day, here or elsewhere
  });

  return {
    // a page just read (index.js open): heard from now on. list() is the live query its rows come from, or null.
    page(id, list = () => null) {
      pages.delete(id);
      pages.set(id, list);
      while (pages.size > PAGES) { const old = pages.keys().next().value; pages.delete(old); stop(lists, old); }
      listen(id);
    },
    // the Timeline just read (index.js timeline): its tasks, wherever they are on it, and today's node
    timeline(rows) {
      const ids = new Set();
      let today = null;
      const walk = (list) => {
        for (const r of list || []) {
          if (r.timeline && r.timeline.today) today = r.timeline.day || null;
          for (const uri of [r.id, r.timeline && r.timeline.uri]) if (/^tana:text:/.test(uri || '')) ids.add(uri);
          walk(r.children);
        }
      };
      walk(rows);
      day = today;
      const uris = [...ids].sort().slice(0, 200), seen = changes(shown);
      keep(followed, 'shown', uris.length ? { uris, limit: uris.length } : null, 'Orbital phone Timeline tasks', (e) => { if (seen(e)) moved(); });
    },
  };
}

module.exports = { createLive, PAGES, LISTS, SETTLE };
