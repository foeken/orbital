// The phone's engine (issue #658): Orbital's own SDK and main/timeline.js, run in the app's hidden web view on the page
// https://home.tana.inc/api/auth/session. That page is Tana's origin, so every call is same-origin with the web view's
// login cookies (no CORS, no bridge), and it is a JSON document without a CSP, so Loro's WASM runs. SwiftUI draws the
// rows this hands back (ios/Orbital/Engine.swift). What main/timeline.js needs of the desktop is stood in for by
// ./stand-ins.js, chosen at bundle time (build.js).
// An ES module so the bundle runs it (Bun leaves a CommonJS entry of an iife bundle wrapped and never called).
import { createTanaClient } from '../../sdk';
import { STATE_TYPES, editable, initDocument, readNode, readSearch, rowLimit, setState, ulid } from '../../sdk/node';
import { readOutline } from '../../sdk/content';
import { addMessage, chatRows, triggerReply } from '../../sdk/chat';
import { listSidebar } from '../../sdk/pins';
import { completedInWindow, searchQueryParams } from '../../sdk/query';
import { S, isSpace, iso } from '../../main/state';
import timeline from '../../main/timeline';
import settings from '../../main/settings';
import { issues, members, within } from './stand-ins';
import loro from 'loro-crdt/package.json';
import NUCLEO from 'nucleo-ui';

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

// A graph node as a list row (ios/Orbital/Timeline.swift Row): its words, its kind for the glyph, its state for a box
const newest = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
const listRow = (n) => ({ id: n.id, title: n.title || 'Untitled', icon: n.id.split(':')[1], stateType: (n.state && n.state.type) || null, createdAt: iso(n.updateTime) || iso(n.createTime) || null });
// A reference with no label of its own is named by the graph, as main/documents.js resolveReferences does
async function titled(rows) {
  const refs = [], walk = (list) => list.forEach((r) => { if (r.reference && !r.reference.label) refs.push(r); walk(r.children || []); });
  walk(rows);
  const ids = [...new Set(refs.map((r) => r.reference.uri))];
  if (!ids.length) return rows;
  const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: ids, limit: ids.length }).catch(() => ({}));
  const names = new Map(nodes.map((n) => [n.id, n.title]));
  for (const r of refs) r.reference.label = names.get(r.reference.uri) || 'Unavailable reference';
  return rows;
}
// A saved search's rows: its stored query asked as main/related.js searchRows asks it
// ponytail: view.audience 'everyone' is not narrowed here (main/related.js everyoneOnly); add it if a search uses it.
async function searchRows(doc) {
  const { query, view } = readSearch(doc);
  if (!query || !Object.keys(query).length) throw new Error('This saved search has no readable query');
  const scoped = (query.ownerUris || []).some((u) => typeof u === 'string' && isSpace(u));
  const spaces = scoped ? (await S.client.graph.listNodes({ nodeTypes: ['space'], limit: 1000 })).nodes : [];
  const { nodes = [] } = await S.client.graph.listNodes(searchQueryParams(query, S.me.userUri, rowLimit(view.limit), undefined, spaces));
  return nodes.filter((n) => completedInWindow(n, view.completedWithin)).map(listRow);
}

// What you type in the composer, written into a chat as Tana writes a message and Tana asked to answer, as the desktop
// sends one (main/documents.js sendChat); the answer arrives as live updates to the chat, which the chat screen reads
async function say(id, text) {
  const doc = await within('opening ' + id, S.client.sync.subscribe(id));
  if (doc.writeDenied) throw new Error('You can read this chat but not write in it');
  const me = S.me.userUri, user = S.me.user || {};
  const name = (await members().catch(() => [])).find((m) => m.id === me)?.title || user.email;
  let messageId;
  doc.transact((loro) => { messageId = addMessage(loro, { text, byUri: me, senderName: name }); });
  await triggerReply({ chatUri: id, messageId, ownerUri: doc.data.get('ownerUri'), getAccessToken });
  return id;
}

let settingsRead = false;

// The icon a saved search was given with Set icon (the settings document's typeIcons, main/icons.js: search uri → Nucleo
// label), drawn by this page into a PNG the app shows as a template image, since SwiftUI has no SVG: 54 px, the 18 px
// glyph at 3x, in the side menu's 1.6 stroke. null for a search with no icon of its own.
let nucleo = null;
const library = () => (nucleo ||= NUCLEO
  ? new Response(new Blob([Uint8Array.from(atob(NUCLEO), (c) => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).json()
    .then((list) => new Map(list.map((i) => [i.n, i.s])), () => new Map())
  : Promise.resolve(new Map()));
async function iconPng(label) {
  const markup = label && (await library()).get(label);
  if (!markup) return null;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="54" height="54">' + markup.replace(/var\(--nucleo-stroke-width, [\d.]+\)/g, '1.6').replace(/currentColor/g, '#000') + '</svg>';
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 54;
  canvas.getContext('2d').drawImage(img, 0, 0, 54, 54);
  return canvas.toDataURL('image/png').split(',')[1];
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
    // the watch choices, from the settings document: waited for on the first read only, read in the background after that
    const fresh = within('settings document', settings.hydrate()).catch(() => {});
    if (!settingsRead) { await fresh; settingsRead = true; }
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
  email: () => (last && last.user && last.user.email) || null,
  // Zooming into a node: what it holds, as the desktop's page for it shows. A chat is its conversation (sdk/chat.js,
  // docs/CHATS.md), a saved search its results, a meeting the documents it owns (its write-up, its outcomes), anything
  // else its outline (sdk/content.js).
  async open(id) {
    const kind = id.split(':')[1], doc = await within('opening ' + id, S.client.sync.subscribe(id)), n = readNode(doc);
    let rows;
    if (kind === 'chat') {
      const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title])), messages = doc.data.get('messages');
      rows = chatRows(messages ? messages.toJSON() : [], { authorName: (uri) => names.get(uri), me: S.me.userUri, streamingId: doc.data.get('streamingMessageId') });
    } else if (kind === 'search') rows = await searchRows(doc);
    else if (kind === 'event') rows = (await S.client.graph.listNodes({ ownerIds: [id], limit: 100, sortOptions: newest })).nodes.map(listRow);
    else rows = readOutline(doc);
    return JSON.stringify({ id, title: n.title || 'Untitled', kind, rows: await titled(rows) });
  },
  // Ask Tana from the composer: a new chat, yours alone and untitled as Tana starts one so its AI names it after the first
  // answer (main/documents.js newChat), with what you typed as its first message. Answers the chat's id.
  async ask(text) {
    const id = 'tana:chat:' + ulid();
    await within('new chat', S.client.sync.subscribe(id, (loro) => {
      initDocument(loro, 'New chat', S.me.userUri, { kind: 'chat' });
      loro.getMap('data').delete('title');
      loro.getMap('data').set('titleAutoGenerated', true);
    }));
    return say(id, text);
  },
  send: (id, text) => say(id, text), // a follow-up in a chat
  // Every saved search you can see, the ones pinned to your sidebar first in their order there, each with its icon (glyph)
  async searches() {
    const [pinned, { nodes = [] }] = await Promise.all([within('sidebar pins', listSidebar(S.client.sync, S.me.userUri)).catch(() => []), S.client.graph.listNodes({ nodeTypes: ['search'], limit: 200, sortOptions: newest })]);
    const at = (n) => (pinned.includes(n.id) ? pinned.indexOf(n.id) : 1e6);
    await within('settings document', settings.hydrate()).catch(() => {}); // the icons; the last known ones when it does not answer
    const chosen = settings.get('typeIcons') || {};
    return JSON.stringify(await Promise.all(nodes.sort((a, b) => at(a) - at(b)).map(async (n) => ({ ...listRow(n), glyph: await iconPng(chosen[n.id]).catch(() => null) }))));
  },
  issues: () => issues.splice(0), // what went wrong since last asked (a part of the page that could not be read), for the log
};
window.webkit?.messageHandlers?.orbital?.postMessage('ready');
