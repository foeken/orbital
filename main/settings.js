'use strict';
// One settings document in Tana, owned by this app, so a choice made on one machine is the same choice on the next.
//
// Why a document of our own rather than a key on the node a setting is about: a type's glyph, a hidden title or a
// view's filter is *our* idea, not Tana's, and Tana's documents are shared — writing a key it does not know into a
// type someone else can see puts our vocabulary in their data for ever. A document the app creates is ours to
// shape, is visible and deletable by the user like any other note, and carries nothing foreign anywhere else.
//
// The settings themselves live in a root container of their own ("settings"), one JSON string per key — the same
// shape the SQLite settings table has always had, which is what makes SQLite a mirror rather than a second design.
// The document's content says what it is, for whoever opens it in Tana.
//
// Reads stay synchronous, because everything that reads a setting is on a hot path (every listed row asks for its
// type's glyph): the cache is filled from SQLite the moment the app opens, so the last known answer is there before
// the network is, and the document replaces it when sync connects. Writes go to all three — cache, SQLite, Tana.
// Offline, the first two still work and the third catches up on the next connect.
const db = require('../db');
const content = require('../sdk/content');
const { initDocument, ulid } = require('../sdk/node');
const { S, report, send } = require('./state');

const TITLE = 'Orbital'; // how a machine that has never seen the document finds it
const OLD_TITLE = 'Tana Companion'; // what it was called before the rename: a workspace whose node was never renamed by hand is still found, rather than given a second document
const POINTER = 'settingsDoc'; // local, never synced: this machine's note of which document that is
const ROOT = 'settings'; // the root container the keys live in

// What follows you between machines, and what cannot. A window's size belongs to the screen it was sized on; the
// agent's task ids belong to the machine that ran them; where you happened to be belongs to the machine you were at.
// Everything else is a choice about your own content, which is the same choice wherever you open the app.
// openaiApiKey is deliberately absent: it must remain on this machine, never in Tana.
// aiModel/aiEffort are the FAST model (Discuss with, an automation's ai nodes) and aiSmartModel/aiSmartEffort the
// SMART one (writing automations), main/ai.js: a choice about your own content, so it follows you, while the key
// that pays for it stays put. None has UI yet; unset means the defaults in main/ai.js.
const SYNCED = [/^viewFilter:/, /^hiddenTitles$/, /^hideMcp$/, /^typeIcons$/, /^typeHues$/, /^notify$/, /^codex$/, /^codexPrompt$/, /^codexHosts$/, /^codexTask$/, /^sensitive$/, /^aiModel$/, /^aiEffort$/, /^aiSmartModel$/, /^aiSmartEffort$/, /^automations$/, /^automationFired$/, /^pref:/];
const isSynced = (key) => SYNCED.some((rule) => rule.test(key));

let cache = null; // key -> value, the answer every read gets
let pending = Promise.resolve(); // writes in order, so two changes to one key cannot land the other way round
let cacheGen = -1; // which database the cache was filled from (db.generation): a new one is a new set of answers
let docId = null; // the settings document, once it is known

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

// Find it, or make it. The pointer is local so this costs one lookup per machine; without one (a new machine, or a
// cleared cache) the document is found by its title among your own documents, oldest first — two machines that
// created one at the same moment therefore settle on the same one rather than drifting apart.
let opening = null;
function settingsDoc() {
  if (!S.client) return Promise.resolve(null);
  return (opening ||= open().finally(() => { opening = null; }));
}
async function open() {
  const known = db.setting(POINTER);
  if (typeof known === 'string' && known) {
    const doc = await S.client.sync.subscribe(known).catch(() => null);
    if (doc) { docId = known; describe(doc); return doc; }
  }
  const found = await discover();
  if (found) { docId = found.id; db.setSetting(POINTER, found.id); describe(found); return found; }
  return create();
}
async function discover() {
  try {
    // The current name first, so a workspace carrying both settles on the one this app writes.
    for (const title of [TITLE, OLD_TITLE]) {
      const { nodes } = await S.client.graph.listNodes({ nodeTypes: ['text'], textQuery: title, createdBy: [S.me.userUri], limit: 20 });
      const mine = nodes.filter((n) => (n.title || '').trim().toLowerCase() === title.toLowerCase())
        .sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
      for (const node of mine) {
        const doc = await S.client.sync.subscribe(node.id).catch(() => null);
        if (doc) return doc;
      }
    }
  } catch (e) { report(e); }
  return null;
}
async function create() {
  const id = 'tana:text:' + ulid();
  const doc = await S.client.sync.subscribe(id, (loro) => {
    initDocument(loro, TITLE, S.me.userUri);
    loro.getMap(ROOT); // the container exists from birth, so a second machine can tell this document from a note
  }).catch((e) => { report(e); return null; });
  if (!doc) return null;
  docId = id;
  db.setSetting(POINTER, id);
  describe(doc);
  return doc;
}
// One line of content, so the document explains itself to whoever opens it in Tana rather than sitting there as an
// empty note with a curious name. Written only into an empty first line: anything you write there is yours.
const EXPLAINER = 'Settings for the Orbital app — hidden titles, view filters, type icons and the rest — kept here so they follow you between machines. The app manages this document; deleting it puts those choices back to their defaults.';
function describe(doc) {
  try {
    const [first] = content.readOutline(doc);
    if (!first || (first.segments || []).some((s) => (s.text || '').trim())) return;
    content.setText(doc, first.id, EXPLAINER);
  } catch { /* the line is cosmetic: a document that will not take it still keeps the settings */ }
}

// Sync connected: the document decides. A key it has replaces what this machine remembered; a key only this machine
// has is pushed up, which is what makes the first run a migration and needs no separate step.
async function hydrate() {
  const doc = await settingsDoc();
  if (!doc) return false;
  load();
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
  if (missing.length) doc.transact((loro) => { const map = loro.getMap(ROOT); for (const key of missing) map.set(key, encode(cache[key])); });
  return changed.length > 0;
}
// A change to the document, wherever it came from: the other machine's, or our own write coming back.
function applyRemote(id) {
  if (!docId || id !== docId) return false;
  return hydrate().then((changed) => { if (changed) send('settings:changed', prefs()); return changed; }).catch((e) => { report(e); return false; });
}

const synced = () => Object.fromEntries(Object.entries(load()).filter(([key]) => isSynced(key)));
// The renderer's half of the same store: everything under `pref:`, with the prefix off, as one object it can read
// at load (preload reads it synchronously) and write through key by key.
const PREF = 'pref:';
const prefs = () => Object.fromEntries(Object.entries(load()).filter(([key]) => key.startsWith(PREF)).map(([key, value]) => [key.slice(PREF.length), value]));
const setPref = (key, value) => { if (typeof key !== 'string' || !key || key.includes(':')) throw new Error('Not a preference name'); return set(PREF + key, value); };
const settingsDocId = () => docId;
const reset = () => { cache = null; docId = null; opening = null; }; // tests, and a second login

module.exports = { get, set, prefs, setPref, flush, hydrate, applyRemote, synced, settingsDocId, isSynced, reset, TITLE, ROOT, POINTER, PREF };
