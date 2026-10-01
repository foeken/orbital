'use strict';
// Where this app's own data lives: the login partition and its cookies, peer.json, the SQLite row cache and the
// local mirror of the settings document. The folder is named after the app, and the app is Orbital now, so a new
// install gets "Orbital" and an older one is moved there once, on the way past. A move rather than reading both
// names: two folders would mean a login in one and a cache in the other. It is written to be deletable — when no
// install carries the old name any more, OLD_DIR and the migrate branch go and the rest stands on its own.
const fs = require('node:fs');
const path = require('node:path');

const DIR = 'Orbital';
const OLD_DIR = 'tana-tasks'; // the app's old name, and the whole of the legacy path

// What Electron answers as app.getPath('appData'), for node-only helpers that have no app to ask.
const appDataDir = () => (process.platform === 'darwin'
  ? path.join(process.env.HOME || '', 'Library', 'Application Support')
  : process.env.APPDATA || path.join(process.env.HOME || '', '.config'));

// Migrating belongs to whatever boots the app (main.js, the CLI) and happens before a single file in there is
// opened: renaming the folder out from under a running instance would leave it writing to paths that no longer
// resolve, so a helper script that only wants to read the database asks without it.
function userDataDir(appData = appDataDir(), { migrate = false } = {}) {
  const next = path.join(appData, DIR), old = path.join(appData, OLD_DIR);
  if (fs.existsSync(next) || !fs.existsSync(old)) return next; // already moved, or nothing to move
  if (!migrate) return old;
  try {
    fs.renameSync(old, next);
    return next;
  } catch {
    return old; // another copy holding it, a read-only volume: keep the session where it is and try again next boot
  }
}

module.exports = { userDataDir, appDataDir, DIR, OLD_DIR };
