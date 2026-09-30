'use strict';
// What main/timeline.js and main/settings.js ask of the desktop, for the phone (ios/engine/build.js maps each require here). Today's pins
// and today's node are read over the sync stream with the SDK's own code, as main/pins.js reads them; the watch choices
// come from the settings document (main/settings.js); live queries and call state still answer empty. The banner edits never reach the phone:
// they are kept on the Mac that announced them.
// ponytail: live meetings are empty; add them from sdk/livequery.js.
const { isMcp, S, today } = require('../../main/state');
const pins = require('../../sdk/pins');

const issues = []; // a part that failed, for the app's Details log (index.js orbital.issues)
// A read over the sync stream, given up after 8 s: main/timeline.js waits for every part before it answers, so a stream
// that never opens would otherwise keep the whole Timeline from showing.
const within = (what, promise) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('no answer in 8 s')), 8000))])
  .catch((e) => { issues.push(what + ': ' + (e && e.message || e)); throw e; });
// A synchronous sha256 (FIPS 180-4): a page has only the asynchronous crypto.subtle, and sdk/chat.js names Tana's agent
// with one when it loads (deterministicId)
const K = Uint32Array.from({ length: 64 }, (_, i) => {
  const primes = []; for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
  return (Math.cbrt(primes[i]) % 1) * 2 ** 32;
});
function sha256(bytes) {
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  const len = Math.ceil((bytes.length + 9) / 64) * 64, m = new Uint8Array(len), v = new DataView(m.buffer), w = new Uint32Array(64);
  m.set(bytes); m[bytes.length] = 0x80; v.setUint32(len - 4, bytes.length * 8); v.setUint32(len - 8, Math.floor(bytes.length / 2 ** 29));
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < len; o += 64) {
    for (let i = 0; i < 64; i++) w[i] = i < 16 ? v.getUint32(o + i * 4) : (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10)) + w[i - 7] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 16];
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = k + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i], t2 = (r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] += x; });
  }
  const out = new Uint8Array(32); h.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x));
  return out;
}
const bytes = (n) => crypto.getRandomValues(new Uint8Array(n));

module.exports = {
  issues,
  within,
  sha256,
  // node:crypto, as the SDK files in the bundle use it
  randomUUID: () => crypto.randomUUID(),
  randomBytes: bytes,
  createHash(algorithm) {
    if (algorithm !== 'sha256') throw new Error(algorithm + ' is not on the phone');
    const parts = [];
    const hash = { update: (x) => (parts.push(typeof x === 'string' ? new TextEncoder().encode(x) : x), hash), digest: (enc) => {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { all.set(p, at); at += p.length; }
      const d = sha256(all); return enc === 'hex' ? [...d].map((x) => x.toString(16).padStart(2, '0')).join('') : d;
    } };
    return hash;
  },
  // ../db
  // ../db, for main/timeline.js and main/settings.js: the page's own storage in place of SQLite
  setting: (key) => JSON.parse(localStorage.getItem('orbital:' + key) ?? 'null') ?? undefined,
  setSetting: (key, value) => (value === undefined ? localStorage.removeItem('orbital:' + key) : localStorage.setItem('orbital:' + key, JSON.stringify(value))),
  settings() {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith('orbital:')) try { out[key.slice(8)] = JSON.parse(localStorage.getItem(key)); } catch { /* not a setting (storageId) */ }
    }
    return out;
  },
  generation: () => 1,
  // ./rows: a task under a row needs its id, words and state (ios/Orbital/Timeline.swift)
  graphRow: (n) => ({ id: n.id, title: n.title || 'Untitled', text: n.title || 'Untitled', done: (n.state && n.state.type) === 'closed', stateType: n.state && n.state.type }),
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
  // the watch choices (settings key notify: node → true watched, false silenced), as main/documents.js reads them; the
  // settings document is read once the phone has hydrated it (index.js timeline)
  notifyWatchedIds: () => new Set(Object.entries(require('../../main/settings').get('notify') || {}).filter(([, on]) => on === true).map(([id]) => id)),
  notifySilencedIds: () => new Set(Object.entries(require('../../main/settings').get('notify') || {}).filter(([, on]) => on === false).map(([id]) => id)),
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
