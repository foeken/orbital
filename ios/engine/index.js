// The phone's engine (issue #658): Orbital's own SDK and main/timeline.js, run in the app's hidden web view on the page
// https://home.tana.inc/api/auth/session. That page is Tana's origin, so every call is same-origin with the web view's
// login cookies (no CORS, no bridge), and it is a JSON document without a CSP, so Loro's WASM runs. SwiftUI draws the
// rows this hands back (ios/Orbital/Engine.swift). What main/timeline.js needs of the desktop is stood in for by
// ./stand-ins.js, chosen at bundle time (build.js).
// An ES module so the bundle runs it (Bun leaves a CommonJS entry of an iife bundle wrapped and never called).
import { createTanaClient, derivePeerId } from '../../sdk';
import { STATE_TYPES, initDocument, readNode, readSearch, rowLimit, setAssignees, ulid } from '../../sdk/node';
import { insertAfter, insertImage, readOutline } from '../../sdk/content';
import { initImage, uploadFile } from '../../sdk/assets';
import { addMessage, chatRows, triggerReply } from '../../sdk/chat';
import { datePins, pinDate, sidebarTree, unpinDate } from '../../sdk/pins';
import { completedInWindow, liveTrigger, searchQueryParams, searchQueryToFilter } from '../../sdk/query';
import { definitions, fieldDefinition, parseKey, setFieldText } from '../../sdk/fields';
import { dateLabel, isDateUri } from '../../sdk/dates';
import { NOTES_SLOTS, attendees, notesOurs, notesSlotId, writeUpOf } from '../../sdk/events';
import { canDelete, canWrite, everyoneOnly } from '../../sdk/access';
import { arrange } from './arrange';
import { listFilter } from './listed';
import { S, isSpace, iso, today } from '../../main/state';
import timeline from '../../main/timeline';
import settings from '../../main/settings';
import { forget, issues, members, within } from './stand-ins';
import { mark } from './sensitive';
import { times } from './labels';
import { read } from './read';
import { createHeld } from './held';
import { demo, demoName, demoOn, demoTitle, isDemo } from './demo';
import { agents, handed, linked, refreshSoon } from './agents';
import { createLive } from './live';
import { createTasks } from './tasks';
import { IMAGE_INSTRUCTIONS, TRANSLATE_INSTRUCTIONS, TRANSLATE_SCHEMA, modelLabel, effortLabel } from '../../main/prompts';
import NUCLEO from 'nucleo-ui';

// The phone reads Orbital's settings document and writes only the keys it sets (Mark as Sensitive): a Mac makes, merges
// and tidies it (main/settings.js). Once it did,
// when it could not find yours, and read an empty one: no icons, nothing sensitive known.
S.settingsReadOnly = true;

const claims = (t) => { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return {}; } };
// tana-session.js without Electron: the page's own cookies, a minute before expiry as Tana does. One lookup at a time of
// each kind: a forced refresh (sdk/transport.js after a 401, which retries once) never waits on a plain lookup that may
// hand back the same expired token (tana-session.js keeps the two apart the same way).
let last = null, expiresAt = 0, answer = 'not asked';
const inFlight = {};
function take(ok, status, json) {
  last = ok && json.authenticated ? json : null;
  answer = status + ' ' + (last ? 'signed in' : 'signed out' + (json.reason ? ' (' + json.reason + ')' : ''));
  expiresAt = last && last.accessToken ? (claims(last.accessToken).exp || 0) * 1000 : 0;
  return last;
}
// The page this runs on is that answer already, loaded uncached by the app a moment ago (Engine.swift start, EngineWeb.kt
// load): the first lookup takes it from there, one round trip less before anything is read. Anything but a signed-in
// answer whose token has more than a minute left is asked again, so a copy some cache kept could never stand in for it.
let onPage = true;
function fromPage() {
  if (!onPage) return null;
  onPage = false;
  try {
    const json = JSON.parse(document.body.textContent);
    return json.authenticated === true && json.accessToken && (claims(json.accessToken).exp || 0) * 1000 > Date.now() + 60000 ? json : null;
  } catch { return null; }
}
function fetchSession(refresh) {
  const kind = refresh ? 'refresh' : 'plain';
  const page = !refresh && !inFlight.plain && fromPage();
  if (page) return Promise.resolve(take(true, 200, page));
  // no-store: Tana sends this with no cache headers, and a signed-out answer from before signing in must never be reused
  return (inFlight[kind] ||= fetch('/api/auth/session' + (refresh ? '?refresh=true' : ''), { credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (res) => {
      if (!res.ok && res.status !== 401 && res.status !== 403) throw new Error('GET /api/auth/session failed: HTTP ' + res.status);
      return take(res.ok, res.status, await res.json().catch(() => ({})));
    }, (e) => { answer = String(e && e.message || e); throw e; }).finally(() => { delete inFlight[kind]; }));
}
async function getAccessToken({ refresh = false } = {}) {
  if (refresh || !last || Date.now() > expiresAt - 60000) await fetchSession(refresh);
  if (!last) throw new Error('not authenticated');
  return last.accessToken;
}

// peer.json's storageId (tana-session.js peerIdentity), kept in the page's own storage
function storageId() {
  let id = localStorage.getItem('orbital:storageId');
  if (!id) localStorage.setItem('orbital:storageId', id = crypto.randomUUID());
  return id;
}

// A graph node as a list row (ios/Orbital/Timeline.swift Row): its words, its kind for the glyph, its state for a box
const newest = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
// A block Tana's agent wrote can have no id (sdk/content.js assignBlockIds, which the phone does not write): one of its own
// here, so the row still has one to be drawn by
const named = (rows, at = 'row') => rows.map((r, i) => ({ ...r, id: r.id || at + '.' + i, children: named(r.children || [], r.id || at + '.' + i) }));
const listRow = (n) => ({ id: n.id, title: n.title || 'Untitled', ...(secret().has(n.id) ? { sensitive: true } : {}), icon: n.id.split(':')[1], stateType: (n.state && n.state.type) || null, createdAt: iso(n.updateTime) || iso(n.createTime) || null });

// A meeting's page, as the desktop's (renderer/meetingnotes.js, renderer/fields.js attendeesFieldEl), read only here: its
// attendees, your notes when you have them (one of the places made for them that is yours, sdk/events.js notesOurs, as
// main/meeting-notes.js reads them), and once Tana wrote it up (sdk/events.js writeUpOf) its summary's outline too, for
// Notes | Summary over them.
async function meeting(id, doc) {
  const me = S.me.userUri, places = Array.from({ length: NOTES_SLOTS }, (_, k) => notesSlotId(me, id, k));
  const [{ nodes: self = [] }, { nodes: owned = [] }, { nodes: found = [] }, people] = await Promise.all([
    S.client.graph.listNodes({ nodeIds: [id], limit: 1 }).catch(() => ({})),
    S.client.graph.listNodes({ ownerIds: [id], limit: 100, sortOptions: newest }),
    S.client.graph.listNodes({ nodeIds: places, limit: NOTES_SLOTS }).catch(() => ({})),
    members().catch(() => []),
  ]);
  const writeUp = writeUpOf(self[0], owned);
  const mine = places.map((p) => found.find((n) => n.id === p)).find((n) => notesOurs(n, me, id));
  const outline = async (docId) => named(readOutline(await hold(docId)));
  const [summary, notes] = await Promise.all([writeUp ? outline(writeUp.id) : null, mine ? outline(mine.id) : null]);
  // the notes' first row names the meeting for whoever opens them on their own (main/meeting-notes.js referenceOf):
  // left out while it is still only that link, as on the desktop, where you are on the meeting already
  const naming = (r) => !(r.children || []).length && (r.segments || []).length === 1 && String((r.segments[0].marks || {}).link || '').endsWith('/e/' + encodeURIComponent(id));
  // a member by the calendar's profile id, else by address; anyone else by the calendar's name or address; rooms left out
  const member = (a) => people.find((m) => m.id === a.identityUri || (a.email && (m.emails || []).includes(a.email.toLowerCase())));
  const attending = attendees(doc).filter((a) => a.role !== 'resource' && !['room', 'resource'].includes(a.cutype))
    .map((a) => ({ name: demoName((member(a) || {}).title || a.name || a.email || 'Guest') }));
  return { summary, notes: notes && notes.filter((r, i) => i || !naming(r)), attendees: attending };
}

// What you marked sensitive in Orbital (the settings document's sensitive: node ids), drawn blurred (sensitive.js)
// Every content call reads this account's settings document first, since only it says what is sensitive: a node marked
// on the Mac a moment ago is never shown once from an older list. After the first time that is a local read (the
// document stays live in the engine, so it is as current as the sync stream). Before the settings were ever read the
// content calls fail rather than show everything; after, a read that fails (offline) goes on with the last list.
const MAC_FIRST = "Open Orbital on your Mac once to set it up for this account, then check again here.";
async function settled() {
  settings.hydrateWorkspace().catch(() => {}); // the workspace's MCP server, as the Mac reads it (main/settings.js)
  // hydrate also answers (false) when the document could not be opened at all: only a known settings document counts
  const read = await within('settings document', settings.hydrate()).then(() => !!settings.settingsDocId(), () => false);
  if (read) return void settings.set('settingsRead', true); // this account's own mirror (stand-ins.js ns), never synced
  if (settings.get('settingsRead')) return;
  // none at all: this account never used Orbital on a Mac, which makes the document; the phones draw a screen of their
  // own for this sentence (Timeline.swift, Timeline.kt MAC_FIRST), so it must stay word for word (ios-engine-check)
  if (settings.hasNoDocument()) throw new Error(MAC_FIRST);
  throw new Error('Could not read your Orbital settings yet, so nothing is shown. Pull to try again.');
}
const secret = () => new Set(Array.isArray(settings.get('sensitive')) ? settings.get('sensitive') : []);
const redact = (rows) => demo(mark(rows, secret())); // marked sensitive, then masked in demo mode

// The documents this page opened or ticked (open, toggle) kept a while, and those only looked at let go of (held.js)
const held = createHeld(() => S.client.sync, within), hold = held.hold, peek = (id, as = readNode) => held.peek(id, as);
// A reference with no label of its own is named by the graph, as main/documents.js resolveReferences does; each name is
// asked once, since a chat on screen is read again as its answer is written (live.js)
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
  const rows = arrange(found.map((n) => ({ id: n.id, title: n.title, state: (n.state && settings.stateName(n.state.type, n.state.workflowUri)) || null, updated: iso(n.updateTime), created: iso(n.createTime),
    createdBy: n.createdBy, assignees: n.assignedTo || [], type: typeTitles.get(n.entityType) })), view,
  { me: S.me.userUri, now: Date.now(), names: new Map(people.map((m) => [m.id, m.title])), agent: new Set(Object.keys(settings.get('codexTask') || {})), pinned: new Set(Object.keys(pinned)), watched: choice(true), silenced: choice(false) });
  const name = (uri) => ({ name: (people.find((m) => m.id === uri) || {}).title || 'Someone' }); // who a task is assigned to, drawn as faces (Faces)
  return rows.map(({ n, group }) => ({ ...listRow(byId.get(n.id)), group, ...(n.state ? { assignees: n.assignees, people: n.assignees.map(name) } : {}) }));
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

// Quick Add Task's types (task.js, main/documents.js taskTypes and customCreation): the types with a workflow that apply
// to documents and that you may create in (a space's type keeps its tasks in that space). Each type is read and let go
// again, and the list is kept for the session: types change rarely and there can be many.
let taskTypeList = null;
// What a document of a type is made as (main/documents.js customCreation): a task when the type has a workflow, else a
// document of it; null for a type of meetings, or one whose space is not yours to write in
async function creatable(uri, ctx) {
  try {
    const type = await peek(uri);
    if ((type.appliesTo ?? 'docs') !== 'docs') return null;
    if (type.ownerUri && !(/^tana:space:/.test(type.ownerUri) && await canWrite(await peek(type.ownerUri), S.me.userUri, ctx))) return null;
    return { uri, title: type.title || '', ownerUri: type.ownerUri || null, task: !!type.workflowUri };
  } catch { return null; }
}
// The phone is about tasks for now: a saved search is in its menu when everything it lists is a task, the Tasks kind or
// a type with a workflow; the rest (meetings, chats, goals, a search of everything) stays on the desktop
const workflow = new Map(); // type uri -> whether it has a workflow, for the session
async function listsTasks(searchId) {
  try {
    const types = searchQueryToFilter((await peek(searchId, readSearch)).query, S.me.userUri).types || [];
    for (const t of types) {
      if (t === 'tasks') continue;
      if (!/^tana:type:/.test(t)) return false;
      if (!workflow.has(t)) workflow.set(t, !!(await peek(t)).workflowUri);
      if (!workflow.get(t)) return false;
    }
    return types.length > 0;
  } catch { return false; }
}
const taskTypes = () => (taskTypeList ||= (async () => {
  const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['type'], limit: 200 }), ctx = await access();
  const types = await Promise.all(nodes.map((t) => creatable(t.id, ctx)));
  return types.filter((t) => t && t.task).sort((a, b) => a.title.localeCompare(b.title));
})().catch((e) => { taskTypeList = null; throw e; }));
// Quick Add on a saved search, as Enter in one on the desktop (renderer/render.js searchPreset, #537): a search that lists
// one type you may make documents of makes one of it, with each field its filter pins to one value (a link, a person or
// one option) set; a field it leaves open, a choice of several or a date range is left for you. null for any other search.
const EQUALS = [undefined, 'equals', 'MODE_EQUALS'];
async function presetOf(searchId) {
  const filter = searchQueryToFilter(readSearch(await hold(searchId)).query, S.me.userUri), types = filter.types || [];
  if (types.length !== 1 || !/^tana:type:/.test(types[0])) return null;
  const type = await creatable(types[0], await access());
  if (!type) return null;
  const fields = {};
  for (const [key, f] of Object.entries(filter.fields || {})) {
    const refs = (f && f.refs) || [], texts = ((f && f.textMatches) || []).filter((m) => EQUALS.includes(m.mode));
    if (!f || f.date) continue;
    if (refs.length === 1 && !texts.length) fields[key] = { ref: refs[0] };
    else if (texts.length === 1 && !refs.length) fields[key] = { text: texts[0].value };
  }
  return { ...type, fields: await labelled(fields) };
}
// each linked value with the words it shows (a person's name, a day, a node's title) and, for a node, its type, which a
// link field that takes only some types is written with
async function labelled(fields) {
  const refs = Object.values(fields).map((v) => v.ref).filter((u) => u && !/^tana:user-profile:/.test(u) && !isDateUri(u));
  const nodes = refs.length ? (await S.client.graph.listNodes({ nodeIds: refs, limit: refs.length })).nodes || [] : [];
  const people = new Map((await members().catch(() => [])).map((m) => [m.id, m.title])), found = new Map(nodes.map((n) => [n.id, n]));
  for (const v of Object.values(fields)) {
    if (!v.ref) continue;
    v.label = v.label || people.get(v.ref) || (isDateUri(v.ref) && dateLabel(v.ref)) || (found.get(v.ref) || {}).title || v.ref;
    if (found.has(v.ref)) v.entityType = found.get(v.ref).entityType;
  }
  return fields;
}
// those values written into the new document, as main/documents.js setField writes a field: a link with its title, and
// the type of what it links to where the field only takes some types
async function presetFields(doc, fields) {
  await labelled(fields);
  for (const [key, v] of Object.entries(fields)) {
    const { typeUri, attribute } = parseKey(key), field = fieldDefinition(await hold(typeUri), attribute);
    if (!field) continue; // no longer on its type
    setFieldText(doc, key, v.ref ? [[{ mention: { uri: v.ref, label: v.label } }]] : [v.text], { field, typeOf: (uri) => (uri === v.ref ? v.entityType : undefined) });
  }
}

// a new document of yours, created as main/documents.js createDocument creates one, answered once Tana has it
// Tana slow to answer is not a failure: the document is made here at once and its writes wait in the queue, so it is
// carried on with (as ask does) rather than refused, which would have Quick Add offer to make it a second time
// given: an id the app chose (Android's Quick Add, sending again what Android ended the app on, Engine.kt takeFlights),
// made only when Tana has no document of that id (sdk/sync.js ifMissing): seeded false when it had one, so the same add
// sent twice is one task
async function create(title, config, given) {
  const id = given || 'tana:text:' + ulid();
  let seeded = false;
  const init = (loro) => { seeded = true; initDocument(loro, title, S.me.userUri, config); };
  // given up on before Tana answered: carried on with only once seeded here, never taken for one Tana had
  const doc = await hold(id, init, given ? { ifMissing: true } : undefined).catch((e) => (seeded && S.client.sync.getDocument(id)) || Promise.reject(e));
  return { id, doc, seeded };
}

// What is kept live on this client (live.js): the pages opened and the Timeline, told to the app as they change
let live = null;
const post = (message) => window.webkit?.messageHandlers?.orbital?.postMessage(message);

// no session, or another one: the old client's stream is closed rather than left reconnecting
function drop() {
  if (S.client) S.client.close().catch(() => {});
  S.client = S.me = live = null;
  settings.reset(); forget(); names.clear(); held.forget(); taskTypeList = null; workflow.clear(); // what the last account's session knew
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

const LANGS = ['English', 'Dutch', 'German', 'French', 'Spanish']; // renderer/translate.js TRANSLATE_LANGS

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
      S.client = createTanaClient({ getAccessToken, orgId: S.me.orgId, peerId: derivePeerId(user), storageId: storageId(), clientName: process.env.ORBITAL_CLIENT }); // build.js
      // every list as the desktop's (listed.js): your hidden titles and Hide MCP applied, as main/views.js listFilter does
      listFilter(S.client.graph, settings);
      // what another device writes to the settings document (a mark made sensitive on the Mac) read in as it arrives, as
      // main/documents.js does, and the app told to read again (S.win below), so nothing stays unblurred until a pull
      S.client.sync.on('change', (id) => {
        if (id === settings.settingsDocId()) Promise.resolve(settings.applyRemote(id)).then(() => S.win.webContents.send('outline:changed'));
      });
      // the stream made again (back from the background, the network back): what was read while it was down may have come
      // back short, Today's Tasks empty among it, so the app reads the Timeline again on the new one
      let streams = 0;
      S.client.sync.on('connected', () => { if (streams++) S.win.webContents.send('outline:changed'); });
      live = createLive({ sync: S.client.sync, me: S.me.userUri, post, moved: () => S.win.webContents.send('outline:changed') });
      S.client.sync.connect().catch((e) => issues.push('sync: ' + (e && e.message || e)));
    }
    return true;
  },
  // the app in front again (Engine.swift and Engine.kt foreground): a stream that died while the phone held the page
  // paused is made again before anything is read on it (sdk/sync.js resume)
  resume: () => (S.client ? S.client.sync.resume() : false),
  // the Timeline page, three days per page, as the rows the desktop renderer gets, with the words for their times
  // (labels.js); its first part (Today's Tasks and Upcoming meetings) told to the app ahead of the rest, as 'part:' and
  // the rows (read.js, Engine.swift show(part:)): a string, as both phones' bridges carry it
  demo: (on) => demoOn(on), // Settings' Demo mode, told before every call (Engine.swift and Engine.kt call)
  async timeline(pages = 1) {
    timeline.setPages(pages);
    const part = (rows) => post('part:' + JSON.stringify(times(rows)));
    const rows = await read({ rows: timeline.rows, settled, follows: () => JSON.stringify(settings.get('notify') || {}), redact, part });
    live?.timeline(rows); // what it lists, followed until the next read
    return JSON.stringify(times(rows));
  },
  // Long press, Assign to …: the workspace's people to pick from, and the task given to the one picked ([] unassigns), as the
  // desktop's Assign to … sets it outright (main/documents.js doc:setAssignees)
  members: async () => JSON.stringify((await members()).map((m) => ({ id: m.id, name: m.title }))),
  // A task's box, Assign to …, and a zoomed node's Assigned to and Visible to (tasks.js)
  ...createTasks({ hold, access, members }),
  why: () => answer, // what Tana last said about the session, for the app's sign-in log
  email: () => (last && last.user && last.user.email) || null,
  account: () => (S.me ? S.me.userUri + '@' + S.me.orgId : null), // who in which workspace, as the settings mirror keys it (stand-ins.js ns): what the app keeps its saved Timeline for
  // Zooming into a node: what it holds, as the desktop's page for it shows. A chat is its conversation (sdk/chat.js,
  // docs/CHATS.md), a saved search its results, a meeting its attendees, your notes and its summary, anything else its
  // outline (sdk/content.js).
  async open(id) {
    await settled();
    const kind = id.split(':')[1];
    const doc = await hold(id), n = readNode(doc);
    let rows = [], summary, notes, attendees;
    if (kind === 'chat') {
      const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title])), messages = doc.data.get('messages');
      rows = chatRows(messages ? messages.toJSON() : [], { authorName: (uri) => names.get(uri), me: S.me.userUri, streamingId: doc.data.get('streamingMessageId') });
    } else if (kind === 'search') rows = await searchRows(doc);
    else if (kind === 'event') ({ summary, notes, attendees } = await meeting(id, doc));
    else rows = named(readOutline(doc));
    // heard from now on (live.js): its own document, and for a saved search or a meeting the list its rows come from,
    // the search as it is saved now (a Save while it is open listens with the new query). A meeting's notes and write-up
    // only: its call, transcript and suggestion log are rewritten every second while the call runs (live 2026-10-04).
    // ponytail: a chat or call newly owned by the meeting shows at the next read; add their kinds if that is missed
    live?.page(id, kind === 'search' ? () => { const { query } = readSearch(doc); return query && Object.keys(query).length ? liveTrigger(searchQueryParams(query, S.me.userUri)) : null; }
      : kind === 'event' ? () => ({ types: ['text'], ownerUris: [id], orderBy: ['-updatedAt'], limit: 100 }) : undefined);
    const outline = async (list) => (list ? redact(await titled(list)) : undefined); // undefined: left out of the JSON
    return JSON.stringify({ title: demoTitle(n.title || 'Untitled', id), kind, rows: redact(await titled(rows)), summary: await outline(summary), notes: await outline(notes), attendees, sensitive: secret().has(id) });
  },
  // An outline's image (Row.image), fetched by the app itself as main/images.js does (sdk/assets.js fetchImage): the
  // redirect and the CDN's cookie it needs are out of a page's reach. refresh: Tana refused the last one.
  token: async (refresh) => JSON.stringify(await getAccessToken({ refresh: !!refresh })),
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
  // Every saved search of tasks you can see (listsTasks), the ones pinned to your sidebar first in their order there, each with its icon (glyph)
  // the ones pinned to your sidebar first, in its order (sections included), then the rest, newest first
  async searches() {
    const [tree, { nodes = [] }] = await Promise.all([within('sidebar pins', sidebarTree(S.client.sync, S.me.userUri)).catch(() => []), S.client.graph.listNodes({ nodeTypes: ['search'], limit: 1000, sortOptions: newest })]);
    await settled(); // the icons and what is sensitive
    const chosen = settings.get('typeIcons') || {}, byId = new Map(nodes.map((n) => [n.id, n])), order = [];
    const take = (entries) => { for (const e of entries) { if (e.uri && byId.has(e.uri) && !order.includes(byId.get(e.uri))) order.push(byId.get(e.uri)); take(e.children || []); } };
    take(tree);
    take(nodes.map((n) => ({ uri: n.id })));
    const tasks = await Promise.all(order.map((n) => listsTasks(n.id)));
    order.splice(0, order.length, ...order.filter((_, i) => tasks[i]));
    return JSON.stringify(await Promise.all(order.map(async (n) => ({ ...listRow(n), glyph: await iconPng(chosen[n.id]).catch(() => null) }))));
  },
  // Siri and Shortcuts' List Tasks and their task lookup (Intents.swift, Engine.swift keepTasks): the tasks assigned to
  // you in every state, the last changed first, marked sensitive and masked in demo mode as every list here is
  async tasks() {
    await settled();
    const { nodes = [] } = await S.client.graph.listNodes({ nodeTypes: ['text'], stateTypes: STATE_TYPES, assignedTo: [S.me.userUri], limit: 300, sortOptions: newest });
    return JSON.stringify(redact(nodes.map(listRow)));
  },
  // Long press, Delete: to Tana's trash, as the desktop deletes (main/documents.js documentAction), where you may
  async remove(id) {
    const doc = await hold(id);
    if (!(await canDelete(doc, S.me.userUri, await access()).catch(() => false))) throw new Error('You cannot delete this');
    const done = await S.client.sync.softDelete(id);
    if (done?.responseUnion?.case !== 'documentActionResponse') throw new Error('Tana did not confirm the delete'); // main/documents.js documentAction
    return JSON.stringify(id);
  },
  // What the app needs besides rows, read at each refresh: Auto-translate as the desktop has it (renderer/translate.js:
  // the language chosen there, a synced preference, and the model and thinking the AI rows use (the desktop's Settings page,
  // main/ai.js chosen); the phone asks ChatGPT itself,
  // Translator.swift), what is sensitive, and what is pinned to today (a long press offers to pin or unpin)
  // Settings' Auto-translate: the same synced preference the desktop's Cmd+K Auto-translate … writes (renderer/translate.js
  // setTranslateTo), off as no value; answered once it is in the settings document
  async translateTo(lang) {
    const to = LANGS.includes(lang) ? lang : null;
    settings.setPref('translateTo', to || undefined);
    await settings.flush();
    return JSON.stringify(to);
  },
  // Settings' Quick and Regular AI: the synced choices the Mac's Settings page writes (main/ai.js setOption), checked against
  // the same remote list there (Settings.swift reads it); here only that it is a model's or effort's name
  async aiChoice(key, value) {
    if (!Object.hasOwn(settings.AI_KEYS, key) || typeof value !== 'string' || !/^[\w.-]{1,64}$/.test(value)) throw new Error('Not an AI choice');
    settings.set(settings.AI_KEYS[key], value);
    await settings.flush();
    return JSON.stringify(true);
  },
  async setup() {
    const to = settings.get('pref:translateTo'), pins = await within('date pins', datePins(S.client.sync, S.me.userUri)).catch(() => ({}));
    refreshSoon(); // the linked agents, asked of the MCP server now and then: what it answers is in the next setup
    return JSON.stringify({ to: LANGS.includes(to) ? to : null, ai: Object.fromEntries(Object.entries(settings.AI_KEYS).map(([k, s]) => [k, settings.get(s)]).filter(([, v]) => typeof v === 'string')),
      sensitive: [...secret()], pinned: Object.keys(pins).filter((id) => pins[id].length), // pinned to any day
      agents: linked(), handed: handed() }); // your Dot and what it has, for the long press
  },
  // What the phone asks ChatGPT with, as the Mac does (main/prompts.js): Auto-translate's instructions and the answer's
  // schema for the language to (null: none), Process image's instructions writing in it, and the names Settings gives
  // the models and the thinking levels asked for. Answers { translate: { instructions, schema } | null,
  // image: { instructions }, models: { id: label }, efforts: { effort: label } }.
  prompts(to, models = [], efforts = []) {
    const lang = LANGS.includes(to) ? to : null, named = (list, label) => Object.fromEntries((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x).map((x) => [x, label(x)]));
    return JSON.stringify({ translate: lang ? { instructions: TRANSLATE_INSTRUCTIONS(lang), schema: TRANSLATE_SCHEMA } : null, image: { instructions: IMAGE_INSTRUCTIONS(lang) },
      models: named(models, modelLabel), efforts: named(efforts, effortLabel) });
  },
  // Long press: Pin to Today, as main/pins.js pins a date (your own pin map); and Mark as sensitive, the synced
  // setting the desktop's mark writes (main/documents.js setSensitive)
  async pin(id, on) {
    // off: every day it is pinned to, so Remove Pin takes it out of Pinned and Today's Tasks wherever it was pinned
    const days = on ? [today()] : (await within('date pins', datePins(S.client.sync, S.me.userUri)))[id] || [];
    for (const day of days) await within('date pins', (on ? pinDate : unpinDate)(S.client.sync, S.me.userUri, id, day));
    return JSON.stringify(on);
  },
  async sensitive(id, on) {
    const ids = secret();
    if (on) ids.add(id); else ids.delete(id);
    settings.set('sensitive', [...ids].sort());
    await settings.flush();
    return JSON.stringify(on);
  },
  // Settings' Sign out, before the app deletes the cookies: a session lookup still under way would set them again (the
  // desktop waits for its lookups the same way, tana-session.js logout), and the client closes
  async signOut() {
    await Promise.allSettled(Object.values(inFlight));
    last = null;
    drop();
  },
  // Quick Add Task: the types to pick from, and a task made with the title and the type chosen (open and yours, as a task
  // from a title always is)
  taskTypes: async () => JSON.stringify(await taskTypes()),
  searchPreset: async (searchId) => JSON.stringify(await presetOf(searchId)),
  // Quick Add's fields: those of the chosen type you can set from a phone (words, a choice, a day, a person, a link), and
  // what a person or link field can take: the workspace's people, or the nodes of the types it links to (any node by
  // its title when it takes any type), as the desktop's field picker lists them (renderer/fields.js linkScope)
  async typeFields(typeUri) {
    if (!/^tana:type:/.test(typeUri || '')) return '[]';
    const kinds = ['text', 'options', 'date', 'member', 'link'];
    return JSON.stringify(definitions(await hold(typeUri)).filter((d) => d && d.key && kinds.includes(d.type || 'text'))
      .map((d) => ({ key: typeUri + '?attribute=' + d.key, title: d.title || d.key, kind: d.type || 'text', options: (d.options || []).map((o) => o && o.label).filter(Boolean) })));
  },
  async fieldChoices(key, q) {
    const { typeUri, attribute } = parseKey(key), def = fieldDefinition(await hold(typeUri), attribute);
    if (!def) return '[]';
    if (def.type === 'member') return JSON.stringify((await members()).map((m) => ({ id: m.id, name: m.title })));
    const types = (def.to || []).map((t) => t.uri).filter(Boolean);
    if (!types.length && !q) return '[]';
    const { nodes = [] } = await S.client.graph.listNodes({ ...(types.length ? { entityTypes: types } : {}), ...(q ? { textQuery: q } : {}), limit: 100, sortOptions: newest });
    return JSON.stringify(nodes.map((n) => ({ id: n.id, name: n.title || 'Untitled' })));
  },
  // searchId: the saved search Quick Add was opened on; its type, when that is the one chosen, comes with its preset
  // values. values: what was set in Quick Add's fields ({ key: { ref, label? } | { text } }), over the preset's;
  // assignee: whom a task is for, yours when none. id: the task's own, chosen by the app so it can send it again
  // (create): when Tana has it already, nothing more is written to it
  async createTask(title, typeUri, searchId, assignee, values, id) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('A task needs a title');
    if (id != null && !/^tana:text:[0-9a-z]{26}$/.test(id)) throw new Error('Not an id for a new task: ' + id);
    const preset = searchId ? await presetOf(searchId) : null, fromSearch = preset && preset.uri === typeUri;
    const type = typeUri ? (fromSearch ? preset : (await taskTypes()).find((t) => t.uri === typeUri)) : null;
    if (typeUri && !type) throw new Error('A task cannot be made with that type here');
    const made = await create(title.trim(), { kind: type && !type.task ? 'doc' : 'task', ...(type ? { entityTypeUri: type.uri, ...(type.ownerUri ? { ownerUri: type.ownerUri } : {}) } : {}) }, id);
    if (!made.seeded) return JSON.stringify(made.id); // sent before, and it landed then
    const doc = made.doc;
    const own = Object.fromEntries(Object.entries(values || {}).filter(([k, v]) => type && k.startsWith(type.uri + '?attribute=') && v && (v.ref || (typeof v.text === 'string' && v.text.trim()))));
    const fields = values ? own : fromSearch ? preset.fields : {}; // Quick Add sends what it shows, the preset's included
    if (Object.keys(fields).length) await presetFields(doc, fields);
    if (assignee && assignee !== S.me.userUri && (!type || type.task)) setAssignees(doc, [assignee], S.me.userUri);
    // answered once Tana has it, not when it is only queued here: the app keeps itself running until then when you leave
    // it right after Add (Engine.swift add), and a page paused with the task still queued could lose it
    await S.client.sync.flushed(made.id);
    return JSON.stringify(made.id);
  },
  // Process image (main.js ai:processImage): what the model read from it (QuickAdd.swift ChatGPT.readImage) made a task
  // or a note, its lines under the title and the image under them, uploaded as the desktop uploads a pasted one
  async fromImage(kind, title, notes, base64, mimeType) {
    // the image uploaded first: one that fails leaves nothing behind, so trying again makes no second note
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const fetch = (url, init) => globalThis.fetch(url, { ...init, credentials: 'omit' }); // the token alone, as with Tana's AI
    const up = await uploadFile(bytes, { filename: 'image', mimeType, getAccessToken, fetch });
    const { id, doc } = await create(String(title).slice(0, 200), { kind: kind === 'task' ? 'task' : 'doc' });
    for (const line of notes || []) insertAfter(doc, null, String(line));
    const uri = 'tana:image:' + ulid();
    // slow to answer, it is carried on with as the note itself is (create): a retry would make a second note
    await hold(uri, (loro) => initImage(loro, { ownerUri: id, cid: up.cid, width: up.width, height: up.height, blurhash: up.blurhash, filename: 'image', mimeType, fileSize: bytes.length }))
      .catch((e) => S.client.sync.getDocument(uri) || Promise.reject(e));
    insertImage(doc, null, uri);
    await Promise.all([S.client.sync.flushed(uri), S.client.sync.flushed(id)]); // once Tana has it, as createTask
    return JSON.stringify(id);
  },
  issues: () => { const e = S.status && S.status.error; if (e) { issues.push(e); S.status.error = null; } return issues.splice(0); }, // main/state.js report's too // what went wrong since last asked (a part of the page that could not be read), for the log
  // Your Dot (agents.js): Settings' Connect your personal agent, and the long press's Assign to <its name> … and Unassign
  ...agents({ hold, settled }),
};
// Demo mode saves nothing, as the desktop's (renderer/state.js DEMO_WRITES): every write refused, whoever asks
for (const name of ['toggle', 'assign', 'share', 'translateTo', 'aiChoice', 'ask', 'send', 'remove', 'pin', 'sensitive', 'createTask', 'fromImage', 'linkCode', 'handTo', 'unhand', 'setDefault', 'unlink']) {
  const write = window.orbital[name];
  window.orbital[name] = (...args) => (isDemo() ? Promise.reject(new Error('Demo mode is on: nothing is saved to Tana')) : write(...args));
}
// What main/timeline.js tells the open pages (main/state.js send): on the phone a window of one page, the app, which reads
// the Timeline again when it changed (a meeting starts recording, a meeting moves); a burst of changes is one read
let told = null;
S.win = { isDestroyed: () => false, webContents: { send(channel) {
  if (channel !== 'outline:changed' || told) return;
  told = setTimeout(() => { told = null; window.webkit?.messageHandlers?.orbital?.postMessage('changed'); }, 500);
} } };
window.webkit?.messageHandlers?.orbital?.postMessage('ready');
