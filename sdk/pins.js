'use strict';
// Sidebar and date pins (docs/PINNING.md): plain Loro mutations on the user's profile, collection and pin-map
// documents, in the same shape as the web client (tree node meta {uri}; pin-map entries[doc].pins/mutedPins of
// LoroMaps), and a document's own data.sharedPinDates for the pins everyone with access sees.
// Items pinned *on an event or a space* are a different thing entirely: they live in that document's own
// pinnedItems list (docs/PINNING.md section 4) and are what the graph reports as EDGE_TYPE_HAS_PIN.
const { LoroMap, LoroList } = require('loro-crdt');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The document the profile points to; no lazy creation (the web client creates these on first pin).
async function pointed(sync, userUri, key) {
  const profile = await sync.subscribe(userUri);
  const uri = profile.data.get(key);
  if (!uri) throw new Error(userUri + ' has no ' + key + ' yet: pin something in Tana first');
  return sync.subscribe(uri);
}
const collection = (sync, userUri) => pointed(sync, userUri, 'pinnedCollectionUri');
const pinMap = (sync, userUri) => pointed(sync, userUri, 'pinMapUri');

// Keep the collection's tree shape: labels are folders/sections and URI nodes are pins. Schema permits either or both.
// id is the Loro tree node id, what the section writes below take.
const parseSidebarTree = (nodes) => nodes.map((n) => {
  const meta = n.meta || {};
  return {
    id: n.id,
    ...(typeof meta.uri === 'string' ? { uri: meta.uri } : {}),
    ...(typeof meta.label === 'string' ? { label: meta.label } : {}),
    children: parseSidebarTree(n.children || []),
  };
});
const walk = (nodes) => nodes.flatMap((n) => [...(n.uri ? [n.uri] : []), ...walk(n.children)]);
const find = (nodes, hit) => { for (const n of nodes) { if (hit(n)) return n; const deeper = find(n.children, hit); if (deeper) return deeper; } };
const plain = (date) => (p) => p.type === 'plain' && p.datetime === date;
const plainDates = (list) => (list || []).filter((p) => p && p.type === 'plain').map((p) => p.datetime);
function checkDate(date) {
  if (!DATE.test(date) || Number.isNaN(Date.parse(date))) throw new Error('date must be YYYY-MM-DD: ' + date);
}

async function listSidebar(sync, userUri) {
  return walk(await sidebarTree(sync, userUri));
}

async function sidebarTree(sync, userUri) {
  return parseSidebarTree((await collection(sync, userUri)).loro.getTree('tree').toJSON());
}

async function pinSidebar(sync, userUri, docUri) {
  const col = await collection(sync, userUri);
  if (walk(parseSidebarTree(col.loro.getTree('tree').toJSON())).includes(docUri)) return;
  col.transact((loro) => { loro.getTree('tree').createNode().data.set('uri', docUri); });
}

// Every copy goes, as the web client's pinItem tool does (QSe collects all node ids with the uri): a pin that was added
// twice would otherwise still be pinned after its unpin.
async function unpinSidebar(sync, userUri, docUri) {
  const col = await collection(sync, userUri);
  col.transact((loro) => {
    const tree = loro.getTree('tree');
    for (const node of tree.nodes()) if (!node.isDeleted() && node.data.get('uri') === docUri) tree.delete(node.id);
  });
}

// Sidebar sections (#29), as Tana writes them (J_ and the collection wrapper in the bundle of 2026-09-23): a section is
// a node with a label and no uri, and its pins are its children. index is a position among the siblings after the move,
// undefined meaning the end, and a position past the end is the end, as Tana's splice has it.
async function sidebar(sync, userUri) {
  const col = await collection(sync, userUri);
  return { col, nodes: parseSidebarTree(col.loro.getTree('tree').toJSON()) };
}
function sectionOf(nodes, id) {
  const section = find(nodes, (n) => n.id === id);
  if (!section || section.uri) throw new Error('not a sidebar section: ' + id);
  return section;
}
function position(index, count) {
  if (index === undefined) return undefined;
  if (!Number.isInteger(index) || index < 0) throw new Error('index must be a whole number from 0: ' + index);
  return Math.min(index, count);
}

// Tana's placePin: a document already in the sidebar moves (its first copy, depth first, as Tana's Xh finds it) and
// anything else is added; section null is the top level. Returns the pin's node id.
async function placePin(sync, userUri, docUri, { section: sectionId = null, index } = {}) {
  const { col, nodes } = await sidebar(sync, userUri);
  const section = sectionId == null ? null : sectionOf(nodes, sectionId);
  const pin = find(nodes, (n) => n.uri === docUri), parent = section ? section.id : undefined;
  const at = position(index, (section ? section.children : nodes).filter((n) => !pin || n.id !== pin.id).length);
  let id;
  col.transact((loro) => {
    const tree = loro.getTree('tree');
    if (pin) { tree.move(pin.id, parent, at); id = pin.id; return; }
    const node = tree.createNode(parent, at);
    node.data.set('uri', docUri);
    id = node.id;
  });
  return id;
}

// A new top-level section, Tana's addSection (addFolder with no parent). Returns its node id.
async function addSection(sync, userUri, label, { index } = {}) {
  if (typeof label !== 'string') throw new Error('a section needs a label');
  const { col, nodes } = await sidebar(sync, userUri);
  const at = position(index, nodes.length);
  let id;
  col.transact((loro) => { const node = loro.getTree('tree').createNode(undefined, at); node.data.set('label', label); id = node.id; });
  return id;
}

async function renameSection(sync, userUri, sectionId, label) {
  if (typeof label !== 'string') throw new Error('a section needs a label');
  const { col, nodes } = await sidebar(sync, userUri);
  sectionOf(nodes, sectionId);
  col.transact((loro) => loro.getTree('tree').getNodeByID(sectionId).data.set('label', label));
}

// Tana's "Remove section": the section goes and every pin in it goes with it.
async function removeSection(sync, userUri, sectionId) {
  const { col, nodes } = await sidebar(sync, userUri);
  sectionOf(nodes, sectionId);
  col.transact((loro) => loro.getTree('tree').delete(sectionId));
}

// The days one document is pinned to for this user, as Tana's getEffectivePins answers it: the shared dates on the
// document plus the personal ones in the pin-map, minus the ones this user muted, sorted. A document this user cannot
// read contributes no shared dates.
async function dates(sync, userUri, docUri) {
  const [pm, shared] = await Promise.all([
    pinMap(sync, userUri),
    sync.subscribe(docUri).then(sharedDates, () => []),
  ]);
  const entry = pm.loro.getMap('entries').get(docUri), json = entry ? entry.toJSON() : {};
  const muted = new Set(plainDates(json.mutedPins));
  return [...new Set([...shared, ...plainDates(json.pins)])].filter((d) => !muted.has(d)).sort();
}

// Every document with at least one personal date pin that is not muted, and its dates: { uri: ['YYYY-MM-DD'] }. This is
// Tana's Today list (getEntitiesWithPinsInRange): shared dates are not in it, because nothing lists documents by their
// sharedPinDates. An entry survives its last unpin as an empty pins list, so what counts is a pin still being in it.
async function datePins(sync, userUri) {
  const entries = (await pinMap(sync, userUri)).loro.getMap('entries').toJSON();
  const out = {};
  for (const [uri, entry] of Object.entries(entries)) {
    const muted = new Set(plainDates((entry || {}).mutedPins));
    const dates = plainDates((entry || {}).pins).filter((d) => !muted.has(d));
    if (dates.length) out[uri] = dates;
  }
  return out;
}
const datePinned = async (sync, userUri) => Object.keys(await datePins(sync, userUri));

async function pinDate(sync, userUri, docUri, date) {
  checkDate(date);
  const pm = await pinMap(sync, userUri);
  pm.transact((loro) => {
    const entries = loro.getMap('entries');
    const entry = entries.get(docUri) || entries.setContainer(docUri, new LoroMap());
    const pins = entry.get('pins') || entry.setContainer('pins', new LoroList());
    const muted = entry.get('mutedPins') || entry.setContainer('mutedPins', new LoroList());
    if (!pins.toJSON().some(plain(date))) {
      const pin = pins.pushContainer(new LoroMap());
      pin.set('type', 'plain'); pin.set('datetime', date); pin.set('pinnedAt', Date.now());
    }
    const mi = muted.toJSON().findIndex(plain(date));
    if (mi >= 0) muted.delete(mi, 1);
  });
}

async function unpinDate(sync, userUri, docUri, date) {
  checkDate(date);
  const pm = await pinMap(sync, userUri);
  pm.transact((loro) => {
    const entry = loro.getMap('entries').get(docUri), pins = entry && entry.get('pins');
    const i = pins ? pins.toJSON().findIndex(plain(date)) : -1;
    if (i >= 0) pins.delete(i, 1);
  });
}

// Mute = hide a date on this user's Today without touching the pin itself, which is how a shared pin goes away for one
// person (web client mutePin/unmutePin on entries[doc].mutedPins). pinDate unmutes on its own.
async function muteDate(sync, userUri, docUri, date) {
  checkDate(date);
  const pm = await pinMap(sync, userUri);
  pm.transact((loro) => {
    const entries = loro.getMap('entries');
    const entry = entries.get(docUri) || entries.setContainer(docUri, new LoroMap());
    if (!entry.get('pins')) entry.setContainer('pins', new LoroList());
    const muted = entry.get('mutedPins') || entry.setContainer('mutedPins', new LoroList());
    if (muted.toJSON().some(plain(date))) return;
    const pin = muted.pushContainer(new LoroMap());
    pin.set('type', 'plain'); pin.set('datetime', date); pin.set('pinnedAt', Date.now());
  });
}

async function unmuteDate(sync, userUri, docUri, date) {
  checkDate(date);
  const pm = await pinMap(sync, userUri);
  pm.transact((loro) => {
    const entry = loro.getMap('entries').get(docUri), muted = entry && entry.get('mutedPins');
    const i = muted ? muted.toJSON().findIndex(plain(date)) : -1;
    if (i >= 0) muted.delete(i, 1);
  });
}

// ---- shared date pins: the document's own data.sharedPinDates, seen by everyone who can see the document ----
// Synchronous on the document, like pinItem: the caller subscribes it and checks write access (web addPinDate/removePinDate).
const sharedDates = (doc) => plainDates(doc.loro.getMap('data').toJSON().sharedPinDates);

function pinSharedDate(doc, date) {
  checkDate(date);
  doc.transact((loro) => {
    const data = loro.getMap('data');
    const list = data.get('sharedPinDates') || data.setContainer('sharedPinDates', new LoroList());
    if (list.toJSON().some(plain(date))) return;
    const pin = list.pushContainer(new LoroMap());
    pin.set('type', 'plain'); pin.set('datetime', date); pin.set('pinnedAt', Date.now());
  });
}

function unpinSharedDate(doc, date) {
  checkDate(date);
  doc.transact((loro) => {
    const list = loro.getMap('data').get('sharedPinDates');
    const i = list ? list.toJSON().findIndex(plain(date)) : -1;
    if (i >= 0) list.delete(i, 1);
  });
}

// ---- items pinned on an event or a space (root MovableList 'pinnedItems' of { uri, mode? }) ----
// Verified live: tana:event:01exampled0000000000000000 holds [{ mode: 'embed', uri: 'tana:chat:...' }] and the graph
// answers ListEdges(HAS_PIN) from it. The element is a map container, like every other schema'd element the web
// client writes (the pin-map entries above); toJSON reads the same either way.
// A duplicate uri reads as its first occurrence (native Tue); pinning a pinned uri with a mode updates the mode and keeps
// its place (native jm); unpinning drops every copy (native Mm filters on uri).
const items = (doc) => {
  const seen = new Set();
  return doc.loro.getMovableList('pinnedItems').toJSON().filter((p) => p && typeof p.uri === 'string' && !seen.has(p.uri) && seen.add(p.uri));
};

function pinItem(doc, uri, mode) {
  doc.transact((loro) => {
    const list = loro.getMovableList('pinnedItems');
    const i = list.toJSON().findIndex((p) => p && p.uri === uri);
    if (i >= 0) {
      const el = list.get(i);
      if (mode) el instanceof LoroMap ? el.set('mode', mode) : list.set(i, { ...el, mode });
      return;
    }
    const item = list.pushContainer(new LoroMap());
    item.set('uri', uri);
    if (mode) item.set('mode', mode);
  });
}

function unpinItem(doc, uri) {
  doc.transact((loro) => {
    const list = loro.getMovableList('pinnedItems');
    const all = list.toJSON();
    for (let i = all.length - 1; i >= 0; i--) if (all[i] && all[i].uri === uri) list.delete(i, 1);
  });
}

module.exports = { listSidebar, sidebarTree, pinSidebar, unpinSidebar, placePin, addSection, renameSection, removeSection, dates, datePins, datePinned, pinDate, unpinDate, muteDate, unmuteDate, sharedDates, pinSharedDate, unpinSharedDate, items, pinItem, unpinItem };
