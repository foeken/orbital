'use strict';
// Generic accessors for the common 'data' map and the ProseMirror-style 'content' map (protocol doc §3).
const { randomBytes } = require('node:crypto');
const { LoroMap, LoroList, LoroMovableList } = require('loro-crdt');

const STATE_TYPES = ['proposed', 'open', 'closed', 'not_now'];
const COMPLETED_WINDOWS = [3, 7, 30, 'all']; // days a completed task stays listed (sdk/query.js completedInWindow)
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
function initDocument(loro, title, byUri, { kind = 'doc', now = Date.now(), entityTypeUri, ownerUri, query, view } = {}) {
  if (!['doc', 'task', 'meeting', 'chat', 'search', 'type'].includes(kind)) throw new Error('unknown kind ' + kind);
  if (entityTypeUri !== undefined && (!/^tana:type:[0-9a-z]{26}$/.test(entityTypeUri) || kind === 'chat')) throw new Error('Invalid custom type');
  if (ownerUri !== undefined && !/^tana:space:[0-9a-z]{26}$/.test(ownerUri)) throw new Error('Invalid type home space');
  const data = loro.getMap('data');
  data.set('type', kind === 'meeting' ? 'event' : kind === 'chat' ? 'chat' : kind === 'search' ? 'search' : kind === 'type' ? 'type' : 'text');
  if (entityTypeUri) data.set('entityTypeUri', entityTypeUri);
  if (ownerUri) data.set('ownerUri', ownerUri);
  data.set('title', title);
  // A type carries none of what a document carries: four real types (raw container dumps, 2026-09-20) hold exactly
  // data{type,title,sharedPinDates,template} — plus instructions and ownerUri when they have them — an empty
  // content map and their colour in the appearance root, with no createdAt, restricted or participants. A type
  // with no ownerUri is a Library type and goes on documents anywhere. Tana's own create (read 2026-09-22) always
  // writes template = { attributes: [] } (a MovableList, which fields.addField appends to) and a random hue.
  if (kind === 'type') {
    data.setContainer('sharedPinDates', new LoroList());
    data.setContainer('template', new LoroMap()).setContainer('attributes', new LoroMovableList());
    loro.getMap('appearance').set('hue', Math.floor(Math.random() * 360));
    loro.getMap('content');
    return;
  }
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
    writeSearchView(loro, view);
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
  return Object.assign({ id: document.id }, document.data.toJSON(), document.writeDenied ? { writeDenied: true } : null);
}

// Companion outline capability, not a replacement for server authorization. Unknown/inherited ACLs stay null.
// Profiles expose name/displayName, not an editable document title. Other unsupported bodies stay read-only.
function editable(n, userUri) {
  if (n.writeDenied) return false; // Tana refused our edits to it (sdk/sync.js _denyWrites), whatever the ACL says
  const kind = (n.id || '').split(':')[1];
  // 'search' is here because a saved search is a document the user owns and renames: a real one carries
  // participants[user] = { type: 'user', role: 'admin' }, so it falls through to the role check below and
  // answers true — the ACL still decides, exactly as it does for text. Unlike 'event' it needs no early
  // return: a search's title is ordinary document data, not a calendar-protected field.
  // 'action' too: an action's body is an ordinary outline (what it will do, in words), and Tana edits it in place,
  // a proposed one included, before it is approved; the ACL decides as it does for text.
  if (!['text', 'space', 'event', 'search', 'action'].includes(kind)) return false;
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
// Tana's transitionTo(state, changedBy) (shared bundle, read 2026-09-23): a plain state drops the workflow keys, a
// workflow state { workflowUri, workflowStateId } (a column of the type's board, workflowStates below) is stateType
// 'open' plus both keys. Clearing a workflow state is setting a plain one.
function setState(document, state, byUri) {
  const column = state && typeof state === 'object';
  if (column ? !WORKFLOW_URI.test(state.workflowUri || '') || typeof state.workflowStateId !== 'string' || !state.workflowStateId : !STATE_TYPES.includes(state)) throw new Error('unknown stateType ' + JSON.stringify(state));
  if (!/^tana:user-profile:/.test(byUri || '')) throw new Error('stateChangedBy must be a tana:user-profile: URI');
  document.transact((loro) => {
    const data = loro.getMap('data');
    data.set('stateType', column ? 'open' : state);
    data.set('stateEnteredAt', Date.now());
    data.set('stateChangedBy', byUri);
    if (column) { data.set('stateWorkflowUri', state.workflowUri); data.set('stateWorkflowStateId', state.workflowStateId); }
    else { data.delete('stateWorkflowUri'); data.delete('stateWorkflowStateId'); }
  });
}

// The states of a tana:workflow: document (a type's data.workflowUri) in board order: data.states, a list of
// { id, name } maps, deduped by id as Tana's own workflow wrapper does before every edit. A task's workflow is its
// own stateWorkflowUri, else its type's workflowUri (Tana's A_ hook).
function workflowStates(document) {
  const seen = new Set();
  return (readNode(document).states || []).filter((s) => s && typeof s.id === 'string' && !seen.has(s.id) && seen.add(s.id)).map(({ id, name }) => ({ id, name }));
}

// Tana's archive(actor) / unarchive(actor) on a loaded document (shared bundle, read 2026-09-23): archived means
// archivedAt > 0, so unarchive writes 0 rather than removing the key, and both stamp archivedBy. A document that is
// not loaded is archived with sync.archive/unarchive (document_action) instead, which is the path the app takes.
function setArchived(document, archived, byUri, now = Date.now()) {
  if (!USER_URI.test(byUri || '')) throw new Error('archivedBy must be a tana:user-profile: URI');
  document.transact((loro) => {
    const data = loro.getMap('data');
    data.set('archivedAt', archived ? now : 0);
    data.set('archivedBy', byUri);
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

// A document's type, set or removed. This is Tana's own `retype` (their shared bundle, read 2026-09-20): the type uri
// is written or deleted and the workflow state keys go with it, because a workflow state is defined by the type that
// is leaving. Their `setEntityType` refuses to replace an existing type and points at `retype` for an explicit
// change, which is exactly what a "Set type" command is, so this follows the retype path and accepts both.
// `workflow` is Tana's one extra rule: a type that defines a workflow expects its documents to be in it, so a
// document with no state at all enters the first one. Which types those are is the caller's to read (the type's own
// `workflowUri`), and the scope rules — what a type applies to, and the space it keeps its documents in — belong
// there too, beside the type node they are read from.
const TYPE_URI = /^tana:type:[0-9a-z]{26}$/;
const WORKFLOW_URI = /^tana:workflow:[0-9a-z]{26}$/;
function setEntityType(document, typeUri, { workflow = false, byUri } = {}) {
  const uri = typeUri == null ? null : typeUri;
  if (uri !== null && !TYPE_URI.test(uri)) throw new Error('Select a workspace type');
  const kind = (document.id || '').split(':')[1];
  if (!['text', 'event'].includes(kind)) throw new Error('Only documents and meetings carry a type');
  const n = readNode(document);
  if ((n.entityTypeUri ?? null) === uri) return uri; // nothing to write, and nothing to undo
  if (workflow && uri && !n.stateType && !USER_URI.test(byUri || '')) throw new Error('stateChangedBy must be a tana:user-profile: URI');
  document.transact((loro) => {
    const data = loro.getMap('data');
    if (uri) data.set('entityTypeUri', uri); else data.delete('entityTypeUri');
    data.delete('stateWorkflowUri');
    data.delete('stateWorkflowStateId');
    if (workflow && uri && !n.stateType) {
      data.set('stateType', 'proposed');
      data.set('stateEnteredAt', Date.now());
      data.set('stateChangedBy', byUri);
    }
  });
  return uri;
}

// Mirrors native Bc scope selection, but unresolved/group audiences stay unknown.
async function audienceMetadata(document, userUri, graph, sync) {
  const direct = taskMeta(document);
  const people = (participants) => {
    if (!participants.length || participants.some(p => p.type !== 'user' || !PERSON_URI.test(p.uri))) return 'unknown';
    return participants.length === 1 && participants[0].uri === userUri ? 'only-me' : 'people';
  };
  // people: who a restricted audience is (#461); hiddenFrom: the assignees outside it, who were given work they cannot
  // open. The grants on the document and on every owner up to the boundary count beside the boundary's, as in
  // access.js audienceOf; everyone is the organization's membership, and an unknown audience names nobody.
  const hidden = (result, participants = []) => {
    if (!['only-me', 'people', 'space'].includes(result.audience)) return result;
    const seen = new Set([...direct.participants, ...participants].map(p => p.uri));
    const hiddenFrom = direct.assignees.filter(uri => !seen.has(uri));
    const people = [...seen].filter(uri => PERSON_URI.test(uri));
    return hiddenFrom.length ? { ...result, people, hiddenFrom } : { ...result, people };
  };
  if (direct.restricted === true) return hidden({ audience: people(direct.participants) });
  // Native setAudienceRule('inherit') deletes restricted; absence also inherits.
  if (direct.restricted !== false && direct.restricted !== undefined) return { audience: 'unknown' };
  try {
    const chain = await graph.getOwnerChain(document.id);
    const owners = (chain.entries || []).filter(e => e.uri !== document.id), at = owners.findIndex(e => e.restricted === true);
    const boundary = owners[at];
    if (boundary) {
      if (owners.slice(0, at + 1).some(e => e.accessible === false)) return { audience: 'unknown' };
      const owner = await sync.subscribe(boundary.uri);
      const between = await Promise.all(owners.slice(0, at).map(e => sync.subscribe(e.uri)));
      // The organization root is restricted to its members, so an org boundary means everyone in the
      // organization (the same membership map access.js checks), plus anyone granted on the way there: a guest or an
      // outside user shared on the document or an owner in between can open it too (access.js audienceOf).
      if (boundary.uri.startsWith('tana:org:')) {
        const members = Object.values(readNode(owner).memberUserProfileDocUris || {});
        const granted = [direct, ...between.map(taskMeta)].flatMap(m => m.participants.map(p => p.uri));
        return members.includes(userUri) ? { audience: 'everyone', people: [...new Set([...members, ...granted])].filter(uri => PERSON_URI.test(uri)) } : { audience: 'unknown' };
      }
      if (taskMeta(owner).restricted !== true) return { audience: 'unknown' };
      const grants = [...new Map([...between, owner].flatMap(d => taskMeta(d).participants).map(p => [p.uri, p])).values()]; // one grant per person, as audienceOf's Object.assign
      const scope = people(grants);
      if (scope !== 'people') return hidden({ audience: scope }, grants); // 'only-me' or 'unknown'
      // An inherited boundary with explicit user participants is as determinate as a direct one: the audience is
      // that participant set (access.js audienceOf agrees). Only a space boundary additionally names a space.
      if (!boundary.uri.startsWith('tana:space:')) return hidden({ audience: 'people' }, grants);
      const title = readNode(owner).title;
      return hidden({ audience: 'space', audienceSpace: { uri: boundary.uri, ...(typeof title === 'string' && title.trim() ? { title } : {}) } }, grants);
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
// A plain value as Tana's schema stores it (cpe/ape in shared-*.js): every object and array under workflowStates and
// attributes is a container there — a workflow state a map, an attribute a map of refs/textMatches/numberRanges lists
// and a date map, each match and range a map — so a search Orbital rewrites keeps the shape Tana gave it. toJSON()
// reads either shape back the same.
function putValue(parent, key, v) {
  if (v === undefined) return;
  const inList = parent instanceof LoroList;
  if (v === null || typeof v !== 'object') { if (inList) parent.push(v); else parent.set(key, v); return; }
  const child = Array.isArray(v) ? new LoroList() : new LoroMap();
  const attached = inList ? parent.insertContainer(parent.length, child) : parent.setContainer(key, child);
  for (const [k, x] of Object.entries(v)) putValue(attached, k, x);
}
function writeSearchQuery(loro, query = {}) {
  const q = loro.getMap('query');
  for (const key of SEARCH_QUERY_LISTS) {
    const list = q.setContainer(key, new LoroList());
    for (const v of Array.isArray(query[key]) ? query[key] : []) putValue(list, null, v);
  }
  // Set or delete, never skip: a flag left alone would survive a rewrite that dropped it, so turning off
  // "assigned to me" and saving would silently keep it on — the lingering filter this whole function exists
  // to prevent. Lists are replaced wholesale for the same reason.
  for (const key of SEARCH_QUERY_FLAGS) {
    if (query[key] !== undefined && query[key] !== null) q.set(key, query[key]);
    else if (q.get(key) !== undefined) q.delete(key);
  }
  const attrs = q.setContainer('attributes', new LoroMap());
  for (const [k, v] of Object.entries(query.attributes || {})) putValue(attrs, k, v);
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
// `display` is the list of facts each row shows, stored in Tana's shape — a map of key -> { shown, order } — because
// Tana's search page reads view.display as exactly that record and would choke on anything else. Tana ignores keys it
// does not know, so Orbital's own keys can live there. searchDisplay reads it back (and the comma-joined string
// earlier builds wrote).
// ponytail: an empty list is stored as an empty map, which Tana also writes for "defaults", so "show nothing" reads
// back as the default; write shown:false entries for the unchosen keys if that choice has to survive.
// `completedWithin` (one of COMPLETED_WINDOWS) is here rather than in the query for the same reason the rest is: Tana's stored
// query has no field for how old a completed task may be, and inventing one would put a key no other client
// understands inside their vocabulary. It does decide which rows are shown, so main applies it to what the query
// answers (sdk/query.js completedInWindow).
// sortBy is Tana's "field" (ascending) or "-field" (descending) over updated, created, title and startTime; Orbital's
// Updated and Created mean newest first, so they are stored with the minus and read back without it (searchSort).
// Orbital's own sorts (status, default) are stored as they are, and Tana ignores a field it does not know.
// ponytail: Tana's oldest-first "updated" reads back as Orbital's newest-first Updated; add a direction if Orbital grows one.
const TANA_SORT = { updated: '-updated', created: '-created' };
const searchSort = (sortBy) => (typeof sortBy === 'string' && sortBy ? sortBy.replace(/^-/, '') : undefined);
function writeSearchView(loro, view = {}) {
  const v = loro.getMap('view');
  for (const key of ['sortBy', 'groupBy']) {
    if (typeof view[key] === 'string' && view[key]) v.set(key, key === 'sortBy' ? TANA_SORT[view[key]] || view[key] : view[key]);
    else if (v.get(key) !== undefined) v.delete(key);
  }
  if (Array.isArray(view.display)) {
    const d = v.setContainer('display', new LoroMap());
    view.display.forEach((key, order) => { const e = d.setContainer(key, new LoroMap()); e.set('shown', true); e.set('order', order); });
  } else if (v.get('display') !== undefined) v.delete('display');
  if (COMPLETED_WINDOWS.includes(view.completedWithin)) v.set('completedWithin', view.completedWithin);
  else if (v.get('completedWithin') !== undefined) v.delete('completedWithin');
  // audience, for the same reason: Tana's query can only say "Open", which is more than everyone (sdk/query.js)
  if (view.audience === 'everyone') v.set('audience', 'everyone');
  else if (v.get('audience') !== undefined) v.delete('audience');
}
function setSearchView(document, view) {
  if ((document.data.get('type')) !== 'search') throw new Error('not a saved search');
  document.transact((loro) => { writeSearchView(loro, view); });
}
// What those two wrote, as JSON: { query, view }. Both are root containers of their own, so readNode never sees them.
const readSearch = (document) => ({ query: document.loro.getMap('query').toJSON(), view: document.loro.getMap('view').toJSON() || {} });
// The facts a saved search's rows show, from its view.display (JSON): the shown keys in order, or undefined for none.
function searchDisplay(display) {
  if (typeof display === 'string') return display.split(',').filter(Boolean);
  if (!display || typeof display !== 'object') return undefined;
  const shown = Object.entries(display).filter(([, e]) => e && e.shown).sort((a, b) => a[1].order - b[1].order).map(([k]) => k);
  return shown.length ? shown : undefined;
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
  if (node.nodeName === 'hardBreak') return '\n'; // an inline line break: inline like a mention, not a block to join around
  const kids = Array.isArray(node.children) ? node.children : [];
  const block = kids.some((k) => k && typeof k === 'object' && k.nodeName !== 'mention' && k.nodeName !== 'hardBreak');
  return kids.map(render).join(block ? '\n' : '');
}

module.exports = { readNode, editable, setTitle, setState, workflowStates, setArchived, setEntityType, taskMeta, audience, audienceMetadata, setAssignees, setSearchQuery, setSearchView, readSearch, searchDisplay, searchSort, contentText, ulid, initDocument, STATE_TYPES, COMPLETED_WINDOWS };
