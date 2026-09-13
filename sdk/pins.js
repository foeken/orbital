'use strict';
// Sidebar and personal date pins (docs/PINNING.md): plain Loro mutations on the user's profile, collection and
// pin-map documents, in the same shape as the web client (tree node meta {uri}; pin-map entries[doc].pins of LoroMaps).
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

async function unpinSidebar(sync, userUri, docUri) {
  const col = await collection(sync, userUri);
  col.transact((loro) => {
    const tree = loro.getTree('tree');
    const node = tree.nodes().find((n) => !n.isDeleted() && n.data.get('uri') === docUri);
    if (node) tree.delete(node.id);
  });
}

async function dates(sync, userUri, docUri) {
  const entry = (await pinMap(sync, userUri)).loro.getMap('entries').get(docUri);
  const pins = entry ? entry.toJSON().pins || [] : [];
  return pins.filter((p) => p.type === 'plain').map((p) => p.datetime);
}

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

module.exports = { listSidebar, sidebarTree, pinSidebar, unpinSidebar, dates, pinDate, unpinDate };
