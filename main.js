const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const db = require('./db');
const tana = require('./tana');

const status = { authenticated: false, syncing: false, lastSync: null, error: null };
let win;
let pushTimer;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setStatus(patch) {
  Object.assign(status, patch);
  send('sync:status', status);
}

async function sync() {
  if (status.syncing) return { ok: true };
  setStatus({ syncing: true, error: null });
  try {
    for (const row of db.dirtyRows()) {
      await tana.pushTask({ id: row.id, title: row.title, done: row.done });
      db.markClean(row.id);
    }
    db.replaceFromTana(await tana.pullTasks());
    send('tasks:changed');
    setStatus({ syncing: false, lastSync: new Date().toISOString() });
    return { ok: true };
  } catch (e) {
    setStatus({ syncing: false, error: String(e && e.message || e) });
    return { ok: false, error: status.error };
  }
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(sync, 2000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 900, height: 700, titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('tasks:list', () => db.list());
ipcMain.handle('tasks:update', (_e, id, patch) => {
  const row = db.update(id, patch);
  schedulePush();
  return row;
});
ipcMain.handle('tasks:content', async (_e, id) => {
  const row = db.get(id);
  if (row && row.content != null) return row.content;
  const content = await tana.readContent(id);
  db.setContent(id, content);
  send('tasks:changed');
  return content;
});
ipcMain.handle('sync:now', () => sync());
ipcMain.handle('sync:status', () => status);
ipcMain.handle('sync:login', async () => {
  try {
    await tana.login();
    setStatus({ authenticated: true, error: null });
  } catch (e) {
    setStatus({ error: String(e && e.message || e) });
    return;
  }
  await sync();
});

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  db.open(path.join(userData, 'tasks.sqlite'));
  tana.init({ authFile: path.join(userData, 'tana-auth.json'), openUrl: shell.openExternal });
  createWindow();
  try {
    status.authenticated = await tana.isAuthenticated();
  } catch (e) {
    status.error = String(e && e.message || e);
  }
  if (status.authenticated) sync();
  setInterval(() => { if (status.authenticated) sync(); }, 60000);
});

app.on('window-all-closed', () => app.quit());
