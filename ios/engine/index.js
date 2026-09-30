// The phone's engine (issue #658): Orbital's own SDK and main/timeline.js, run in the app's hidden web view on the page
// https://home.tana.inc/api/auth/session. That page is Tana's origin, so every call is same-origin with the web view's
// login cookies (no CORS, no bridge), and it is a JSON document without a CSP, so Loro's WASM runs. SwiftUI draws the
// rows this hands back (ios/Orbital/Engine.swift). What main/timeline.js needs of the desktop is stood in for by
// ./stand-ins.js, chosen at bundle time (build.js).
// An ES module so the bundle runs it (Bun leaves a CommonJS entry of an iife bundle wrapped and never called).
import { createTransport } from '../../sdk/transport';
import { GraphClient } from '../../sdk/graph';
import { HistoryClient } from '../../sdk/history';
import { S } from '../../main/state';
import timeline from '../../main/timeline';
import { sync } from './stand-ins';
import loro from 'loro-crdt/package.json';

const claims = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } };
// tana-session.js without Electron: the page's own cookies, one lookup at a time, a minute before expiry as Tana does
let last = null, expiresAt = 0, inFlight = null;
function fetchSession(refresh) {
  // no-store: Tana sends this with no cache headers, and a signed-out answer from before signing in must never be reused
  inFlight ||= fetch('/api/auth/session' + (refresh ? '?refresh=true' : ''), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok && res.status !== 401 && res.status !== 403) throw new Error('GET /api/auth/session failed: HTTP ' + res.status);
      const json = await res.json().catch(() => ({}));
      last = res.ok && json.authenticated ? json : null;
      expiresAt = last && last.accessToken ? (claims(last.accessToken).exp || 0) * 1000 : 0;
      return last;
    }).finally(() => { inFlight = null; });
  return inFlight;
}
async function getAccessToken({ refresh = false } = {}) {
  if (refresh || !last || Date.now() > expiresAt - 60000) await fetchSession(refresh);
  if (!last) throw new Error('not authenticated');
  return last.accessToken;
}

window.orbital = {
  // true once signed in and connected; false when this web view has no Tana session
  async connect() {
    if (!(await fetchSession(false))) { S.client = S.me = null; return false; }
    S.me = { userUri: 'tana:user-profile:' + (last.userExternalId || claims(last.accessToken)['urn:tana:user:id']), user: last.user };
    const transport = createTransport({ getAccessToken, clientName: 'orbital-ios' });
    S.client ||= { graph: new GraphClient(transport), history: new HistoryClient(transport), sync };
    return true;
  },
  // the Timeline page, three days per page, as the rows the desktop renderer gets
  async timeline(pages = 1) {
    timeline.setPages(pages);
    return JSON.stringify(await timeline.rows());
  },
  // main/documents.js webLink: a node's page on home.tana.inc, under the org document's ulid
  link: (id) => 'https://home.tana.inc/o/' + String(last && last.orgDocUri || '').split(':').pop() + '/' + ({ type: 't', 'user-profile': 'u', event: 'e', space: 's' }[id.split(':')[1]] || 'l') + '/' + encodeURIComponent(id),
  loro: loro.version,
};
window.webkit?.messageHandlers?.orbital?.postMessage('ready');
