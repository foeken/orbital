const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession, peerIdentity } = require('./tana-session');
const { createTanaClient } = require('./sdk');
const { readNode, setTitle, setState, contentText } = require('./sdk/node');

const OPEN_TASKS_QUERY = (userUri) => ({
  nodeTypes: ['text'], assignedTo: [userUri], stateTypes: ['open'], limit: 500,
  sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
});

const status = { authenticated: false, connected: false, syncing: false, lastSync: null, error: null };
let win, session, client, me;
let refreshTimer;
const subscribed = new Set();

const errText = (e) => String((e && e.message) || e);
const now = () => new Date().toISOString();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(patch) {
  Object.assign(status, patch);
  send('sync:status', status);
}

async function start() {
  me = await session.info();
  const peer = peerIdentity({ file: path.join(app.getPath('userData'), 'peer.json'), userExternalId: me.userExternalId });
  client = createTanaClient({ getAccessToken: (o) => session.getAccessToken(o), orgId: me.orgId, ...peer, logger: console });
  client.sync.on('connected', () => setStatus({ connected: true, error: null }));
  client.sync.on('disconnected', () => setStatus({ connected: false }));
  client.sync.on('error', (e) => setStatus({ error: errText(e) }));
  client.sync.on('change', onChange);
  setStatus({ authenticated: true });
  await client.sync.connect();
  await refresh();
}

async function refresh() {
  if (!client || status.syncing) return;
  setStatus({ syncing: true, error: null });
  try {
    const { nodes } = await client.graph.listNodes(OPEN_TASKS_QUERY(me.userUri));
    const rows = nodes.map((n) => ({ id: n.id, title: n.title || '', done: 0, space: null, updatedAt: n.updateTime || now() }));
    db.replaceFromTana(rows);
    send('tasks:changed');
    const ids = new Set(rows.map((r) => r.id));
    for (const id of ids) if (!subscribed.has(id)) subscribe(id);
    for (const id of subscribed) if (!ids.has(id)) { subscribed.delete(id); client.sync.unsubscribe(id).catch(() => {}); }
    setStatus({ syncing: false, lastSync: now() });
  } catch (e) {
    setStatus({ syncing: false, error: errText(e) });
  }
}

function subscribe(id) {
  subscribed.add(id);
  return client.sync.subscribe(id).catch((e) => { subscribed.delete(id); setStatus({ error: errText(e) }); return null; });
}

function scheduleRefresh(ms) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

function onChange(docId) {
  try {
    const doc = client.sync.getDocument(docId);
    const row = doc && db.get(docId);
    if (!row) return;
    const n = readNode(doc);
    const next = { title: n.title ?? row.title, done: n.stateType === 'closed' ? 1 : 0, content: row.content == null ? null : contentText(doc) };
    if (next.title === row.title && next.done === row.done && next.content === row.content) return;
    db.upsert({ ...row, ...next, updatedAt: now() });
    send('tasks:changed');
  } catch (e) {
    setStatus({ error: errText(e) });
  }
}

async function document(id) {
  if (!client) throw new Error('not connected to Tana');
  const doc = client.sync.getDocument(id) || await subscribe(id);
  if (!doc) throw new Error(status.error || 'could not subscribe to ' + id);
  return doc;
}

function createWindow() {
  win = new BrowserWindow({
    width: 900, height: 700, titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'Tasks', submenu: [{ label: 'Sync with Tana', accelerator: 'CmdOrCtrl+R', click: () => refresh() }] },
    { role: 'windowMenu' },
  ]));
}

ipcMain.handle('tasks:list', () => db.list());
ipcMain.handle('tasks:update', async (_e, id, patch) => {
  const row = db.get(id);
  if (!row) throw new Error('no task ' + id);
  try {
    const doc = await document(id);
    if (patch.title != null && patch.title !== row.title) setTitle(doc, patch.title);
    if (patch.done != null && (patch.done ? 1 : 0) !== row.done) {
      setState(doc, patch.done ? 'closed' : 'open', me.userUri);
      scheduleRefresh(2000); // a closed task drops off the open list
    }
  } catch (e) {
    setStatus({ error: errText(e) });
    throw e;
  }
  return db.upsert({ ...row, ...patch, updatedAt: now() });
});
ipcMain.handle('tasks:content', async (_e, id) => {
  const row = db.get(id);
  if (row && row.content != null) return row.content;
  const content = contentText(await document(id));
  db.setContent(id, content);
  send('tasks:changed');
  return content;
});
ipcMain.handle('sync:status', () => status);
ipcMain.handle('sync:login', async () => {
  try {
    await session.login();
    await start();
  } catch (e) {
    setStatus({ error: errText(e) });
  }
});

app.whenReady().then(async () => {
  db.open(path.join(app.getPath('userData'), 'tasks.sqlite'));
  session = createTanaSession();
  createMenu();
  createWindow();
  try {
    if (await session.isAuthenticated()) await start();
    else setStatus({ authenticated: false });
  } catch (e) {
    setStatus({ error: errText(e) });
  }
  setInterval(refresh, 60000);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (client) client.close().catch(() => {}); });
