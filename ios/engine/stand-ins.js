'use strict';
// What main/timeline.js asks of the desktop, for the phone (ios/engine/build.js maps each require here). Today's pins
// and today's node are read over the sync stream with the SDK's own code, as main/pins.js reads them; the watch choices
// in the settings document, live queries and call state still answer empty. The banner edits never reach the phone:
// they are kept on the Mac that announced them.
// ponytail: watch choices and live meetings are empty; add them from the settings document and sdk/livequery.js.
const { isMcp, S, today } = require('../../main/state');
const pins = require('../../sdk/pins');

const issues = []; // a part that failed, for the app's Details log (index.js orbital.issues)
// A read over the sync stream, given up after 8 s: main/timeline.js waits for every part before it answers, so a stream
// that never opens would otherwise keep the whole Timeline from showing.
const within = (what, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('no answer in 8 s')), 8000))])
  .catch((e) => { issues.push(what + ': ' + (e && e.message || e)); throw e; });
const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));

module.exports = {
  issues,
  // node:crypto, as the SDK files in the bundle use it
  randomUUID: () => crypto.randomUUID(),
  randomBytes: bytes,
  createHash() { throw new Error('createHash is not on the phone'); },
  // ../db
  setting: (key) => JSON.parse(localStorage.getItem('orbital:' + key) ?? 'null'),
  setSetting: (key, value) => localStorage.setItem('orbital:' + key, JSON.stringify(value)),
  // ./rows: a task under a row needs its id, words and state (ios/Orbital/Timeline.swift)
  graphRow: (n) => ({ id: n.id, title: n.title || 'Untitled', text: n.title || 'Untitled', done: (n.state && n.state.type) === 'closed' }),
  toNode: (row) => row,
  rememberNodeHue() {},
  hm: (ms) => { const d = new Date(ms); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); }, // sdk/chat.js hm
  isAllDay(start, end, allDayFlag) { // main/rows.js isAllDay
    const s = new Date(start), e = end ? new Date(end) : null;
    const midnight = s.getUTCHours() + s.getUTCMinutes() === 0 || s.getHours() + s.getMinutes() === 0;
    return allDayFlag === true || !!(e && midnight && (e - s) % 864e5 === 0);
  },
  members: () => S.client.graph.listNodes({ nodeTypes: ['user-profile'], limit: 500 }).then(({ nodes }) => nodes.map((n) => ({ id: n.id, title: n.title }))),
  // ./views inboxFrom
  inboxFrom(me, creator, chat, names) {
    if (creator && creator !== me) return 'From ' + (names.get(creator) || 'someone else');
    if (!chat) return null;
    const topic = /^MCP:\s*(.+)/i.exec(chat.title || '')?.[1];
    return isMcp(chat) ? 'Via MCP' + (topic ? ': ' + topic : '') : "From Tana's AI";
  },
  // ./documents
  announcedEdits: () => [],
  notifyWatchedIds: () => new Set(),
  notifySilencedIds: () => new Set(),
  document: (id) => within('reading ' + id, S.client.sync.subscribe(id)),
  // ./pins: main/pins.js pinnedDates, and todayNode(0, true), which finds today's node and never makes it
  pinnedDates: () => within('date pins', pins.datePins(S.client.sync, S.me.userUri)).catch(() => ({})),
  async todayNode() {
    const title = today();
    const { nodes = [] } = await S.client.graph.listNodes({ textQuery: title, nodeTypes: ['text'], createdBy: [S.me.userUri], limit: 20 });
    const node = nodes.find((n) => (n.title || '').trim().toLowerCase() === title);
    if (!node) throw new Error('no node for ' + title);
    return node.id;
  },
  // ../sdk/livequery, ../sdk/calls
  openLiveQuery: async () => ({ on() {}, close: async () => {} }),
  callState: () => ({ recordings: [], offTheRecord: false }),
  callSessions: () => ({ sessions: [] }),
};
