const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession, peerIdentity } = require('./tana-session');
const { createTanaClient } = require('./sdk');
const { readNode, setTitle, setState } = require('./sdk/node');
const content = require('./sdk/content');

const OPEN_TASKS_QUERY = (userUri) => ({
  nodeTypes: ['text'], assignedTo: [userUri], stateTypes: ['open'], limit: 500,
  sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
});

const status = { authenticated: false, connected: false, syncing: false, lastSync: null, error: null };
let win, session, client, me;
let refreshTimer;
const subscribed = new Set();
const stateOf = new Map(); // docId -> stateType (from the list query, then from the live document); set = the document is a task

const errText = (e) => String((e && e.message) || e);
const now = () => new Date().toISOString();
const icon = (id) => (stateOf.get(id) ? 'task' : undefined);

function info(doc) {
  const n = readNode(doc);
  stateOf.set(doc.id, n.stateType);
  return { id: doc.id, title: n.title || '', kind: 'document', done: n.stateType === 'closed' ? 1 : 0, icon: icon(doc.id) };
}

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
    const rows = nodes.map((n) => ({ id: n.id, title: n.title || '', done: 0, updatedAt: n.updateTime || now() }));
    for (const n of nodes) stateOf.set(n.id, n.state && n.state.type);
    db.replaceFromTana(rows);
    send('outline:changed', null);
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
    send('outline:changed', docId);
    const doc = client.sync.getDocument(docId), row = doc && db.get(docId);
    if (!row) return;
    const n = readNode(doc), done = n.stateType === 'closed' ? 1 : 0, title = n.title ?? row.title;
    stateOf.set(docId, n.stateType);
    if (title === row.title && done === row.done) return;
    db.upsert({ ...row, title, done, updatedAt: now() });
    send('outline:changed', null); // a root's title/state changed too
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
    width: 900, height: 700, title: 'Tana', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
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

// Run fn on the subscribed Document; the ops transact synchronously, so the result is in Loro (and sent) on resolve.
async function op(id, fn) {
  try {
    return fn(await document(id));
  } catch (e) {
    setStatus({ error: errText(e) });
    throw e;
  }
}

ipcMain.handle('outline:roots', () => db.list().map((r) => ({ id: r.id, text: r.title, kind: 'document', done: r.done, hasChildren: true, icon: icon(r.id) })));
ipcMain.handle('outline:children', (_e, id) => op(id, content.readOutline));
ipcMain.handle('doc:info', (_e, id) => op(id, info));
ipcMain.handle('doc:setTitle', (_e, id, title) => op(id, (doc) => { setTitle(doc, title); }));
ipcMain.handle('doc:setDone', (_e, id, done) => op(id, (doc) => {
  setState(doc, done ? 'closed' : 'open', me.userUri);
  scheduleRefresh(2000); // a closed task drops off the open list
}));
ipcMain.handle('block:setText', (_e, id, nodeId, value) => op(id, (doc) => { content.setText(doc, nodeId, value); })); // value: string or segments
ipcMain.handle('block:insertAfter', (_e, id, nodeId, text) => op(id, (doc) => content.insertAfter(doc, nodeId, text)));
ipcMain.handle('block:insertChild', (_e, id, nodeId, text) => op(id, (doc) => content.insertChild(doc, nodeId, text)));
ipcMain.handle('block:remove', (_e, id, nodeId) => op(id, (doc) => { content.remove(doc, nodeId); }));
ipcMain.handle('block:indent', (_e, id, nodeId) => op(id, (doc) => { content.indent(doc, nodeId); }));
ipcMain.handle('block:outdent', (_e, id, nodeId) => op(id, (doc) => { content.outdent(doc, nodeId); }));
ipcMain.handle('block:move', (_e, id, nodeId, direction) => op(id, (doc) => { content.move(doc, nodeId, direction); }));
ipcMain.handle('sync:refresh', () => refresh());
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
