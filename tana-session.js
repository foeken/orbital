'use strict';
// Electron-only Tana auth: cookie session in a persistent partition, bearer token from /api/auth/session.
const { BrowserWindow, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { derivePeerId } = require('./sdk');

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

function createTanaSession({ partition = 'persist:tana', origin = 'https://home.tana.inc' } = {}) {
  const ses = session.fromPartition(partition);
  let last = null; // last session JSON from /api/auth/session
  let expiresAt = 0; // ms epoch of last.accessToken's exp

  async function fetchSession(refresh) {
    const res = await ses.fetch(origin + '/api/auth/session' + (refresh ? '?refresh=true' : ''), {
      credentials: 'include', headers: { accept: 'application/json' },
    });
    if (!res.ok && res.status !== 401) throw new Error('GET /api/auth/session failed: HTTP ' + res.status);
    const json = await res.json().catch(() => ({}));
    last = res.ok && json.authenticated ? json : null;
    expiresAt = last && last.accessToken ? (jwtClaims(last.accessToken).exp || 0) * 1000 : 0;
    return last;
  }

  async function isAuthenticated() {
    return Boolean(await fetchSession(false));
  }

  function login() {
    return new Promise((resolve, reject) => {
      const win = new BrowserWindow({
        width: 520, height: 720, title: 'Log in to Tana',
        webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      // Google & co refuse embedded logins that advertise Electron.
      win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/ (Electron|tana-tasks)\/\S+/g, ''));
      let done = false, checking = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (!win.isDestroyed()) win.close();
        err ? reject(err) : resolve();
      };
      const check = async () => {
        if (done || checking) return;
        checking = true;
        try { if (await isAuthenticated()) finish(); } catch { /* not yet */ } finally { checking = false; }
      };
      const timer = setInterval(check, 2000);
      win.webContents.on('did-navigate', check);
      win.on('closed', () => finish(new Error('login window closed before signing in')));
      win.loadURL(origin);
      check();
    });
  }

  async function getAccessToken({ refresh = false } = {}) {
    if (refresh || !last || !last.accessToken || Date.now() > expiresAt - 30000) await fetchSession(refresh);
    if (!last || !last.accessToken) throw new Error('not authenticated');
    return last.accessToken;
  }

  async function info() {
    await getAccessToken();
    const c = jwtClaims(last.accessToken);
    const userExternalId = last.userExternalId || c['urn:tana:user:id'];
    return {
      userUri: 'tana:user-profile:' + userExternalId,
      userExternalId,
      orgId: c.org_id || last.organizationId,
      organizationId: last.organizationId,
      orgDocUri: last.orgDocUri,
      sid: last.sessionId || c.sid,
      user: last.user,
    };
  }

  async function logout() {
    last = null;
    expiresAt = 0;
    await ses.clearStorageData();
  }

  return { isAuthenticated, login, getAccessToken, info, logout };
}

// Peer identity per PLATFORM-PROTOCOL.md §1.1: storageId is a persisted UUID (peer.json); the peer id
// gets a fresh 16-bit nonce per process so concurrent processes (app + CLI) never share a Loro peer id.
function peerIdentity({ file, userExternalId }) {
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  if (!stored.storageId) {
    stored.storageId = crypto.randomUUID();
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
  }
  return { peerId: derivePeerId(userExternalId), storageId: stored.storageId };
}

module.exports = { createTanaSession, peerIdentity };
