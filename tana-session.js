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

  const inFlight = new Map(); // refresh flag -> the lookup already running
  // Every request asks for a token, so a cold or expiring cache made each caller fetch its own session. With many
  // documents bootstrapping at once that became a burst on /api/auth/session, the server answered 429, and because a
  // failed fetch leaves `last` unset the cache stayed cold — so the next retry wave was just as large. One shared
  // lookup per kind collapses a wave into a single request; a forced refresh keeps its own slot so it cannot be
  // served a result that was already stale when it was asked for.
  function fetchSession(refresh) {
    const key = !!refresh;
    const running = inFlight.get(key);
    if (running) return running;
    const run = (async () => {
      const res = await ses.fetch(origin + '/api/auth/session' + (key ? '?refresh=true' : ''), {
        credentials: 'include', headers: { accept: 'application/json' },
      });
      // Tana's sessionGate reads 401 and 403 alike as signed out; anything else is a failure worth retrying.
      const signedOut = res.status === 401 || res.status === 403;
      if (!res.ok && !signedOut) throw new Error('GET /api/auth/session failed: HTTP ' + res.status);
      const json = await res.json().catch(() => ({}));
      last = res.ok && json.authenticated ? json : null;
      expiresAt = last && last.accessToken ? (jwtClaims(last.accessToken).exp || 0) * 1000 : 0;
      return last;
    })();
    inFlight.set(key, run);
    return run.finally(() => { if (inFlight.get(key) === run) inFlight.delete(key); });
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
    // A minute before expiry, as Tana's own client refreshes (sessionGate: exp - 60 s).
    if (refresh || !last || !last.accessToken || Date.now() > expiresAt - 60000) await fetchSession(refresh);
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
// gets a fresh 15-bit nonce per process (sdk/sync.js derivePeerId) so concurrent processes (app + CLI) never share a Loro peer id.
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
