'use strict';
const db = require('../db');
const access = require('../sdk/access');
const content = require('../sdk/content');
const chat = require('../sdk/chat');
const { readNode, editable, ulid, initDocument, STATE_TYPES } = require('../sdk/node');
const { DOC_URI, KINDS, NOT_CONNECTED, PLAIN_KINDS, S, TAG, deletedNodes, editability, errText, hueLoaded, idKind, isDeleted, metaSigs, nodeHues, nodeMeta, now, pathCache, redoStack, report, scheduleRefresh, send, subscribed, summaryCache, typeHues, typeTitles, undoStack, visibleGraphNodes } = require('./state');
const { eventMeta, graphRow, hueOf, hueWithType, kindRow, memberRow, members, nodeTag, ownHue, plainRow, rememberNodeHue, rememberType, resolveHue, resolveTypes, toNode, typeTag } = require('./rows');

// Resolve native embeds without replacing the containing block identity or loading target content recursively.
async function outlineWithReferences(doc) {
  return resolveReferences(content.readOutline(doc));
}
// The reference rows of any outline (content embeds, chat attachments and proposals) resolved in one place.
async function resolveReferences(nodes) {
  const refs = [];
  const visit = rows => { for (const n of rows) { if (n.type === 'reference') refs.push(n.reference); visit(n.children || []); } };
  visit(nodes);
  const uris = [...new Set(refs.map(r => r.uri).filter(uri => typeof uri === 'string' && DOC_URI.test(uri)))];
  const targets = new Map();
  for (let i = 0; i < uris.length; i += 200) {
    try {
      const result = await S.client.graph.listNodes({nodeIds: uris.slice(i, i + 200), limit: 200});
      const visible = visibleGraphNodes(result.nodes);
      visible.forEach(rememberNodeHue);
      await resolveTypes(visible.map(n => n.entityType));
      for (const n of visible) targets.set(n.id, toNode(graphRow(n)));
    } catch { /* Keep unresolved reference identity; inaccessible targets must not break the surrounding outline. */ }
  }
  for (const ref of refs) if (targets.has(ref.uri)) ref.node = targets.get(ref.uri);
  return nodes;
}

// A chat has no content outline at all: the conversation is data.messages on the chat document itself
// (docs/CHATS.md). Read only when the chat is opened — a chat document is megabytes of inline tool output.
async function chatOutline(doc) {
  const messages = doc.data.get('messages');
  const names = new Map((await members().catch(() => [])).map((m) => [m.id, m.title]));
  return resolveReferences(chat.chatRows(messages ? messages.toJSON() : [], { authorName: (uri) => names.get(uri) }));
}

// New document ('doc' | 'task' | 'meeting'): seeded locally, created on the server by the bootstrap (sdk/sync.js subscribe with init).
async function customCreation(typeUri) {
  if (typeof typeUri !== 'string' || !/^tana:type:[0-9a-z]{26}$/.test(typeUri)) throw new Error('Select a workspace type');
  const type = readNode(await document(typeUri));
  if (type.type !== 'type' || isDeleted(type)) throw new Error('Type is unavailable');
  const appliesTo = type.appliesTo ?? 'docs';
  if (!['docs','events'].includes(appliesTo)) throw new Error('Unsupported type target');
  if (type.ownerUri) {
    if (!/^tana:space:[0-9a-z]{26}$/.test(type.ownerUri)) throw new Error('Unsupported type scope');
    if (!await access.canWrite(readNode(await document(type.ownerUri)), S.me.userUri, await accessContext())) throw new Error('Type home space write permission is unknown or unavailable');
  }
  return {kind:appliesTo === 'events' ? 'meeting' : 'doc',entityTypeUri:typeUri,ownerUri:type.ownerUri};
}
async function creationOptions() {
  if (!S.client) throw new Error(NOT_CONNECTED);
  const result = await S.client.graph.listNodes({nodeTypes:['type'],limit:1000,mode:'LIST_NODES_MODE_WITH_COUNT'});
  const options = [{id:'task',kind:'task',title:'Task',icon:'task',selectable:true},{id:'meeting',kind:'meeting',title:'Meeting',icon:'meeting',selectable:true},{id:'chat',kind:'chat',title:'Chat',icon:'chat',selectable:true}];
  const types = await Promise.all(result.nodes.map(async n => {
    rememberType(n);
    // the chooser shows a type the way its documents render: the type's own hue and its app-local icon
    const look = { hue: ownHue(n) === undefined ? typeHues.get(n.id) : ownHue(n), iconSvg: db.icon(n.id) || undefined };
    try { const config=await customCreation(n.id); return {id:n.id,kind:'custom',typeUri:n.id,title:n.title || '',...look,icon:config.kind === 'meeting' ? 'meeting' : 'doc',ownerUri:config.ownerUri,appliesTo:config.kind === 'meeting' ? 'events' : 'docs',selectable:true}; }
    catch(e) { return {id:n.id,kind:'custom',typeUri:n.id,title:n.title || '',...look,icon:'doc',selectable:false,reason:errText(e)}; }
  }));
  return {options:[...options,...types.sort((a,b)=>a.title.localeCompare(b.title))],complete:result.totalCount !== undefined && result.totalCount === result.nodes.length};
}
async function createDocument(title, opts = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('Keep an empty draft local until it has a title');
  if (!S.client) throw new Error(NOT_CONNECTED);
  let config = {kind:opts.kind || 'doc'};
  if (config.kind === 'custom') config = await customCreation(opts.typeUri);
  else if (opts.typeUri !== undefined) throw new Error('Custom type requires kind custom');
  if (!Object.hasOwn(KINDS, config.kind)) throw new Error('Unsupported creation kind'); // 'constructor' is a truthy lookup, not a kind
  const id = KINDS[config.kind] + ulid();
  const doc = await subscribe(id, loro => initDocument(loro, title, S.me.userUri, config));
  if (!doc) throw new Error(S.status.error || 'could not create ' + id);
  const node = await info(doc); scheduleRefresh(2000); return node; // give GraphService's index time to include the new node
}

// Node shape for any subscribed document: cached row when listed, else derived from the Loro data map.
async function info(doc) {
  const n = readNode(doc), row = db.get(doc.id);
  if (isDeleted(n) || deletedNodes.has(doc.id)) throw new Error('Node has been deleted');
  rememberNodeHue(n);
  // A cached row carries the short list form of an event's meta ("Mon 9:00"); a zoomed node shows the full date
  // like search does (#113), so the meta is rebuilt from the event itself when there is one.
  const ev = n.type === 'event' || doc.id.startsWith('tana:event:') ? eventMeta(n.startTime, n.endTime, true) : undefined;
  if (row) return toNode({ ...row, title: n.title ?? row.title, done: n.stateType === 'closed' ? 1 : 0, meta: ev || row.meta });
  await resolveHue(doc.id); // cached rows already carry the hue the refresh learned from the graph
  if (idKind(doc.id) === 'user-profile') return toNode(memberRow(doc.id, n.title || doc.data.get('name') || doc.data.get('displayName') || '', now(), hueOf(n)));
  if (PLAIN_KINDS.has(idKind(doc.id))) return toNode(kindRow(doc.id, idKind(doc.id), n.title || '', now(), hueOf(n)));
  const isEvent = n.type === 'event' || doc.id.startsWith('tana:event:');
  await resolveTypes([n.entityTypeUri]);
  if (!isEvent && !n.stateType) return toNode(plainRow(doc.id, n.title || '', now(), n.entityTypeUri, hueOf(n)));
  return toNode({
    id: doc.id, title: n.title || '', done: n.stateType === 'closed' ? 1 : 0, icon: isEvent ? 'meeting' : 'task',
    hue: hueWithType(hueOf(n), n.entityTypeUri), meta: isEvent ? eventMeta(n.startTime, n.endTime, true) : null, tags: [nodeTag(isEvent ? TAG.meeting : TAG.task, n), ...typeTag(n.entityTypeUri)],
  });
}
function setIcon(id, svg) {
  if (svg != null) {
    if (typeof svg !== 'string' || Buffer.byteLength(svg) >= 65536) throw new Error('icon must be an SVG string under 64 KB');
    svg = svg.trim().replace(/^<\?xml[^>]*\?>\s*/, ''); // FileReader text of a .svg may start with an XML declaration
    if (!svg.startsWith('<svg')) throw new Error('icon must start with <svg');
  }
  db.setIcon(id, svg);
  send('outline:changed', null);
}

function setSensitive(id, on) {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Not a Tana document id');
  if (typeof on !== 'boolean') throw new Error('Sensitive state must be true or false');
  db.setSensitive(id, on);
  return on;
}

function subscribe(id, init) {
  return S.client.sync.subscribe(id, init).catch((e) => { subscribed.delete(id); report(e); return null; });
}

function invalidateDeleted(id) {
  deletedNodes.add(id);
  db.remove(id);
  nodeHues.delete(id); hueLoaded.delete(id); editability.delete(id); pathCache.delete(id); nodeMeta.delete(id);
  typeTitles.delete(id); typeHues.delete(id);
  summaryCache.delete(id);
  for (const [event, writeUp] of summaryCache) if (writeUp === id) summaryCache.delete(event); // a deleted write-up is no redirect target
  send('outline:removed', id); // renderer must evict children/search/pin/zoom caches by id
  send('outline:changed', null);
}

function onChange(docId) {
  try {
    const doc = S.client.sync.getDocument(docId);
    if (!doc) return;
    const n = readNode(doc), row = db.get(docId);
    if (isDeleted(n)) {
      invalidateDeleted(docId);
      return;
    }
    const restored = deletedNodes.delete(docId);
    const hueChanged = rememberNodeHue(n);
    const done = n.stateType === 'closed' ? 1 : 0, title = n.title ?? row?.title;
    const rowChanged = row && (title !== row.title || done !== row.done || hueChanged);
    if (rowChanged) db.setRow(docId, { title, done, updatedAt: now() }); // every view's row, not just the one db.get found
    // Collection/profile/date-pin changes do not have cached view rows, but invalidate pins globally.
    const pinsChanged = docId === S.me?.userUri || ['collection', 'pin-map'].includes(idKind(docId));
    // The renderer keeps a document's metadata (assignees, audience, sharing) until one of them moves; a text
    // edit must not cost it the owner-chain and link-sharing lookups, so the event says whether they did.
    const sig = metaSig(n), meta = metaSigs.get(docId) !== sig;
    metaSigs.set(docId, sig);
    send('outline:changed', docId, { meta }); // the renderer patches this one row from doc:info
    if (pinsChanged || restored) send('outline:changed', null);
    if (restored) scheduleRefresh(0);
  } catch (e) {
    report(e);
  }
}
// What doc:taskMeta is built from, as one string per document: seeded when the renderer reads the metadata, compared
// on every change. participants carry roles and restricted the audience rule; assignedToUris the assignees.
const metaSig = (n) => JSON.stringify([n.assignedToUris, n.restricted, n.participants]);

async function document(id) {
  if (!S.client || !S.me) throw new Error(NOT_CONNECTED);
  // A renderer draft carries a local id until it is materialised; subscribing one would create a phantom document
  // whose pending bootstrap then rejects as "unsubscribed <id>" on the next refresh.
  if (!DOC_URI.test(id)) throw new Error(NOT_CONNECTED);
  const doc = await subscribe(id); // getDocument can expose an empty handle before bootstrap completes
  if (!doc) throw new Error(S.status.error || 'could not subscribe to ' + id);
  return doc;
}

async function op(id, fn) {
  try {
    const doc = await document(id);
    if (isDeleted(readNode(doc)) || deletedNodes.has(id)) throw new Error('Node has been deleted');
    return await fn(doc);
  } catch (e) {
    report(e);
    throw e;
  }
}

// Mutations: same as op, plus global undo ordering across documents (each Document keeps its own Loro UndoManager).
// ponytail: a linear scan of an unbounded stack, run once per refresh; index it if either ever grows into the thousands.
const inHistory = (id) => [...undoStack, ...redoStack].some((step) => step === id || step?.id === id || (Array.isArray(step) && step.includes(id)));
async function mut(id, fn, accessMutation = false) {
  if (S.historyBusy) throw new Error('History operation is still running');
  const result = await op(id, (doc) => {
    if (!accessMutation && editable(readNode(doc), S.me && S.me.userUri) === false) throw new Error('This node is read-only in the outliner');
    return fn(doc);
  });
  // Sharing and moves are gated by an audience disclosure and a preview token; a raw CRDT undo would rewrite
  // participants, restricted or ownerUri without either, so those mutations do not enter the undo stack.
  if (!accessMutation) { undoStack.push(id); redoStack.length = 0; }
  return result;
}
// Task metadata lives in separate CRDT documents. Preflight the whole selection, then group those
// per-document transactions into one user-visible history step.
async function mutTasks(ids, fn) {
  if (S.historyBusy) throw new Error('History operation is still running');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !DOC_URI.test(id))) throw new Error('Select unique task documents');
  const docs = await Promise.all(ids.map((id) => op(id, (doc) => {
    const node = readNode(doc);
    if (!STATE_TYPES.includes(node.stateType)) throw new Error('Task metadata can only be changed on tasks');
    if (editable(node, S.me && S.me.userUri) === false) throw new Error('This node is read-only in the outliner');
    return doc;
  })));
  const changed = [];
  try {
    for (const doc of docs) {
      const before = doc.loro.oplogVersion();
      fn(doc);
      if (before.compare(doc.loro.oplogVersion()) !== 0) changed.push(doc.id);
    }
  } finally {
    if (changed.length) { undoStack.push(changed); redoStack.length = 0; }
  }
  return changed.length;
}
// ponytail: one undo step per mutation call across docs; inside a document the UndoManager keeps one step per
// transact (mergeInterval 0), so a multi-document mutation is as many steps as documents.
async function documentAction(id, action, record = true) {
  if (record && S.historyBusy) throw new Error('History operation is still running');
  if (record) S.historyBusy = true;
  try {
  if (typeof id !== 'string' || !DOC_URI.test(id)) throw new Error('Invalid document URI');
  const doc = await document(id), ctx = await accessContext();
  if (!await access.canDelete(doc, S.me.userUri, ctx, action === 'restore')) throw new Error('Delete/restore permission is unknown or unavailable');
  const response = await S.client.sync[action](id);
  if (response.responseUnion?.case !== 'documentActionResponse') throw new Error('Document action was not acknowledged');
  if (action === 'softDelete') invalidateDeleted(id);
  // Restore visibility comes from the server's live update, not a fabricated local snapshot.
  if (record) { undoStack.push({ id, documentAction:action }); redoStack.length = 0; }
  scheduleRefresh(0);
  return id;
  } finally { if (record) S.historyBusy = false; }
}
async function history(from, to, action, can) {
  if (S.historyBusy) throw new Error('History operation is still running');
  S.historyBusy = true;
  try {
    while (from.length) {
      const step = from.at(-1);
      if (Array.isArray(step)) {
        let changedId = null;
        for (const id of action === 'undo' ? [...step].reverse() : step) {
          const doc = S.client && S.client.sync.getDocument(id);
          if (!doc || !doc[can]() || isDeleted(readNode(doc)) || editable(readNode(doc), S.me && S.me.userUri) === false) continue;
          if (doc[action]()) changedId ||= id;
        }
        from.pop();
        if (changedId) { to.push(step); scheduleRefresh(2000); return changedId; }
        continue;
      }
      if (typeof step === 'object') {
        const command = action === 'undo' ? (step.documentAction === 'softDelete' ? 'restore' : 'softDelete') : step.documentAction;
        await documentAction(step.id, command, false);
        from.pop(); to.push(step); return step.id;
      }
      const id = step, doc = S.client && S.client.sync.getDocument(id);
      if (!doc || !doc[can]() || isDeleted(readNode(doc)) || editable(readNode(doc), S.me && S.me.userUri) === false) { from.pop(); continue; }
      // An undone state change belongs back on its list (unchecking a task returns it to Tasks), which only a refresh knows.
      if (doc[action]()) { from.pop(); to.push(id); scheduleRefresh(2000); return id; }
      from.pop();
    }
    return null;
  } finally { S.historyBusy = false; }
}
// linkSharing lives on the graph node only. Every visible row asks for it as it scrolls in, so the lookups that
// arrive within a few milliseconds of each other go out as one nodeIds query instead of one call per row.
const linkBatch = new Map(); // id -> [resolve]
let linkTimer = null;
function linkShared(id) {
  return new Promise((resolve) => {
    if (!linkBatch.has(id)) linkBatch.set(id, []);
    linkBatch.get(id).push(resolve);
    linkTimer ||= setTimeout(async () => {
      const batch = new Map(linkBatch); linkBatch.clear(); linkTimer = null;
      let shared = new Set();
      try {
        const ids = [...batch.keys()];
        for (let i = 0; i < ids.length; i += 200) {
          const { nodes = [] } = await S.client.graph.listNodes({ nodeIds: ids.slice(i, i + 200), limit: 200 });
          for (const n of nodes) if (n.linkSharing && n.linkSharing.mode) shared.add(n.id);
        }
      } catch { shared = new Set(); }
      for (const [nodeId, resolves] of batch) for (const r of resolves) r(shared.has(nodeId));
    }, 25);
  });
}
async function accessContext() {
  const token = await S.session.getAccessToken();
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return {sync:S.client.sync, graph:S.client.graph, orgDocUri:S.me.orgDocUri,
    orgAdmin:claims.org_id === S.me.orgId && ['admin','owner'].includes(claims.role)};
}
// Native write access to a document: a participant grant or an inherited owner boundary (sdk/access.js), never the
// outliner's editable-body answer, which is about editing a title or content.
const canWriteDoc = async (doc) => access.canWrite(readNode(doc), S.me.userUri, await accessContext());
async function moveTarget(spaceId) {
  if (spaceId === 'library') return access.LIBRARY;
  if (typeof spaceId !== 'string' || !/^tana:space:[0-9a-z]{26}$/.test(spaceId)) throw new Error('Select a space');
  return document(spaceId);
}

module.exports = { outlineWithReferences, resolveReferences, chatOutline, customCreation, creationOptions, createDocument, info, setIcon, setSensitive, subscribe, invalidateDeleted, onChange, document, op, inHistory, mut, mutTasks, documentAction, history, linkShared, metaSig, accessContext, canWriteDoc, moveTarget };
