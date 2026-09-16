'use strict';
// Electron main: the process boundary. Everything that knows Tana lives in main/ (state, rows, documents, related,
// views, pins, images); this file owns the window, the menu, the IPC table and the boot sequence, plus the test hook
// that scripts/sdk-check.js and the CLI use to drive the same modules without a window.
const { app, BrowserWindow, Menu, ipcMain, nativeTheme, screen, shell } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession } = require('./tana-session');
const updater = require('./updater');
const access = require('./sdk/access');
const { readNode, setTitle, setState, taskMeta, audienceMetadata, setAssignees } = require('./sdk/node');
const { isHidden } = require('./sdk/query');
const content = require('./sdk/content');
const fields = require('./sdk/fields');
const { NOT_CONNECTED, S, VIEWS, errText, idKind, isSpace, metaSigs, pathCache, truncatedViews, redoStack, report, scheduleRefresh, send, setStatus, undoStack, visibleGraphNodes } = require('./main/state');
const { cachedNodeHue, graphRow, members, rememberNodeHue, toNode } = require('./main/rows');
const { accessContext, chatOutline, createDocument, creationOptions, documentAction, history, info, linkShared, metaSig, moveTarget, mut, mutTasks, onChange, op, outlineWithReferences, setSensitive } = require('./main/documents');
const { callOf, pathOf, related, spaceChildren, summaryUri } = require('./main/related');
const { hiddenRules, listFilter, preset, refresh, search, setHidden, setViewFilter, start, viewFilter, viewRows } = require('./main/views');
const { nodePin, pinState, pinTree, pinned, setPin, todayNode, weekNode, weekTitle } = require('./main/pins');
const { image } = require('./main/images');

ipcMain.handle('doc:path', async (_e, id) => { try { const p = await pathOf(id); pathCache.set(id, p); return p; } catch (e) { report(e); return pathCache.get(id) || []; } });

// A failed S.session probe is unknown, not a confirmed sign-out. The renderer keeps the login button hidden while authChecking.
async function resolveInitialAuth(s) {
  try { return { authenticated: Boolean(await s.isAuthenticated()) }; }
  catch (error) { return { authenticated: null, error }; }
}

// The window comes back where it was left: its normal frame (not the maximized or full-screen one) and whether it was
// maximized, kept in the "window" setting. A frame that no longer sits on any display (a monitor unplugged) or that
// is not a frame at all falls back to the default size, centred; the title bar must be on a display to grab it.
const DEFAULT_WINDOW = { width: 900, height: 700 };
function restoredBounds(saved, workAreas) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) || saved.width <= 0 || saved.height <= 0) return DEFAULT_WINDOW;
  const { x, y, width, height } = saved;
  const onScreen = workAreas.some((a) => x < a.x + a.width - 40 && x + width > a.x + 40 && y >= a.y - 10 && y < a.y + a.height - 40);
  return onScreen ? { x, y, width, height } : DEFAULT_WINDOW;
}

function createWindow() {
  const saved = db.setting('window');
  S.win = new BrowserWindow({
    ...restoredBounds(saved, screen.getAllDisplays().map((d) => d.workArea)), title: 'Tana', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (saved && saved.maximized) S.win.maximize();
  // saved shortly after a move or resize settles, and once more on close, so a quit or an update relaunch keeps it
  let boundsTimer = null;
  const saveBounds = () => { clearTimeout(boundsTimer); boundsTimer = null; if (!S.win.isDestroyed()) db.setSetting('window', { ...S.win.getNormalBounds(), maximized: S.win.isMaximized() }); };
  for (const name of ['resize', 'move', 'maximize', 'unmaximize']) S.win.on(name, () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); });
  S.win.on('close', saveBounds);
  S.win.on('page-title-updated', (e) => e.preventDefault());
  S.win.on('focus', () => refresh());
  S.win.loadFile(path.join(__dirname, 'index.html'));
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => updater.check({ manual: true }) },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// Run fn on the subscribed Document; the ops transact synchronously, so the result is in Loro (and sent) on resolve.
ipcMain.handle('outline:roots', async () => {
  const rows = db.list();
  const rules = hiddenRules(); // a row cached before the rule was added is hidden here too, refresh or no refresh
  return VIEWS.map((view) => ({ ...view, truncated: truncatedViews.has(view.id), nodes: (rows[view.id] || []).filter((r) => !isHidden(r.title, rules)).map(toNode) }));
});
ipcMain.handle('view:list', async (_e, id, filter) => {
  preset(id); // validate before changing which view the refresh loop owns
  S.activeView = id;
  S.activeFilter = filter;
  await S.refreshing;
  return viewRows(id, filter);
});
ipcMain.handle('view:filter', (_e, id) => viewFilter(id));
ipcMain.handle('view:setFilter', (_e, id, filter) => {
  const stored = setViewFilter(id, filter);
  if (id === S.activeView) S.activeFilter = stored;
  return stored;
});
// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (_e, id) => (isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))));
ipcMain.handle('doc:info', (_e, id) => op(id, info));
ipcMain.handle('doc:creationOptions', () => creationOptions());
ipcMain.handle('doc:create', (_e, title, opts) => createDocument(title, opts || {}));
ipcMain.handle('search', (_e, query) => search(query));
ipcMain.handle('history:undo', () => history(undoStack, redoStack, 'undo', 'canUndo'));
ipcMain.handle('history:redo', () => history(redoStack, undoStack, 'redo', 'canRedo'));
ipcMain.handle('doc:delete', (_e, id) => documentAction(id, 'softDelete'));
ipcMain.handle('doc:restore', (_e, id) => documentAction(id, 'restore'));
ipcMain.handle('doc:setTitle', (_e, id, title) => mut(id, (doc) => { setTitle(doc, title); }));
ipcMain.handle('doc:setDone', (_e, id, done) => mut(id, (doc) => {
  setState(doc, done ? 'closed' : 'open', S.me.userUri);
  scheduleRefresh(2000); // a closed task drops off the open list
}));
ipcMain.handle('doc:setState', (_e, id, state) => mutTasks([id], (doc) => setState(doc, state, S.me.userUri)).then((count) => { scheduleRefresh(2000); return count; }));
ipcMain.handle('doc:setStateMany', (_e, ids, state) => mutTasks(ids, (doc) => setState(doc, state, S.me.userUri)).then((count) => { scheduleRefresh(2000); return count; }));
// linkSharing lives on the graph node, never in the document, so public-to-the-internet needs its own lookup
ipcMain.handle('doc:taskMeta', (_e, id) => op(id, async doc => {
  metaSigs.set(id, metaSig(readNode(doc))); // from here on, only a change to these fields invalidates the renderer's copy
  return { ...taskMeta(doc), ...await audienceMetadata(doc, S.me.userUri, S.client.graph, S.client.sync), linkShared: await linkShared(id) };
}));
// Access has native capability checks independent of the outliner's editable-body support.
ipcMain.handle('doc:accessOptions', (_e, id) => op(id, async doc => access.capabilities(doc, S.me.userUri, await accessContext())));
ipcMain.handle('doc:setSharing', (_e, id, selection) => mut(id, async doc => {
  await access.setSharing(doc, S.me.userUri, selection, await accessContext()); scheduleRefresh(2000);
}, true));
ipcMain.handle('spaces:search', async (_e, query = '') => {
  if (typeof query !== 'string' || query.length > 500) throw new Error('Invalid space query');
  if (!S.client) throw new Error(NOT_CONNECTED);
  const { nodes } = await S.client.graph.listNodes({ nodeTypes: ['space'], textQuery: query.trim(), limit: 50 });
  const ctx = await accessContext();
  const spaces = await Promise.all(nodes.map(async n => ({ ...toNode(graphRow(n)), selectable: await access.canWrite(n, S.me.userUri, ctx) })));
  // "Library" moves a document out of every space; it is a target, not a space, so it is added here rather than queried.
  const library = { id: 'library', title: 'Library', text: 'Library', kind: 'document', icon: 'library', editable: false, selectable: true };
  return 'library'.startsWith(query.trim().toLowerCase()) || !query.trim() ? [library, ...spaces] : spaces;
});
ipcMain.handle('doc:previewMove', (_e, id, spaceId) => op(id, async doc => access.previewMove(doc, await moveTarget(spaceId), S.me.userUri, await accessContext())));
ipcMain.handle('doc:moveToSpace', (_e, id, spaceId, token) => mut(id, async doc => {
  const result = await access.moveToSpace(doc, await moveTarget(spaceId), S.me.userUri, await accessContext(), token);
  pathCache.delete(id); send('outline:changed', null); scheduleRefresh(2000); return result;
}, true));
ipcMain.handle('doc:setAssignees', (_e, id, uris) => mut(id, (doc) => {
  setAssignees(doc, uris, S.me.userUri);
  scheduleRefresh(2000); // reassignment may add or remove this task from the active filter
}));
ipcMain.handle('doc:setAssigneesMany', (_e, ids, uris) => mutTasks(ids, (doc) => setAssignees(doc, uris, S.me.userUri)).then((count) => { scheduleRefresh(2000); return count; }));
ipcMain.handle('block:setText', (_e, id, nodeId, value) => mut(id, (doc) => { content.setText(doc, nodeId, value); })); // value: string or segments
ipcMain.handle('block:setBlockType', (_e, id, nodeId, type) => mut(id, (doc) => { content.setBlockType(doc, nodeId, type); })); // type: one of content.BLOCK_TYPES
ipcMain.handle('block:insertDivider', (_e, id, nodeId) => mut(id, (doc) => content.insertDivider(doc, nodeId))); // nodeId null appends at the end
ipcMain.handle('block:insertAfter', (_e, id, nodeId, text) => mut(id, (doc) => content.insertAfter(doc, nodeId, text)));
ipcMain.handle('block:insertChild', (_e, id, nodeId, text) => mut(id, (doc) => content.insertChild(doc, nodeId, text)));
ipcMain.handle('block:removeMany', (_e, id, nodeIds) => mut(id, doc => content.removeMany(doc, nodeIds)));
ipcMain.handle('block:moveMany', (_e, id, nodeIds, direction) => mut(id, doc => content.moveMany(doc, nodeIds, direction)));
ipcMain.handle('block:indentMany', (_e, id, nodeIds) => mut(id, doc => content.indentMany(doc, nodeIds)));
ipcMain.handle('block:outdentMany', (_e, id, nodeIds) => mut(id, doc => content.outdentMany(doc, nodeIds)));
ipcMain.handle('block:remove', (_e, id, nodeId) => mut(id, (doc) => { content.remove(doc, nodeId); }));
ipcMain.handle('block:indent', (_e, id, nodeId) => mut(id, (doc) => { content.indent(doc, nodeId); }));
ipcMain.handle('block:outdent', (_e, id, nodeId) => mut(id, (doc) => { content.outdent(doc, nodeId); }));
ipcMain.handle('block:move', (_e, id, nodeId, direction) => mut(id, (doc) => { content.move(doc, nodeId, direction); }));
ipcMain.handle('block:toggleCheckbox', (_e, id, nodeId) => mut(id, (doc) => { content.toggleCheckbox(doc, nodeId); }));
ipcMain.handle('pins:list', () => pinned());
ipcMain.handle('pins:state', (_e, id) => pinState(id));
ipcMain.handle('pins:pin', (_e, id, target) => setPin(id, target, true));
ipcMain.handle('pins:unpin', (_e, id, target) => setPin(id, target, false));
ipcMain.handle('pins:pinTo', (_e, hubId, uri) => nodePin(hubId, uri, true)); // pin a document on a meeting/space
ipcMain.handle('pins:unpinFrom', (_e, hubId, uri) => nodePin(hubId, uri, false));
ipcMain.handle('sensitive:list', () => db.sensitiveIds());
ipcMain.handle('sensitive:set', (_e, id, on) => setSensitive(id, on));
ipcMain.handle('doc:related', (_e, id) => related(id)); // { summary, tagline, pinned[], outcomes[], notes[] }
ipcMain.handle('doc:summaryUri', (_e, id) => summaryUri(id)); // where a meeting should actually open, or null
ipcMain.handle('doc:setField', (_e, id, key, text) => mut(id, (doc) => fields.setFieldText(doc, key, text)));
// The web link for a node, the same url home.tana.inc opens: /o/<org>/l/<encoded node uri>
ipcMain.handle('doc:link', (_e, id) => {
  // the path segment is the org *document* ulid (tana:org:01ks7…), not the WorkOS org id in S.me.orgId
  const org = (S.me && S.me.orgDocUri || '').split(':').pop();
  if (!org) throw new Error(NOT_CONNECTED);
  if (!/^tana:[a-z-]+:[0-9a-z]{26}$/.test(id)) throw new Error('Not a Tana document id');
  return 'https://home.tana.inc/o/' + org + '/l/' + encodeURIComponent(id);
});
// A link in node text opens in the user's browser; only http(s), never a file or custom scheme.
ipcMain.handle('shell:open', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  return shell.openExternal(url);
});
// The node for today: a document titled with today's date, pinned to today. Created and pinned when missing,
// so "Show today node" always lands somewhere. Matching is by exact title, the same string the pin uses.
ipcMain.handle('doc:todayNode', () => todayNode());
ipcMain.handle('doc:weekNode', async () => (await weekNode()).id);
// macOS appearance, for the renderer's "follow the system" theme: current value on demand, plus live changes
const systemTheme = () => (nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('theme:system', () => systemTheme());
if (nativeTheme) nativeTheme.on('updated', () => send('theme:system', systemTheme()));
ipcMain.handle('image', (_e, uri) => image(uri));
ipcMain.handle('members', () => members());
// Hidden titles: the user's list of patterns, applied to every list and search (see listFilter/sdk-query isHidden).
ipcMain.handle('filters:list', () => hiddenRules());
ipcMain.handle('filters:set', (_e, patterns) => setHidden(patterns));
ipcMain.handle('filters:add', (_e, pattern) => setHidden([...hiddenRules(), pattern]));
ipcMain.handle('filters:remove', (_e, pattern) => setHidden(hiddenRules().filter((p) => p.toLowerCase() !== String(pattern ?? '').trim().toLowerCase())));
ipcMain.handle('sync:refresh', () => refresh());
ipcMain.handle('sync:status', () => S.status);
ipcMain.handle('sync:login', async () => {
  try {
    await S.session.login();
    await start();
  } catch (e) {
    report(e);
  }
});

if (process.env.TANA_MAIN_TEST) {
  module.exports = { resolveInitialAuth, graphRow, cachedNodeHue, VIEWS, toNode, outlineWithReferences, chatOutline, op, onChange, documentAction, createDocument, creationOptions, search, viewRows, spaceChildren, start, refresh, related, callOf, weekTitle, weekNode,
    statusSnapshot: () => ({ ...S.status }), rememberNodeHue, restoredBounds,
    undo: () => history(undoStack, redoStack, 'undo', 'canUndo'), redo: () => history(redoStack, undoStack, 'redo', 'canRedo'), visibleGraphNodes, pinTree,
    nodePin,
    accessContext,
    testRuntime: (runtime) => { S.client = runtime.client; S.me = runtime.me; S.win = runtime.win; S.session = runtime.session; S.userData = runtime.userData || null; S.activeView = runtime.activeView || 'tasks'; S.activeFilter = undefined; if (S.client) listFilter(S.client); } };
} else {
  app.setName('Tana Companion');
  app.setPath('userData', path.join(app.getPath('appData'), 'tana-tasks')); // before 'ready': same S.session/cache for dev runs, the CLI and the packaged app

  app.whenReady().then(async () => {
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); // packaged builds carry the icon in the bundle
    S.userData = app.getPath('userData');
    db.open(path.join(S.userData, 'tasks.sqlite'));
    S.session = createTanaSession();
    createMenu();
    createWindow();
    const auth = await resolveInitialAuth(S.session);
    setStatus({ authChecking: false, authenticated: auth.authenticated, error: auth.error ? errText(auth.error) : null });
    if (auth.authenticated) {
      try { await start(); }
      catch (e) { setStatus({ error: errText(e) }); }
    }
    // Discovery has no query subscription. Refreshing the active view is one ListNodes call every 30 seconds.
    setInterval(refresh, 30000);
    // Updates: at launch and once a day, silent unless there is one (updater.js swaps the bundle and relaunches).
    updater.check();
    setInterval(() => updater.check(), 24 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { if (S.client) S.client.close().catch(() => {}); });
}
