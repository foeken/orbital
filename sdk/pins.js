'use strict';
// Sidebar and personal date pins (docs/PINNING.md): plain Loro mutations on the user's profile, collection and
// pin-map documents, in the same shape as the web client (tree node meta {uri}; pin-map entries[doc].pins of LoroMaps).
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
const parseSidebarTree = (nodes) => nodes.map((n) => {
  const meta = n.meta || {};
  return {
    ...(typeof meta.uri === 'string' ? { uri: meta.uri } : {}),
    ...(typeof meta.label === 'string' ? { label: meta.label } : {}),
    children: parseSidebarTree(n.children || []),
  };
});
const walk = (nodes) => nodes.flatMap((n) => [...(n.uri ? [n.uri] : []), ...walk(n.children)]);
const plain = (date) => (p) => p.type === 'plain' && p.datetime === date;
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

async function dates(sync, userUri, docUri) {
  const entry = (await pinMap(sync, userUri)).loro.getMap('entries').get(docUri);
  const pins = entry ? entry.toJSON().pins || [] : [];
  return pins.filter((p) => p.type === 'plain').map((p) => p.datetime);
}

// Every document with at least one personal date pin, and its dates: { uri: ['YYYY-MM-DD'] }. An entry survives its
// last unpin as an empty pins list, so what counts is a pin still being in it, not the key being there.
async function datePins(sync, userUri) {
  const entries = (await pinMap(sync, userUri)).loro.getMap('entries').toJSON();
  const out = {};
  for (const [uri, entry] of Object.entries(entries)) {
    const dates = ((entry || {}).pins || []).filter((p) => p.type === 'plain').map((p) => p.datetime);
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

module.exports = { listSidebar, sidebarTree, pinSidebar, unpinSidebar, dates, datePins, datePinned, pinDate, unpinDate, items, pinItem, unpinItem };
