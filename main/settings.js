'use strict';
// One settings document in Tana, owned by this app, so a choice made on one machine is the same choice on the next.
//
// Why a document of our own rather than a key on the node a setting is about: a type's glyph, a hidden title or a
// view's filter is *our* idea, not Tana's, and Tana's documents are shared — writing a key it does not know into a
// type someone else can see puts our vocabulary in their data for ever. A document the app creates is ours to
// shape, is visible and deletable by the user like any other note, and carries nothing foreign anywhere else.
//
// The settings themselves live in a root container of their own ("ext:orbital"), one JSON string per key — the same
// shape the SQLite settings table has always had, which is what makes SQLite a mirror rather than a second design.
// The `ext:` prefix marks the key as an extension's rather than Tana's: Tana may one day give documents a root of
// its own called "settings", and ours must not be the one in the way (Eirik Hoem, 2026-09-23).
// The document's content says what it is, for whoever opens it in Tana.
//
// Reads stay synchronous, because everything that reads a setting is on a hot path (every listed row asks for its
// type's glyph): the cache is filled from SQLite the moment the app opens, so the last known answer is there before
// the network is, and the document replaces it when sync connects. Writes go to all three — cache, SQLite, Tana.
// Offline, the first two still work and the third catches up on the next connect.
const db = require('../db');
const content = require('../sdk/content');
const { deterministicId } = require('../sdk/chat');
const { initDocument, readNode, ulid } = require('../sdk/node');
const { audienceOf } = require('../sdk/access');
const { S, isDeleted, report, send } = require('./state');

const TITLE = 'Orbital'; // how a machine that has never seen the document finds it
const OLD_TITLE = 'Tana Companion'; // what it was called before the rename: a workspace whose node was never renamed by hand is still found, rather than given a second document
const POINTER = 'settingsDoc'; // local, never synced: this machine's note of which document that is
const ROOT = 'ext:orbital'; // the root container the keys live in
const OLD_ROOT = 'settings'; // where they lived before: moved into ROOT on the next hydrate
const OLD_DOCS = 'ext:orbital:old'; // settings documents this one took over from, one key each (open)
const MARK = 'ext:orbital:doc'; // written at creation, so a document that holds no key yet is still known for ours

// What follows you between machines, and what cannot. A window's size belongs to the screen it was sized on; the
// agent's task ids belong to the machine that ran them; where you happened to be belongs to the machine you were at.
// Everything else is a choice about your own content, which is the same choice wherever you open the app.
// openaiApiKey is deliberately absent: it must remain on this machine, never in Tana. ChatGPT auth is in a separate
// local Codex home under userData, not in these settings or in the user's regular Codex home.
// AI_KEYS are the Regular AI (reading images) and the Quick AI (everything else) and how hard each thinks (main/ai.js), set on
// the Mac's and the iPhone's Settings alike (ios/engine/index.js aiChoice): a choice about your own content, so it follows
// you, while the key that pays for it stays put. Unset means the defaults in main/ai.js.
const AI_KEYS = { model: 'aiModel', effort: 'aiEffort', quickModel: 'aiQuickModel', quickEffort: 'aiQuickEffort' };
// myTasks is which saved search the Work View's right half is (main/views.js myTasks), by id so a rename keeps it.
const SYNCED = [/^viewFilter:/, /^hiddenTitles$/, /^hideMcp$/, /^typeIcons$/, /^typeHues$/, /^notify$/, /^codex$/, /^agents$/, /^defaultAgent$/, /^codexPrompt$/, /^codexTask$/, /^agentChats$/, /^sensitive$/, /^ai(Quick)?(Model|Effort)$/, /^myTasks$/, /^relay(Key|KeyNext|Seen)$/, /^pref:/];
const isSynced = (key) => SYNCED.some((rule) => rule.test(key));

let cache = null; // key -> value, the answer every read gets
let pending = Promise.resolve(); // writes in order, so two changes to one key cannot land the other way round
let cacheGen = -1; // which database the cache was filled from (db.generation): a new one is a new set of answers
let docId = null; // the settings document, once it is known
let settled = false; // this session has looked for the oldest settings document once, pointer or not (open)

// SQLite is the mirror the app opens with: every synced key is written to it as well, so a launch with no network
// still knows what you chose, and so a first run on a new machine has something to push up.
function load() {
  if (cache && cacheGen === db.generation()) return cache;
  // A *different* database knows a different document — but the first fill is not a different one, and dropping the
  // pointer there would throw away the document the open that is still running has just found.
  if (cache && cacheGen !== db.generation()) { docId = null; }
  cache = {};
  cacheGen = db.generation();
  Object.assign(cache, db.settings());
  return cache;
}
const get = (key) => load()[key];
// A task's status as the app names it: Tana's own four, and Waiting — your part done, the next step someone else's.
// Tana has no such state, but a task's status may name a workflow of its own (stateWorkflowUri, read before its type's),
// so Waiting is an open task in one workflow of the workspace's: its id is computed from the workspace's, as Tana names
// its own agent (sdk/chat.js deterministicId), and its one state's id is fixed, so every Orbital — each machine, each
// colleague, the phone — puts a task in the same one and reads it back with no lookup (main/documents.js waitingState
// makes it the first time). Tana keeps it, but its web app shows an untyped task as In Progress and offers only its own
// four (checked 2026-10-02); choosing one there clears Waiting. The phone loads this file too (ios/engine), so it is here.
const WAITING_STATE = '6203c1bc-5ed9-4680-b957-2445bdcc9a6b';
const flows = new Map(); // org uri -> its Waiting workflow uri: a hash, asked of every listed row
const waitingWorkflow = (org = S.me && S.me.orgDocUri) => (org ? flows.get(org) || flows.set(org, 'tana:workflow:' + deterministicId('orbital:waiting:' + org)).get(org) : null);
const stateName = (type, workflowUri) => (type === 'open' && !!workflowUri && workflowUri === waitingWorkflow() ? 'waiting' : type);
function set(key, value) {
  load();
  if (value === undefined) delete cache[key]; else cache[key] = value;
  db.setSetting(key, value);
  if (isSynced(key)) pending = pending.then(() => write(key, value)).catch(report);
  return value;
}
const flush = () => pending; // everything written so far has reached the document (or failed loudly)
// Every synced key as the document stores it: JSON per key, so a value is whatever it was, and a map stays one flat
// container rather than a tree of Loro containers to keep in step.
const encode = (value) => JSON.stringify(value === undefined ? null : value);
const decode = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

async function write(key, value) {
  const doc = await settingsDoc();
  if (!doc) return; // not connected, or the document could not be made: SQLite keeps it until the next hydrate
  doc.transact((loro) => {
    const map = loro.getMap(ROOT);
    if (value === undefined) map.delete(key); else map.set(key, encode(value));
  });
}

// Find it, or make it. The pointer is local, so a write costs no lookup; the document is found by its title among your
// own documents, oldest first, on a machine without one and once a session on every other — two machines that each
// made one before either could see the other's would otherwise keep a document each for ever. One deleted in Tana is
// not written to: the oldest still standing is used, or a new one, which hydrate fills from what this machine has.
let opening = null;
function settingsDoc() {
  if (!S.client) return Promise.resolve(null);
  return (opening ||= open().finally(() => { opening = null; }));
}
async function open() {
  const known = db.setting(POINTER);
  if (typeof known === 'string' && known) {
    const had = known !== docId && !!S.client.sync.getDocument(known); // held by something else before this looked: that stays
    const doc = await S.client.sync.subscribe(known).catch(() => null);
    // the copies this one took over hold what was true before: never taken again, and still left out of the lists
    const gaveUp = doc ? Object.keys(doc.loro.getMap(OLD_DOCS).toJSON() || {}) : [];
    if (doc && !isDeleted(readNode(doc))) {
      if (settled) return use(doc);
      settled = true;
      const oldest = await discover(new Set(gaveUp));
      if (!oldest || oldest.id === known) return use(doc);
      // the phone follows the one a Mac kept, so it hears what is written there from now on, and merges nothing itself
      if (S.settingsReadOnly) { if (!had) S.client.sync.unsubscribe(known).catch(() => {}); return use(oldest); }
      // the one this machine used is still an app document, not a note of yours: it stays out of the lists (appDocIds), with
      // those it had taken over itself. One key per document, so two machines giving theirs up at once both keep theirs.
      carry(oldest, [known, ...gaveUp]);
      // and what it holds that the winner does not: another machine may have written it there since this one last looked,
      // which this machine's mirror cannot know. The winner keeps its own value where both have one.
      const held = doc.loro.getMap(ROOT).toJSON() || {};
      oldest.transact((loro) => { const map = loro.getMap(ROOT); for (const [key, text] of Object.entries(held)) if (map.get(key) === undefined) map.set(key, text); });
      if (!had) S.client.sync.unsubscribe(known).catch(() => {}); // given up: no live copy of it, and its changes are not ours to route
      return use(oldest);
    }
    if (doc && !had) S.client.sync.unsubscribe(known).catch(() => {}); // deleted in Tana: nothing to keep live
    if (doc) { // deleted in Tana: the next one standing or a new one, never a copy it took over, and its list goes along
      settled = true;
      const found = await discover(new Set(gaveUp));
      const next = found ? use(found) : await create();
      if (next && !S.settingsReadOnly) carry(next, gaveUp);
      return next;
    }
  }
  settled = true;
  const found = await discover();
  return found ? use(found) : create();
}
const carry = (doc, ids) => { if (ids.length) doc.transact((loro) => { const map = loro.getMap(OLD_DOCS); for (const id of ids) map.set(id, true); }); };
function use(doc) {
  docId = doc.id; db.setSetting(POINTER, doc.id);
  if (S.settingsReadOnly) return doc;
  describe(doc);
  // one an older build made before any key was written carries neither a key nor the mark: without one it is a note to
  // the next machine, which would make a second document
  if (!holdsSettings(doc)) { try { doc.transact((loro) => loro.getMap(MARK).set('app', 'orbital')); } catch (e) { report(e); } }
  return doc;
}
// Whether the last search for the document finished and found none (false when it failed): the phones, which never
// make one, tell "this account never used Orbital on a Mac" from "Tana did not answer" by it (ios/engine/index.js settled)
let noDocument = false;
async function discover(skip = new Set()) {
  noDocument = false;
  try {
    // past hidden titles and Hide MCP: those keep it out of the lists, and must not make a second one
    const listNodes = S.client.graph.listNodesUnhidden || S.client.graph.listNodes;
    // The current name first, so a workspace carrying both settles on the one this app writes.
    for (const title of [TITLE, OLD_TITLE]) {
      // oldest first from the graph, so a crowd of newer notes with the same title cannot push the oldest past the limit.
      // ponytail: textQuery is full text and ListNodes has no title filter or paging, so 1,000 older documents of yours
      // that mention the word could still hide it; the restricted/exactParticipantUris filters would narrow that, once verified live.
      const { nodes } = await listNodes({ nodeTypes: ['text'], textQuery: title, createdBy: [S.me.userUri], limit: 1000,
        sortOptions: [{ field: 'SORT_FIELD_CREATE_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] });
      const mine = nodes.filter((n) => (n.title || '').trim().toLowerCase() === title.toLowerCase())
        .sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
      for (const node of mine) {
        // a public link is on the graph node (main/documents.js linkShared), whatever the document's own roots say
        if (skip.has(node.id) || (node.linkSharing && node.linkSharing.mode)) continue;
        const had = !!S.client.sync.getDocument(node.id); // somebody else's subscription stays, whatever this decides
        const doc = await S.client.sync.subscribe(node.id).catch(() => null);
        if (doc && !isDeleted(readNode(doc)) && holdsSettings(doc) && await onlyMine(doc)) return doc;
        if (doc && !had) S.client.sync.unsubscribe(node.id).catch(() => {}); // not ours: no live copy of it for the session
      }
    }
    noDocument = true;
  } catch (e) { report(e); }
  return null;
}
// A title is not proof: a note of yours called "Orbital" must never be taken over and filled with every synced key.
// Ours carries the mark it was made with, or (made by an older build) at least one key in either root.
const holdsSettings = (doc) => [MARK, ROOT, OLD_ROOT].some((root) => Object.keys(doc.loro.getMap(root).toJSON() || {}).length > 0);
// The title and the mark are anybody's to write who can edit a document, and every synced key (the sensitive marks, the
// agent prompts) would be written into the one taken: only one nobody else can read is taken — only you in its audience
// (sdk/access.js audienceOf) and no public link, which audienceOf leaves to the linkSharing root.
// Only a restricted one is asked about at all: audienceOf answers it from the document itself, where an open one would
// have it load the owner chain and the org, subscriptions nobody lets go of, for an answer that can only be no.
const onlyMine = async (doc) => readNode(doc).restricted === true && !doc.loro.getMap('linkSharing').get('mode')
  && (await audienceOf(readNode(doc), S.me.userUri, { sync: S.client.sync, orgDocUri: S.me.orgDocUri })).scope === 'only-me';
async function create() {
  if (S.settingsReadOnly) return null; // the iPhone app never makes, merges or tidies the document: a Mac does (ios/engine/index.js)
  const id = 'tana:text:' + ulid();
  const doc = await S.client.sync.subscribe(id, (loro) => {
    initDocument(loro, TITLE, S.me.userUri);
    loro.getMap(MARK).set('app', 'orbital'); // an empty root is never stored: this is how a second machine tells it from a note
  }).catch((e) => { report(e); return null; });
  if (!doc) return null;
  return use(doc);
}
// One line of content, so the document explains itself to whoever opens it in Tana rather than sitting there as an
// empty note with a curious name. Written only into an empty first line: anything you write there is yours.
const EXPLAINER = 'Settings for the Orbital app — hidden titles, view filters, type icons and the rest — kept here so they follow you between machines. The app manages this document; if it is deleted, the app writes a new one from what it remembers.';
function describe(doc) {
  try {
    const [first] = content.readOutline(doc);
    if (!first || (first.segments || []).some((s) => (s.text || '').trim())) return;
    content.setText(doc, first.id, EXPLAINER);
  } catch { /* the line is cosmetic: a document that will not take it still keeps the settings */ }
}

// Sync connected: the document decides. A key it has replaces what this machine remembered; a key only this machine
// has is pushed up, which is what makes the first run a migration and needs no separate step. What it changed is sent
// to the open pages: they read their preferences at load, from SQLite, which on a new machine is still empty.
async function hydrate() {
  const doc = await settingsDoc();
  if (!doc) return false;
  load();
  if (!S.settingsReadOnly) migrate(doc);
  const remote = doc.loro.getMap(ROOT).toJSON();
  const changed = [];
  for (const [key, text] of Object.entries(remote || {})) {
    const value = decode(text);
    if (JSON.stringify(cache[key]) === JSON.stringify(value)) continue;
    if (value === undefined || value === null) { delete cache[key]; db.setSetting(key, undefined); }
    else { cache[key] = value; db.setSetting(key, value); }
    changed.push(key);
  }
  const missing = Object.keys(cache).filter((key) => isSynced(key) && !Object.hasOwn(remote || {}, key));
  // read only (the phone): a key only it remembers was most likely taken out on a Mac since, so it goes here too
  if (missing.length && S.settingsReadOnly) for (const key of missing) { delete cache[key]; db.setSetting(key, undefined); changed.push(key); }
  else if (missing.length) doc.transact((loro) => { const map = loro.getMap(ROOT); for (const key of missing) map.set(key, encode(cache[key])); });
  if (changed.length) send('settings:changed', prefs());
  return changed.length > 0;
}
// A document an older build wrote keeps its keys in the old root: move them across once, the new root winning where
// both have a key, and empty the old one so nothing reads it again.
function migrate(doc) {
  const old = doc.loro.getMap(OLD_ROOT).toJSON();
  if (!old || !Object.keys(old).length) return;
  doc.transact((loro) => {
    const map = loro.getMap(ROOT);
    for (const [key, text] of Object.entries(old)) if (map.get(key) === undefined) map.set(key, text);
    loro.getMap(OLD_ROOT).clear();
  });
}
// A change to the document, wherever it came from: the other machine's, or our own write coming back.
// A watch choice and an agent task are each about one document, and a page draws them with that document (the bell,
// the Tracking section, the agent badge), so every document whose entry another machine moved is announced as a
// metadata change of its own, as tellOthers does for this machine's other pages.
const PER_DOCUMENT = ['notify', 'codexTask'];
function applyRemote(id) {
  if (S.me && id === S.me.orgDocUri) { hydrateWorkspace().catch(report); return false; } // the org document goes on to whatever else reads it
  if (!docId || id !== docId) return false;
  const before = PER_DOCUMENT.map((key) => load()[key] || {});
  return hydrate().then((changed) => {
    if (!changed) return changed; // hydrate has sent settings:changed itself
    const moved = new Set();
    PER_DOCUMENT.forEach((key, i) => { const was = before[i], now = load()[key] || {}; for (const doc of Object.keys({ ...was, ...now })) if (JSON.stringify(was[doc]) !== JSON.stringify(now[doc])) moved.add(doc); });
    for (const doc of moved) send('outline:changed', doc, { meta: true });
    return changed;
  }).catch((e) => { report(e); return false; });
}

const synced = () => Object.fromEntries(Object.entries(load()).filter(([key]) => isSynced(key)));

// ---- the workspace's settings: one for everyone in it (issue #814) ----
// The same root on Tana's own workspace document (the org document, S.me.orgDocUri), beside the workspace settings Tana
// keeps there itself (featurePolicy, approvedMcpServers): today only mcpServerUrl, the MCP server everyone in it uses (main/mcp-server.js).
// Every member reads it; this machine mirrors it under WORKSPACE, never synced, since it is not yours.
// ponytail: only Orbital keeps a member from writing it (orgAdmin below), since Tana does not refuse one yet: #815
const WORKSPACE = 'workspace';
const workspaceGet = (key) => (get(WORKSPACE) || {})[key];
async function workspaceDoc() {
  const uri = S.client && S.me && S.me.orgDocUri;
  return uri ? S.client.sync.subscribe(uri).catch(() => null) : null;
}
async function hydrateWorkspace() {
  const doc = await workspaceDoc();
  if (!doc) return;
  const now = Object.fromEntries(Object.entries(doc.loro.getMap(ROOT).toJSON() || {}).map(([key, text]) => [key, decode(text)]));
  if (JSON.stringify(now) === JSON.stringify(get(WORKSPACE) || {})) return;
  load()[WORKSPACE] = now; db.setSetting(WORKSPACE, now);
  send('settings:changed', prefs());
}
// Whether you are an admin of the workspace you are signed into, as the session token says (the claims Tana's own client reads)
async function orgAdmin() {
  const c = JSON.parse(Buffer.from(String(await S.session.getAccessToken()).split('.')[1], 'base64url').toString());
  return c.org_id === S.me.orgId && ['admin', 'owner'].includes(c.role);
}
async function setWorkspace(key, value) {
  if (!await orgAdmin()) throw new Error('Only an admin of the workspace can change this');
  const doc = await workspaceDoc();
  if (!doc) throw new Error('The workspace is not there yet: connect first');
  // and who changed it last, so a member who finds the MCP server out of date knows which admin to ask (renderer/agent.js)
  // (and with the last setting taken out, that goes too: the workspace's settings are empty again)
  doc.transact((loro) => {
    const map = loro.getMap(ROOT);
    if (value === undefined) map.delete(key); else map.set(key, encode(value));
    if (map.keys().some((k) => k !== 'changedBy')) map.set('changedBy', encode({ user: S.me.userUri, at: Date.now() })); else map.delete('changedBy');
  });
  await hydrateWorkspace();
}
// The renderer's half of the same store: everything under `pref:`, with the prefix off, as one object it can read
// at load (preload reads it synchronously) and write through key by key.
const PREF = 'pref:';
const prefs = () => Object.fromEntries(Object.entries(load()).filter(([key]) => key.startsWith(PREF)).map(([key, value]) => [key.slice(PREF.length), value]));
const setPref = (key, value) => { if (typeof key !== 'string' || !key || key.includes(':')) throw new Error('Not a preference name'); return set(PREF + key, value); };
const settingsDocId = () => docId;
const hasNoDocument = () => noDocument;
// Every settings document of yours the lists must leave out: the one in use and those it took over from (open).
const appDocIds = () => {
  const doc = docId && S.client && S.client.sync.getDocument(docId);
  return [docId, ...(doc ? Object.keys(doc.loro.getMap(OLD_DOCS).toJSON() || {}) : [])].filter(Boolean);
};
const reset = () => { cache = null; docId = null; opening = null; settled = false; }; // tests, and a second login
// A setting one page writes reaches every other page and window at once: applyRemote announces only what another
// machine changed, since this machine's own write comes back from Tana as nothing new. The writer is left out, because
// it already holds the value and an older snapshot arriving late would undo a newer choice there. Every handler that
// writes a setting a page keeps a copy of calls this (#228: preferences, sensitive marks, the MCP switch; view
// filters, watch choices and agent marks were left out and a stale page wrote its old filter back). docId: the
// document a choice is about, whose metadata the other pages read again, since that is where its watch state and its
// agent badge are drawn.
function tellOthers(from, docId) { // from: the page handle that wrote it (main/state.js pageOf), or null
  const next = prefs();
  for (const w of S.windows || []) if (!w.isDestroyed()) for (const p of w.panes) if (p !== from && !p.isDestroyed()) {
    p.send('settings:changed', next);
    if (docId) p.send('outline:changed', docId, { meta: true });
  }
  if (S.settings && !S.settings.isDestroyed()) S.settings.webContents.send('settings:changed', next); // the Settings window (main.js openSettings), a write of its own included: it reads again
}

// the preferences now, asked for once the page listens for settings:changed (renderer/app.js; preload's prefs:snapshot is the load-time copy)
const ipc = { 'prefs:now': () => prefs() };

module.exports = { get, set, stateName, waitingWorkflow, WAITING_STATE, prefs, setPref, flush, hydrate, applyRemote, synced, settingsDocId, hasNoDocument, appDocIds, isSynced, reset, AI_KEYS, tellOthers, ipc, TITLE, ROOT, POINTER, PREF,
  workspaceGet, setWorkspace, hydrateWorkspace, orgAdmin };
