'use strict';
// What main/timeline.js asks of the desktop, for the phone (ios/engine/build.js maps each require here). The parts that
// need the sync stream answer empty for now: today's pins and today's node, the watch choices in the settings document,
// live queries and call state. The banner edits never reach the phone: they are kept on the Mac that announced them.
// ponytail: pins, watch choices and live meetings wait on the sync stream in the web view; add them with it.
const { isMcp } = require('../../main/state');

const sync = { on() {}, getDocument() {}, subscribe: async () => {}, unsubscribe: async () => {} };
const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));

module.exports = {
  sync,
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
  members: () => require('../../main/state').S.client.graph.listNodes({ nodeTypes: ['user-profile'], limit: 500 }).then(({ nodes }) => nodes.map((n) => ({ id: n.id, title: n.title }))),
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
  document: () => Promise.reject(new Error('no documents on the phone yet')),
  // ./pins
  pinnedDates: async () => ({}),
  todayNode: async () => null,
  // ../sdk/livequery, ../sdk/calls
  openLiveQuery: async () => ({ on() {}, close: async () => {} }),
  callState: () => ({ recordings: [], offTheRecord: false }),
  callSessions: () => ({ sessions: [] }),
};
