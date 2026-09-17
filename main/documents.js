'use strict';
const db = require('../db');
const access = require('../sdk/access');
const content = require('../sdk/content');
const chat = require('../sdk/chat');
const { readNode, audienceMetadata, editable, ulid, initDocument, STATE_TYPES } = require('../sdk/node');
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
  // A saved search is created empty and then narrowed with the pills, unlike the other kinds, which are created from
  // a title alone. writeSearchQuery materialises every key, so the empty query is still a readable one — a search
  // born without it would be refused by searchChildren for the rest of its life.
  const options = [{id:'doc',kind:'doc',title:'Doc',icon:'doc',selectable:true},{id:'task',kind:'task',title:'Task',icon:'task',selectable:true},{id:'meeting',kind:'meeting',title:'Meeting',icon:'meeting',selectable:true},{id:'chat',kind:'chat',title:'Chat',icon:'chat',selectable:true},{id:'search',kind:'search',title:'Search',icon:'search',selectable:true}];
  const types = await Promise.all(result.nodes.map(async n => {
    rememberType(n);
    // the chooser shows a type the way its documents render: the type's own hue and its app-local icon
    const look = { hue: ownHue(n) === undefined ? typeHues.get(n.id) : ownHue(n) };
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
  // A saved search is created from a query, never from a bare title: initDocument writes the query container at
  // birth because searchChildren reads an empty one as unreadable and refuses to run it.
  if (config.kind === 'search') {
    if (!opts.query || typeof opts.query !== 'object' || Array.isArray(opts.query)) throw new Error('A saved search needs a query');
    config = {...config, query: opts.query};
  } else if (opts.query !== undefined) throw new Error('Only a saved search carries a query');
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

// ---- watching a node for changes ----
// On by default where a named list of people can see the node — the same audience the row shows — and it is not
// assigned to you, since an assignee is already looking at their own work. Every other audience is off until asked
// for in Cmd+K: 'space' is visibility through the space it lives in, 'only-me' is your own private work with nobody
// else to change it, 'everyone' is the whole organisation, and 'unknown' is nothing anyone can follow.
// The document's own `restricted` flag cannot answer this. A document shared through the meeting it belongs to
// carries no flag of its own, and that is most of what is actually shared with you: a sweep of sixty recent
// documents found every 'people' one unrestricted and owned by an event, so the old test matched none of them.
const notifyDefault = (n, audience) => {
  const me = S.me && S.me.userUri;
  if (!me || audience !== 'people') return false;
  return !(Array.isArray(n.assignedToUris) && n.assignedToUris.includes(me));
};
// An inherited audience costs an owner-chain lookup and a read of the boundary, so it is asked for only where the
// answer decides something: never for a document whose choice is already explicit, and never for a local edit.
const docAudience = (doc) => audienceMetadata(doc, S.me && S.me.userUri, S.client.graph, S.client.sync).then((a) => a.audience, () => 'unknown');
// An explicit choice wins; absent, the rule above decides. Stored as a map so "off for a node the rule would watch"
// is a real answer and not the same as never having chosen.
const notifyChoices = () => { const stored = db.setting('notify'); return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}; };
const notifyOn = (n, audience) => { const chosen = notifyChoices()[n.id]; return typeof chosen === 'boolean' ? chosen : notifyDefault(n, audience); };
// The nodes you explicitly asked to be told about. A change only reaches onChange while its document is subscribed,
// and the view refresh unsubscribes everything the active view stops listing, so without this "notify me" quietly
// meant "while this view happens to list it". The rule-based defaults cannot be enumerated without reading every
// document, so they stay as they were: watched while something is looking at them.
const notifyWatchedIds = () => { const chosen = notifyChoices(); return new Set(Object.keys(chosen).filter((id) => chosen[id] === true)); };
async function notifyState(id) {
  const { n, audience } = await op(id, async (doc) => ({ n: readNode(doc), audience: await docAudience(doc) }));
  return { on: notifyOn(n, audience), default: notifyDefault(n, audience), explicit: typeof notifyChoices()[id] === 'boolean' };
}
async function setNotify(id, on) {
  const chosen = notifyChoices();
  if (on === null || on === undefined) delete chosen[id]; else chosen[id] = !!on;
  db.setSetting('notify', chosen);
  return notifyState(id);
}
const NOTIFY_STATE = { proposed: 'Inbox', open: 'In Progress', closed: 'Completed', not_now: 'Later' };
// docId -> [title, stateType, oplog frontiers] as last seen: what a change has to differ from to be one. The
// frontiers are what makes an ordinary edit count — a body rewritten elsewhere moves neither title nor state, and
// watching a node you never hear from is the same as not watching it. They also absorb a re-import of ops already
// seen (a resync), which a version-free comparison would announce as an edit.
const notifySigs = new Map();
const notifyQuiet = new Map(); // docId -> when a plain edit was last announced
const EDIT_QUIET_MS = 60000; // a remote edit arrives op by op: someone typing is one banner a minute, not fifty
// Only changes from somewhere else. onChange fires for your own typing too, and being notified about your own edits
// would make this unusable; sdk/document.js already marks every change local or remote, so the origin decides.
async function notifyWatched(id, doc, n, info) {
  const sig = [n.title ?? '', n.stateType ?? '', JSON.stringify(doc.loro.oplogFrontiers())];
  const before = notifySigs.get(id);
  notifySigs.set(id, sig);
  if (!info || info.origin !== 'remote') return;
  if (!before || JSON.stringify(before) === JSON.stringify(sig)) return; // first sight, or nothing worth saying moved
  const chosen = notifyChoices()[id];
  if (!(typeof chosen === 'boolean' ? chosen : notifyDefault(n, await docAudience(doc)))) return;
  const moved = before[0] !== sig[0] || before[1] !== sig[1]; // a rename or a status change: rare, and always worth a banner
  if (!moved) { const last = notifyQuiet.get(id) || 0; if (Date.now() - last < EDIT_QUIET_MS) return; notifyQuiet.set(id, Date.now()); }
  const body = before[1] !== sig[1] ? (NOTIFY_STATE[sig[1]] ? 'Now ' + NOTIFY_STATE[sig[1]] : 'Status changed') : 'Edited';
  if (S.notify) S.notify(id, n.title || 'Untitled', body);
}
function onChange(docId, info) {
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
    notifyWatched(docId, doc, n, info).catch(report); // the signature is taken here and now; the audience it may need is not
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

module.exports = { outlineWithReferences, resolveReferences, chatOutline, customCreation, creationOptions, createDocument, info, setSensitive, subscribe, invalidateDeleted, onChange, notifyState, setNotify, notifyDefault, notifyOn, notifyWatchedIds, document, op, inHistory, mut, mutTasks, documentAction, history, linkShared, metaSig, accessContext, canWriteDoc, moveTarget };
