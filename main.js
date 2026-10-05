'use strict';
// Electron main: the process boundary. Everything that knows Tana lives in main/ (state, rows, documents, related,
// views, pins, images, and each one's ipc table); this file owns the window, the menu, the boot sequence and the
// registering of those tables, plus the test hook that scripts/sdk-check.js and the CLI use to drive the same
// modules without a window.
const { app, BaseWindow, BrowserWindow, Menu, Notification, WebContentsView, clipboard, ipcMain, nativeTheme, screen, shell } = require('electron');
const path = require('node:path');
const db = require('./db');
const { createTanaSession } = require('./tana-session');
const { userDataDir } = require('./userdata');
const updater = require('./updater');
const agents = require('./main/agents');
const ai = require('./main/ai');
const { S, VIEWS, errText, idKind, isSearch, isSpace, pageOf, today, redoStack, report, send, setStatus, undoStack, visibleGraphNodes } = require('./main/state');
const { cachedNodeHue, graphRow, rememberNodeHue, rememberType, toNode } = require('./main/rows');
const { webLink, accessContext, archivedTypes, chatOutline, createDocument, creationOptions, discussWith, documentAction, followSummary, history, mut, onChange, op, outlineWithReferences, sensitiveIds, setSensitive, setType, setTypeHue, typeCandidates, typeChoices, typeList } = require('./main/documents');
const { changesOf, dropSearchHeads, fieldDefs, related, searchChildren, spaceChildren, summaryChanges, unwatchRelated, watchRelated } = require('./main/related');
const { announceNewInbox, watchInbox, inboxCount, listFilter, refresh, search, searchCreate, searchTitle, setMcpHidden, settingsReady, start, stop, viewFilter, viewRows } = require('./main/views');
const { nodePin, pinTree, weekNode, weekTitle } = require('./main/pins');
const inbox = require('./main/inbox');
const proposalsPage = require('./main/proposals');
const timelinePage = require('./main/timeline');
const icons = require('./main/icons');
const settings = require('./main/settings');
const meetings = require('./main/meetings');
const presence = require('./main/presence');

// Only Orbital's own pages may call main. Each page's preload hands it window.api, and a view that navigates elsewhere
// (a link or a file dropped on it) runs the same preload on the page it lands on, so main checks every call's frame:
// one of the packaged files below, nothing else. keepHome stops the views navigating away in the first place.
const APP_PAGES = new Set(['shell.html', 'index.html', 'help.html', 'task.html', 'update.html', 'settings.html'].map((f) => require('node:url').pathToFileURL(path.join(__dirname, f)).href));
const fromApp = (e) => { const frame = e && e.senderFrame; return !!frame && APP_PAGES.has(String(frame.url).split(/[?#]/)[0]); };
for (const kind of ['handle', 'on']) {
  const register = ipcMain[kind].bind(ipcMain);
  ipcMain[kind] = (channel, fn) => register(channel, (e, ...args) => {
    if (fromApp(e)) return fn(e, ...args);
    if (kind === 'handle') throw new Error('Not an Orbital page');
    e.returnValue = null; // a sendSync from elsewhere gets nothing rather than hanging
  });
}
// A view showing one of Orbital's pages stays on them: a navigation anywhere else in any of its frames is refused, and a
// page that asks for a new window gets none, an http(s) link opening in the browser instead.
function keepHome(wc) {
  const stay = (e) => { if (!APP_PAGES.has(String(e.url).split(/[?#]/)[0]) && !/^about:(blank|srcdoc)$/.test(e.url)) e.preventDefault(); };
  wc.on('will-frame-navigate', stay);
  wc.on('will-redirect', stay);
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// A main/ module that answers the renderer keeps its channels beside the code they call, as a table it exports:
// ipc = { 'channel': (event, ...args) => … }. preload.js names each channel for the page. What main.js registers
// itself is Electron's: windows, overlays, shell (the Codex handoff opens Codex through it), app paths, and settings
// sent to the other pages; plus outline:children, which routes between several modules.
for (const m of [require('./main/documents'), agents, require('./main/chatagents'), require('./main/views'), require('./main/pins'), inbox, proposalsPage, timelinePage, presence, meetings, require('./main/images'), icons, require('./main/related'), require('./main/rows'), settings, updater]) {
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

// Outliner windows (issue #137): ⌃⌘N opens another, a little down and right of the one in front. A window is a
// BaseWindow with one WebContentsView, its shell (shell.html), which lays out its pages with Trellis: any number, docked,
// tabbed or floating (issue #159), each an iframe of index.html and a whole outliner with its own view, place and
// history. Main keys a page by its frame (main/state.js pageOf), so a page beside another is to it what a page in
// another window is. The shell owns the layout; main keeps which pages there are (each by its id, '' the first, then
// '2', '3', ...), the layout the window saves, and says what to open or close. What main pushes is shared state and goes to every page
// (main/state.js send); S.win is the window used last and S.pane its page, which a notification click opens in. The
// first window takes the saved bounds and layout, and it alone saves them (win.primary): another window is for the
// moment, and one closed last used to leave the next launch its single page (issue #444). A page's id is unique across
// windows, since its view and place are stored under it.
S.windows = new Set();
S.windowViews = new Map(); // page id -> { id, filter }: the view that page shows
const FOCUS_FRESH_MS = 30000; // a window gaining focus within this long of the last completed refresh does not start another
const BACKGROUND = { light: '#ececec', dark: '#2b2f31' }; // the window behind the shell, in the pages' theme
const PRELOAD = path.join(__dirname, 'preload.js');
const shellWindow = (wc) => [...S.windows].find((w) => w.shell && w.shell.webContents === wc);
const tellShell = (win, cmd, arg) => { const wc = win.shell && win.shell.webContents; if (wc && !wc.isDestroyed()) wc.send('shell:command', cmd, arg); };
// Signed out, every page is the same login button, so the shell shows page '' alone and keeps the layout aside for
// after the login (relayout tells it, 'auth'); main keeps saving the layout it had.
const signedOut = () => S.status.authChecking === false && S.status.authenticated === false;
// The Work View's layout (renderer/timeline.js): '' beside '2', in Trellis's document format. A first launch opens it,
// and a window saved split before the workspace (v1: { split: true, splitAt }) comes back as it.
const pair = (at) => ({ schema: 1, root: { kind: 'split', id: 'split-work', axis: 'x', weights: [at, 1 - at],
  children: ['', '2'].map((id) => ({ kind: 'panel', id: 'panel-work' + id, views: ['page' + id], selected: 'page' + id })) },
floating: [], hidden: [], views: { page: { type: 'page', params: { side: '' } }, page2: { type: 'page', params: { side: '2' } } } });
const WORK_SPLIT = 0.6; // the Work View's Timeline takes 60% of the width, My Tasks 40%
const savedDoc = (saved) => (!saved ? pair(WORK_SPLIT) : saved.doc && typeof saved.doc === 'object' ? saved.doc
  : saved.split === true ? pair(saved.splitAt > 0 && saved.splitAt < 1 ? saved.splitAt : 0.5) : null);
// the page ids a layout holds (view 'page' + id), in its order; a window without one shows page ''
const docPages = (doc) => { const ids = Object.entries((doc && doc.views) || {}).filter(([k, v]) => v && v.type === 'page' && k.startsWith('page')).map(([k]) => k.slice(4)); return ids.length ? ids : ['']; };
// a new page's id: the smallest from 2 up that no page has, loaded, loading or just asked for
const taken = (w) => [...w.pages, ...docPages(w.doc), ...w.panes.map((p) => p.side)]; // a layout kept aside while signed out still holds its ids
const freeId = () => { let n = 2; while ([...S.windows].some((w) => taken(w).includes(String(n)))) n++; return String(n); };
// another window's layout: one page, under an id no window has
const onePage = (id) => ({ schema: 1, root: { kind: 'panel', id: 'panel-' + id, views: ['page' + id], selected: 'page' + id }, floating: [], hidden: [], views: { ['page' + id]: { type: 'page', params: { side: id } } } });
// What a page starts on: its view and place, from the page that opened it or the saved view it is part of, keyed by its
// id and handed over with that id (window:getSide), so its preload stores them before the page reads them. Written by
// the page that asked, they raced the new page's load. A key set to null is cleared; one left out keeps what is stored.
const starts = new Map();
function setStart(id, keys, suffix = '') {
  const start = {};
  for (const key of ['view', 'place']) { const v = keys && typeof keys === 'object' ? keys[key + suffix] : undefined; if (v === null || (typeof v === 'string' && v.length < 20000)) start[key] = v; }
  if (Object.keys(start).length) starts.set(id, start); else starts.delete(id);
}
// A saved view names page ids, and another window may have one of them open: that page takes a free id instead, with
// its keys, so no two live pages store their place under one key. '' is only ever the main window's.
function adoptLayout(win, doc, keys) {
  const others = new Set([...S.windows].filter((w) => w !== win).flatMap(taken));
  const ids = docPages(doc), used = new Set([...others, ...ids]), map = new Map();
  for (const id of ids) if (id && others.has(id)) { let n = 2; while (used.has(String(n))) n++; used.add(String(n)); map.set(id, String(n)); }
  for (const id of ids) setStart(map.get(id) ?? id, keys, id ? ':' + id : '');
  for (const [id, to] of map) starts.set(to, { ...starts.get(to), as: id }); // the id it has in the view, for its Home check (renderer/nodes.js)
  if (!map.size) return doc;
  const swap = (s) => (typeof s === 'string' && s.startsWith('page') && map.has(s.slice(4)) ? 'page' + map.get(s.slice(4)) : s);
  const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [swap(k), walk(x)])) : swap(v));
  const out = walk(doc);
  for (const [k, v] of Object.entries(out.views)) if (v && v.type === 'page') v.params = { ...v.params, side: k.slice(4) };
  return out;
}
// the page after this one in the layout's order, round to the first (⌘/, where the keys go when one closes)
function nextPane(page) {
  const win = page.win, order = win.pages.filter((id) => win.panes.some((p) => p.side === id));
  const next = order[(order.indexOf(page.side) + 1) % order.length];
  return win.panes.find((p) => p.side === next && p !== page) || null;
}
// A page registers when its preload asks window:getSide. Only an iframe of a window's shell is a page: the shell itself
// and the Help tour or Quick Add Task are main frames. Its id is its url's and never changes while it lives; one already
// taken (which should not happen) gets a free one.
function addPage(e) {
  const frame = e.senderFrame, win = frame && shellWindow(e.sender);
  if (!win || !frame.parent) return null;
  let side = '', links = false;
  try { const params = new URL(frame.url).searchParams; side = params.get('side') || ''; links = params.get('links') === '1'; } catch { /* no url: the first page */ }
  if (!/^([2-9]|[1-9]\d+)$/.test(side)) side = '';
  if (win.panes.some((p) => p.side === side)) side = freeId();
  const page = { id: frame.processId + ':' + frame.frameToken, frame, win, side, links, // links: the window's Graph pane (#462)
    isDestroyed: () => frame.isDestroyed() || frame.detached,
    send: (channel, ...args) => { if (!page.isDestroyed()) frame.send(channel, ...args); },
    // the window's keys to the shell, and the shell's to this page's panel and iframe
    focus: () => { const wc = win.shell.webContents; if (!wc.isDestroyed()) wc.focus(); tellShell(win, 'focus', page.side); } };
  win.panes.push(page);
  // A new pane, tab or floating pane gives the new page the keys: it is the page ⌘W and a notification click aim at from now, even before its
  // document has taken the focus (the shell focuses its iframe once it has loaded).
  if (win.focusNext === side) { win.focusNext = null; S.win = win; S.pane = page; }
  return page;
}
// A page gone (its panel closed, a reload, its window closed): what main kept for it goes with it.
function dropPage(page) {
  const win = page.win;
  win.panes = win.panes.filter((p) => p !== page);
  S.windowViews.delete(page.id); unwatchRelated(page.id); dropSearchHeads(page.id);
  // its viewing heartbeat too: the page's own null may come after this (a window closing), keyed 'main' by then
  presence.view(null, page.id);
  if (S.pane === page) S.pane = win.panes[0] || null;
}
// The shell fills the window; the Help tour or Quick Add Task, when open, covers it (openOverlay).
function fit(win) {
  const { width, height } = win.getContentBounds();
  for (const v of [win.shell, win.overlay]) if (v) v.setBounds({ x: 0, y: 0, width, height });
}
// A new page (⇧⌘N to the right, ⌘N a tab, ⌥⌘N a floating pane; the Work View's '2'), beside the page that asked (from). Its id
// is main's to give, so the page asking can store its place under it first; the layout report that follows saves it.
function openPage(win, { id = freeId(), where = 'right', from, focus = true }) {
  win.pages.push(id);
  if (focus) win.focusNext = id;
  tellShell(win, 'open', { id, where, from, focus });
  return id;
}
// Signed in or out: the saved layout comes back, or waits while every page is the login button.
const relayout = () => { for (const w of S.windows) if (!w.isDestroyed() && w.signedOut !== signedOut()) { w.signedOut = signedOut(); tellShell(w, 'auth', { signedOut: w.signedOut }); } };
// The Help tour (help.html, issue #230), Quick Add Task (task.html, issue #237) and the update card (update.html, #667): a
// transparent page of its own laid over the whole window, so it sits above both halves of a split rather than inside the one that asked. Added last, it
// is on top, and there is one at a time. Closing it hands the keys back to the page that asked, whose caret is where it
// was, with what it has to say: open the palette (⌘K closed the tour), or a note for its toast (the task it made).
const OVERLAYS = { help: 'help.html', task: 'task.html', update: 'update.html' };
// at: where the tour starts, its iPhone page for Cmd+K Install mobile app (help.js); any other value is the first page
function openOverlay(page, which, theme, at) { // page: the handle that asked (main/state.js pageOf)
  const win = page && page.win;
  if (!win || win.overlay || !Object.hasOwn(OVERLAYS, which)) return false;
  const view = new WebContentsView({ webPreferences: { preload: PRELOAD } });
  keepHome(view.webContents);
  view.setBackgroundColor('#00000000');
  view.opener = page;
  view.which = which;
  win.overlay = view; win.contentView.addChildView(view); fit(win);
  view.webContents.once('did-finish-load', () => view.webContents.focus());
  view.webContents.loadFile(path.join(__dirname, OVERLAYS[which]), { query: { theme: theme === 'dark' ? 'dark' : 'light', ...(which === 'help' && at === 'mobile' && { at }) } });
  return true;
}
function closeOverlay(win, result = {}) {
  const view = win && win.overlay;
  if (!view) return;
  win.overlay = null;
  if (!win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  const opener = view.opener;
  // a first start this overlay was covering (firstHelp): now there is room for it, whichever half opened this one, over
  // whichever page is the main half now (the one that asked may have closed meanwhile, ⌘W under Quick Add Task). First, so
  // a ⌘K that closed Quick Add Task does not leave the palette open under the tour.
  const pending = win.helpPending; win.helpPending = null;
  const main = win.panes.find((p) => !p.side) || win.panes[0]; // page '' when it is open: the tour's own
  const help = !!pending && !win.isDestroyed() && !!main && firstHelp(main, pending.theme);
  const note = typeof result.note === 'string' ? result.note.slice(0, 200) : undefined;
  const open = typeof result.open === 'string' && /^tana:[a-z-]+:[0-9a-z]{26}$/.test(result.open) ? result.open : undefined; // the node the note is about, which its toast opens
  if (opener && !opener.isDestroyed()) {
    if (!help) opener.focus(); // the tour has the keys now
    opener.send('overlay:closed', { palette: result.palette === true && !help, chatgpt: result.chatgpt === true && !help, note: help ? undefined : note, open: help ? undefined : open });
  }
  if (help && note) win.overlay.later = { opener, note, open }; // the task's toast waits for the tour: under it, it would be gone first
  const later = view.later; // this was that tour: the toast it held back is due now
  if (later && later.opener && !later.opener.isDestroyed()) later.opener.send('overlay:closed', { palette: false, note: later.note, open: later.open });
  // an update a check found while this covered the window (checkUpdates), once nothing else is laid over it
  if (win.updatePending && !win.overlay && !win.isDestroyed() && main && !main.isDestroyed()) { win.updatePending = false; openOverlay(main, 'update', win.theme || systemTheme()); }
}
const frontPane = () => (S.win && !S.win.isDestroyed() ? (S.win.panes.includes(S.pane) ? S.pane : S.win.panes[0]) || null : null);
// A check that finds a newer release lays the update card over the page that asked (Cmd+K) or the front window.
// A window the Help tour or Quick Add Task covers keeps the offer (updatePending) and closeOverlay opens it after them.
const checkUpdates = (manual = false, page = frontPane()) => updater.check({ manual, show: () => {
  if (!page || page.isDestroyed()) return false;
  const win = page.win;
  if (win.overlay) { if (win.overlay.which !== 'update') win.updatePending = true; return true; }
  return openOverlay(page, 'update', win.theme || systemTheme());
} });
// Orbital's Settings window (settings.html, settings.js): a window of its own, as a Mac app's settings are.
// One at a time, brought forward when it is open; a fixed width that takes the height of the tab it shows (settings:size,
// from its own page only); closed by ⌘W (closeFront), never minimised, zoomed or resized by hand. Main's pushes reach it
// with the pages' (main/state.js send, main/settings.js tellOthers).
const SETTINGS_WIDTH = 600;
function openSettings() {
  if (S.settings && !S.settings.isDestroyed()) return S.settings.focus();
  const theme = settings.prefs().theme, dark = theme === 'dark' || (theme !== 'light' && systemTheme() === 'dark');
  const win = new BrowserWindow({ width: SETTINGS_WIDTH, height: 400, useContentSize: true, show: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    title: 'Settings', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 13 }, // centred on the title's 38px line (settings.css #title)
    backgroundColor: dark ? '#262628' : '#f6f6f6', webPreferences: { preload: PRELOAD } }); // settings.css --bg
  S.settings = win;
  keepHome(win.webContents);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (S.settings === win) S.settings = null; });
  win.loadFile(path.join(__dirname, 'settings.html'));
}
ipcMain.handle('settings:open', () => { openSettings(); });
ipcMain.on('settings:size', (e, height) => {
  const win = S.settings;
  if (!win || win.isDestroyed() || e.sender !== win.webContents || !Number.isFinite(height)) return;
  win.setContentSize(SETTINGS_WIDTH, Math.round(Math.min(Math.max(height, 160), 900)), win.isVisible()); // animated once it shows, as a tab switch is
});
function createWindow() {
  const saved = db.setting('window'), front = S.windows.size ? S.win : null;
  const bounds = front && !front.isDestroyed() ? { ...front.getNormalBounds(), x: front.getNormalBounds().x + 24, y: front.getNormalBounds().y + 24 } : restoredBounds(saved, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BaseWindow({ ...bounds, title: 'Orbital', titleBarStyle: 'hiddenInset', backgroundColor: BACKGROUND.light });
  // saved shortly after a move or resize settles, and once more on close, so a quit or an update relaunch keeps it
  let boundsTimer = null;
  const saveBounds = () => { clearTimeout(boundsTimer); boundsTimer = null; if (!win.isDestroyed() && win.primary) db.setSetting('window', { ...win.getNormalBounds(), maximized: win.isMaximized(), doc: win.doc }); };
  const saveSoon = () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); };
  win.panes = []; win.saveBounds = saveBounds; win.saveSoon = saveSoon; // a layout the shell reports is saved too
  // the layout comes back with the frame it was saved with, and a first launch (nothing saved) opens the Work View, the
  // Timeline beside My Tasks (renderer/edit.js reads which page it is). Another window opens with one page, under an id
  // that may have been a closed page's: it keeps nothing of that page, and starts where the page that asked is (window:new).
  win.primary = !front;
  win.doc = front ? onePage(freeId()) : savedDoc(saved);
  win.pages = docPages(win.doc);
  if (front) setStart(win.pages[0], { view: null, place: null });
  // nodeIntegrationInSubFrames: preload.js runs in each page's iframe as well, which is what gives a page window.api
  win.shell = new WebContentsView({ webPreferences: { preload: PRELOAD, nodeIntegrationInSubFrames: true } });
  keepHome(win.shell.webContents);
  win.contentView.addChildView(win.shell); fit(win);
  // a crash takes the pages with it; the reload that brings them back registers them again
  win.shell.webContents.on('render-process-gone', () => { for (const p of [...win.panes]) dropPage(p); });
  win.shell.webContents.loadFile(path.join(__dirname, 'shell.html'));
  S.windows.add(win); S.win = win;
  for (const name of ['resize', 'move', 'maximize', 'unmaximize']) win.on(name, saveSoon);
  // every way the frame changes size: a window saved maximized is made at its normal bounds and maximized after, which
  // macOS reports as maximize and no resize, so the shell kept the normal size in the corner of the screen (#550)
  for (const name of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(name, () => fit(win));
  if (!front && saved && saved.maximized) win.maximize(); // after the listeners: maximizing here reports at once, and a shell not told stays at the normal size
  win.on('close', saveBounds);
  // Coming back to a window re-reads the lists, unless they were read moments ago: the live queries keep them
  // current, and every Cmd+Tab re-reading all of them (and every page reloading after it) was chatter (issue #268).
  win.on('focus', () => { S.win = win; if (!(Date.now() - Date.parse(S.status.lastSync) < FOCUS_FRESH_MS)) refresh(); });
  win.on('closed', () => {
    closeOverlay(win);
    for (const p of [...win.panes]) dropPage(p);
    S.windows.delete(win);
    if (S.win === win) { S.win = [...S.windows].at(-1) || null; S.pane = frontPane(); }
    if (win.primary && S.win) { S.win.primary = true; S.win.saveBounds(); } // the window left saves from now on
    // A WebContentsView's page outlives its window unless it is closed by hand. waitForBeforeUnload: each page gets its
    // beforeunload (renderer/app.js), which sends the characters still waiting on the 400 ms edit timer and lets go of
    // its presence room and heartbeat before it is gone.
    const wc = win.shell.webContents;
    if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: true });
  });
  return win;
}
// Cmd+W closes the page you are in while there are more, and the window when it is the last (signed out, one shows).
// The shell flushes the page and closes it, and its layout report drops it here; the next page takes the keys.
function closeFront(win, page = S.pane) {
  if (!win) return;
  const target = win.panes && (win.panes.includes(page) ? page : win.panes[0]);
  // the last page beside the Graph pane closes the window too: the Graph pane follows it and cannot stand alone (#462)
  if (!target || signedOut() || win.pages.length < 2 || (!target.links && win.panes.filter((p) => !p.links).length < 2)) return win.close();
  const next = nextPane(target);
  win.pages = win.pages.filter((id) => id !== target.side); // a second ⌘W before the report counts it gone
  tellShell(win, 'close', target.side);
  if (next) next.focus();
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' },
      { label: 'Check for Updates…', click: () => checkUpdates(true) },
      // the key is the renderer's Open settings row (DEFAULT_HOTKEYS), so it can be re-recorded; the menu shows it and opens the window itself
      { type: 'separator' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: () => openSettings() },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [{ label: 'New Window', accelerator: 'Ctrl+Cmd+N', registerAccelerator: false, click: () => createWindow() }, { type: 'separator' }, { label: 'Close', accelerator: 'CmdOrCtrl+W', click: () => closeFront(BaseWindow.getFocusedWindow()) }] },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// events start with an empty content map (no doc node yet); readOutline needs the children list
ipcMain.handle('outline:children', (e, id) => { const page = pageOf(e); return (id === inbox.PAGE ? inbox.rows() : id === proposalsPage.PAGE ? proposalsPage.rows() : id === timelinePage.PAGE ? timelinePage.rows((part) => { if (page) page.send('timeline:part', part); }) : isSearch(id) ? searchChildren(id, page ? page.id : 'main') : isSpace(id) ? spaceChildren(id) : op(id, (doc) => (idKind(id) === 'chat' ? chatOutline(doc) : doc.content.get('children') ? outlineWithReferences(doc) : []))); });
// The renderer's preferences, from the same store: a synchronous snapshot at load (preload reads it before the
// first paint) and one write per change.
// the menu shows ⌃⌘N but leaves the key to the renderer's New window row (DEFAULT_HOTKEYS), so it can be re-recorded
ipcMain.handle('window:new', (e, start) => { const id = createWindow().pages[0]; setStart(id, { view: null, place: null, ...(start && typeof start === 'object' ? start : {}) }); return id; });
// New tab ⌘N, New pane ⇧⌘N, New floating pane ⌥⌘N (issue #159; the modifiers ⌘-, ⇧- and ⌥-click open a link with): a new page beside the one that asked, taking the keys. Answers the
// new page's id, so the page asking can store its view and place under it for the new one to open on.
ipcMain.handle('window:split', (e, where, start) => {
  const page = pageOf(e);
  if (!page || signedOut()) return null;
  const id = freeId();
  setStart(id, { view: null, place: null, ...(start && typeof start === 'object' ? start : {}) }); // an id used before keeps nothing of that page
  // 'links': the window's Graph pane (issue #462), beside the page and leaving it the keys; the shell keeps one per window
  return openPage(page.win, { id, where: ['right', 'tab', 'float', 'links'].includes(where) ? where : 'right', from: page.side, focus: where !== 'links' });
});
// asked by preload.js on every load, a Reload included: this page's id ('' the first page, then '2', '3', ...).
// This is where a page registers (addPage); an overlay asking is no page and gets the defaults.
ipcMain.on('window:getSide', (e) => {
  const page = pageOf(e) || addPage(e);
  const side = page ? page.side : '', start = page && starts.get(side);
  if (start) starts.delete(side);
  const saved = !start && page && (db.setting('places') || {})[side];
  e.returnValue = start ? { side, start } : saved ? { side, saved } : { side };
});
// Each page's view and place, mirrored from its localStorage (renderer/edit.js rememberPlace) into the database the layout
// is saved in: Chromium has lost a whole profile's localStorage between two launches, and every tab but the first then
// opened on My Tasks (#636). preload.js fills a key localStorage no longer has from this copy.
ipcMain.on('page:place', (e, view, place) => {
  const page = pageOf(e), places = db.setting('places') || {}, now = places[page?.side];
  if (!page || typeof view !== 'string' || typeof place !== 'string' || place.length > 20000 || (now && now.view === view && now.place === place)) return;
  db.setSetting('places', { ...places, [page.side]: { view, place } });
});
// A page taking the keys (preload.js, its window's focus): the window and page a notification click opens in, and ⌘W closes
ipcMain.on('page:focus', (e) => { const page = pageOf(e); if (page) { S.win = page.win; S.pane = page; } });
// On macOS a right-click leaves a window in the background, where a left click brings it forward: ⌘K opened by one
// (renderer/events.js contextmenu) asks for its window, so the palette's field has the keys and shows its caret.
ipcMain.on('window:activate', (e) => { const page = pageOf(e); if (!page || page.win.isFocused()) return; app.focus({ steal: true }); page.win.focus(); page.focus(); });
// A page leaving (pagehide: its panel closed, a reload). Its frame may be gone by the time this arrives, so whatever the
// window holds that is gone goes too.
ipcMain.on('page:gone', (e) => {
  const page = pageOf(e), win = page ? page.win : shellWindow(e.sender);
  if (page) dropPage(page);
  if (win) for (const p of [...win.panes]) if (p.isDestroyed()) dropPage(p);
});
ipcMain.handle('overlay:open', (e, which, theme, at) => { openOverlay(pageOf(e), which, theme, at); });
ipcMain.handle('overlay:close', (e, result) => { closeOverlay([...S.windows].find((w) => w.overlay && w.overlay.webContents === e.sender), result && typeof result === 'object' ? result : {}); });
// Cmd+K Save view and Saved views (issue #442): the layout this window has (null: page '' alone, never rearranged), and
// one to put it back to; 'workView' is the Work View's, the one a first launch opens (pair). The pages' places are
// theirs, written by the page that asked (renderer/palette.js); the shell reloads, starts from this layout
// (shell:state) and every page opens where the view was saved.
ipcMain.handle('window:layout', (e) => pageOf(e)?.win?.doc || null);
// A saved view is the main window's (win.primary): chosen in another window it is laid out there, which comes forward.
ipcMain.handle('window:setLayout', (e, doc, keys) => {
  const asked = pageOf(e)?.win, win = [...S.windows].find((w) => w.primary && !w.isDestroyed()) || asked;
  if (doc === 'workView') doc = pair(WORK_SPLIT);
  if (!win || signedOut() || (doc !== null && !(doc && typeof doc === 'object' && Object.values(doc.views || {}).some((v) => v && v.type === 'page')))) return false;
  doc = adoptLayout(win, doc, keys);
  win.primary = true; win.doc = doc; win.pages = docPages(doc); win.saveBounds();
  win.reloading = true; tellShell(win, 'reload'); // the shell has every page send what it was typing first; what it reports meanwhile is the old layout
  if (win !== asked) win.focus();
  return true;
});
// The shell (preload.js window.shell), synchronous at its start: the layout to start from (null: page '' alone), the
// theme, and whether it is signed out (page '' alone, the layout kept aside until 'auth' says otherwise).
ipcMain.on('shell:state', (e) => {
  const win = shellWindow(e.sender);
  if (!win) { e.returnValue = { doc: null, theme: systemTheme(), signedOut: signedOut() }; return; }
  win.signedOut = signedOut(); win.reloading = false;
  win.pages = win.signedOut ? [''] : docPages(win.doc);
  e.returnValue = { doc: win.doc || null, theme: win.theme || systemTheme(), signedOut: win.signedOut };
});
// The shell's layout after every committed change: doc is Trellis's document, pages the ids in it in its order. A page
// not in it is closing. Saved with the window, except while signed out, when the shell shows the login alone.
ipcMain.on('shell:layout', (e, layout) => {
  const win = shellWindow(e.sender);
  if (!win || win.reloading || !layout || !Array.isArray(layout.pages)) return;
  win.pages = layout.pages.filter((id) => typeof id === 'string');
  for (const p of [...win.panes]) if (!win.pages.includes(p.side)) dropPage(p);
  if (signedOut() || !layout.doc || typeof layout.doc !== 'object') return;
  win.doc = layout.doc; win.saveSoon();
});
// a page says which theme it drew itself in (renderer/theme.js): the shell's Trellis theme and the window behind it follow
ipcMain.on('window:theme', (e, theme) => {
  const win = pageOf(e)?.win;
  if (!win || !Object.hasOwn(BACKGROUND, theme)) return;
  win.theme = theme; win.setBackgroundColor(BACKGROUND[theme]); tellShell(win, 'theme', theme);
});
// Demo mode lives in the outliner (renderer/state.js); main only needs to know it is on, so no banner shows a real title.
ipcMain.on('app:demoMode', (_e, on) => { S.demo = on === true; });
ipcMain.on('app:checkUpdates', (e) => checkUpdates(true, pageOf(e) || undefined)); // Cmd+K Check for updates: the menu item's check, over the page that asked
ipcMain.on('prefs:snapshot', (e) => { e.returnValue = settings.prefs(); });
// The Help tour's first start (renderer/overlays.js helpOnce), opened here, by main, once. Only after this session has
// read the settings document — the snapshot above is this machine's last copy, which on a new machine knows nothing yet,
// so a read that failed declines rather than trusting it — and only over a page still open in a window nothing covers
// (Quick Add Task open: main opens it when that closes, firstHelp). helpSeen is marked only once the tour is really opening:
// one step, so two windows, Quick Add Task or a page closing on the way can neither show it twice nor spend it unseen.
// A window Quick Add Task covers keeps the ask (helpPending) and closeOverlay opens it once that closes: the close is told
// only to the half that opened Quick Add Task, which is not always the one that asked.
function firstHelp(page, theme) {
  if (!settings.settingsDocId() || settings.prefs().helpSeen || !page || page.isDestroyed()) return false;
  const win = page.win;
  if (win && win.overlay) { win.helpPending = { theme }; return false; } // the window's, not the page's: closeOverlay aims it
  if (!openOverlay(page, 'help', theme)) return false;
  settings.setPref('helpSeen', true);
  return true;
}
ipcMain.handle('help:claim', async (e, theme) => { const page = pageOf(e); await settingsReady(); return firstHelp(page, theme); });
const { tellOthers } = settings; // a setting one page writes reaches the others (main/settings.js)
ipcMain.handle('prefs:set', (e, key, value) => { const stored = settings.setPref(key, value); tellOthers(pageOf(e)); return stored; });
// The OpenAI API key is kept for whoever already has one; Sign in with ChatGPT is the way in (issue #669). An empty key
// clears it, and then the palette stops offering the row.
ipcMain.handle('openai:setKey', (_e, key) => {
  if (typeof key !== 'string') throw new Error('OpenAI API key must be text');
  settings.set('openaiApiKey', key.trim() || null);
  if (key.trim()) autoTypeIcons(); // a key is somebody to ask: the types with no icon need not wait for the next boot
  // every page hears it, as a sign-in is heard: Set OpenAI API key appears or goes everywhere (ai.js withKey)
  ai.chatgptStatus(app.getPath('userData')).then((status) => send('ai:chatgptChanged', status), () => {});
  return !!key.trim();
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
  await refresh({ after: true }); // the cached rows carry the icon name, so they are rebuilt before anything is told to redraw
  send('outline:changed', null);
  return chosen;
});
// After each start: the fast AI picks a glyph for every titled type and field that has none (issues #250, #606). In the
// background, because the lists must not wait on a model, and quiet without a ChatGPT sign-in or an API key.
async function autoTypeIcons() {
  try {
    const userData = app.getPath('userData');
    if (!settings.get('openaiApiKey') && !(await ai.chatgptStatus(userData, false)).signedIn) return; // nobody to ask: read no type documents either
    const types = (await typeList()).filter((t) => t.title.trim());
    // a field goes out as "Type › Field": its name alone ("Status", "Owner") says little about what it holds. One type
    // at a time, each read released by the on-demand sweep like any other (main/related.js fieldDefs).
    const fields = [];
    for (const t of types) for (const d of await fieldDefs(t.uri)) if ((d.title || '').trim()) fields.push({ uri: t.uri + '?attribute=' + d.key, title: t.title + ' › ' + d.title });
    const added = await icons.fillTypeIcons([...types, ...fields], (missing, labels) => ai.pickTypeIcons(missing, labels, globalThis.fetch, userData));
    if (added) { await refresh({ after: true }); send('outline:changed', null); }
  } catch (e) { console.warn('type icons:', errText(e)); } // a missing glyph is not worth an error in the window
}
ai.onSignedIn = autoTypeIcons; // and a ChatGPT sign-in the same
ipcMain.handle('sensitive:set', (e, id, on) => { const stored = setSensitive(id, on); tellOthers(pageOf(e)); return stored; });
// and what the title suggests that name is (main/ai.js). ChatGPT auth takes priority over the local API key.
ipcMain.handle('ai:translate', (_e, texts, to, opts) => ai.translate(texts, to, globalThis.fetch, app.getPath('userData'), { local: !!(opts && opts.local) })); // a note shown in English, never saved (renderer/translate.js); local: this Mac's answers only
ipcMain.handle('ai:discussWith', (_e, title) => ai.suggestDiscussWith(title, globalThis.fetch, app.getPath('userData')));
// The Settings page's Quick and Regular AI (renderer/settings.js): the synced settings.AI_KEYS, only from main's own lists
ipcMain.handle('ai:options', () => ai.options(S.userData));
ipcMain.handle('ai:setOption', async (e, key, value) => { const next = await ai.setOption(key, value, S.userData); tellOthers(pageOf(e)); return next; });
// "Auto-pick type": the types this document may have, weighed by the model; the write stays doc:setType's
ipcMain.handle('ai:classifyType', async (_e, id) => ai.classifyType(await typeCandidates(id), globalThis.fetch, app.getPath('userData')));
// Process image (issue #507): an image read by the model into a task or a note, made with what it read as its lines
// and the image under them. Returns the Node for the page to open. The image is a file dropped on Create new
// (shell.js) { bytes, filename, mimeType }, or from Cmd+K the clipboard's { clipboard: true } or an image row's { uri }.
async function imageToProcess(file) {
  if (file?.clipboard) {
    const found = await clipboardPng();
    if (!found) throw new Error('The clipboard holds no image');
    return { bytes: Buffer.from(await (await found.item.getType(found.type)).arrayBuffer()), filename: 'Clipboard image.png', mimeType: 'image/png' };
  }
  if (typeof file?.uri !== 'string') return file;
  const [, mimeType, base64] = /^data:([^;,]+);base64,(.*)$/s.exec(await require('./main/images').image(file.uri)) || [];
  return { bytes: Buffer.from(base64 || '', 'base64'), filename: 'image', mimeType };
}
// Electron 45's clipboard is the async W3C one. Chromium offers a copied bitmap as image/png, but a copied image file
// (Finder, CleanShot) only under macOS's own PNG type, next to its file url: has('image/png') said no to those.
const CLIPBOARD_PNG = ['image/png', 'electron application/osclipboard;format="Apple PNG pasteboard type"'];
async function clipboardPng() {
  for (const item of await clipboard.read()) { const type = CLIPBOARD_PNG.find((t) => item.types.includes(t)); if (type) return { item, type }; }
  return null;
}
ipcMain.handle('clipboard:hasImage', async () => !!(await clipboardPng())); // Cmd+K's and Quick Add's Process image from clipboard
ipcMain.handle('ai:processImage', async (_e, source) => {
  const file = await imageToProcess(source);
  const read = await ai.readImage(file, globalThis.fetch, app.getPath('userData'));
  const node = await createDocument(read.title, { kind: read.kind });
  const content = require('./sdk/content');
  if (read.notes.length) await mut(node.id, (doc) => { for (const line of read.notes) content.insertAfter(doc, null, line); });
  await require('./main/images').insertImage(node.id, null, { bytes: file.bytes, filename: file.filename || 'image', mimeType: file.mimeType });
  return node;
});
ipcMain.handle('doc:exportPdf', (_e, id) => require('./main/pdf').exportPdf(id, S.win));
// A link in node text opens in the user's browser; only http(s), never a file or custom scheme.
ipcMain.handle('shell:open', (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
  return shell.openExternal(url);
});
// A canvas is a tldraw board, and tldraw needs a licence Orbital does not have, so Tana's own page draws it: a window of
// its own on the Tana session, with everything but the board (tldraw's .tl-container) hidden (issue #611). The hiding
// waits for the board, so a login page or an error still shows. One window per canvas; opening it again brings it forward.
const CANVAS_CSS = `body:has(.tl-container) * { visibility: hidden !important; }
body:has(.tl-container) :is(.tl-container, .tl-container *, [data-radix-popper-content-wrapper], [data-radix-popper-content-wrapper] *) { visibility: visible !important; }
.tl-container { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }
:has(.tl-container) { transform: none !important; contain: none !important; filter: none !important; }`;
const canvasWindows = new Map(); // canvas id -> its window
ipcMain.handle('canvas:open', (_e, id) => {
  if (!/^tana:canvas:[0-9a-z]{26}$/.test(String(id))) throw new Error('Not a canvas');
  const open = canvasWindows.get(id);
  if (open && !open.isDestroyed()) return open.focus();
  const url = webLink(id);
  const win = new BrowserWindow({ width: 1200, height: 800, webPreferences: { partition: 'persist:tana', preload: path.join(__dirname, 'canvas-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ (Electron|tana-tasks)\/\S+/g, '')); // as the login window: Tana reads an Electron agent as its own desktop app
  win.webContents.on('dom-ready', () => win.webContents.insertCSS(CANVAS_CSS));
  win.webContents.setWindowOpenHandler(({ url: to }) => { if (/^https?:\/\//i.test(to)) shell.openExternal(to); return { action: 'deny' }; });
  win.on('closed', () => canvasWindows.delete(id));
  canvasWindows.set(id, win);
  win.loadURL(url);
});
// macOS appearance, for the renderer's "follow the system" theme: current value on demand, plus live changes
const systemTheme = () => (nativeTheme && nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('theme:system', () => systemTheme());
if (nativeTheme) nativeTheme.on('updated', () => send('theme:system', systemTheme()));
ipcMain.handle('mcp:setHidden', async (e, on) => { const stored = await setMcpHidden(on); tellOthers(pageOf(e)); return stored; });
ipcMain.handle('sync:status', () => S.status);
ipcMain.handle('sync:login', async () => {
  try {
    if (!(await S.session.login())) return; // the login window closed: nothing happened, and nothing to say
    await start();
    autoTypeIcons();
  } catch (e) {
    report(e);
  } finally { relayout(); }
});
// ⌘K Log out of Tana: the stream closed and the session's cookies cleared, so every window shows the login. Signed out
// first: the pages hear it before the reads the closing stream fails, and say nothing of those (renderer/nodes.js showError).
ipcMain.handle('sync:logout', async () => {
  for (const w of canvasWindows.values()) if (!w.isDestroyed()) w.destroy(); // a board stays on screen after its cookies go (#611)
  setStatus({ authenticated: false, connected: false, syncing: false, error: null });
  relayout();
  stop();
  await S.session.logout();
});

if (process.env.TANA_MAIN_TEST) {
  module.exports = { resolveInitialAuth, graphRow, cachedNodeHue, rememberType, VIEWS, toNode, outlineWithReferences, reliveRefs: require('./main/documents').reliveRefs, rememberEdit: require('./main/documents').rememberEdit, chatOutline, op, onChange, documentAction, archivedTypes, createDocument, creationOptions, typeChoices, typeCandidates, setType, setTypeHue, discussWith, ai, icons, settings, search, viewFilter, searchCreate, searchTitle, viewRows, spaceChildren, start, refresh, related, watchRelated, weekTitle, weekNode,
    statusSnapshot: () => ({ ...S.status }), rememberNodeHue, restoredBounds, savedDoc, closeFront, today,
    undo: () => history(undoStack, redoStack, 'undo', 'canUndo'), redo: () => history(redoStack, undoStack, 'redo', 'canRedo'), visibleGraphNodes, pinTree, changesOf, summaryChanges, followSummary, announceNewInbox, watchInbox, timelinePage,
    nodePin, dropSearchHeads,
    autoTypeIcons,
    agents, // the agent handoff (main/agents/index.js), so a check can drive it through the real path
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

  // orbital:<id> (orbital:tana:text:…), clicked anywhere on this Mac, opens that node here, as it does on the phones
  // (ios Shell.swift open, android MainActivity). Heard before 'ready': the link that launched the app comes before it.
  // Only a node id is taken; any page can open such a link, and opening is all it does.
  let openNode = null, linked = null;
  app.on('open-url', (e, url) => {
    e.preventDefault();
    const id = String(url).slice('orbital:'.length);
    if (!/^orbital:tana:[a-z-]+:[0-9a-z]{26}$/.test(url)) return;
    if (openNode) openNode(id); else linked = id;
  });
  if (app.isPackaged) app.setAsDefaultProtocolClient('orbital'); // a dev run would take the links from the installed app

  app.whenReady().then(async () => {
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); // packaged builds carry the icon in the bundle
    // The dock belongs to main, the counting to main/views: the same split refresh already uses through S.refresh.
    S.badge = (count) => { try { app.setBadgeCount(Number(count) || 0); } catch { /* no badge on this platform */ } };
    // Showing a notification is electron's; deciding there should be one is main/documents'. Clicking it opens the node.
    // An edit banner has one macOS identifier per node, so the 'summary' that follows it (Tana's sentence for the edit,
    // main/documents.js followSummary) replaces it in place, silently — unless it was clicked, and so already seen.
    const clickedEdits = new Set();
    // Held until clicked or closed: a Notification that only lived in this function was garbage-collected while it sat in
    // Notification Center, and its click handler with it, so a click minutes later did nothing. One per macOS id: a
    // banner replaced in place lets go of the one it replaced.
    const onScreen = new Map();
    // A node opened in the page used last, not all of them; a new window when the last one was closed, or the first
    // page when it has not loaded yet (a link that launched the app): told once it has, and so listens.
    openNode = (docId) => {
      const page = frontPane();
      if (page) { S.win.show(); S.win.focus(); page.focus(); return page.send('notify:open', docId); }
      if (!S.windows.size) createWindow();
      const wc = S.win.shell.webContents, loaded = (_e, isMainFrame) => { const first = !isMainFrame && frontPane(); if (first) { wc.off('did-frame-finish-load', loaded); first.send('notify:open', docId); } };
      wc.on('did-frame-finish-load', loaded);
    };
    S.notify = async (docId, title, body, kind, subtitle) => { // subtitle: macOS's line between title and body (what an edit changed)
      if (S.demo || !Notification.isSupported || !Notification.isSupported()) return; // demo mode: nothing real on screen, banners included
      // Auto-translate (#547) covers banners too: their words in the chosen language, never a sensitive node's, and the
      // banner as written when the answer does not come within 15 s (main/ai.js translate: this Mac detects, the model translates)
      const to = settings.prefs().translateTo;
      if (to && !sensitiveIds().includes(docId)) {
        const found = await ai.translate([title, subtitle || '', body || ''], to, globalThis.fetch, S.userData, { timeout: 15000 }).catch(() => []);
        [title, subtitle, body] = [title, subtitle, body].map((t, i) => found[i]?.text || t);
      }
      const id = kind ? 'edit:' + docId : undefined; // undefined: a fresh random id, as before
      if (kind === 'summary' && clickedEdits.has(id)) return;
      if (kind === 'edit') clickedEdits.delete(id);
      const note = new Notification({ id, title, subtitle, body, silent: kind === 'summary' });
      const key = id || note;
      onScreen.set(key, note);
      note.on('close', () => { if (onScreen.get(key) === note) onScreen.delete(key); });
      note.on('click', () => {
        if (onScreen.get(key) === note) onScreen.delete(key);
        if (id) clickedEdits.add(id);
        openNode(docId);
      });
      note.show();
    };
    S.userData = app.getPath('userData');
    db.open(path.join(S.userData, 'tasks.sqlite'));
    S.session = createTanaSession();
    createMenu();
    createWindow();
    if (linked) openNode(linked);
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
    checkUpdates();
    setInterval(() => checkUpdates(), 24 * 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => {}); // stay in the Dock (activate above)
  app.on('before-quit', () => { if (S.client) S.client.close().catch(() => {}); agents.stop(); ai.stop(); }); // no writer outlives the app that spawned it
}
