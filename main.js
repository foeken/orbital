'use strict';
// Electron main: the process boundary. Everything that knows Tana lives in main/ (state, rows, documents, related,
// views, pins, images); this file owns the window, the menu, the IPC table and the boot sequence, plus the test hook
// that scripts/sdk-check.js and the CLI use to drive the same modules without a window.
const { app, BaseWindow, BrowserWindow, Menu, Notification, WebContentsView, globalShortcut, ipcMain, nativeTheme, screen, shell } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession } = require('./tana-session');
const { userDataDir } = require('./userdata');
const updater = require('./updater');
const access = require('./sdk/access');
const { readNode, setTitle, setState, taskMeta, audienceMetadata, setAssignees, setSearchQuery, setSearchView, searchDisplay, searchSort } = require('./sdk/node');
const { completedWindow, filterToSearchQuery, isHidden, searchQueryToFilter, validViewFilter } = require('./sdk/query');
const content = require('./sdk/content');
const { isDateUri } = require('./sdk/dates');
const agent = require('./main/agent');
const ai = require('./main/ai');
const { NOT_CONNECTED, S, VIEWS, docStates, errText, idKind, isSearch, isSpace, metaSigs, pathCache, today, truncatedViews, redoStack, report, scheduleRefresh, send, setStatus, undoStack, visibleGraphNodes } = require('./main/state');
const { cachedNodeHue, graphRow, members, rememberNodeHue, rememberType, toNode } = require('./main/rows');
const { accessContext, addTypeField, archivedTypes, chatOutline, codexIds, createDocument, creationOptions, creatorOf, defineField, discussWith, documentAction, followSummary, history, info, linkShared, metaSig, moveBlock, moveTarget, mut, mutTasks, notifyOn, notifyState, referenceIn, setCodex, setField, setNotify, onChange, op, outlineWithReferences, sensitiveIds, setSensitive, setType, setTypeHue, typeCandidates, typeChoices, typeList } = require('./main/documents');
const { callOf, changesOf, pathOf, related, searchChildren, searchPreview, spaceChildren, summaryChanges, summaryUri, unwatchRelated, watchRelated } = require('./main/related');
const { announceNewInbox, hiddenRules, watchInbox, inboxCount, listFilter, mcpHidden, myTasks, preset, refresh, search, searchCreate, searchList, searchTitle, setHidden, setMcpHidden, setViewFilter, start, viewFilter, viewRows } = require('./main/views');
const { nodePin, pinState, pinTree, pinned, pinnedDates, pinnedUris, setPin, todayNode, weekNode, weekTitle } = require('./main/pins');
const { image, insertImage, cancelUpload } = require('./main/images');
const inbox = require('./main/inbox');
const proposalsPage = require('./main/proposals');
const timelinePage = require('./main/timeline');
const icons = require('./main/icons');
const settings = require('./main/settings');
const quick = require('./main/quickadd');
const meetings = require('./main/meetings');

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

// Outliner windows (issue #137): Cmd+N opens another, a little down and right of the one in front. A window holds one
// page, or two side by side (issue #159): a BaseWindow with a WebContentsView per page, each a whole outliner with its
// own view, place and history. Main already keys a page by its webContents id (the view it shows, its sidebar watch),
// so a page beside another is to them what a page in another window is. What main pushes is shared state and goes to
// every page (main/state.js send); S.win is the window used last and S.pane its page, which a notification click opens
// in. The first window takes the saved bounds; the one closed last saves them.
S.windows = new Set();
S.windowViews = new Map(); // webContents id -> { id, filter }: the view that page shows
const MIN_PANE = 320; // neither half is dragged narrower than this (renderer/app.js splitGrip)
const SPLIT_LINE = { light: '#ececec', dark: '#2b2f31' }; // the window behind the pages, in the page's theme; the line itself is the right half's (styles.css .splitgrip)
const paneWindow = (wc) => [...S.windows].find((w) => w.panes.some((p) => p.webContents === wc));
// Signed out, every page is the same login button, so the window shows its left page alone and the right one waits
// hidden; the split stays saved and comes back after login (relayout).
const signedOut = () => S.status.authChecking === false && S.status.authenticated === false;
const isSplit = (win) => win.panes.length > 1 && !signedOut();
// each page's side ('' left or alone, '2' right) and whether it is half of a split: the grip on its inner edge (renderer/app.js)
const tellSides = (win) => win.panes.forEach((p, i) => { p.side = i ? '2' : ''; if (!p.webContents.isDestroyed()) p.webContents.send('window:side', p.side, isSplit(win)); });
// win.splitAt: the left half's share of the width, dragged by the grip and saved with the window (even by default)
function layout(win) {
  const { width, height } = win.getContentBounds(), [left, right] = win.panes;
  if (right) right.setVisible(isSplit(win));
  if (!isSplit(win)) return left && left.setBounds({ x: 0, y: 0, width, height });
  const min = Math.min(MIN_PANE, Math.floor(width / 2));
  const w = Math.max(min, Math.min(width - min, Math.round(width * (win.splitAt ?? 0.5))));
  left.setBounds({ x: 0, y: 0, width: w, height });
  right.setBounds({ x: w, y: 0, width: width - w, height });
}
const relayout = () => { for (const w of S.windows) if (!w.isDestroyed()) { layout(w); tellSides(w); } };
function addPane(win, side) {
  const pane = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  pane.side = side; // '2': the right half, which keeps its own view and place (renderer/state.js SIDE)
  pane.webContents.on('focus', () => { S.win = win; S.pane = pane.webContents; });
  win.panes.push(pane); win.contentView.addChildView(pane); layout(win);
  tellSides(win);
  pane.webContents.loadFile(path.join(__dirname, 'index.html'));
  if (win.saveBounds) win.saveBounds();
  return pane;
}
// A WebContentsView's page outlives its window unless it is closed by hand.
function removePane(win, pane) {
  const wc = pane.webContents, key = wc.id;
  win.panes = win.panes.filter((p) => p !== pane);
  if (!win.isDestroyed()) { win.contentView.removeChildView(pane); layout(win); }
  tellSides(win); // the half left alone is the window's page
  if (win.saveBounds && !win.isDestroyed()) win.saveBounds();
  S.windowViews.delete(key); unwatchRelated(key);
  if (S.pane === wc) S.pane = win.panes[0]?.webContents || null;
  // waitForBeforeUnload: the page gets its beforeunload (renderer/app.js), which sends the characters still waiting on
  // the 400 ms edit timer and lets go of its presence room and heartbeat before it is gone
  if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: true });
}
const frontPane = () => S.win && !S.win.isDestroyed() ? (S.win.panes.find((p) => p.webContents === S.pane) || S.win.panes[0])?.webContents : null;
function createWindow() {
  const saved = db.setting('window'), front = S.windows.size ? S.win : null;
  const bounds = front && !front.isDestroyed() ? { ...front.getNormalBounds(), x: front.getNormalBounds().x + 24, y: front.getNormalBounds().y + 24 } : restoredBounds(saved, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BaseWindow({ ...bounds, title: 'Orbital', titleBarStyle: 'hiddenInset', backgroundColor: SPLIT_LINE.light });
  win.panes = [];
  // saved shortly after a move or resize settles, and once more on close, so a quit or an update relaunch keeps it
  let boundsTimer = null;
  const saveBounds = () => { clearTimeout(boundsTimer); boundsTimer = null; if (!win.isDestroyed()) db.setSetting('window', { ...win.getNormalBounds(), maximized: win.isMaximized(), split: win.panes.length > 1, splitAt: win.splitAt }); };
  const saveSoon = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); };
  if (!front && saved && Number.isFinite(saved.splitAt)) win.splitAt = saved.splitAt;
  S.windows.add(win); S.win = win; S.pane = addPane(win, '').webContents;
  // the split comes back with the frame it was saved with, and a first launch (nothing saved) opens split: the Work View,
  // the Timeline beside My Tasks (renderer/edit.js reads which half it is)
  if (!front && (!saved || saved.split)) addPane(win, '2');
  win.saveBounds = saveBounds; win.saveSoon = saveSoon; // a split opened, closed or dragged is saved too
  if (!front && saved && saved.maximized) win.maximize();
  for (const name of ['resize', 'move', 'maximize', 'unmaximize']) win.on(name, saveSoon);
  win.on('resize', () => layout(win));
  win.on('close', saveBounds);
  win.on('focus', () => { S.win = win; refresh(); });
  win.on('closed', () => {
    // right half first: the left one closing first would leave the right one alone for a moment, and removePane would
    // hand it the left half's keys, so it saved its page over the left one's and a restart opened both on it
    for (const p of [...win.panes].reverse()) removePane(win, p);
    S.windows.delete(win);
    if (S.win === win) { S.win = [...S.windows].at(-1) || null; S.pane = frontPane(); }
  });
}
// ⌥⌘N (issue #159): a second page beside the one that asked, opening where it was (the renderer stores its place
// first), or back to one page, the one that asked.
function toggleSplit(wc) {
  const win = paneWindow(wc);
  if (!win) return;
  if (win.panes.length > 1) { for (const p of win.panes) if (p.webContents !== wc) removePane(win, p); return; }
  const pane = addPane(win, '2');
  pane.webContents.once('did-finish-load', () => pane.webContents.focus()); // keyboard first: the new page takes the keys
}
// Cmd+W closes the page you are in when there are two, and the window otherwise.
function closeFront(win, wc = S.pane) {
  if (!win) return;
  const pane = win.panes && win.panes.length > 1 && win.panes.find((p) => p.webContents === wc);
  if (pane) removePane(win, pane); else win.close();
}

// Quick add (docs/QUICK-ADD.md): a second, frameless window the global shortcut summons from any app. It is not a
// mode of the main window — the outliner keeps its own state and the panel stays cheap — and there is only ever one
// of it: main/quickadd.js decides whether a press shows, raises or hides it.
// Tall enough that the assignee list has somewhere to scroll; the card fills the window and the chooser takes
// whatever the form leaves it (quick-add.css).
const QUICK_PANEL = { width: 560, height: 320 };
function createQuickPanel() {
  const win = new BrowserWindow({
    // A real panel: the system's material behind the form, and its own rounded corners and shadow around it
    ...QUICK_PANEL, show: false, frame: false, vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000', roundedCorners: true, resizable: false, minimizable: false,
    maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, title: 'Quick add',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // summoned over whatever the user is in
  win.on('blur', () => { if (!win.isDestroyed()) win.hide(); }); // clicking away dismisses it, like the shortcut does
  win.on('hide', () => { if (nativeTheme) nativeTheme.themeSource = 'system'; }); // only while it shows: the outliner's Follow system reads it
  win.on('closed', () => { quick.panelState.win = null; });
  win.loadFile(path.join(__dirname, 'quick-add.html'));
  return win;
}
// The panel's material is native, and native material follows the app's appearance, not the page: so the app takes
// Orbital's own theme, or the panel's text would sit on the wrong material whenever it differs from macOS's.
const themeSource = () => { const t = settings.prefs().theme; return t === 'dark' || t === 'light' ? t : 'system'; };
const toggleQuickPanel = () => { if (nativeTheme) nativeTheme.themeSource = themeSource(); quick.togglePanel(quick.panelState, createQuickPanel); };
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
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => createWindow() }, { type: 'separator' }, { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => closeFront(BaseWindow.getFocusedWindow()) }] },
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
ipcMain.handle('view:list', async (e, id, filter) => {
  preset(id); // validate before changing which view the refresh loop owns
  S.activeView = id;
  S.activeFilter = filter;
  if (e && e.sender && S.windows.size) S.windowViews.set(e.sender.id, { id, filter }); // this window's view (the checks call with no event)
  await S.refreshing;
  return viewRows(id, filter);
});
ipcMain.handle('view:filter', (_e, id) => viewFilter(id));
ipcMain.handle('view:setFilter', (_e, id, filter) => {
  const stored = setViewFilter(id, filter);
  if (id === S.activeView) S.activeFilter = stored;
  for (const v of S.windowViews.values()) if (v.id === id) v.filter = stored; // every window showing it
  return stored;
});
// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (e, id) => (id === inbox.PAGE ? inbox.rows() : id === proposalsPage.PAGE ? proposalsPage.rows() : id === timelinePage.PAGE ? timelinePage.rows((part) => { if (!e.sender.isDestroyed()) e.sender.send('timeline:part', part); }) : isSearch(id) ? searchChildren(id) : isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))));
// Notifications (main/inbox.js): the page's rows come through outline:children above; these are its count and writes.
ipcMain.handle('inbox:unread', () => inbox.unread());
ipcMain.handle('inbox:setRead', (_e, id, read) => inbox.setRead(id, !!read));
ipcMain.handle('inbox:markAll', () => inbox.markAll());
// Proposals (main/proposals.js): its rows come through outline:children too; this is the one write, approve or reject.
ipcMain.handle('timeline:pages', (_e, n) => timelinePage.setPages(n)); // how many pages of three days back the Timeline reads (main/timeline.js)
ipcMain.handle('proposals:answer', (_e, chatUri, proposedUri, approve) => proposalsPage.answer(chatUri, proposedUri, !!approve));
ipcMain.handle('doc:info', (_e, id) => op(id, info));
ipcMain.handle('doc:creationOptions', () => creationOptions());
// A document's type: the choices it can be given (with the ones it cannot, and why), and the change itself.
ipcMain.handle('doc:types', (_e, id) => typeChoices(id));
ipcMain.handle('doc:setType', (_e, id, typeUri) => setType(id, typeUri ?? null));
// Fields that hold choices or links (issue #33): a value checked the way Tana checks it, a field's definition on its
// type, a new field, and every type a link field could point at.
ipcMain.handle('field:set', (_e, id, key, value) => setField(id, key, value));
ipcMain.handle('field:define', (_e, typeUri, attribute, change) => defineField(typeUri, attribute, change || {}));
ipcMain.handle('field:add', (_e, typeUri, def) => addTypeField(typeUri, def));
ipcMain.handle('types:list', () => typeList());
// A type's colour: the one `appearance` field Tana keeps, written on the type itself, so every document wearing
// it follows. setTypeHue rebuilds the rows and announces them itself, since no change event carries appearance.
ipcMain.handle('doc:setTypeHue', (_e, typeUri, hue) => setTypeHue(typeUri, hue ?? null));
// A type's own glyph: the built-in Nucleo set to search, the glyphs currently chosen (sent with every roots load so
// no row is drawn before the glyph it names exists), and the choice itself. App-local: Tana has nowhere to keep it.
ipcMain.handle('icons:search', (_e, query) => icons.searchIcons(query));
ipcMain.handle('icons:types', () => icons.typeIcons());
// The renderer's preferences, from the same store: a synchronous snapshot at load (preload reads it before the
// first paint) and one write per change.
// the menu shows ⌘N but leaves the key to the renderer's New window row (DEFAULT_HOTKEYS), so it can be re-recorded
ipcMain.handle('window:new', () => { createWindow(); });
ipcMain.handle('window:split', (e) => { toggleSplit(e.sender); });
// ⌘\: the keys go to the other half of a split (nothing to do in a window with one page)
ipcMain.handle('window:otherPane', (e) => { const other = paneWindow(e.sender)?.panes.find((p) => p.webContents !== e.sender); if (other) other.webContents.focus(); });
// asked by preload.js on every load, a Reload included: which side this page is ('' left or alone, '2' the right half).
// A restart adds both halves before either loads, so a restored right half knows it is one.
ipcMain.on('window:getSide', (e) => {
  const win = paneWindow(e.sender);
  e.returnValue = { side: win?.panes.find((p) => p.webContents === e.sender)?.side || '', split: Boolean(win && isSplit(win)) };
});
// Cmd+K Work View (renderer/timeline.js): the page asking has stored both halves' places. A new right half reads its
// own at load; a half already open is told to go to its own.
ipcMain.handle('window:workView', (e) => {
  const win = paneWindow(e.sender);
  if (!win) return;
  if (win.panes.length < 2) addPane(win, '2');
  else for (const p of win.panes) if (p.webContents !== e.sender) p.webContents.send('window:toPlace');
});
// The X at the end of the right half's header (renderer/app.js): that half closes, as Cmd+W closes it. Only in a
// split: a page alone never closes its window from here.
ipcMain.handle('window:closePane', (e) => { const win = paneWindow(e.sender); if (win && win.panes.length > 1) closeFront(win, e.sender); });
// A page's header is a window drag region, where the page hears nothing of the mouse, so a page the pointer has left
// asks for the cursor to be watched here: every 100 ms until it is outside that half, and then it is told
// (renderer/app.js pointer-in, which shows the top row).
ipcMain.on('window:watchPointer', (e) => {
  const wc = e.sender, win = paneWindow(wc), pane = win && win.panes.find((p) => p.webContents === wc);
  if (!pane) return;
  clearInterval(pane.pointerTimer);
  pane.pointerTimer = setInterval(() => {
    if (win.isDestroyed() || wc.isDestroyed()) return clearInterval(pane.pointerTimer);
    const { x, y } = screen.getCursorScreenPoint(), c = win.getContentBounds(), b = pane.getBounds();
    if (x >= c.x + b.x && x < c.x + b.x + b.width && y >= c.y + b.y && y < c.y + b.y + b.height) return;
    clearInterval(pane.pointerTimer);
    wc.send('window:pointerOut');
  }, 100);
});
// Cmd+K Swap panes: the halves change sides, and each takes the other's side marker, so a restart keeps them there
ipcMain.handle('window:swapPanes', (e) => {
  const win = paneWindow(e.sender);
  if (!win || win.panes.length < 2) return;
  win.panes.reverse();
  if (win.splitAt != null) win.splitAt = 1 - win.splitAt; // each half keeps its width
  tellSides(win);
  layout(win);
  win.saveSoon();
});
// The grip on the right half's left edge (renderer/app.js splitGrip): 'start', 'move' or 'even'. The cursor is read
// here, from the screen, rather than from the page: the page moves under the pointer as it is dragged, so its own
// coordinates run ahead of the drag. The share kept is the one on screen, clamped, so a restart draws the same line.
ipcMain.on('window:splitDrag', (e, phase) => {
  const win = paneWindow(e.sender);
  if (!win || win.panes.length < 2) return;
  const b = win.getContentBounds(), room = b.width, x = screen.getCursorScreenPoint().x - b.x;
  if (phase === 'start') { win.dragOffset = x - win.panes[0].getBounds().width; return; }
  if (phase === 'even') win.splitAt = undefined;
  else { const min = Math.min(MIN_PANE, Math.floor(room / 2)); win.splitAt = Math.max(min, Math.min(room - min, x - (win.dragOffset || 0))) / room; }
  layout(win); win.saveSoon();
});
// The pointer is over one half's grip: the other half draws its half of the swap pill too, so the two meet on the line
ipcMain.on('window:splitHover', (e, on) => { for (const p of paneWindow(e.sender)?.panes || []) if (p.webContents !== e.sender) p.webContents.send('window:splitHover', on); });
// a page says which theme it drew itself in (renderer/theme.js), and the line between split pages follows it
ipcMain.on('window:theme', (e, theme) => { const win = paneWindow(e.sender); if (win) win.setBackgroundColor(SPLIT_LINE[theme] || SPLIT_LINE.light); });
// Demo mode lives in the outliner (renderer/state.js); main only needs to know it is on, so no banner shows a real title.
ipcMain.on('app:demoMode', (_e, on) => { S.demo = on === true; });
ipcMain.on('prefs:snapshot', (e) => { e.returnValue = settings.prefs(); });
// A setting one page writes reaches every other page and window at once: settings.applyRemote announces only what
// another machine changed, since this machine's own write comes back from Tana as nothing new. The writer is left
// out, because it already holds the value and an older snapshot arriving late would undo a newer choice there.
const tellOthers = (sender) => {
  const synced = settings.prefs();
  for (const w of S.windows) if (!w.isDestroyed()) for (const p of w.panes) if (p.webContents !== sender && !p.webContents.isDestroyed()) p.webContents.send('settings:changed', synced);
};
ipcMain.handle('prefs:set', (e, key, value) => { const stored = settings.setPref(key, value); tellOthers(e?.sender); return stored; });
ipcMain.handle('openai:setKey', (_e, key) => {
  if (typeof key !== 'string' || !key.trim()) throw new Error('OpenAI API key cannot be empty');
  settings.set('openaiApiKey', key.trim());
  return true;
});
ipcMain.handle('chatgpt:status', () => ai.chatgptStatus(app.getPath('userData'), true));
ipcMain.handle('chatgpt:login', async () => {
  const result = await ai.startChatGPTLogin(app.getPath('userData'));
  if (!result.verificationUrl) return result;
  try {
    const loginUrl = new URL(result.verificationUrl);
    if (loginUrl.protocol !== 'https:') throw new Error('Codex returned an invalid ChatGPT sign-in URL');
    await shell.openExternal(loginUrl.toString());
  }
  catch (error) { await ai.cancelChatGPTLogin(app.getPath('userData')); throw error; }
  return { loggingIn: true, userCode: result.userCode };
});
ipcMain.handle('chatgpt:cancel', () => ai.cancelChatGPTLogin(app.getPath('userData')));
ipcMain.handle('chatgpt:logout', () => ai.logoutChatGPT(app.getPath('userData')));
ipcMain.handle('icons:setType', async (_e, typeUri, name) => {
  const chosen = icons.setTypeIcon(typeUri, name ?? null);
  await refresh(); // the cached rows carry the icon name, so they are rebuilt before anything is told to redraw
  send('outline:changed', null);
  return chosen;
});
ipcMain.handle('doc:create', (_e, title, opts) => createDocument(title, opts || {}));
ipcMain.handle('search', (_e, query, scope) => search(query, scope));
ipcMain.handle('search:list', () => searchList());
// The renderer sends a view id, never a query: the filter→query vocabulary lives in sdk/query, which classic
// renderer scripts cannot require, and main already holds the canonical filter for every view.
ipcMain.handle('search:create', (_e, id, title) => searchCreate(id, title));
ipcMain.handle('search:myTasks', (_e, findOnly) => myTasks(findOnly === true));
// The same filter vocabulary in both directions, so the pills that edit a view can edit a saved search. The query
// lives in a root container of its own, which readNode never sees, so reading takes it off the document directly.
// Writing replaces it wholesale rather than patching: what the pills are showing is what the document ends up saying.
ipcMain.handle('search:filter', (_e, id) => op(id, (doc) => {
  const arrangement = doc.loro.getMap('view').toJSON() || {}; // how it is shown lives beside the query, not inside it
  return {
    // the completed window is the app's own, so it is stored beside the query and handed back as part of the filter
    // the pills edit; absent, it reads as the default the pill shows the first time Completed is asked for
    filter: { ...searchQueryToFilter(doc.loro.getMap('query').toJSON(), S.me && S.me.userUri), completedWithin: completedWindow(arrangement.completedWithin) },
    sort: searchSort(arrangement.sortBy),
    group: arrangement.groupBy,
    // Tana's record of key -> { shown, order } (or the comma-joined string earlier builds wrote)
    display: searchDisplay(arrangement.display),
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
ipcMain.handle('doc:archive', (_e, id) => documentAction(id, 'archive'));
ipcMain.handle('doc:unarchive', (_e, id) => documentAction(id, 'unarchive'));
ipcMain.handle('types:archived', () => archivedTypes());
ipcMain.handle('deleted:list', () => db.deletedList()); // local: the graph does not list deleted documents
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
  // A task that already lives on another machine cannot be opened or queued from here — the deep link and the Codex
  // CLI both resolve against this app's own store, which is why the badge's codex:open refuses the same way — so it
  // is refused before the context and the stored prompt are rewritten for a handoff that will not happen.
  const existing = agent.taskLink(id);
  if (existing && existing.host !== 'local') throw new Error('This task runs on ' + ((agent.hostRecord(existing.host) || {}).title || existing.host) + '; queue to it from that machine');
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
// Linking a node to a Codex task that already exists (#143): the link Codex copies, codex://threads/<id>, or the bare
// id. The node takes the local agent mark the way an assignment does, as a task on this machine, where a pasted
// link can only have come from; no task is started and nothing is written to the node.
ipcMain.handle('codex:link', async (_e, id, link) => {
  if (typeof id !== 'string' || !/^tana:[a-z-]+:[0-9a-z]{26}$/.test(id)) throw new Error('Not a Tana node');
  const threadId = String(link || '').trim().replace(/^codex:\/\/threads\//i, '').replace(/\/$/, '');
  if (!agent.THREAD_ID.test(threadId)) throw new Error('Paste a Codex task link: codex://threads/…');
  const result = await setCodex(id, true);
  agent.setCodexTask(id, threadId, 'local');
  return result;
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
ipcMain.handle('block:setCell', (_e, id, cellId, value) => mut(id, (doc) => { content.setCellText(doc, cellId, value); })); // one table cell's text, same value as setText
ipcMain.handle('block:tableOp', (_e, id, cellId, op) => mut(id, (doc) => content.tableOp(doc, cellId, op))); // a row or column around a cell (content.TABLE_OPS); returns the cell for the caret
ipcMain.handle('block:setBlockType', (_e, id, nodeId, type) => mut(id, (doc) => { content.setBlockType(doc, nodeId, type); })); // type: one of content.BLOCK_TYPES
ipcMain.handle('block:insertDivider', (_e, id, nodeId) => mut(id, (doc) => content.insertDivider(doc, nodeId))); // nodeId null appends at the end
ipcMain.handle('block:insertImage', (_e, id, nodeId, file, uploadId) => insertImage(id, nodeId, file, uploadId)); // file { bytes, filename, mimeType }: upload, image document, block after nodeId
ipcMain.handle('block:cancelUpload', (_e, uploadId) => cancelUpload(uploadId));
ipcMain.handle('block:insertTable', (_e, id, nodeId) => mut(id, (doc) => content.insertTable(doc, nodeId))); // "/" Table: 3x3 with a header row after nodeId; returns its first cell
ipcMain.handle('block:insertAfter', (_e, id, nodeId, text, block) => mut(id, (doc) => content.insertAfter(doc, nodeId, text, false, block)));
ipcMain.handle('block:insertBefore', (_e, id, nodeId, text) => mut(id, (doc) => content.insertBefore(doc, nodeId, text)));
ipcMain.handle('block:split', (_e, id, nodeId, before, after, asChild) => mut(id, (doc) => content.split(doc, nodeId, before, after, asChild))); // one undo step for both halves
ipcMain.handle('block:join', (_e, id, nodeId, intoId, value) => mut(id, (doc) => content.join(doc, nodeId, intoId, value))); // its reverse: the row above takes the words, one undo step
ipcMain.handle('block:insertChild', (_e, id, nodeId, text) => mut(id, (doc) => content.insertChild(doc, nodeId, text)));
ipcMain.handle('block:removeMany', (_e, id, nodeIds) => mut(id, doc => content.removeMany(doc, nodeIds)));
ipcMain.handle('block:moveMany', (_e, id, nodeIds, direction) => mut(id, doc => content.moveMany(doc, nodeIds, direction)));
ipcMain.handle('block:indentMany', (_e, id, nodeIds) => mut(id, doc => content.indentMany(doc, nodeIds)));
ipcMain.handle('block:outdentMany', (_e, id, nodeIds) => mut(id, doc => content.outdentMany(doc, nodeIds)));
ipcMain.handle('block:remove', (_e, id, nodeId) => mut(id, (doc) => { content.remove(doc, nodeId); }));
ipcMain.handle('block:indent', (_e, id, nodeId) => mut(id, (doc) => { content.indent(doc, nodeId); }));
ipcMain.handle('block:outdent', (_e, id, nodeId) => mut(id, (doc) => { content.outdent(doc, nodeId); }));
ipcMain.handle('block:move', (_e, id, nodeId, direction) => mut(id, (doc) => { content.move(doc, nodeId, direction); }));
// A drag names the place outright: the row lands behind afterId, or at the top of parentId, or at the top of toId's
// own rows. toId is the outline it lands in, which is the page or one of its fields (main/documents.js moveBlock).
ipcMain.handle('block:moveTo', (_e, id, nodeId, toId, parentId, afterId) => moveBlock(id, nodeId, toId, parentId, afterId));
// The same place, with a link landing in it instead of the row itself (main/documents.js referenceIn).
ipcMain.handle('block:insertMention', (_e, toId, uri, label, parentId, afterId) => referenceIn(toId, uri, label, parentId, afterId));
ipcMain.handle('block:toggleCheckbox', (_e, id, nodeId) => mut(id, (doc) => { content.toggleCheckbox(doc, nodeId); }));
ipcMain.handle('pins:list', () => pinned());
ipcMain.handle('pins:state', (_e, id) => pinState(id));
ipcMain.handle('pins:ids', () => pinnedUris()); // which documents carry a pin at all, for the mark on a row
ipcMain.handle('pins:dates', () => pinnedDates()); // { uri: ['YYYY-MM-DD'] }, for the Pinned section
ipcMain.handle('pins:pin', (_e, id, target, date) => setPin(id, target, true, date));
ipcMain.handle('pins:unpin', (_e, id, target, date) => setPin(id, target, false, date));
ipcMain.handle('pins:pinTo', (_e, hubId, uri) => nodePin(hubId, uri, true)); // pin a document on a meeting/space
ipcMain.handle('pins:unpinFrom', (_e, hubId, uri) => nodePin(hubId, uri, false));
ipcMain.handle('sensitive:list', () => sensitiveIds()); // the synced setting sensitive:set writes; db's table is only its migration source
ipcMain.handle('sensitive:set', (e, id, on) => { const stored = setSensitive(id, on); tellOthers(e?.sender); return stored; });
ipcMain.handle('doc:related', (_e, id) => related(id)); // { summary, tagline, pinned[], outcomes[], proposals[], notes[], backlinks[] }
ipcMain.handle('doc:watchRelated', (e, id) => watchRelated(id, e && e.sender ? e.sender.id : 'main')); // the page on screen (null: none): its sidebar's edges pushed as 'related:changed'
ipcMain.handle('meeting:info', (_e, id) => meetings.meetingInfo(id));
ipcMain.handle('meeting:edit', (_e, id, change) => meetings.editMeeting(id, change));
ipcMain.handle('meeting:suggestions', () => meetings.attendeeSuggestions());
ipcMain.handle('doc:summaryUri', (_e, id) => summaryUri(id)); // where a meeting should actually open, or null
// "Discuss with …": one call for the type and the field, because both are the same decision (main/documents.js)
ipcMain.handle('doc:discussWith', (_e, id, who) => discussWith(id, who));
// and what the title suggests that name is (main/ai.js). ChatGPT auth takes priority over the local API key.
ipcMain.handle('ai:discussWith', (_e, title) => ai.suggestDiscussWith(title, globalThis.fetch, app.getPath('userData')));
// "Classify type": the types this document may have, weighed by the model; the write stays doc:setType's
ipcMain.handle('ai:classifyType', async (_e, id) => ai.classifyType(await typeCandidates(id), globalThis.fetch, app.getPath('userData')));
// Presence (main/presence.js): the renderer opens a room per document on screen, names the one being viewed, and says
// where its caret is.
const presence = require('./main/presence');
ipcMain.handle('presence:open', (_e, id) => presence.open(id));
ipcMain.handle('presence:close', (_e, id) => presence.close(id));
ipcMain.handle('presence:view', (e, id) => presence.view(id, e.sender.id)); // per page: one half going away cannot end the other's heartbeat
ipcMain.handle('presence:set', (_e, id, at) => presence.set(id, at && typeof at.blockId === 'string' ? { blockId: at.blockId, anchor: Number(at.anchor) || 0, focus: Number(at.focus) || 0 } : null));
ipcMain.handle('doc:exportPdf', (_e, id) => require('./main/pdf').exportPdf(id, S.win));
// The web link for a node, the same url home.tana.inc opens: /o/<org>/<route>/<encoded node uri>. The route is Tana's
// per kind (its link resolver beside JP.type.url, shared bundle of 2026-09-23): a type, a person, a meeting and a space
// have pages of their own, and /l/ — every other document — shows a type as raw JSON (issue #88).
const LINK_ROUTES = { type: 't', 'user-profile': 'u', event: 'e', space: 's' };
ipcMain.handle('doc:link', (_e, id) => {
  // the path segment is the org *document* ulid (tana:org:01ks7…), not the WorkOS org id in S.me.orgId
  const org = (S.me && S.me.orgDocUri || '').split(':').pop();
  if (!org) throw new Error(NOT_CONNECTED);
  if (!/^tana:[a-z-]+:[0-9a-z]{26}$/.test(id)) throw new Error('Not a Tana document id');
  return 'https://home.tana.inc/o/' + org + '/' + (LINK_ROUTES[id.split(':')[1]] || 'l') + '/' + encodeURIComponent(id);
});
// A link in node text opens in the user's browser; only http(s), never a file or custom scheme.
ipcMain.handle('shell:open', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  return shell.openExternal(url);
});
// The node for today: a document titled with today's date, pinned to today. Created and pinned when missing,
// so "Show today node" always lands somewhere. Matching is by exact title, the same string the pin uses.
// A 'YYYY-MM-DD' day instead of the offset is the page a date mention opens.
ipcMain.handle('doc:todayNode', (_e, offset, findOnly) => todayNode(isDateUri('tana:plaindate:' + offset) ? offset : offset === 1 ? 1 : 0, findOnly === true));
ipcMain.handle('doc:weekNode', async (_e, findOnly) => (await weekNode(new Date(), findOnly === true)).id);
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
ipcMain.handle('quick:create', (_e, input) => quick.quickCreate(input || {}, { assignToAgent }));
ipcMain.handle('quick:close', () => { hideQuickPanel(); return true; });
// The meeting this user has joined right now, for the outliner's Pin to meeting row: the same read the panel makes,
// so meeting detection lives in one place (main/quickadd.js) rather than once per window.
ipcMain.handle('meeting:current', () => quick.currentMeeting());
// Hidden titles: the user's list of patterns, applied to every list and search (see listFilter/sdk-query isHidden).
ipcMain.handle('filters:list', () => hiddenRules());
ipcMain.handle('filters:set', (_e, patterns) => setHidden(patterns));
ipcMain.handle('filters:add', (_e, pattern) => setHidden([...hiddenRules(), pattern]));
ipcMain.handle('filters:remove', (_e, pattern) => setHidden(hiddenRules().filter((p) => p.toLowerCase() !== String(pattern ?? '').trim().toLowerCase())));
// MCP chats: one switch over every list and search, applied in the same listFilter the hidden titles go through.
ipcMain.handle('mcp:hidden', () => mcpHidden());
ipcMain.handle('mcp:setHidden', async (e, on) => { const stored = await setMcpHidden(on); tellOthers(e?.sender); return stored; });
ipcMain.handle('sync:refresh', () => refresh());
ipcMain.handle('sync:status', () => S.status);
ipcMain.handle('sync:login', async () => {
  try {
    await S.session.login();
    await start();
  } catch (e) {
    report(e);
  } finally { relayout(); }
});

if (process.env.TANA_MAIN_TEST) {
  module.exports = { resolveInitialAuth, graphRow, cachedNodeHue, rememberType, VIEWS, toNode, outlineWithReferences, chatOutline, op, onChange, documentAction, archivedTypes, createDocument, creationOptions, typeChoices, typeCandidates, setType, setTypeHue, discussWith, ai, icons, settings, search, viewFilter, searchCreate, searchTitle, viewRows, spaceChildren, start, refresh, related, watchRelated, callOf, weekTitle, weekNode,
    statusSnapshot: () => ({ ...S.status }), rememberNodeHue, restoredBounds, today,
    undo: () => history(undoStack, redoStack, 'undo', 'canUndo'), redo: () => history(redoStack, undoStack, 'redo', 'canRedo'), visibleGraphNodes, pinTree, changesOf, summaryChanges, followSummary, announceNewInbox, watchInbox, timelinePage,
    nodePin, layout,
    quickContext: quick.quickContext, quickCreate: quick.quickCreate, togglePanel: quick.togglePanel, registerShortcut: quick.registerShortcut, QUICK_ACCELERATOR: quick.ACCELERATOR,
    assignToAgent, // the one handoff both entry points use, so a check can drive the panel through the real path
    accessContext, inboxCount, S,
    testRuntime: (runtime) => { S.client = runtime.client; S.me = runtime.me; S.win = runtime.win; S.session = runtime.session; S.userData = runtime.userData || null; S.activeView = runtime.activeView || 'inbox'; S.activeFilter = undefined; if (S.client) listFilter(S.client); } };
} else {
  app.setName('Orbital');
  // The About panel reads the bundle's plist, which in a dev run is Electron's own name and version; say it here instead.
  // The icon is named only for a dev run: the packaged app leaves build/icon.png out (package.json --ignore) and
  // carries its own, so naming that path there would point at a file the bundle does not have.
  app.setAboutPanelOptions({ applicationName: 'Orbital', applicationVersion: app.getVersion(), version: '', ...(app.isPackaged ? {} : { iconPath: path.join(__dirname, 'build', 'icon.png') }) });
  // Before 'ready': the same session, cache and settings mirror for dev runs, the CLI and the packaged app. The
  // folder is named after the app, so an install still carrying the old name is moved here once (userdata.js).
  app.setPath('userData', userDataDir(app.getPath('appData'), { migrate: true }));

  app.whenReady().then(async () => {
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); // packaged builds carry the icon in the bundle
    // The dock belongs to main, the counting to main/views: the same split refresh already uses through S.refresh.
    S.badge = (count) => { try { app.setBadgeCount(Number(count) || 0); } catch { /* no badge on this platform */ } };
    // Showing a notification is electron's; deciding there should be one is main/documents'. Clicking it opens the node.
    // An edit banner has one macOS identifier per node, so the 'summary' that follows it (Tana's sentence for the edit,
    // main/documents.js followSummary) replaces it in place, silently — unless it was clicked, and so already seen.
    const clickedEdits = new Set();
    S.notify = (docId, title, body, kind, subtitle) => { // subtitle: macOS's line between title and body (what an edit changed)
      if (S.demo || !Notification.isSupported || !Notification.isSupported()) return; // demo mode: nothing real on screen, banners included
      const id = kind ? 'edit:' + docId : undefined; // undefined: a fresh random id, as before
      if (kind === 'summary' && clickedEdits.has(id)) return;
      if (kind === 'edit') clickedEdits.delete(id);
      const note = new Notification({ id, title, subtitle, body, silent: kind === 'summary' });
      note.on('click', () => { // the page used last, not all of them; a new window when the last one was closed
        if (id) clickedEdits.add(id);
        let wc = frontPane();
        if (!wc) { createWindow(); wc = frontPane(); return wc.once('did-finish-load', () => wc.send('notify:open', docId)); }
        S.win.show(); S.win.focus(); wc.focus(); wc.send('notify:open', docId);
      });
      note.show();
    };
    S.userData = app.getPath('userData');
    db.open(path.join(S.userData, 'tasks.sqlite'));
    S.session = createTanaSession();
    createMenu();
    createWindow();
    // Closing the last window keeps the app in the Dock, as a Mac app does (Cmd+Q quits); the Dock icon opens a new
    // one, and brings the window forward while there is one. Registered once the first window exists, so a click
    // during launch cannot open a window before the database is.
    app.on('activate', () => { if (!S.windows.size) createWindow(); });
    // The global shortcut is registered once the app is ready and released at quit; a refusal (another app holds the
    // combo) lands in the status the window shows rather than leaving a key that quietly does nothing.
    quick.registerShortcut(globalShortcut, toggleQuickPanel);
    const auth = await resolveInitialAuth(S.session);
    setStatus({ authChecking: false, authenticated: auth.authenticated, error: auth.error ? errText(auth.error) : null });
    relayout();
    if (auth.authenticated) {
      try { await start(); }
      catch (e) { setStatus({ error: errText(e) }); }
    }
    // The lists are kept current by live queries (main/views.js watchViews, watchMine, watchInbox; a saved search in
    // main/related.js): Tana pushes their answers, and each answer re-reads its list. This is only the backstop for a
    // push that never arrived — a dropped connection, a query Tana refused — at a tenth of the old 30 s poll.
    setInterval(refresh, 5 * 60 * 1000);
    // Updates: at launch and once a day, silent unless there is one (updater.js swaps the bundle and relaunches).
    updater.check();
    setInterval(() => updater.check(), 24 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => {}); // stay in the Dock (activate above)
  app.on('before-quit', () => { if (S.client) S.client.close().catch(() => {}); agent.stopOwnedTasks(); ai.stop(); }); // no writer outlives the app that spawned it
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
