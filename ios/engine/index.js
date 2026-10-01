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
import { datePins, sidebarTree } from '../../sdk/pins';
import { addMeetingChats, completedInWindow, searchQueryParams } from '../../sdk/query';
import { canDelete, canWrite, everyoneOnly } from '../../sdk/access';
import { arrange } from './arrange';
import { S, isSpace, iso, visibleGraphNodes } from '../../main/state';
import timeline from '../../main/timeline';
import settings from '../../main/settings';
import { forget, issues, members, within } from './stand-ins';
import { PRIVATE, redact as scrub } from './redact';
import NUCLEO from 'nucleo-ui';

// The phone reads Orbital's settings document and never makes one: a Mac does (main/settings.js create). Once it did,
// when it could not find yours, and read an empty one: no icons, nothing sensitive known.
S.settingsReadOnly = true;

const claims = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } };
// tana-session.js without Electron: the page's own cookies, a minute before expiry as Tana does. One lookup at a time of
// each kind: a forced refresh (sdk/transport.js after a 401, which retries once) never waits on a plain lookup that may
// hand back the same expired token (tana-session.js keeps the two apart the same way).
let last = null, expiresAt = 0, answer = 'not asked';
const inFlight = {};
function fetchSession(refresh) {
  const kind = refresh ? 'refresh' : 'plain';
  // no-store: Tana sends this with no cache headers, and a signed-out answer from before signing in must never be reused
  return (inFlight[kind] ||= fetch('/api/auth/session' + (refresh ? '?refresh=true' : ''), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok && res.status !== 401 && res.status !== 403) throw new Error('GET /api/auth/session failed: HTTP ' + res.status);
      const json = await res.json().catch(() => ({}));
      last = res.ok && json.authenticated ? json : null;
      answer = res.status + ' ' + (last ? 'signed in' : 'signed out' + (json.reason ? ' (' + json.reason + ')' : ''));
      expiresAt = last && last.accessToken ? (claims(last.accessToken).exp || 0) * 1000 : 0;
      return last;
    }, (e) => { answer = String(e && e.message || e); throw e; }).finally(() => { delete inFlight[kind]; }));
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
const listRow = (n) => ({ id: n.id, title: secret().has(n.id) ? PRIVATE : n.title || 'Untitled', icon: n.id.split(':')[1], stateType: (n.state && n.state.type) || null, createdAt: iso(n.updateTime) || iso(n.createTime) || null });

// What you marked sensitive in Orbital (the settings document's sensitive: node ids) never shows on the phone (redact.js).
// Every content call reads this account's settings document first, since only it says what is sensitive: a node marked
// on the Mac a moment ago is never shown once from an older list. After the first time that is a local read (the
// document stays live in the engine, so it is as current as the sync stream). Before the settings were ever read the
// content calls fail rather than show everything; after, a read that fails (offline) goes on with the last list.
async function settled() {
  // hydrate also answers (false) when the document could not be opened at all: only a known settings document counts
  const read = await within('settings document', settings.hydrate()).then(() => !!settings.settingsDocId(), () => false);
  if (read) return void settings.set('settingsRead', true); // this account's own mirror (stand-ins.js ns), never synced
  if (!settings.get('settingsRead')) throw new Error('Could not read your Orbital settings yet, so nothing is shown. Pull to try again.');
}
const secret = () => new Set(Array.isArray(settings.get('sensitive')) ? settings.get('sensitive') : []);
const redact = (rows) => scrub(rows, secret());

// The documents this page opened or ticked (open, toggle) are let go of once they are no longer among the last few, as
// the desktop lets its on-demand reads go (main/documents.js onDemand): a subscription holds the whole document, and a
// chat can be megabytes. One the page already held for something else (the Timeline's) is left alone.
const KEEP = 12, kept = [];
// init makes a new document (sdk/sync.js subscribe); it is counted before the wait, so one that times out is still let go.
async function hold(id, init) {
  const had = !!S.client.sync.getDocument(id), at = kept.indexOf(id);
  if (at >= 0) kept.splice(at, 1);
  if (at >= 0 || !had) kept.push(id); // newest last; one held for something else is never ours to let go
  while (kept.length > KEEP) S.client.sync.unsubscribe(kept.shift()).catch(() => {}); // drains queued writes first
  return within('opening ' + id, S.client.sync.subscribe(id, init));
}
// A reference with no label of its own is named by the graph, as main/documents.js resolveReferences does; each name is
// asked once, since a chat on screen is read again every two seconds
const names = new Map();
async function titled(rows) {
  const refs = [], walk = (list) => list.forEach((r) => { if (r.reference && !r.reference.label) refs.push(r); walk(r.children || []); });
  walk(rows);
  const ids = [...new Set(refs.map((r) => r.reference.uri))].filter((id) => !names.has(id));
  if (ids.length) {
    const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: ids, limit: ids.length }).catch(() => ({}));
    for (const n of nodes) names.set(n.id, n.title);
  }
  for (const r of refs) r.reference.label = names.get(r.reference.uri) || 'Unavailable reference';
  return rows;
}
// A saved search's rows: its stored query asked as main/related.js searchRows asks it
async function searchRows(doc) {
  const { query, view } = readSearch(doc);
  if (!query || !Object.keys(query).length) throw new Error('This saved search has no readable query');
  const scoped = (query.ownerUris || []).some((u) => typeof u === 'string' && isSpace(u));
  const spaces = scoped ? (await S.client.graph.listNodes({ nodeTypes: ['space'], limit: 1000 })).nodes : [];
  const { nodes = [] } = await S.client.graph.listNodes(searchQueryParams(query, S.me.userUri, rowLimit(view.limit), undefined, spaces));
  let found = nodes.filter((n) => completedInWindow(n, view.completedWithin));
  if (view.audience === 'everyone') found = await everyoneOnly(S.client.graph, found);
  // arranged as the search was saved: its sort and its sections (arrange.js), with what they are named by
  const types = [...new Set(found.map((n) => n.entityType).filter(Boolean))];
  const [people, pinned, typeNodes] = await Promise.all([members().catch(() => []), within('date pins', datePins(S.client.sync, S.me.userUri)).catch(() => ({})),
    types.length ? S.client.graph.listNodes({ nodeIds: types, limit: types.length }).then((r) => r.nodes, () => []) : []]);
  const typeTitles = new Map(typeNodes.map((t) => [t.id, t.title])), notify = settings.get('notify') || {};
  const choice = (on) => new Set(Object.keys(notify).filter((id) => notify[id] === on));
  const byId = new Map(found.map((n) => [n.id, n]));
  const rows = arrange(found.map((n) => ({ id: n.id, title: n.title, state: (n.state && n.state.type) || null, updated: iso(n.updateTime), created: iso(n.createTime),
    createdBy: n.createdBy, assignees: n.assignedTo || [], type: typeTitles.get(n.entityType) })), view,
  { me: S.me.userUri, now: Date.now(), names: new Map(people.map((m) => [m.id, m.title])), pinned: new Set(Object.keys(pinned)), watched: choice(true), silenced: choice(false) });
  return rows.map(({ n, group }) => ({ ...listRow(byId.get(n.id)), group }));
}

// What you type in the composer, written into a chat as Tana writes a message and Tana asked to answer, as the desktop
// sends one (main/documents.js sendChat); the answer arrives as live updates to the chat, which the chat screen reads.
// Someone else's chat is checked first, with the desktop's rule (canWriteDoc: sdk/access canWrite), so a chat you can
// only read never keeps a message that did not reach Tana. Answers { id, warning }: the warning when Tana did not take
// the message up, which is sent all the same.
async function say(id, text) {
  const doc = await hold(id);
  if (doc.writeDenied || !(await writable(doc))) throw new Error('You can read this chat but not write in it');
  const words = await message(text);
  let messageId;
  doc.transact((loro) => { messageId = addMessage(loro, words); });
  return answered(id, messageId, doc.data.get('ownerUri'));
}
// a message as addMessage takes it: its words, and who sent it by uri and by name
const message = async (text) => ({ text, byUri: S.me.userUri, senderName: (await members().catch(() => [])).find((m) => m.id === S.me.userUri)?.title || (S.me.user || {}).email });
// The message is in the chat either way: Tana not taking it up is a warning under the composer, not a failed send, or
// the composer would offer to send it again (main/documents.js askReply answers it the same way)
async function answered(id, messageId, ownerUri) {
  // without the page's cookies: Tana's AI refuses a request that carries both them and the token (auth/multiple-auth-mechanisms)
  const fetch = (url, init) => globalThis.fetch(url, { ...init, credentials: 'omit' });
  const warning = await triggerReply({ chatUri: id, messageId, ownerUri, getAccessToken, fetch }).then(() => null, (e) => 'Sent, but Tana did not answer: ' + (e && e.message || e));
  return JSON.stringify({ id, warning });
}
// main/documents.js accessContext and canWriteDoc: write access to a document, from its participants and owners
async function access() {
  const c = claims(await getAccessToken());
  // the owners and the org it reads go through hold, so they are let go of like every other document read here
  return { sync: { subscribe: (uri) => hold(uri) }, graph: S.client.graph, orgDocUri: S.me.orgDocUri, orgAdmin: c.org_id === S.me.orgId && ['admin', 'owner'].includes(c.role) };
}
const writable = async (doc) => canWrite(readNode(doc), S.me.userUri, await access()).catch(() => false);

// no session, or another one: the old client's stream is closed rather than left reconnecting
function drop() {
  if (S.client) S.client.close().catch(() => {});
  S.client = S.me = null;
  settings.reset(); forget(); names.clear(); kept.length = 0; // what the last account's session knew
}

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
    if (!(await fetchSession(false))) { drop(); return false; }
    const c = claims(last.accessToken), user = last.userExternalId || c['urn:tana:user:id'];
    const me = { userUri: 'tana:user-profile:' + user, user: last.user, orgId: c.org_id || last.organizationId, orgDocUri: last.orgDocUri };
    // the client is made for one user in one org (its peer id, the sync stream): signed in as someone else, a new one
    if (S.me && (S.me.userUri !== me.userUri || S.me.orgId !== me.orgId)) drop();
    S.me = me;
    if (!S.client) {
      // the whole client, sync stream included: a same-origin fetch stream here, as Tana's own client runs it
      S.client = createTanaClient({ getAccessToken, orgId: S.me.orgId, peerId: await peerId(user), storageId: storageId(), clientName: 'orbital-ios' });
      // every list as the desktop's (main/views.js listFilter): no deleted nodes, not the Orbital settings document, and
      // meeting chats in any list of chats (sdk/query.js addMeetingChats); a lookup by id answers as it is
      const list = S.client.graph.listNodes.bind(S.client.graph);
      S.client.graph.listNodes = addMeetingChats(async (params) => {
        const result = await list(params), app = new Set(settings.appDocIds());
        return { ...result, nodes: visibleGraphNodes(result.nodes).filter((n) => params.nodeIds || !app.has(n.id)) };
      });
      S.client.sync.connect().catch((e) => issues.push('sync: ' + (e && e.message || e)));
    }
    return true;
  },
  // the Timeline page, three days per page, as the rows the desktop renderer gets
  async timeline(pages = 1) {
    timeline.setPages(pages);
    await settled(); // the watch choices and what is sensitive
    return JSON.stringify(redact(await timeline.rows()));
  },
  // A task's box, as the desktop's does it (renderer/edit.js toggleDone, main/documents.js doc:setDone and mutTasks): an
  // Inbox task is accepted first (In Progress), a finished one is reopened, anything else is completed. Answers the state
  // written; refuses what is not a task or is read-only to you.
  // A write only queues, and Tana says no later, as a write-denied event (sdk/sync.js): its answer is waited for a few
  // seconds so a refused box goes back rather than looking ticked until the next read.
  // ponytail: 3 s for Tana's refusal; a slower one shows at the first read half a minute on (Engine.swift settle).
  async toggle(id) {
    const doc = await hold(id), n = readNode(doc);
    if (!STATE_TYPES.includes(n.stateType)) throw new Error('Only a task can be ticked off');
    if (doc.writeDenied || editable(n, S.me.userUri) === false) throw new Error('This task is read-only to you');
    const next = n.stateType === 'proposed' || n.stateType === 'closed' ? 'open' : 'closed';
    const refused = new Promise((resolve) => {
      const on = (denied) => { if (denied === id) done(true); };
      const done = (answer) => { S.client.sync.off('write-denied', on); clearTimeout(timer); resolve(answer); };
      const timer = setTimeout(() => done(false), 3000);
      S.client.sync.on('write-denied', on);
    });
    setState(doc, next, S.me.userUri);
    if (await refused) throw new Error('Tana refused the change: this task is read-only to you');
    return JSON.stringify(next);
  },
  why: () => answer, // what Tana last said about the session, for the app's sign-in log
  email: () => (last && last.user && last.user.email) || null,
  // Zooming into a node: what it holds, as the desktop's page for it shows. A chat is its conversation (sdk/chat.js,
  // docs/CHATS.md), a saved search its results, a meeting the documents it owns (its write-up, its outcomes), anything
  // else its outline (sdk/content.js).
  async open(id) {
    await settled();
    const kind = id.split(':')[1];
    if (secret().has(id)) return JSON.stringify({ title: PRIVATE, kind, rows: [], private: true }); // before it is fetched at all
    const doc = await hold(id), n = readNode(doc);
    let rows;
    if (kind === 'chat') {
      const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title])), messages = doc.data.get('messages');
      rows = chatRows(messages ? messages.toJSON() : [], { authorName: (uri) => names.get(uri), me: S.me.userUri, streamingId: doc.data.get('streamingMessageId') });
    } else if (kind === 'search') rows = await searchRows(doc);
    else if (kind === 'event') rows = (await S.client.graph.listNodes({ ownerIds: [id], limit: 100, sortOptions: newest })).nodes.map(listRow);
    else rows = readOutline(doc);
    return JSON.stringify({ title: n.title || 'Untitled', kind, rows: redact(await titled(rows)) });
  },
  // Ask Tana from the composer: a new chat, yours alone and untitled as Tana starts one so its AI names it after the first
  // answer (main/documents.js newChat), with what you typed as its first message. Answers the chat's id.
  // The message is written with the chat, in one go: a chat that is slow to reach Tana still arrives with its message,
  // never empty, and the composer is told it is saved rather than offered to send it again.
  async ask(text) {
    const id = 'tana:chat:' + ulid(), words = await message(text);
    let messageId;
    const doc = await hold(id, (loro) => {
      initDocument(loro, 'New chat', S.me.userUri, { kind: 'chat' });
      loro.getMap('data').delete('title');
      loro.getMap('data').set('titleAutoGenerated', true);
      messageId = addMessage(loro, words);
    }).catch((e) => ({ failed: e }));
    if (doc.failed) return JSON.stringify({ id, warning: 'Saved, but Tana could not be reached yet: ' + (doc.failed.message || doc.failed) });
    return answered(id, messageId, doc.data.get('ownerUri'));
  },
  send: (id, text) => say(id, text), // a follow-up in a chat
  // Every saved search you can see, the ones pinned to your sidebar first in their order there, each with its icon (glyph)
  // the ones pinned to your sidebar first, in its order (sections included), then the rest, newest first
  async searches() {
    const [tree, { nodes = [] }] = await Promise.all([within('sidebar pins', sidebarTree(S.client.sync, S.me.userUri)).catch(() => []), S.client.graph.listNodes({ nodeTypes: ['search'], limit: 1000, sortOptions: newest })]);
    await settled(); // the icons and what is sensitive
    const chosen = settings.get('typeIcons') || {}, byId = new Map(nodes.map((n) => [n.id, n])), order = [];
    const take = (entries) => { for (const e of entries) { if (e.uri && byId.has(e.uri) && !order.includes(byId.get(e.uri))) order.push(byId.get(e.uri)); take(e.children || []); } };
    take(tree);
    take(nodes.map((n) => ({ uri: n.id })));
    return JSON.stringify(await Promise.all(order.map(async (n) => ({ ...listRow(n), glyph: await iconPng(chosen[n.id]).catch(() => null) }))));
  },
  // Long press, Delete: to Tana's trash, as the desktop deletes (main/documents.js documentAction), where you may
  async remove(id) {
    const doc = await hold(id);
    if (!(await canDelete(doc, S.me.userUri, await access()).catch(() => false))) throw new Error('You cannot delete this');
    await S.client.sync.softDelete(id);
    return JSON.stringify(id);
  },
  // Auto-translate as the desktop has it (renderer/translate.js): the language chosen there (a synced preference),
  // and the model the AI rows use; the phone asks ChatGPT itself (Translator.swift)
  translation: () => { const to = settings.get('pref:translateTo'); return JSON.stringify({ to: ['English', 'Dutch', 'German', 'French', 'Spanish'].includes(to) ? to : null, model: settings.get('aiModel') || null }); },
  // Settings' Sign out, before the app deletes the cookies: a session lookup still under way would set them again (the
  // desktop waits for its lookups the same way, tana-session.js logout), and the client closes
  async signOut() {
    await Promise.allSettled(Object.values(inFlight));
    last = null;
    drop();
  },
  issues: () => { const e = S.status && S.status.error; if (e) { issues.push(e); S.status.error = null; } return issues.splice(0); }, // main/state.js report's too // what went wrong since last asked (a part of the page that could not be read), for the log
};
window.webkit?.messageHandlers?.orbital?.postMessage('ready');
