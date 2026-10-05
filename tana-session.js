'use strict';
// Electron-only Tana auth: cookie session in a persistent partition, bearer token from /api/auth/session.
const { BrowserWindow, WebContentsView, session } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { derivePeerId } = require('./sdk');

function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

// The login window's strip above Tana's page: passkeys do not work in this window yet, so it says what does. Orbital's
// own page, as the window's main frame, with Tana's sign-in in a view under it; nothing is written into Tana's page.
const NOTE_HEIGHT = 40;
const NOTE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><title>Log in to Tana</title>
<meta name="color-scheme" content="light dark"><style>
body { margin: 0; height: ${NOTE_HEIGHT}px; box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 0 14px;
  background: #f3f3f3; border-bottom: 1px solid #e3e3e3; color: #555; font: 13px -apple-system, sans-serif; cursor: default; user-select: none; }
b { font-weight: 600; color: #1d1d1f; } svg { flex: none; width: 16px; height: 16px; color: #666; }
@media (prefers-color-scheme: dark) { body { background: #222527; border-color: #2f3335; color: #a0a5a8; } b { color: #e0e0e0; } svg { color: #a0a5a8; } }
</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="1" stroke="currentColor"><path d="M5.75,8.25v-3.25c0-1.795,1.455-3.25,3.25-3.25h0c1.795,0,3.25,1.455,3.25,3.25v3.25"></path><line x1="9" y1="11.75" x2="9" y2="12.75"></line><rect x="3.25" y="8.25" width="11.5" height="8" rx="2" ry="2"></rect></g></svg><span><b>Passkeys aren't supported yet.</b> Sign in with your password and 2FA code.</span>`);

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

  // true once signed in; false when the window is closed first, which is a cancel rather than a failure
  function login() {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 520, height: 720 + NOTE_HEIGHT, title: 'Log in to Tana',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const wc = view.webContents;
      const fit = () => { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: NOTE_HEIGHT, width, height: height - NOTE_HEIGHT }); };
      win.contentView.addChildView(view);
      fit();
      win.on('resize', fit);
      win.loadURL(NOTE);
      // Google & co refuse embedded logins that advertise Electron.
      wc.setUserAgent(wc.getUserAgent().replace(/ (Electron|tana-tasks)\/\S+/g, ''));
      let done = false, checking = false, signedIn = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (!win.isDestroyed()) win.close();
        resolve(signedIn);
      };
      const check = async () => {
        if (done || checking) return;
        checking = true;
        try { if (await isAuthenticated()) { signedIn = true; finish(); } } catch { /* not yet */ } finally { checking = false; }
      };
      const timer = setInterval(check, 2000);
      wc.on('did-navigate', check);
      wc.once('did-finish-load', () => wc.focus()); // the keys go to Tana's form, not the strip
      win.on('closed', () => { if (!wc.isDestroyed()) wc.close(); finish(); }); // a view's page outlives its window unless closed
      wc.loadURL(origin);
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
    await Promise.allSettled(inFlight.values()); // a session lookup still out would set its cookies again after the clear
    last = null; // after it, or its answer would put the session back
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
