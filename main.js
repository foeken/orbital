const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession, peerIdentity } = require('./tana-session');
const { createTanaClient } = require('./sdk');
const { readNode, setTitle, setState } = require('./sdk/node');
const content = require('./sdk/content');

const SECTIONS = [{ id: 'tasks', title: 'Tasks', icon: 'task' }, { id: 'meetings', title: 'Meetings', icon: 'meeting' }];
const TAG = { task: { label: 'task', color: 'grey' }, meeting: { label: 'meeting', color: 'gold' } };

const OPEN_TASKS_QUERY = (userUri) => ({
  nodeTypes: ['text'], assignedTo: [userUri], stateTypes: ['open'], limit: 500,
  sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
});
// events I take part in, from the start of local today to 7 days ahead
const MEETINGS_QUERY = (userUri) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return {
    nodeTypes: ['event'], hasParticipantUris: [userUri], limit: 200,
    eventStartTimeMin: start.toISOString(), eventStartTimeMax: new Date(start.getTime() + 7 * 864e5).toISOString(),
    sortOptions: [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_ASCENDING' }],
  };
};

const status = { authenticated: false, connected: false, syncing: false, lastSync: null, error: null };
let win, session, client, me;
let refreshTimer;
const subscribed = new Set();
const typeTitles = new Map(); // entityType uri -> title, resolved once per session

const errText = (e) => String((e && e.message) || e);
const now = () => new Date().toISOString();

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hm = (d) => d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
// "Mon 9:00–9:30" in local time; all-day events come as UTC (or local) midnight with a whole-day span: "Mon, all day"
function eventMeta(start, end) {
  if (!start) return undefined;
  const s = new Date(start), e = end ? new Date(end) : null;
  const midnight = s.getUTCHours() + s.getUTCMinutes() === 0 || s.getHours() + s.getMinutes() === 0;
  const allDay = e && midnight && (e - s) % 864e5 === 0;
  return WEEKDAY[s.getDay()] + (allDay ? ', all day' : ' ' + hm(s) + (e ? '–' + hm(e) : ''));
}

async function resolveTypes(uris) {
  const missing = [...new Set(uris.filter((u) => u && !typeTitles.has(u)))];
  if (!missing.length) return;
  const { nodes } = await client.graph.listNodes({ nodeIds: missing, limit: missing.length });
  for (const n of nodes) typeTitles.set(n.id, n.title || '');
}
const typeTag = (uri) => (uri && typeTitles.get(uri) ? [{ label: typeTitles.get(uri), color: 'grey' }] : []);

// rows for db.replaceSection from graph Node JSON
const taskRow = (n) => ({
  id: n.id, title: n.title || '', done: n.state && n.state.type === 'closed' ? 1 : 0, icon: 'task',
  tags: [TAG.task, ...typeTag(n.entityType)], sortKey: n.updateTime || now(), updatedAt: n.updateTime || now(),
});
const meetingRow = (n) => {
  const ev = n.calendarEvent || {};
  return {
    id: n.id, title: n.title || '', done: 0, icon: 'meeting', meta: eventMeta(ev.startTime, ev.endTime),
    tags: [TAG.meeting, ...typeTag(n.entityType)], sortKey: ev.startTime || now(), updatedAt: n.updateTime || now(),
  };
};

const toNode = (r) => ({ id: r.id, title: r.title, text: r.title, kind: 'document', done: r.icon === 'task' ? r.done : undefined, hasChildren: true, icon: r.icon || undefined, tags: r.tags, meta: r.meta || undefined });

// Node shape for any subscribed document: cached row when listed, else derived from the Loro data map.
async function info(doc) {
  const n = readNode(doc), row = db.get(doc.id);
  if (row) return toNode({ ...row, title: n.title ?? row.title, done: n.stateType === 'closed' ? 1 : 0 });
  const isEvent = n.type === 'event' || doc.id.startsWith('tana:event:');
  await resolveTypes([n.entityTypeUri]);
  return toNode({
    id: doc.id, title: n.title || '', done: n.stateType === 'closed' ? 1 : 0, icon: isEvent ? 'meeting' : n.stateType ? 'task' : null,
    meta: isEvent ? eventMeta(n.startTime, n.endTime) : null, tags: [...(isEvent ? [TAG.meeting] : n.stateType ? [TAG.task] : []), ...typeTag(n.entityTypeUri)],
  });
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
    const [tasks, meetings] = await Promise.all([client.graph.listNodes(OPEN_TASKS_QUERY(me.userUri)), client.graph.listNodes(MEETINGS_QUERY(me.userUri))]);
    await resolveTypes([...tasks.nodes, ...meetings.nodes].map((n) => n.entityType));
    db.replaceSection('tasks', tasks.nodes.map(taskRow));
    db.replaceSection('meetings', meetings.nodes.map(meetingRow));
    send('outline:changed', null);
    const ids = new Set([...tasks.nodes, ...meetings.nodes].map((n) => n.id));
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
    { label: 'Tana', submenu: [{ label: 'Sync', accelerator: 'CmdOrCtrl+R', click: () => refresh() }] },
    { role: 'windowMenu' },
  ]));
}

// Run fn on the subscribed Document; the ops transact synchronously, so the result is in Loro (and sent) on resolve.
async function op(id, fn) {
  try {
    return await fn(await document(id));
  } catch (e) {
    setStatus({ error: errText(e) });
    throw e;
  }
}

ipcMain.handle('outline:roots', () => {
  const rows = db.list();
  return SECTIONS.map((s) => ({ ...s, nodes: (rows[s.id] || []).map(toNode) }));
});
// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (_e, id) => op(id, (doc) => (doc.content.get('children') ? content.readOutline(doc) : [])));
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
