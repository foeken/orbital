'use strict';
// Generic accessors for the common 'data' map and the ProseMirror-style 'content' map (protocol doc §3).
const { randomBytes } = require('node:crypto');
const { LoroMap, LoroList } = require('loro-crdt');

const STATE_TYPES = ['proposed', 'open', 'closed', 'not_now'];
const B32 = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase as in Tana ids
const USER_URI = /^tana:user-profile:[0-9a-z]{26}$/;
// Audience classification only: a guest profile is an external person with an explicit participant grant, never me.
// Write paths keep USER_URI; guest ACL semantics are not part of the verified sharing subset.
const PERSON_URI = /^tana:(?:user|guest)-profile:[0-9a-z]{26}$/;

// 26-char ULID: 48-bit ms timestamp + 80 random bits.
function ulid(now = Date.now()) {
  let s = '', t = now;
  for (let i = 0; i < 10; i++) { s = B32[t % 32] + s; t = Math.floor(t / 32); }
  for (const b of randomBytes(16)) s += B32[b % 32];
  return s;
}

// The data map of a new document as the web client creates it plus an empty content skeleton. Run inside
// Document.transact. kind 'doc' (default): a plain text document (scripts/fixtures/task-snapshot.b64 minus the
// task fields); 'task': plus the open state assigned to byUri; 'meeting': a 'tana:event:' document laid out like a
// Tana-created event (tana:event:01exampley0000000000000000, without the calendar-provider fields), starting at
// the next half hour for 30 minutes.
function initDocument(loro, title, byUri, { kind = 'doc', now = Date.now(), entityTypeUri, ownerUri, query } = {}) {
  if (!['doc', 'task', 'meeting', 'chat', 'search'].includes(kind)) throw new Error('unknown kind ' + kind);
  if (entityTypeUri !== undefined && (!/^tana:type:[0-9a-z]{26}$/.test(entityTypeUri) || kind === 'chat')) throw new Error('Invalid custom type');
  if (ownerUri !== undefined && !/^tana:space:[0-9a-z]{26}$/.test(ownerUri)) throw new Error('Invalid type home space');
  const data = loro.getMap('data');
  data.set('type', kind === 'meeting' ? 'event' : kind === 'chat' ? 'chat' : kind === 'search' ? 'search' : 'text');
  if (entityTypeUri) data.set('entityTypeUri', entityTypeUri);
  if (ownerUri) data.set('ownerUri', ownerUri);
  data.set('title', title);
  data.set('createdAt', now);
  data.set('restricted', true);
  const p = data.setContainer('participants', new LoroMap()).setContainer(byUri, new LoroMap());
  p.set('type', 'user');
  p.set('role', 'admin');
  // A saved search carries no sharedPinDates: a real one (raw container dump, 2026-09-17) has exactly
  // data{type,createdAt,title,restricted,participants} plus the query and view roots, and empty content and
  // linkSharing — no ownerUri, since a Library-level search has no owner. Its query is written separately by
  // the caller (setSearchQuery); an empty query map here would be indistinguishable from an unreadable one,
  // which searchChildren treats as a failure, so the document is created with its query already in place.
  if (kind === 'search') {
    // The query is written here rather than after creation: searchChildren treats an empty query map as an
    // unreadable document and refuses to run it, so a search created without one would be born broken.
    writeSearchQuery(loro, query);
    loro.getMap('view');
    return; // no sharedPinDates, no assignedToUris, no outline content
  }
  data.setContainer('sharedPinDates', new LoroList());
  if (kind === 'chat') {
    data.setContainer('participantUris', new LoroList());
    data.setContainer('messages', new LoroList());
    return; // native chat schema has no outline content
  }
  if (kind === 'meeting') {
    const start = Math.ceil(now / 18e5) * 18e5;
    data.set('startTime', start);
    data.set('endTime', start + 18e5);
    data.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);
    data.set('origin', 'tana');
    data.setContainer('attendees', new LoroList());
    data.setContainer('attributes', new LoroMap());
    data.setContainer('organizer', new LoroMap());
    loro.getMovableList('pinnedItems'); // native event root, not data.pinnedItems
    return; // native events do not initialize an outline
  } else {
    data.setContainer('attributes', new LoroMap());
  }
  data.setContainer('assignedToUris', new LoroList()); // native Tp.create seeds this for all text documents
  if (kind === 'task') {
    data.set('stateType', 'open');
    data.set('stateEnteredAt', now);
    data.set('stateChangedBy', byUri);
    data.get('assignedToUris').push(byUri);
    data.set('assignedToUrisChangedAt', now);
    data.set('assignedToUrisChangedBy', byUri);
  }
  const c = loro.getMap('content');
  c.set('nodeName', 'doc');
  c.setContainer('attributes', new LoroMap());
  const children = c.setContainer('children', new LoroList());
  // Native Qf initializes empty text content as one paragraph, with a persistent block id.
  const paragraph = children.pushContainer(new LoroMap());
  paragraph.set('nodeName', 'paragraph');
  paragraph.setContainer('attributes', new LoroMap()).set('blockId', ulid().slice(-8));
  paragraph.setContainer('children', new LoroList());
}

function readNode(document) {
  return Object.assign({ id: document.id }, document.data.toJSON());
}

// Companion outline capability, not a replacement for server authorization. Unknown/inherited ACLs stay null.
// Profiles expose name/displayName, not an editable document title. Other unsupported bodies stay read-only.
function editable(n, userUri) {
  const kind = (n.id || '').split(':')[1];
  // 'search' is here because a saved search is a document the user owns and renames: a real one carries
  // participants[user] = { type: 'user', role: 'admin' }, so it falls through to the role check below and
  // answers true — the ACL still decides, exactly as it does for text. Unlike 'event' it needs no early
  // return: a search's title is ordinary document data, not a calendar-protected field.
  if (!['text', 'space', 'event', 'search'].includes(kind)) return false;
  const role = n.participants && n.participants[userUri] && n.participants[userUri].role;
  if (kind === 'event') return false; // protected title needs organizer + external-calendar write capability, not exposed by our graph contract
  if (role === 'admin' || role === 'editor') return true;
  if (role === 'viewer') return false;
  return null;
}

// Exactly what the web client's setTitle writes: title plus removal of titleAutoGenerated.
function setTitle(document, title) {
  document.transact((loro) => {
    const data = loro.getMap('data');
    data.set('title', title);
    data.delete('titleAutoGenerated');
  });
}

// transitionTo(stateType, changedBy) for plain (non-workflow) states.
function setState(document, stateType, byUri) {
  if (!STATE_TYPES.includes(stateType)) throw new Error('unknown stateType ' + stateType);
  if (!/^tana:user-profile:/.test(byUri || '')) throw new Error('stateChangedBy must be a tana:user-profile: URI');
  document.transact((loro) => {
    const data = loro.getMap('data');
    data.set('stateType', stateType);
    data.set('stateEnteredAt', Date.now());
    data.set('stateChangedBy', byUri);
    data.delete('stateWorkflowUri');
    data.delete('stateWorkflowStateId');
  });
}

function taskMeta(document) {
  const n = readNode(document);
  return {
    assignees: Array.isArray(n.assignedToUris) ? n.assignedToUris.filter((uri) => typeof uri === 'string') : [],
    restricted: typeof n.restricted === 'boolean' ? n.restricted : undefined,
    participants: Object.entries(n.participants || {}).map(([uri, participant]) => ({ uri, type: participant && participant.type, role: participant && participant.role })),
  };
}

// Mirrors native Bc scope selection, but unresolved/group audiences stay unknown.
async function audienceMetadata(document, userUri, graph, sync) {
  const direct = taskMeta(document);
  const people = (participants) => {
    if (!participants.length || participants.some(p => p.type !== 'user' || !PERSON_URI.test(p.uri))) return 'unknown';
    return participants.length === 1 && participants[0].uri === userUri ? 'only-me' : 'people';
  };
  if (direct.restricted === true) return { audience: people(direct.participants) };
  // Native setAudienceRule('inherit') deletes restricted; absence also inherits.
  if (direct.restricted !== false && direct.restricted !== undefined) return { audience: 'unknown' };
  try {
    const chain = await graph.getOwnerChain(document.id);
    const boundary = (chain.entries || []).find(e => e.uri !== document.id && e.restricted === true);
    if (boundary) {
      if (boundary.accessible === false) return { audience: 'unknown' };
      const owner = await sync.subscribe(boundary.uri);
      // The organization root is restricted to its members, so an org boundary means everyone in the
      // organization (the same membership map access.js checks).
      if (boundary.uri.startsWith('tana:org:')) {
        const members = readNode(owner).memberUserProfileDocUris || {};
        return { audience: Object.values(members).includes(userUri) ? 'everyone' : 'unknown' };
      }
      const meta = taskMeta(owner);
      if (meta.restricted !== true) return { audience: 'unknown' };
      const scope = people(meta.participants);
      if (scope !== 'people') return { audience: scope }; // 'only-me' or 'unknown'
      // An inherited boundary with explicit user participants is as determinate as a direct one: the audience is
      // that participant set (access.js audienceOf agrees). Only a space boundary additionally names a space.
      if (!boundary.uri.startsWith('tana:space:')) return { audience: 'people' };
      const title = readNode(owner).title;
      return { audience: 'space', audienceSpace: { uri: boundary.uri, ...(typeof title === 'string' && title.trim() ? { title } : {}) } };
    }
    return { audience: chain.effectivelyRestricted === false ? 'everyone' : 'unknown' };
  } catch { return { audience: 'unknown' }; }
}

// Keep the original SDK classification contract for existing callers.
async function audience(...args) { return (await audienceMetadata(...args)).audience; }

// A saved search's stored query lives in a root container of its own, not in data. Tana's own client assigns
// every key on write (arrays defaulting to empty) rather than patching, so a stored query is always whole and a
// removed filter cannot linger; this does the same. Keys absent from `query` are written as empty, which is what
// a real saved search carries — but the map as a whole is never left empty, since searchChildren reads an empty
// map as an unreadable document and refuses to run it.
const SEARCH_QUERY_LISTS = ['types', 'entityTypeUris', 'ownerUris', 'createdBy', 'assignedTo', 'participantUris', 'stateTypes', 'workflowStates'];
const SEARCH_QUERY_FLAGS = ['textQuery', 'assignedToViewer', 'createdByViewer', 'unassigned', 'visibility'];
function writeSearchQuery(loro, query = {}) {
  const q = loro.getMap('query');
  for (const key of SEARCH_QUERY_LISTS) {
    const list = q.setContainer(key, new LoroList());
    for (const v of Array.isArray(query[key]) ? query[key] : []) list.push(v);
  }
  // Set or delete, never skip: a flag left alone would survive a rewrite that dropped it, so turning off
  // "assigned to me" and saving would silently keep it on — the lingering filter this whole function exists
  // to prevent. Lists are replaced wholesale for the same reason.
  for (const key of SEARCH_QUERY_FLAGS) {
    if (query[key] !== undefined && query[key] !== null) q.set(key, query[key]);
    else if (q.get(key) !== undefined) q.delete(key);
  }
  const attrs = q.setContainer('attributes', new LoroMap());
  for (const [k, v] of Object.entries(query.attributes || {})) attrs.set(k, v);
  // eventTime is set or removed for the same reason the flags are: a cleared date window that lingered would
  // keep filtering a search the user thought they had widened.
  if (query.eventTime && typeof query.eventTime === 'object') {
    const t = q.setContainer('eventTime', new LoroMap());
    for (const [k, v] of Object.entries(query.eventTime)) if (v !== undefined) t.set(k, v);
  } else if (q.get('eventTime') !== undefined) q.delete('eventTime');
}
function setSearchQuery(document, query) {
  if ((document.data.get('type')) !== 'search') throw new Error('not a saved search');
  document.transact((loro) => { writeSearchQuery(loro, query); });
}
// How a saved search's rows are arranged — sorted and grouped — lives in the `view` root container, beside the query
// rather than inside it: it changes nothing about which rows the search finds, only how they are shown. Set or
// delete for the same reason the query's flags are: an arrangement dropped from a save must not linger in the
// document and come back the next time it is opened.
function writeSearchView(loro, view = {}) {
  const v = loro.getMap('view');
  for (const key of ['sortBy', 'groupBy']) {
    if (typeof view[key] === 'string' && view[key]) v.set(key, view[key]);
    else if (v.get(key) !== undefined) v.delete(key);
  }
}
function setSearchView(document, view) {
  if ((document.data.get('type')) !== 'search') throw new Error('not a saved search');
  document.transact((loro) => { writeSearchView(loro, view); });
}

// Rewrites the task's existing list container; empty is the supported "unassigned" value.
function setAssignees(document, uris, byUri) {
  if (!Array.isArray(uris)) throw new Error('assignees must be an array of user-profile URIs');
  if (!USER_URI.test(byUri || '')) throw new Error('assignedToUrisChangedBy must be a tana:user-profile URI');
  const assignees = [...new Set(uris)];
  if (assignees.some((uri) => !USER_URI.test(uri || ''))) throw new Error('assignees must be tana:user-profile URIs');
  if (!STATE_TYPES.includes(readNode(document).stateType)) throw new Error('assignees can only be changed on a task');
  if (JSON.stringify(taskMeta(document).assignees) === JSON.stringify(assignees)) return assignees;
  document.transact((loro) => {
    const data = loro.getMap('data');
    const list = data.get('assignedToUris');
    if (list instanceof LoroList) list.clear();
    else data.setContainer('assignedToUris', new LoroList());
    const target = data.get('assignedToUris');
    assignees.forEach((uri) => target.push(uri));
    data.set('assignedToUrisChangedAt', Date.now());
    data.set('assignedToUrisChangedBy', byUri);
  });
  return assignees;
}

function contentText(document) {
  return render(document.content.toJSON());
}

// ponytail: block vs inline is inferred (a node with non-mention child nodes is a block container); add an
// explicit node-name table if the editor schema turns out to have inline nodes with children.
function render(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  if (node.nodeName === 'mention') return (node.attributes && node.attributes.label) || '';
  const kids = Array.isArray(node.children) ? node.children : [];
  const block = kids.some((k) => k && typeof k === 'object' && k.nodeName !== 'mention');
  return kids.map(render).join(block ? '\n' : '');
}

module.exports = { readNode, editable, setTitle, setState, taskMeta, audience, audienceMetadata, setAssignees, setSearchQuery, setSearchView, contentText, ulid, initDocument, STATE_TYPES };
