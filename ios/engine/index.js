// The phone's engine (issue #658): Orbital's own SDK and main/timeline.js, run in the app's hidden web view on the page
// https://home.tana.inc/api/auth/session. That page is Tana's origin, so every call is same-origin with the web view's
// login cookies (no CORS, no bridge), and it is a JSON document without a CSP, so Loro's WASM runs. SwiftUI draws the
// rows this hands back (ios/Orbital/Engine.swift). What main/timeline.js needs of the desktop is stood in for by
// ./stand-ins.js, chosen at bundle time (build.js).
// An ES module so the bundle runs it (Bun leaves a CommonJS entry of an iife bundle wrapped and never called).
import { createTanaClient } from '../../sdk';
import { STATE_TYPES, editable, readNode, setState } from '../../sdk/node';
import { S } from '../../main/state';
import timeline from '../../main/timeline';
import { issues } from './stand-ins';
import loro from 'loro-crdt/package.json';

const claims = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } };
// tana-session.js without Electron: the page's own cookies, one lookup at a time, a minute before expiry as Tana does
let last = null, expiresAt = 0, inFlight = null, answer = 'not asked';
function fetchSession(refresh) {
  // no-store: Tana sends this with no cache headers, and a signed-out answer from before signing in must never be reused
  inFlight ||= fetch('/api/auth/session' + (refresh ? '?refresh=true' : ''), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok && res.status !== 401 && res.status !== 403) throw new Error('GET /api/auth/session failed: HTTP ' + res.status);
      const json = await res.json().catch(() => ({}));
      last = res.ok && json.authenticated ? json : null;
      answer = res.status + ' ' + (last ? 'signed in' : 'signed out' + (json.reason ? ' (' + json.reason + ')' : ''));
      expiresAt = last && last.accessToken ? (claims(last.accessToken).exp || 0) * 1000 : 0;
      return last;
    }, (e) => { answer = String(e && e.message || e); throw e; }).finally(() => { inFlight = null; });
  return inFlight;
}
async function getAccessToken({ refresh = false } = {}) {
  if (refresh || !last || Date.now() > expiresAt - 60000) await fetchSession(refresh);
  if (!last) throw new Error('not authenticated');
  return last.accessToken;
}

// sdk/sync.js derivePeerId, asynchronous here: a page has no synchronous sha256
async function peerId(user) {
  const hash = new DataView(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.trim().toLowerCase()))).getBigUint64(0) >> 16n;
  return ((hash << 16n) | BigInt(Math.floor(Math.random() * 32768))).toString(10);
}
// peer.json's storageId (tana-session.js peerIdentity), kept in the page's own storage
function storageId() {
  let id = localStorage.getItem('orbital:storageId');
  if (!id) localStorage.setItem('orbital:storageId', id = crypto.randomUUID());
  return id;
}

window.orbital = {
  // true once signed in and connected; false when this web view has no Tana session
  async connect() {
    if (!(await fetchSession(false))) { S.client = S.me = null; return false; }
    const c = claims(last.accessToken), user = last.userExternalId || c['urn:tana:user:id'];
    S.me = { userUri: 'tana:user-profile:' + user, user: last.user, orgId: c.org_id || last.organizationId, orgDocUri: last.orgDocUri };
    if (!S.client) {
      // the whole client, sync stream included: a same-origin fetch stream here, as Tana's own client runs it
      S.client = createTanaClient({ getAccessToken, orgId: S.me.orgId, peerId: await peerId(user), storageId: storageId(), clientName: 'orbital-ios' });
      S.client.sync.connect().catch((e) => issues.push('sync: ' + (e && e.message || e)));
    }
    return true;
  },
  // the Timeline page, three days per page, as the rows the desktop renderer gets
  async timeline(pages = 1) {
    timeline.setPages(pages);
    return JSON.stringify(await timeline.rows());
  },
  // main/documents.js webLink: a node's page on home.tana.inc, under the org document's ulid
  link: (id) => 'https://home.tana.inc/o/' + String(last && last.orgDocUri || '').split(':').pop() + '/' + ({ type: 't', 'user-profile': 'u', event: 'e', space: 's' }[id.split(':')[1]] || 'l') + '/' + encodeURIComponent(id),
  // A task's box, as the desktop's does it (renderer/edit.js toggleDone, main/documents.js doc:setDone and mutTasks): an
  // Inbox task is accepted first (In Progress), a finished one is reopened, anything else is completed. Answers the state
  // written; refuses what is not a task or is read-only to you.
  async toggle(id) {
    const doc = await S.client.sync.subscribe(id), n = readNode(doc);
    if (!STATE_TYPES.includes(n.stateType)) throw new Error('Only a task can be ticked off');
    if (editable(n, S.me.userUri) === false) throw new Error('This task is read-only to you');
    const next = n.stateType === 'proposed' || n.stateType === 'closed' ? 'open' : 'closed';
    setState(doc, next, S.me.userUri);
    return next;
  },
  loro: loro.version,
  why: () => answer, // what Tana last said about the session, for the app's sign-in log
  issues: () => issues.splice(0), // what went wrong since last asked (a part of the page that could not be read), for the log
};
window.webkit?.messageHandlers?.orbital?.postMessage('ready');
