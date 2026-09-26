'use strict';
// Electron main: the process boundary. Everything that knows Tana lives in main/ (state, rows, documents, related,
// views, pins, images, and each one's ipc table); this file owns the window, the menu, the boot sequence and the
// registering of those tables, plus the test hook that scripts/sdk-check.js and the CLI use to drive the same
// modules without a window.
const { app, BaseWindow, Menu, Notification, WebContentsView, ipcMain, nativeTheme, screen, shell } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession } = require('./tana-session');
const { userDataDir } = require('./userdata');
const updater = require('./updater');
const { readNode } = require('./sdk/node');
const agent = require('./main/agent');
const ai = require('./main/ai');
const { S, VIEWS, errText, idKind, isSearch, isSpace, today, redoStack, report, send, setStatus, undoStack, visibleGraphNodes } = require('./main/state');
const { cachedNodeHue, graphRow, rememberNodeHue, rememberType, toNode } = require('./main/rows');
const { accessContext, archivedTypes, chatOutline, createDocument, creationOptions, discussWith, documentAction, followSummary, history, setCodex, onChange, op, outlineWithReferences, setSensitive, setType, setTypeHue, typeCandidates, typeChoices, typeList } = require('./main/documents');
const { callOf, changesOf, related, searchChildren, spaceChildren, summaryChanges, unwatchRelated, watchRelated } = require('./main/related');
const { announceNewInbox, watchInbox, inboxCount, listFilter, refresh, search, searchCreate, searchTitle, setMcpHidden, start, viewFilter, viewRows } = require('./main/views');
const { nodePin, pinTree, weekNode, weekTitle } = require('./main/pins');
const inbox = require('./main/inbox');
const proposalsPage = require('./main/proposals');
const timelinePage = require('./main/timeline');
const icons = require('./main/icons');
const settings = require('./main/settings');
const meetings = require('./main/meetings');

// A main/ module that answers the renderer keeps its channels beside the code they call, as a table it exports:
// ipc = { 'channel': (event, ...args) => … }. preload.js names each channel for the page. What main.js registers
// itself is Electron's: windows, overlays, shell (the Codex handoff opens Codex through it), app paths, and settings
// sent to the other pages; plus outline:children, which routes between several modules.
for (const m of [require('./main/documents'), require('./main/views'), require('./main/pins'), inbox, proposalsPage, timelinePage, require('./main/presence'), meetings, require('./main/images'), icons, require('./main/related'), require('./main/rows')]) {
  for (const [channel, handle] of Object.entries(m.ipc)) ipcMain.handle(channel, handle);
}

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
const FOCUS_FRESH_MS = 30000; // a window gaining focus within this long of the last completed refresh does not start another
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
  if (win.overlay) win.overlay.setBounds({ x: 0, y: 0, width, height }); // the Help tour or Create task covers both halves (openOverlay)
  win.panes.forEach((p, i) => p.setVisible(i === 0 || isSplit(win))); // every time: a hidden right half can become the left one
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
// The Help tour (help.html, issue #230) and Create task (task.html, issue #237): a transparent page of its own laid
// over the whole window, so it sits above both halves of a split rather than inside the one that asked. Added last, it
// is on top, and there is one at a time. Closing it hands the keys back to the page that asked, whose caret is where it
// was, with what it has to say: open the palette (⌘K closed the tour), or a note for its toast (the task it made).
const OVERLAYS = { help: 'help.html', task: 'task.html' };
function openOverlay(wc, page, theme) {
  const win = paneWindow(wc);
  if (!win || win.overlay || !Object.hasOwn(OVERLAYS, page)) return;
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  view.setBackgroundColor('#00000000');
  view.opener = wc;
  win.overlay = view; win.contentView.addChildView(view); layout(win);
  view.webContents.once('did-finish-load', () => view.webContents.focus());
  view.webContents.loadFile(path.join(__dirname, OVERLAYS[page]), { query: { theme: theme === 'dark' ? 'dark' : 'light' } });
}
function closeOverlay(win, result = {}) {
  const view = win && win.overlay;
  if (!view) return;
  win.overlay = null;
  if (!win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  const opener = view.opener;
  if (!opener || opener.isDestroyed()) return;
  opener.focus();
  opener.send('overlay:closed', { palette: result.palette === true, note: typeof result.note === 'string' ? result.note.slice(0, 200) : undefined });
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
  // Coming back to a window re-reads the lists, unless they were read moments ago: the live queries keep them
  // current, and every Cmd+Tab re-reading all of them (and every page reloading after it) was chatter (issue #268).
  win.on('focus', () => { S.win = win; if (!(Date.now() - Date.parse(S.status.lastSync) < FOCUS_FRESH_MS)) refresh(); });
  win.on('closed', () => {
    closeOverlay(win);
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
// Cmd+W closes the page you are in when there are two on screen, and the window otherwise (signed out, one shows).
function closeFront(win, wc = S.pane) {
  if (!win) return;
  const pane = win.panes && isSplit(win) && win.panes.find((p) => p.webContents === wc);
  if (pane) removePane(win, pane); else win.close();
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
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => createWindow() }, { type: 'separator' }, { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => closeFront(BaseWindow.getFocusedWindow()) }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (e, id) => (id === inbox.PAGE ? inbox.rows() : id === proposalsPage.PAGE ? proposalsPage.rows() : id === timelinePage.PAGE ? timelinePage.rows((part) => { if (!e.sender.isDestroyed()) e.sender.send('timeline:part', part); }) : isSearch(id) ? searchChildren(id) : isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))));
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
ipcMain.handle('overlay:open', (e, page, theme) => { openOverlay(e.sender, page, theme); });
ipcMain.handle('overlay:close', (e, result) => { closeOverlay([...S.windows].find((w) => w.overlay && w.overlay.webContents === e.sender), result && typeof result === 'object' ? result : {}); });
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
  // the pages change sides and the line stays where it is: the left half is as wide as it was, with the other page in it
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
  autoTypeIcons(); // a key is somebody to ask: the types with no icon need not wait for the next boot
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
// After each start: the fast AI picks a glyph for every titled type that has none (issue #250). In the background,
// because the lists must not wait on a model, and quiet without a ChatGPT sign-in or an API key.
async function autoTypeIcons() {
  try {
    const types = (await typeList()).filter((t) => t.title.trim());
    const added = await icons.fillTypeIcons(types, (missing, labels) => ai.pickTypeIcons(missing, labels, globalThis.fetch, app.getPath('userData')));
    if (added) { await refresh(); send('outline:changed', null); }
  } catch (e) { console.warn('type icons:', errText(e)); } // a missing glyph is not worth an error in the window
}
ai.onSignedIn = autoTypeIcons; // and a ChatGPT sign-in the same
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
// The handoff itself, lifted out of the handler below so a check can drive it without the IPC around it.
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
  const bin = agent.codexBin(); // the task was opened through the Codex app, so this Mac has a codex to queue with
  try { if (bin) require('node:child_process').execFile(bin, ['queue', '--thread', threadId, '--message', message], { timeout: 20000 }, () => {}); } catch { /* the task is open regardless */ }
}
// One bounded app-server child per refresh answers for every linked node (main/agent.js). Every page asks on every
// refresh, so the pages asking while a read runs share it: each read is a child per host (an ssh session for a remote
// one), and a split window used to start two at once for the same answer (issue #267).
let agentStatusRead = null;
ipcMain.handle('codex:status', () => (agentStatusRead ||= agent.readAgentStatuses(agent.codexTasks()).finally(() => { agentStatusRead = null; })));
ipcMain.handle('sensitive:set', (e, id, on) => { const stored = setSensitive(id, on); tellOthers(e?.sender); return stored; });
// and what the title suggests that name is (main/ai.js). ChatGPT auth takes priority over the local API key.
ipcMain.handle('ai:discussWith', (_e, title) => ai.suggestDiscussWith(title, globalThis.fetch, app.getPath('userData')));
// "Classify type": the types this document may have, weighed by the model; the write stays doc:setType's
ipcMain.handle('ai:classifyType', async (_e, id) => ai.classifyType(await typeCandidates(id), globalThis.fetch, app.getPath('userData')));
ipcMain.handle('doc:exportPdf', (_e, id) => require('./main/pdf').exportPdf(id, S.win));
// A link in node text opens in the user's browser; only http(s), never a file or custom scheme.
ipcMain.handle('shell:open', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  return shell.openExternal(url);
});
// macOS appearance, for the renderer's "follow the system" theme: current value on demand, plus live changes
const systemTheme = () => (nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('theme:system', () => systemTheme());
if (nativeTheme) nativeTheme.on('updated', () => send('theme:system', systemTheme()));
ipcMain.handle('mcp:setHidden', async (e, on) => { const stored = await setMcpHidden(on); tellOthers(e?.sender); return stored; });
ipcMain.handle('sync:status', () => S.status);
ipcMain.handle('sync:login', async () => {
  try {
    await S.session.login();
    await start();
    autoTypeIcons();
  } catch (e) {
    report(e);
  } finally { relayout(); }
});

if (process.env.TANA_MAIN_TEST) {
  module.exports = { resolveInitialAuth, graphRow, cachedNodeHue, rememberType, VIEWS, toNode, outlineWithReferences, chatOutline, op, onChange, documentAction, archivedTypes, createDocument, creationOptions, typeChoices, typeCandidates, setType, setTypeHue, discussWith, ai, icons, settings, search, viewFilter, searchCreate, searchTitle, viewRows, spaceChildren, start, refresh, related, watchRelated, callOf, weekTitle, weekNode,
    statusSnapshot: () => ({ ...S.status }), rememberNodeHue, restoredBounds, today,
    undo: () => history(undoStack, redoStack, 'undo', 'canUndo'), redo: () => history(redoStack, undoStack, 'redo', 'canRedo'), visibleGraphNodes, pinTree, changesOf, summaryChanges, followSummary, announceNewInbox, watchInbox, timelinePage,
    nodePin, layout,
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
    const auth = await resolveInitialAuth(S.session);
    setStatus({ authChecking: false, authenticated: auth.authenticated, error: auth.error ? errText(auth.error) : null });
    relayout();
    if (auth.authenticated) {
      try { await start(); autoTypeIcons(); }
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
}
