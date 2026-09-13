const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession, peerIdentity } = require('./tana-session');
const { createTanaClient } = require('./sdk');
const { readNode, setTitle, setState, ulid, initDocument } = require('./sdk/node');
const { parseQuery, searchParams, needsTypes } = require('./sdk/query');
const content = require('./sdk/content');
const pins = require('./sdk/pins');

const SECTIONS = [{ id: 'tasks', title: 'Tasks', icon: 'task' }, { id: 'meetings', title: 'Meetings', icon: 'meeting' }];
const TAG = { task: { label: 'task', color: 'grey' }, meeting: { label: 'meeting', color: 'gold' }, doc: { label: 'doc', color: 'grey' } };
const KINDS = { doc: 'tana:text:', task: 'tana:text:', meeting: 'tana:event:' };

const OPEN_TASKS_QUERY = (userUri) => ({
  nodeTypes: ['text'], assignedTo: [userUri], stateTypes: ['open'], limit: 500,
  sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }],
});
// events I take part in, from the start of local today to 7 days ahead
// past week through next week, oldest first
const MEETINGS_QUERY = (userUri) => {
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 7);
  return {
    nodeTypes: ['event'], hasParticipantUris: [userUri], limit: 300,
    eventStartTimeMin: start.toISOString(), eventStartTimeMax: new Date(start.getTime() + 14 * 864e5).toISOString(),
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
// "Mon 9:00–9:30" in local time; all-day events come as UTC (or local) midnight with a whole-day span: "Mon, all day".
// withDate (search results, any week): "Fri 9 9:00–10:00" / "Fri 9".
function eventMeta(start, end, withDate) {
  if (!start) return undefined;
  const s = new Date(start), e = end ? new Date(end) : null;
  const midnight = s.getUTCHours() + s.getUTCMinutes() === 0 || s.getHours() + s.getMinutes() === 0;
  const allDay = e && midnight && (e - s) % 864e5 === 0;
  const day = WEEKDAY[s.getDay()] + (withDate ? ' ' + s.getDate() : '');
  return allDay ? day + (withDate ? '' : ', all day') : day + ' ' + hm(s) + (e ? '–' + hm(e) : '');
}

async function resolveTypes(uris) {
  const missing = [...new Set(uris.filter((u) => u && !typeTitles.has(u)))];
  if (!missing.length) return;
  const { nodes } = await client.graph.listNodes({ nodeIds: missing, limit: missing.length });
  for (const n of nodes) typeTitles.set(n.id, n.title || '');
}
const typeTag = (uri) => (uri && typeTitles.get(uri) ? [{ label: typeTitles.get(uri), color: 'grey' }] : []);
// plain untyped document (no state, no type): 'doc' icon + chip; typed documents keep their type tag and the plain bullet
const plainRow = (id, title, updatedAt, typeUri) => ({ id, title, done: 0, icon: typeUri ? null : 'doc', tags: typeUri ? typeTag(typeUri) : [TAG.doc], sortKey: updatedAt, updatedAt });
// lowercase type title -> uri for #Type search filters; the type list is loaded once per session (and seeds typeTitles)
let typesLoaded;
async function typesByTitle() {
  typesLoaded ||= client.graph.listNodes({ nodeTypes: ['type'], limit: 200 }).then(({ nodes }) => { for (const n of nodes) typeTitles.set(n.id, n.title || ''); }, () => { typesLoaded = null; });
  await typesLoaded;
  return new Map([...typeTitles].map(([uri, title]) => [title.toLowerCase(), uri]));
}

// rows for db.replaceSection from graph Node JSON
const taskRow = (n) => ({
  id: n.id, title: n.title || '', done: n.state && n.state.type === 'closed' ? 1 : 0, icon: 'task',
  tags: [TAG.task, ...typeTag(n.entityType)], sortKey: n.updateTime || now(), updatedAt: n.updateTime || now(),
});
const meetingRow = (n, withDate) => {
  const ev = n.calendarEvent || {};
  return {
    id: n.id, title: n.title || '', done: 0, icon: 'meeting', meta: eventMeta(ev.startTime, ev.endTime, withDate),
    tags: [TAG.meeting, ...typeTag(n.entityType)], sortKey: ev.startTime || now(), updatedAt: n.updateTime || now(),
  };
};

const toNode = (r) => ({ id: r.id, title: r.title, text: r.title, kind: 'document', done: r.icon === 'task' ? r.done : undefined, hasChildren: true, icon: r.icon || undefined, tags: r.tags, meta: r.meta || undefined, iconSvg: db.icon(r.id) || undefined });

// Node shape from any graph Node JSON (search results): events, tasks, typed and plain documents.
function graphRow(n, withDate) {
  if (n.calendarEvent || n.id.startsWith('tana:event:')) return meetingRow(n, withDate);
  if (n.state && n.state.type) return taskRow(n);
  return plainRow(n.id, n.title || '', n.updateTime || now(), n.entityType);
}

// Live search over all top-level items (graph full-text search, relevance order) with #task/#meeting/#Type filters.
async function search(query) {
  if (!client) return [];
  const parsed = parseQuery(query);
  const params = searchParams(parsed, needsTypes(parsed) ? await typesByTitle() : new Map());
  if (!params) return [];
  const { nodes } = await client.graph.listNodes(params);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n, true)));
}

// New document ('doc' | 'task' | 'meeting'): seeded locally, created on the server by the bootstrap (sdk/sync.js subscribe with init).
async function createDocument(title, { kind = 'doc' } = {}) {
  if (!client) throw new Error('not connected to Tana');
  if (!KINDS[kind]) throw new Error('kind must be doc, task or meeting: ' + kind);
  const id = KINDS[kind] + ulid();
  const doc = await subscribe(id, (loro) => initDocument(loro, String(title || ''), me.userUri, { kind }));
  if (!doc) throw new Error(status.error || 'could not create ' + id);
  return info(doc);
}

// Node shape for any subscribed document: cached row when listed, else derived from the Loro data map.
async function info(doc) {
  const n = readNode(doc), row = db.get(doc.id);
  if (row) return toNode({ ...row, title: n.title ?? row.title, done: n.stateType === 'closed' ? 1 : 0 });
  const isEvent = n.type === 'event' || doc.id.startsWith('tana:event:');
  await resolveTypes([n.entityTypeUri]);
  if (!isEvent && !n.stateType) return toNode(plainRow(doc.id, n.title || '', now(), n.entityTypeUri));
  return toNode({
    id: doc.id, title: n.title || '', done: n.stateType === 'closed' ? 1 : 0, icon: isEvent ? 'meeting' : 'task',
    meta: isEvent ? eventMeta(n.startTime, n.endTime) : null, tags: [isEvent ? TAG.meeting : TAG.task, ...typeTag(n.entityTypeUri)],
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- pins (sdk/pins.js over the user's profile/collection/pin-map docs) and app-local icons ----
const today = () => new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
const pinTarget = (target) => { if (target !== 'sidebar' && target !== 'today') throw new Error('pin target must be sidebar or today: ' + target); return target; };

// Sidebar pins as Nodes, in sidebar order; pinned items we cannot subscribe (spaces, types, ...) are skipped quietly.
async function pinned() {
  if (!client) return [];
  const uris = await pins.listSidebar(client.sync, me.userUri);
  const docs = await Promise.all(uris.map((u) => client.sync.getDocument(u) || client.sync.subscribe(u).catch(() => null)));
  return Promise.all(docs.filter(Boolean).map(info));
}
async function pinState(id) {
  if (!client) throw new Error('not connected to Tana');
  return { sidebar: (await pins.listSidebar(client.sync, me.userUri)).includes(id), dates: await pins.dates(client.sync, me.userUri, id) };
}
async function setPin(id, target, on) {
  if (!client) throw new Error('not connected to Tana');
  const sync = client.sync, user = me.userUri;
  if (pinTarget(target) === 'sidebar') await (on ? pins.pinSidebar : pins.unpinSidebar)(sync, user, id);
  else await (on ? pins.pinDate : pins.unpinDate)(sync, user, id, today());
}
function setIcon(id, svg) {
  if (svg != null) {
    if (typeof svg !== 'string' || Buffer.byteLength(svg) >= 65536) throw new Error('icon must be an SVG string under 64 KB');
    svg = svg.trim().replace(/^<\?xml[^>]*\?>\s*/, ''); // FileReader text of a .svg may start with an XML declaration
    if (!svg.startsWith('<svg')) throw new Error('icon must start with <svg');
  }
  db.setIcon(id, svg);
  send('outline:changed', null);
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

function subscribe(id, init) {
  subscribed.add(id);
  return client.sync.subscribe(id, init).catch((e) => { subscribed.delete(id); setStatus({ error: errText(e) }); return null; });
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

// Mutations: same as op, plus global undo ordering across documents (each Document keeps its own Loro UndoManager).
const undoStack = [], redoStack = [];
async function mut(id, fn) {
  const result = await op(id, fn);
  undoStack.push(id); redoStack.length = 0;
  return result;
}
// ponytail: one undo step per mutation call across docs; Loro merges steps within 500 ms inside a document.
function history(from, to, action, can) {
  while (from.length) {
    const id = from.pop();
    const doc = client && client.sync.getDocument(id);
    if (!doc || !doc[can]()) continue;
    if (doc[action]()) { to.push(id); return id; }
  }
  return null;
}

ipcMain.handle('outline:roots', () => {
  const rows = db.list();
  return SECTIONS.map((s) => ({ ...s, nodes: (rows[s.id] || []).map(toNode) }));
});
// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (_e, id) => op(id, (doc) => (doc.content.get('children') ? content.readOutline(doc) : [])));
ipcMain.handle('doc:info', (_e, id) => op(id, info));
ipcMain.handle('doc:create', (_e, title, opts) => createDocument(title, opts || {}));
ipcMain.handle('search', (_e, query) => search(query));
ipcMain.handle('history:undo', () => history(undoStack, redoStack, 'undo', 'canUndo'));
ipcMain.handle('history:redo', () => history(redoStack, undoStack, 'redo', 'canRedo'));
ipcMain.handle('doc:setTitle', (_e, id, title) => mut(id, (doc) => { setTitle(doc, title); }));
ipcMain.handle('doc:setDone', (_e, id, done) => mut(id, (doc) => {
  setState(doc, done ? 'closed' : 'open', me.userUri);
  scheduleRefresh(2000); // a closed task drops off the open list
}));
ipcMain.handle('block:setText', (_e, id, nodeId, value) => mut(id, (doc) => { content.setText(doc, nodeId, value); })); // value: string or segments
ipcMain.handle('block:insertAfter', (_e, id, nodeId, text) => mut(id, (doc) => content.insertAfter(doc, nodeId, text)));
ipcMain.handle('block:insertChild', (_e, id, nodeId, text) => mut(id, (doc) => content.insertChild(doc, nodeId, text)));
ipcMain.handle('block:remove', (_e, id, nodeId) => mut(id, (doc) => { content.remove(doc, nodeId); }));
ipcMain.handle('block:indent', (_e, id, nodeId) => mut(id, (doc) => { content.indent(doc, nodeId); }));
ipcMain.handle('block:outdent', (_e, id, nodeId) => mut(id, (doc) => { content.outdent(doc, nodeId); }));
ipcMain.handle('block:move', (_e, id, nodeId, direction) => mut(id, (doc) => { content.move(doc, nodeId, direction); }));
ipcMain.handle('pins:list', () => pinned());
ipcMain.handle('pins:state', (_e, id) => pinState(id));
ipcMain.handle('pins:pin', (_e, id, target) => setPin(id, target, true));
ipcMain.handle('pins:unpin', (_e, id, target) => setPin(id, target, false));
ipcMain.handle('doc:setIcon', (_e, id, svg) => setIcon(id, svg));
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

app.setName('Tana Companion');
app.setPath('userData', path.join(app.getPath('appData'), 'tana-tasks')); // before 'ready': same session/cache for dev runs, the CLI and the packaged app

app.whenReady().then(async () => {
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); // packaged builds carry the icon in the bundle
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
