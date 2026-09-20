'use strict';
// Electron main: the process boundary. Everything that knows Tana lives in main/ (state, rows, documents, related,
// views, pins, images); this file owns the window, the menu, the IPC table and the boot sequence, plus the test hook
// that scripts/sdk-check.js and the CLI use to drive the same modules without a window.
const { app, BrowserWindow, Menu, Notification, globalShortcut, ipcMain, nativeTheme, screen, shell } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession } = require('./tana-session');
const updater = require('./updater');
const access = require('./sdk/access');
const { readNode, setTitle, setState, taskMeta, audienceMetadata, setAssignees, setSearchQuery, setSearchView } = require('./sdk/node');
const { completedWindow, filterToSearchQuery, isHidden, searchQueryToFilter, validViewFilter } = require('./sdk/query');
const content = require('./sdk/content');
const agent = require('./main/agent');
const fields = require('./sdk/fields');
const { NOT_CONNECTED, S, VIEWS, docStates, errText, idKind, isSearch, isSpace, metaSigs, pathCache, today, truncatedViews, redoStack, report, scheduleRefresh, send, setStatus, undoStack, visibleGraphNodes } = require('./main/state');
const { cachedNodeHue, graphRow, members, rememberNodeHue, toNode } = require('./main/rows');
const { accessContext, chatOutline, codexIds, createDocument, creationOptions, creatorOf, documentAction, history, info, linkShared, metaSig, moveTarget, mut, mutTasks, notifyOn, notifyState, setCodex, setNotify, onChange, op, outlineWithReferences, setSensitive } = require('./main/documents');
const { callOf, changesOf, pathOf, related, searchChildren, searchPreview, spaceChildren, summaryChanges, summaryUri } = require('./main/related');
const { hiddenRules, inboxCount, listFilter, preset, refresh, search, searchCreate, searchList, searchTitle, setHidden, setViewFilter, start, viewFilter, viewRows } = require('./main/views');
const { nodePin, pinState, pinTree, pinned, setPin, todayNode, weekNode, weekTitle } = require('./main/pins');
const { image } = require('./main/images');
const quick = require('./main/quickadd');

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
  // The quick-add panel is a window of its own, and a hidden one still counts as open: without this, closing the
  // outliner after the panel had been summoned once would leave the app running invisibly instead of quitting.
  S.win.on('closed', () => { const panel = quick.panelState.win; if (panel && !panel.isDestroyed()) panel.destroy(); });
  S.win.loadFile(path.join(__dirname, 'index.html'));
}

// Quick add (docs/QUICK-ADD.md): a second, frameless window the global shortcut summons from any app. It is not a
// mode of the main window — the outliner keeps its own state and the panel stays cheap — and there is only ever one
// of it: main/quickadd.js decides whether a press shows, raises or hides it.
// Tall enough that the assignee list has somewhere to scroll; the card fills the window and the chooser takes
// whatever the form leaves it (quick-add.css).
const QUICK_PANEL = { width: 560, height: 320 };
function createQuickPanel() {
  const win = new BrowserWindow({
    ...QUICK_PANEL, show: false, frame: false, transparent: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Quick add',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // summoned over whatever the user is in
  win.on('blur', () => { if (!win.isDestroyed()) win.hide(); }); // clicking away dismisses it, like the shortcut does
  win.on('closed', () => { quick.panelState.win = null; });
  win.loadFile(path.join(__dirname, 'quick-add.html'));
  return win;
}
const toggleQuickPanel = () => quick.togglePanel(quick.panelState, createQuickPanel);
const hideQuickPanel = () => { const win = quick.panelState.win; if (win && !win.isDestroyed()) win.hide(); };

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
ipcMain.handle('outline:children', (_e, id) => (isSearch(id) ? searchChildren(id) : isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))));
ipcMain.handle('doc:info', (_e, id) => op(id, info));
ipcMain.handle('doc:creationOptions', () => creationOptions());
ipcMain.handle('doc:create', (_e, title, opts) => createDocument(title, opts || {}));
ipcMain.handle('search', (_e, query) => search(query));
ipcMain.handle('search:list', () => searchList());
// The renderer sends a view id, never a query: the filter→query vocabulary lives in sdk/query, which classic
// renderer scripts cannot require, and main already holds the canonical filter for every view.
ipcMain.handle('search:create', (_e, id, title) => searchCreate(id, title));
// The same filter vocabulary in both directions, so the pills that edit a view can edit a saved search. The query
// lives in a root container of its own, which readNode never sees, so reading takes it off the document directly.
// Writing replaces it wholesale rather than patching: what the pills are showing is what the document ends up saying.
ipcMain.handle('search:filter', (_e, id) => op(id, (doc) => {
  const arrangement = doc.loro.getMap('view').toJSON() || {}; // how it is shown lives beside the query, not inside it
  return {
    // the completed window is the app's own, so it is stored beside the query and handed back as part of the filter
    // the pills edit; absent, it reads as the default the pill shows the first time Completed is asked for
    filter: { ...searchQueryToFilter(doc.loro.getMap('query').toJSON(), S.me && S.me.userUri), completedWithin: completedWindow(arrangement.completedWithin) },
    sort: arrangement.sortBy,
    group: arrangement.groupBy,
    // stored as one string, since a Loro map holds scalars: '' is a real choice (a row showing nothing of itself)
    display: typeof arrangement.display === 'string' ? arrangement.display.split(',').filter(Boolean) : undefined,
  };
}));
// What the pills would find if they were saved. A staged edit has to change the rows, or the pills read as broken.
ipcMain.handle('search:preview', (_e, filter) => searchPreview(filter));
ipcMain.handle('search:setFilter', (_e, id, filter, sort, group, display) => {
  if (!validViewFilter(filter)) throw new Error('invalid view filter'); // never let a bad filter empty a saved search
  return mut(id, (doc) => {
    setSearchQuery(doc, filterToSearchQuery(filter, S.me && S.me.userUri));
    setSearchView(doc, { sortBy: sort, groupBy: group, display, completedWithin: filter.completedWithin }); // saved together: one press, one state of the page
  });
});
ipcMain.handle('history:undo', () => history(undoStack, redoStack, 'undo', 'canUndo'));
ipcMain.handle('history:redo', () => history(redoStack, undoStack, 'redo', 'canRedo'));
ipcMain.handle('doc:delete', (_e, id) => documentAction(id, 'softDelete'));
ipcMain.handle('doc:restore', (_e, id) => documentAction(id, 'restore'));
ipcMain.handle('doc:setTitle', (_e, id, title) => mut(id, (doc) => { setTitle(doc, title); }));
ipcMain.handle('doc:setDone', (_e, id, done) => mut(id, (doc) => {
  setState(doc, done ? 'closed' : 'open', S.me.userUri);
  docStates.set(id, done ? 'closed' : 'open');
  scheduleRefresh(2000); // a closed task drops off the open list
}));
// The state is recorded here, where it is known, rather than left to whatever reads the document next: the refresh
// two seconds from now asks the search index, which can still be answering with the state from before this write.
ipcMain.handle('doc:setState', (_e, id, state) => mutTasks([id], (doc) => setState(doc, state, S.me.userUri)).then((count) => { docStates.set(id, state); scheduleRefresh(2000); return count; }));
ipcMain.handle('doc:setStateMany', (_e, ids, state) => mutTasks(ids, (doc) => setState(doc, state, S.me.userUri)).then((count) => { for (const id of ids) docStates.set(id, state); scheduleRefresh(2000); return count; }));
// linkSharing lives on the graph node, never in the document, so public-to-the-internet needs its own lookup
ipcMain.handle('doc:taskMeta', (_e, id) => op(id, async doc => {
  const n = readNode(doc);
  metaSigs.set(id, metaSig(n)); // from here on, only a change to these fields invalidates the renderer's copy
  // watched rides along: the creator is a graph fact, already cached for anything a view has listed
  return { ...taskMeta(doc), ...await audienceMetadata(doc, S.me.userUri, S.client.graph, S.client.sync), linkShared: await linkShared(id), watched: notifyOn(n, await creatorOf(id)) };
}));
// Access has native capability checks independent of the outliner's editable-body support.
// Watching a node for changes: on by default where you were given access to the document itself and are not its
// assignee. null clears the choice and falls back to that rule, so "default" stays a live answer rather than a copy.
ipcMain.handle('notify:state', (_e, id) => notifyState(id));
ipcMain.handle('notify:set', (_e, id, on) => setNotify(id, on));
// Assigned to the local Codex agent: an app-local mark, not a Tana assignee (see main/documents.js).
ipcMain.handle('codex:list', () => codexIds());
// Assigning hands the node to a Codex task: the context is written, the local mark is stored, and then the work is
// opened — a new composer carrying the self-registration prompt, or the task this node already has, told what
// changed. openExternal failing raises, so the renderer shows why and the node keeps no badge it has not earned.
ipcMain.handle('codex:models', (_e, host) => agent.listModels(undefined, host));
// The machines a task can be sent to, named for the chooser. No addresses, no commands, no credentials leave main.
ipcMain.handle('codex:hosts', () => agent.hosts());
// Adding and removing machines. The form's three fields are validated here, and an invalid one is refused rather
// than stored: the renderer can name a host, never reach past this boundary with a command.
ipcMain.handle('codex:hostAdd', (_e, title, ssh, bin) => agent.addHost({ title, ssh, bin }));
ipcMain.handle('codex:hostRemove', (_e, id) => agent.removeHost(id));
ipcMain.handle('codex:taskHost', (_e, id) => { const link = agent.taskLink(id); return link ? link.host : null; });
// Which machine each linked node's task is on, read with the statuses so the UI knows what it may offer to open.
ipcMain.handle('codex:taskHosts', () => Object.fromEntries(Object.keys(agent.codexTasks()).map((id) => [id, (agent.taskLink(id) || {}).host]).filter(([, host]) => host)));
// The badge's destination: the task this node is linked to, opened by id the same way creating one does. The renderer
// passes the node, never a url, so there is nothing here to point somewhere else.
ipcMain.handle('codex:open', async (_e, id) => {
  const link = agent.taskLink(id);
  if (!link) return false; // nothing linked yet: the badge is not a button in that state either
  if (link.host !== 'local') return false; // the deep link resolves against this app only; the UI says where it is instead
  if (!shell || !shell.openExternal) throw new Error('Cannot open Codex from here');
  await shell.openExternal(agent.TASK + encodeURIComponent(link.threadId));
  return true;
});
// The handoff itself, lifted out of the handler below unchanged so the quick-add panel can hand a new task over
// through this exact path instead of a second one of its own (docs/QUICK-ADD.md).
async function assignToAgent(id, prompt, model, host) {
  const where = agent.hostId(host); // an id the registry knows, or nothing
  if (!where) throw new Error('That machine is not configured any more');
  // A machine that is not there cannot take the task: say so before anything is written, so the page keeps the
  // prompt, the model and the choice of host and the press can simply be repeated.
  if (where !== 'local' && !(await agent.hostReady(where))) throw new Error((agent.hostRecord(where).title || where) + ' cannot be reached right now');
  const result = await setCodex(id, true, prompt);
  // The node's own title, taken off the document the assignment just wrote to, so the Codex task is named after the
  // work rather than after the prompt's opening sentence. Read here and not passed in by each window: one authority
  // for both entry points, never a string a panel has been holding since it opened, and no second subscription —
  // setCodex has the document open by the time this runs.
  const open = S.client && S.client.sync.getDocument(id);
  const title = open ? readNode(open).title : '';
  const plan = agent.handoff(id, prompt, __dirname, title);
  if (plan.kind === 'create') {
    // Made here rather than through the public link: this is what gets a blank workspace, the chosen model and the
    // id up front, so the badge can stop being pending the moment the task exists and the app opens it directly.
    const threadId = await agent.createTask({ nodeUri: id, prompt: agent.agentPrompt(id, __dirname, title), model, userData: S.userData, host: where });
    agent.setCodexTask(id, threadId, where); // host and id land together, before anything reads either
    // Only a task on this machine can be opened by the local deep link; one on another host is linked and watched,
    // but the app has no route to it, and the UI says that rather than opening the wrong thing.
    if (where === 'local') {
      if (!shell || !shell.openExternal) throw new Error('Cannot open Codex from here');
      await shell.openExternal(agent.TASK + encodeURIComponent(threadId));
    }
    return result;
  }
  if (!shell || !shell.openExternal) throw new Error('Cannot open Codex from here'); // no silent success
  await shell.openExternal(plan.url);
  if (plan.queue) queueToTask(plan.threadId, plan.queue);
  return result;
}
ipcMain.handle('codex:set', async (_e, id, on, prompt, model, host) => {
  // Unassigning lets go of the link as well: the next assignment is a new task, not a return to the old one. The
  // Codex task itself is left alone — it is the user's, with its own history — and so is the Tana context.
  // Letting go of the link lets go of the writer with it: a child still holding that thread is what makes Codex
  // refuse to open it. The Codex task itself is untouched — not deleted, not archived — so its history stays.
  if (!on) { const result = await setCodex(id, false, prompt); agent.clearCodexTask(id); await agent.releaseTask(id); return result; }
  return assignToAgent(id, prompt, model, host);
});
// The current request, delivered to the task this node already has. Best effort on purpose: the task is open in
// front of the user either way, and a queue that does not land must not undo an assignment that did.
function queueToTask(threadId, message) {
  try { require('node:child_process').execFile('codex', ['queue', '--thread', threadId, '--message', message], { timeout: 20000 }, () => {}); } catch { /* the task is open regardless */ }
}
// One bounded app-server child per refresh answers for every linked node (main/agent.js).
ipcMain.handle('codex:status', () => agent.readAgentStatuses(agent.codexTasks()));
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
ipcMain.handle('doc:todayNode', (_e, offset) => todayNode(offset === 1 ? 1 : 0));
ipcMain.handle('doc:weekNode', async () => (await weekNode()).id);
// macOS appearance, for the renderer's "follow the system" theme: current value on demand, plus live changes
const systemTheme = () => (nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('theme:system', () => systemTheme());
if (nativeTheme) nativeTheme.on('updated', () => send('theme:system', systemTheme()));
ipcMain.handle('image', (_e, uri) => image(uri));
ipcMain.handle('members', () => members());
// The quick-add panel's whole surface: what to show when it opens, and the one write it makes.
ipcMain.handle('quick:context', () => quick.quickContext());
// assignToAgent is injected rather than required: main/quickadd.js knows Tana, not electron's shell, and the Agent
// handoff must stay the one above rather than a copy living in the panel's path.
ipcMain.handle('quick:create', (_e, input) => quick.quickCreate(input || {}, { assignToAgent, hostReady: (host) => agent.hostReady(agent.hostId(host) || 'local') }));
ipcMain.handle('quick:close', () => { hideQuickPanel(); return true; });
// The meeting this user has joined right now, for the outliner's Pin to meeting row: the same read the panel makes,
// so meeting detection lives in one place (main/quickadd.js) rather than once per window.
ipcMain.handle('meeting:current', () => quick.currentMeeting());
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
  module.exports = { resolveInitialAuth, graphRow, cachedNodeHue, VIEWS, toNode, outlineWithReferences, chatOutline, op, onChange, documentAction, createDocument, creationOptions, search, viewFilter, searchCreate, searchTitle, viewRows, spaceChildren, start, refresh, related, callOf, weekTitle, weekNode,
    statusSnapshot: () => ({ ...S.status }), rememberNodeHue, restoredBounds, today,
    undo: () => history(undoStack, redoStack, 'undo', 'canUndo'), redo: () => history(redoStack, undoStack, 'redo', 'canRedo'), visibleGraphNodes, pinTree, changesOf, summaryChanges,
    nodePin,
    quickContext: quick.quickContext, quickCreate: quick.quickCreate, togglePanel: quick.togglePanel, registerShortcut: quick.registerShortcut, QUICK_ACCELERATOR: quick.ACCELERATOR,
    assignToAgent, // the one handoff both entry points use, so a check can drive the panel through the real path
    accessContext, inboxCount, S,
    testRuntime: (runtime) => { S.client = runtime.client; S.me = runtime.me; S.win = runtime.win; S.session = runtime.session; S.userData = runtime.userData || null; S.activeView = runtime.activeView || 'inbox'; S.activeFilter = undefined; if (S.client) listFilter(S.client); } };
} else {
  app.setName('Tana Companion');
  app.setPath('userData', path.join(app.getPath('appData'), 'tana-tasks')); // before 'ready': same S.session/cache for dev runs, the CLI and the packaged app

  app.whenReady().then(async () => {
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); // packaged builds carry the icon in the bundle
    // The dock belongs to main, the counting to main/views: the same split refresh already uses through S.refresh.
    S.badge = (count) => { try { app.setBadgeCount(Number(count) || 0); } catch { /* no badge on this platform */ } };
    // Showing a notification is electron's; deciding there should be one is main/documents'. Clicking it opens the node.
    S.notify = (docId, title, body) => {
      if (!Notification.isSupported || !Notification.isSupported()) return;
      const note = new Notification({ title, body });
      note.on('click', () => { if (S.win && !S.win.isDestroyed()) { S.win.show(); S.win.focus(); send('notify:open', docId); } });
      note.show();
    };
    S.userData = app.getPath('userData');
    db.open(path.join(S.userData, 'tasks.sqlite'));
    S.session = createTanaSession();
    createMenu();
    createWindow();
    // The global shortcut is registered once the app is ready and released at quit; a refusal (another app holds the
    // combo) lands in the status the window shows rather than leaving a key that quietly does nothing.
    quick.registerShortcut(globalShortcut, toggleQuickPanel);
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
  app.on('before-quit', () => { if (S.client) S.client.close().catch(() => {}); agent.stopOwnedTasks(); }); // no writer outlives the app that spawned it
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
