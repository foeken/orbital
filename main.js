const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const db = require('./db');
const { createTanaSession, peerIdentity } = require('./tana-session');
const { createTanaClient } = require('./sdk');
const { fetchImage } = require('./sdk/assets');
const { readNode, setTitle, setState, ulid, initDocument } = require('./sdk/node');
const { parseQuery, searchParams, needsTypes, taskParams, libraryQueries, DEFAULT_TASK_FILTER, DEFAULT_LIBRARY_FILTER } = require('./sdk/query');
const content = require('./sdk/content');
const pins = require('./sdk/pins');

const SECTIONS = [{ id: 'tasks', title: 'Tasks', icon: 'task' }, { id: 'meetings', title: 'Meetings', icon: 'meeting' }, { id: 'library', title: 'Library', icon: 'doc' }, { id: 'chats', title: 'Chats', icon: 'chat' }];
const TAG = { task: { label: 'task', color: 'grey' }, meeting: { label: 'meeting', color: 'gold' }, space: { label: 'space', color: 'grey' }, doc: { label: 'doc', color: 'grey' }, member: { label: 'member', color: 'grey' } };
const KINDS = { doc: 'tana:text:', task: 'tana:text:', meeting: 'tana:event:' };
const PLAIN_KINDS = new Set(['chat', 'canvas', 'agent', 'skill']); // tana:<kind>: ids listed read-only: plain bullet + kind tag

// persisted view filters (db settings table)
const taskFilter = () => db.setting('taskFilter') || DEFAULT_TASK_FILTER;
const libraryFilter = () => db.setting('libraryFilter') || DEFAULT_LIBRARY_FILTER;
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
const typeHues = new Map(); // type uri -> appearance.hue (0-360), for coloured type tags
const rememberType = (n) => { typeTitles.set(n.id, n.title || ''); if (n.appearance && typeof n.appearance.hue === 'number') typeHues.set(n.id, n.appearance.hue); };

// Where a document lives in Tana: owner chain root-first as [{ id, title }]; unowned documents are in the Library.
const pathCache = new Map(); // docId -> path (refreshed on every info() call; cheap enough per open)
async function pathOf(id) {
  const { entries = [] } = await client.graph.getOwnerChain(id);
  const owners = entries.map((e) => e.uri).filter((u) => u !== id).reverse();
  if (!owners.length) return [{ id: 'library', title: 'Library' }];
  await resolveTypes(owners); // same title cache: any node id -> title
  return owners.map((u) => ({ id: u, title: typeTitles.get(u) || u }));
}
ipcMain.handle('doc:path', async (_e, id) => { try { const p = await pathOf(id); pathCache.set(id, p); return p; } catch (e) { setStatus({ error: errText(e) }); return pathCache.get(id) || []; } });

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
  nodes.forEach(rememberType);
}
// { label, hue } when the type node has appearance.hue, else grey (docs/OUTLINER.md addendum 12)
const typeTag = (uri) => (uri && typeTitles.get(uri) ? [typeHues.has(uri) ? { label: typeTitles.get(uri), hue: typeHues.get(uri) } : { label: typeTitles.get(uri), color: 'grey' }] : []);
// plain untyped document (no state, no type): 'doc' icon + chip; typed documents keep their type tag and the plain bullet
const isSpace = (id) => id.startsWith('tana:space:');
const plainRow = (id, title, updatedAt, typeUri) => (isSpace(id)
  ? { id, title, done: 0, icon: 'space', tags: [TAG.space], sortKey: updatedAt, updatedAt }
  : { id, title, done: 0, icon: typeUri ? null : 'doc', tags: typeUri ? typeTag(typeUri) : [TAG.doc], sortKey: updatedAt, updatedAt });
const memberRow = (id, title, updatedAt) => ({ id, title, done: 0, icon: 'member', tags: [TAG.member], sortKey: updatedAt, updatedAt });
const kindRow = (id, kind, title, updatedAt) => ({ id, title, done: 0, icon: null, tags: [{ label: kind, color: 'grey' }], sortKey: updatedAt, updatedAt });
const idKind = (id) => id.split(':')[1];
const memberTitle = (n) => n.title || (n.userProfile && n.userProfile.name) || '';

// A space's "content" is the documents it owns (graph query), returned as document Nodes.
async function spaceChildren(id) {
  const { nodes } = await client.graph.listNodes({ ownerIds: [id], limit: 200, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n)));
}
// lowercase type title -> uri for #Type search filters; the type list is loaded once per session (and seeds typeTitles)
let typesLoaded;
async function typesByTitle() {
  typesLoaded ||= client.graph.listNodes({ nodeTypes: ['type'], limit: 200 }).then(({ nodes }) => { nodes.forEach(rememberType); }, () => { typesLoaded = null; });
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
  if (n.userProfile || idKind(n.id) === 'user-profile') return memberRow(n.id, memberTitle(n), n.updateTime || now());
  if (PLAIN_KINDS.has(idKind(n.id))) return kindRow(n.id, idKind(n.id), n.title || '', n.updateTime || now());
  if (n.state && n.state.type) return taskRow(n);
  return plainRow(n.id, n.title || '', n.updateTime || now(), n.entityType);
}

// all org members, cached per session, by display name
let membersLoaded;
function members() {
  if (!client) return Promise.resolve([]);
  membersLoaded ||= client.graph.listNodes({ nodeTypes: ['user-profile'], limit: 500 })
    .then(({ nodes }) => nodes.map((n) => ({ ...toNode(graphRow(n)), me: n.id === me.userUri || undefined })).sort((a, b) => a.title.localeCompare(b.title)), (e) => { membersLoaded = null; throw e; });
  return membersLoaded;
}

// Library: one query per selected kind in parallel, merged newest first, capped at 100. Partial filters fall back to the stored one.
// Chats view: all chat nodes newest first; MCP chats (invocation intent 'mcp', titles "MCP: …") hidden unless asked.
async function chats({ includeMcp = false } = {}) {
  if (!client) return [];
  const { nodes } = await client.graph.listNodes({ nodeTypes: ['chat'], limit: 200, sortOptions: [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }] });
  const isMcp = (n) => (n.invocationContext && n.invocationContext.intent === 'mcp') || /^MCP:/i.test(n.title || '');
  return nodes.filter((n) => includeMcp || !isMcp(n)).map((n) => toNode({ ...graphRow(n), meta: isMcp(n) ? 'MCP' : undefined }));
}

async function library(filter) {
  if (!client) return [];
  const f = { ...libraryFilter(), ...(filter || {}) };
  const results = await Promise.all(libraryQueries(f, me.userUri).map(async ({ kind, params }) => {
    const { nodes } = await client.graph.listNodes(params);
    return kind === 'docs' ? nodes.filter((n) => !(n.state && n.state.type)) : nodes;
  }));
  const seen = new Set();
  const nodes = results.flat().filter((n) => !seen.has(n.id) && seen.add(n.id))
    .sort((a, b) => String(b.updateTime || '').localeCompare(String(a.updateTime || ''))).slice(0, 100);
  await resolveTypes(nodes.map((n) => n.entityType));
  return nodes.map((n) => toNode(graphRow(n, true)));
}

// Live search over all top-level items (graph full-text search, relevance order) with #task/#meeting/#Type filters.
async function search(query) {
  if (!client) return [];
  const parsed = parseQuery(query);
  const params = searchParams(parsed, needsTypes(parsed) ? await typesByTitle() : new Map());
  if (!params) return [];
  const { nodes } = await client.graph.listNodes({ ...params, limit: 40 }); // wider net so title matches are not pushed out by full-text hits
  await resolveTypes(nodes.map((n) => n.entityType));
  // title matches first (exact, then prefix, then contains), full-text hits keep the server's relevance order
  const q = parsed.text.trim().toLowerCase();
  const rank = (n) => { const t = (n.title || '').toLowerCase(); return t === q ? 0 : t.startsWith(q) ? 1 : t.includes(q) ? 2 : 3; };
  return nodes.map((n, i) => [rank(n), i, n]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , n]) => toNode(graphRow(n, true)));
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
  if (idKind(doc.id) === 'user-profile') return toNode(memberRow(doc.id, n.title || doc.data.get('name') || doc.data.get('displayName') || '', now()));
  if (PLAIN_KINDS.has(idKind(doc.id))) return toNode(kindRow(doc.id, idKind(doc.id), n.title || '', now()));
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

// ---- images: tana:image: uri -> data URL, cached in memory and under userData/images/<sha1(uri)> (the data URL as text)
const imageCache = new Map(); // uri -> Promise<data URL>
function image(uri) {
  if (!session) return Promise.reject(new Error('not logged in to Tana'));
  if (!imageCache.has(uri)) imageCache.set(uri, loadImage(uri).catch((e) => { imageCache.delete(uri); throw e; }));
  return imageCache.get(uri);
}
async function loadImage(uri) {
  const dir = path.join(app.getPath('userData'), 'images'), file = path.join(dir, createHash('sha1').update(uri).digest('hex'));
  const cached = await fs.readFile(file, 'utf8').catch(() => null);
  if (cached) return cached;
  const { mime, bytes } = await fetchImage(uri, { getAccessToken: (o) => session.getAccessToken(o) });
  const url = 'data:' + mime + ';base64,' + bytes.toString('base64');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, url);
  return url;
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

// one refresh at a time; callers that changed the filter await the in-flight run and start a new one
let refreshing = null;
function refresh() {
  if (!client) return Promise.resolve();
  return refreshing ||= doRefresh().finally(() => { refreshing = null; });
}
async function doRefresh() {
  setStatus({ syncing: true, error: null });
  try {
    const [tasks, meetings] = await Promise.all([client.graph.listNodes(taskParams(taskFilter(), me.userUri)), client.graph.listNodes(MEETINGS_QUERY(me.userUri))]);
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
async function setTaskFilter(f) {
  db.setSetting('taskFilter', { states: f && f.states ? f.states : null, assignee: (f && f.assignee) || 'me' });
  await refreshing; // a run with the old filter
  await refresh();
  return taskFilter();
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
ipcMain.handle('outline:children', (_e, id) => (isSpace(id) ? spaceChildren(id) : op(id, (doc) => (doc.content.get('children') ? content.readOutline(doc) : []))));
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
ipcMain.handle('image', (_e, uri) => image(uri));
ipcMain.handle('members', () => members());
ipcMain.handle('tasks:filter', () => taskFilter());
ipcMain.handle('tasks:setFilter', (_e, f) => setTaskFilter(f));
ipcMain.handle('library:list', (_e, f) => library(f));
ipcMain.handle('chats:list', (_e, o) => chats(o || {}));
ipcMain.handle('library:filter', () => libraryFilter());
ipcMain.handle('library:setFilter', (_e, f) => { db.setSetting('libraryFilter', { ...DEFAULT_LIBRARY_FILTER, ...(f || {}) }); return libraryFilter(); });
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
