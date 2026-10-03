'use strict';
// The GPUI spike's real engine: your Tana, read-only, through the desktop's own main-process code. Run by Electron (the
// Tana session is a cookie in Electron's partition, tana-session.js), with no window of its own:
//   ORBITAL_NODE=node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ORBITAL_ENGINE=gpui/engine-tana.js
// It does what scripts/platform-cli.js backend() does: main.js in its check mode (TANA_MAIN_TEST) over a live client,
// with every ipc handler caught instead of registered. preload.js then runs against those handlers, so window.api here
// is the renderer's own, call for call. A fake window with one page carries what main pushes ("outline:changed").
//
// Read-only, three ways: only calls that read are answered (READS); main's own writes on a read are turned off (block
// ids given on open, the settings document's merge and tidy); and the sync client refuses to send any change to a
// document at all, except Tana's own ephemeral live-query documents, which are how a query is asked. Demo mode's masks
// (ios/engine/demo.js over renderer/segments.js) are on unless ORBITAL_REAL_WORDS=1.
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const electron = require('electron');
const { app } = electron;
const root = path.join(__dirname, '..');

app.setPath('userData', require('../userdata').userDataDir(app.getPath('appData'), { migrate: false }));
if (app.dock) app.dock.hide();

const READS = new Set(['roots', 'viewFilter', 'viewList', 'children', 'node', 'search', 'pinIds', 'status', 'members', 'searches',
  'searchFilter', 'taskMeta', 'typeList', 'timelinePages', 'inboxUnread', 'filters']);

const handlers = {};
electron.ipcMain.handle = (channel, fn) => { handlers[channel] = fn; };
electron.ipcMain.on = (channel, fn) => { handlers['on:' + channel] = fn; };

function guard(sync) {
  const command = sync._command.bind(sync);
  const writes = (c) => (c.case === 'liveDocumentUpdate' && !String(c.value.documentId).startsWith('tana:liveQuery:'))
    || c.case === 'documentAction' || (c.case === 'applyBootstrapUpdates' && c.value.updates && c.value.updates.length && !String(c.value.documentId).startsWith('tana:liveQuery:'));
  sync._command = (c, ...rest) => {
    if (writes(c)) { console.error('[engine] refused a write: ' + c.case + ' ' + (c.value && c.value.documentId)); return Promise.reject(new Error('read-only')); }
    return command(c, ...rest);
  };
}

app.whenReady().then(async () => {
  const { createTanaSession, peerIdentity } = require('../tana-session');
  const { createTanaClient } = require('../sdk');
  const session = createTanaSession();
  const me = await session.info();
  if (!me) throw new Error('not authenticated: sign in with npm run tana -- login');
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  const client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: { log() {}, info() {}, warn: console.error, error: console.error, debug() {} }, clientName: 'orbital-gpui-spike', userAgent: 'Orbital-GPUI-Spike/0' });
  guard(client.sync);
  await client.sync.connect();

  require('../sdk/content').assignBlockIds = () => 0; // main/documents.js gives blocks ids as it opens a document
  process.env.TANA_MAIN_TEST = '1';
  require('../db').open(path.join(app.getPath('temp'), 'orbital-gpui-spike.sqlite'));
  const main = require('../main');
  main.S.settingsReadOnly = true; // as the iPhone: the settings document is read, never made, merged or tidied

  // one page, which main pushes to and every call comes from (main/state.js pageOf finds it by its frame)
  const frame = { processId: 0, frameToken: 'gpui' };
  const listeners = {};
  const page = { id: '0:gpui', frame, side: '', isDestroyed: () => false, focus() {},
    send: (channel, ...args) => (listeners[channel] || []).forEach((cb) => cb({}, ...args)) };
  const win = { isDestroyed: () => false, panes: [page], show() {}, focus() {} };
  page.win = win;
  main.testRuntime({ client, me, win, session, userData: app.getPath('userData') });
  main.S.windows = new Set([win]);

  // preload.js against the caught handlers: window.api exactly as the renderer gets it
  const event = { sender: { send() {} }, senderFrame: frame };
  const exposed = {};
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: {
      invoke: async (channel, ...args) => { if (!handlers[channel]) throw new Error('no handler: ' + channel); return handlers[channel](event, ...args); },
      on: (channel, cb) => { (listeners[channel] ||= []).push(cb); },
      send: (channel, ...args) => { const h = handlers['on:' + channel]; if (h) h({ ...event, returnValue: undefined }, ...args); },
      sendSync: (channel) => (channel === 'window:getSide' ? { side: '' } : null),
    },
    webFrame: { setZoomFactor() {}, getZoomFactor: () => 1 },
  };
  const store = new Map();
  const win$ = { addEventListener() {}, location: { pathname: '/index.html' }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
  win$.top = win$; win$.window = win$;
  const ctx = vm.createContext({ ...win$, require: (m) => (m === 'electron' ? fakeElectron : require(m)), console, setTimeout, clearTimeout, process: { platform: process.platform, env: {} } });
  vm.runInContext('(function () {' + fs.readFileSync(path.join(root, 'preload.js'), 'utf8') + '\n})()', ctx, { filename: 'preload.js' });
  const api = exposed.api;

  const realWords = process.env.ORBITAL_REAL_WORDS === '1';
  const { demo, demoOn } = require('../ios/engine/demo');
  demoOn(!realWords);
  const maskTags = (r) => ({ ...r,
    ...(r.tags ? { tags: r.tags.map((t) => ({ ...t, label: demo([{ id: t.uri || t.label, title: t.label }])[0].title })) } : {}),
    ...(r.children ? { children: r.children.map(maskTags) } : {}) });
  const mask = (value) => {
    if (realWords || value == null) return value;
    if (Array.isArray(value)) return value.map((v) => (v && typeof v === 'object' ? maskTags(demo([v])[0]) : v)); // ids stay ids
    if (Array.isArray(value.nodes)) return { ...value, nodes: mask(value.nodes) };
    if (value.id && (value.title != null || value.text != null)) return mask([value])[0];
    return value;
  };
  const answers = {};
  for (const [name, fn] of Object.entries(api)) if (typeof fn === 'function') answers[name] = READS.has(name) ? async (...a) => mask(await fn(...a)) : fn;
  require('./serve').serve(answers, { allow: (m) => READS.has(m), refuse: 'This spike reads your Tana and never writes to it' });
  console.error('[engine] reading Tana as ' + me.userUri + (realWords ? '' : ', words masked'));
}).catch((e) => { console.error('[engine] ' + (e && e.stack || e)); process.exit(1); });
