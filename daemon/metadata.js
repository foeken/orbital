'use strict';
// A node's Orbital metadata (docs/DAEMON.md): the `ext:orbital` root container, the one Orbital's settings document
// keeps its keys in (main/settings.js ROOT), one JSON string per key. The daemon's two tools read and write that root
// and nothing else: never `data`, `content`, `appearance` or any other root, and never the settings document itself,
// whose `ext:orbital` holds your settings, the relay key among them (docs/MCP-SERVER.md).
//
// Anything here is readable by whoever can open the node (it travels with the document over sync), so it is a place for
// an agent's labels, never for secrets. Tana's own client keeps a root it does not know as it is.
const { DOC_URI } = require('../sdk/ids');

const ROOT = 'ext:orbital'; // main/settings.js ROOT; scripts/daemon-check.js holds the two together
// What marks the settings document (main/settings.js MARK, OLD_DOCS, OLD_ROOT) and the titles it is found by (TITLE, OLD_TITLE)
const SETTINGS_ROOTS = ['ext:orbital:doc', 'ext:orbital:old', 'settings'];
const SETTINGS_TITLES = ['orbital', 'tana companion'];
const SETTINGS_KEYS = ['relayKey']; // a key only the settings document has: an older one carries no mark
// Documents a person makes and works on. Not the system kinds (user-profile, org, pin-map, collection, liveQuery,
// presence, user-inbox): those are Tana's bookkeeping.
const KINDS = new Set(['text', 'event', 'space', 'type', 'workflow', 'chat', 'canvas', 'agent', 'skill', 'artifact', 'search', 'call', 'transcript', 'image', 'asset', 'contact']);
const LIMITS = { keys: 200, value: 8 * 1024, total: 64 * 1024 };
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const refuse = (message) => Object.assign(new Error(message), { refused: true });
const kindOf = (uri) => (typeof uri === 'string' && DOC_URI.test(uri) ? uri.slice(5, -27) : null);
function checkUri(uri) {
  const kind = kindOf(uri);
  if (!kind) throw refuse('node: a Tana id, tana:<kind>:<26 characters>');
  if (!KINDS.has(kind)) throw refuse('Metadata is kept on documents only, not on a ' + kind);
}
const rootOf = (doc, name) => doc.loro.getMap(name).toJSON() || {};
// The settings document, however it was made: its mark, a root only it has, a key only it holds, or the title it is found by
function isSettings(doc) {
  if (SETTINGS_ROOTS.some((name) => Object.keys(rootOf(doc, name)).length)) return true;
  if (SETTINGS_KEYS.some((key) => Object.hasOwn(rootOf(doc, ROOT), key))) return true;
  const title = doc.loro.getMap('data').get('title');
  return SETTINGS_TITLES.includes(String(title || '').trim().toLowerCase());
}
function checkDoc(doc) {
  if (isSettings(doc)) throw refuse('That is the Orbital settings document: its metadata is not readable or writable here');
}
const decode = (text) => { try { return JSON.parse(text); } catch { return text; } };

// { key: value } for the keys asked (all when none are), a key the node does not have left out
function read(doc, keys) {
  checkDoc(doc);
  const all = rootOf(doc, ROOT), out = {};
  for (const key of keys && keys.length ? keys : Object.keys(all)) if (Object.hasOwn(all, key)) out[key] = decode(all[key]);
  return out;
}

// set: { key: any JSON value }, del: [key]. All or nothing: the whole change is checked before anything is written.
function plan(doc, set = {}, del = []) {
  checkDoc(doc);
  if (!set || typeof set !== 'object' || Array.isArray(set)) throw refuse('set: an object of key to value');
  if (!Array.isArray(del)) throw refuse('delete: a list of keys');
  const next = { ...rootOf(doc, ROOT) }, writes = {};
  for (const [key, value] of Object.entries(set)) {
    if (!KEY.test(key)) throw refuse('Key ' + JSON.stringify(key.slice(0, 70)) + ': a letter, then up to 63 letters, digits, _ . or -');
    if (SETTINGS_KEYS.includes(key)) throw refuse('Key ' + key + ' is reserved');
    if (value === undefined || value === null) throw refuse('Value of ' + key + ': use delete to take a key out');
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > LIMITS.value) throw refuse('Value of ' + key + ' is over ' + LIMITS.value / 1024 + ' KB');
    writes[key] = next[key] = text;
  }
  for (const key of del) { if (typeof key !== 'string') throw refuse('delete: keys are strings'); delete next[key]; }
  if (Object.keys(next).length > LIMITS.keys) throw refuse('A node keeps at most ' + LIMITS.keys + ' keys');
  if (Buffer.byteLength(JSON.stringify(next)) > LIMITS.total) throw refuse('A node keeps at most ' + LIMITS.total / 1024 + ' KB of metadata');
  return { writes, deletes: del.filter((key) => Object.hasOwn(rootOf(doc, ROOT), key)) };
}
function write(doc, set, del) {
  const { writes, deletes } = plan(doc, set, del);
  const before = rootOf(doc, ROOT), changed = Object.entries(writes).filter(([key, text]) => before[key] !== text);
  if (changed.length || deletes.length) {
    doc.transact((loro) => {
      const map = loro.getMap(ROOT);
      for (const [key, text] of changed) map.set(key, text);
      for (const key of deletes) map.delete(key);
    });
  }
  return { changed: changed.length + deletes.length };
}

module.exports = { ROOT, KINDS, LIMITS, checkUri, isSettings, read, write, refuse };
