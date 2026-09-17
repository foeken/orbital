'use strict';
// Search queries with #filters (docs/OUTLINER.md Addendum 6/10): "sam #task" -> text 'sam', tags ['task'].
// #task = documents with a task state, #meeting = events, #member = user profiles, #<Type> = documents of that type
// (title match, case-insensitive).
const { STATE_TYPES } = require('./node');

const SORT = [{ field: 'SORT_FIELD_TEXT_RANK', direction: 'SORT_DIRECTION_DESCENDING' }];
const UPDATE_DESC = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
const KIND_TAGS = ['task', 'meeting', 'member', 'space'];

// ponytail: a tag is one word, so multi-word type titles ("Decision Record") are not reachable; add quoting if wanted.
function parseQuery(query) {
  const tags = [];
  const text = String(query || '').replace(/(^|\s)#(\S+)/g, (_, sp, tag) => { tags.push(tag); return sp; }).replace(/\s+/g, ' ').trim();
  return { text, tags };
}

// graph.listNodes params for a parsed query. `types` maps lowercase type title -> tana:type uri.
// Returns null for an unknown #type (no results) or an empty query.
function searchParams({ text, tags }, types, limit = 20) {
  if (!text && !tags.length) return null;
  const p = { nodeTypes: ['text', 'event', 'user-profile', 'space', 'search'], limit, sortOptions: SORT };
  if (text) p.textQuery = text;
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t === 'task') { p.nodeTypes = ['text']; p.stateTypes = STATE_TYPES; }
    else if (t === 'meeting') p.nodeTypes = ['event'];
    else if (t === 'member') p.nodeTypes = ['user-profile'];
    else if (t === 'space') p.nodeTypes = ['space'];
    else if (types.has(t)) p.entityTypes = [...(p.entityTypes || []), types.get(t)];
    else return null;
  }
  return p;
}

// Does a query need the type list? (only #tags other than task/meeting/member)
const needsTypes = ({ tags }) => tags.some((t) => !KIND_TAGS.includes(t.toLowerCase()));

// ---- Hidden titles: one user-maintained list that keeps matching nodes out of every list and search ----
// Case-insensitive on the node title: a pattern matches the whole title, or its start when it ends with '*'.
// "Block*" hides "Block" and "Block (Really)"; "Block *" only the latter; "Lunch" only "Lunch"; a full title
// ("Remote / WFH (non-blocking)") needs no syntax at all. One glob character, no regex, no query language.
// A bare '*' is dropped: it would empty every view, which is never what the user meant to configure.
const HIDE_MAX = 200; // patterns kept, and characters per pattern
const hideRules = (list) => {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).filter((p) => typeof p === 'string').map((p) => p.trim().slice(0, HIDE_MAX))
    .filter((p) => p && p !== '*' && !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).slice(0, HIDE_MAX);
};
const isHidden = (title, rules) => {
  const t = String(title ?? '').trim().toLowerCase();
  if (!t || !Array.isArray(rules)) return false;
  return rules.some((rule) => {
    const p = String(rule ?? '').trim().toLowerCase();
    return p.endsWith('*') ? p.length > 1 && t.startsWith(p.slice(0, -1)) : p === t;
  });
};

// ---- Views (docs/VIEWS.md) ----
// A saved search is a document like any other listed kind: Tana's own client groups `search` with text, event, chat,
// canvas, agent and skill as a document kind (and keeps `liveQuery`, a materialised result cache, well away from them).
const VIEW_KINDS = ['meetings', 'tasks', 'docs', 'chats', 'canvases', 'agents', 'skills', 'searches', 'spaces', 'people'];
const KIND_NODE_TYPE = { meetings: 'event', tasks: 'text', docs: 'text', chats: 'chat', canvases: 'canvas', agents: 'agent', skills: 'skill', searches: 'search', spaces: 'space', people: 'user-profile' };
// Spaces and people are containers and members, not library content: they are listed when asked for by name.
const ANY_KINDS = VIEW_KINDS.filter((k) => k !== 'people' && k !== 'spaces');
const VIEW_PRESETS = {
  inbox: { types: null, states: ['proposed'], assignee: 'anyone' },
  tasks: { types: ['tasks'], states: ['proposed', 'open', 'not_now'], assignee: 'me' }, // everything not yet done: Inbox, In Progress, Later
  meetings: { types: ['meetings'], participant: 'me', window: 'recent' },
  library: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' },
  chats: { types: ['chats'] },
  people: { types: ['people'] },
};
// A page that is a kind: Tasks lists tasks, People lists people. Its type is its identity, so it is not offered as a
// filter and a stored one cannot override it — only the Library and the Inbox choose their kinds.
const KIND_VIEWS = new Set(['tasks', 'meetings', 'chats', 'people']);
const viewTypes = (id, f) => (KIND_VIEWS.has(id) ? { ...f, types: VIEW_PRESETS[id].types } : f);

// assignee: 'me' | 'anyone' | 'unassigned' | <user-profile uri>
function assigneeParams(assignee, me) {
  if (assignee === 'anyone') return {};
  if (assignee === 'unassigned') return { unassigned: true };
  return { assignedTo: [assignee === 'me' || !assignee ? me : assignee] };
}

const FILTER_KEYS = new Set(['types', 'states', 'assignee', 'text', 'participant', 'window']);
const USER = /^tana:user-profile:[0-9a-z]{26}$/;
function validViewFilter(f) {
  return !!f && !Array.isArray(f) && typeof f === 'object' && Object.keys(f).every((k) => FILTER_KEYS.has(k))
    && (f.types === undefined || f.types === null || Array.isArray(f.types) && f.types.every((x) => VIEW_KINDS.includes(x)))
    && (f.states === undefined || f.states === null || Array.isArray(f.states) && f.states.every((x) => STATE_TYPES.includes(x)))
    && (f.assignee === undefined || ['me', 'anyone', 'unassigned'].includes(f.assignee) || USER.test(f.assignee))
    && (f.text === undefined || typeof f.text === 'string')
    && (f.participant === undefined || f.participant === null || f.participant === 'me')
    && (f.window === undefined || f.window === null || f.window === 'recent');
}

function viewParams(f, me, limit = 1000) {
  if (!validViewFilter(f)) throw new Error('invalid view filter');
  // No kinds selected is "any kind we list", never an unconstrained query: nodeTypes: [] is no filter at all to the
  // graph, which answers with images, calls and transcripts that no view can render.
  const kinds = f.types && f.types.length ? f.types : ANY_KINDS;
  const p = {
    nodeTypes: [...new Set(kinds.map((k) => KIND_NODE_TYPE[k]))], limit,
    sortOptions: f.types && f.types.length === 1 && f.types[0] === 'meetings'
      ? [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] : UPDATE_DESC,
    mode: 'LIST_NODES_MODE_WITH_COUNT',
  };
  // A state and an assignee only mean something while tasks are in the selection, which is exactly when those two
  // pills are shown. Applying a hidden filter is how picking People in the Library returned nothing: no person has
  // a task state, so the saved "Inbox, In Progress" quietly emptied the list.
  if (kinds.includes('tasks')) {
    if (f.states !== undefined && f.states !== null) p.stateTypes = f.states;
    Object.assign(p, assigneeParams(f.assignee, me));
  }
  if (f.text) p.textQuery = f.text.trim();
  if (f.participant === 'me') p.hasParticipantUris = [me];
  if (f.window === 'recent') {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 7);
    p.eventStartTimeMin = start.toISOString();
    p.eventStartTimeMax = new Date(start.getTime() + 14 * 864e5).toISOString();
  }
  return p;
}

// A saved search's stored `query` root container as graph.listNodes params (docs/…/2026-09-16-saved-searches-design.md).
// Every field is guarded: a real search document omits optional keys rather than writing them empty.
// `visibility`, `workflowStates` and `attributes` are deliberately not translated — see the spec's §4.
function searchQueryParams(query, me, limit = 1000) {
  const q = query || {};
  const list = (v) => (Array.isArray(v) && v.length ? v : undefined);
  const p = { limit, sortOptions: UPDATE_DESC, mode: 'LIST_NODES_MODE_WITH_COUNT' };
  // nodeTypes: [] is no filter at all to the graph, which answers with images, calls and transcripts no view can
  // render, so an unconstrained search falls back to the kinds a view lists — the same rule viewParams follows.
  p.nodeTypes = list(q.types) || [...new Set(ANY_KINDS.map((k) => KIND_NODE_TYPE[k]))];
  if (typeof q.textQuery === 'string' && q.textQuery.trim()) p.textQuery = q.textQuery.trim();
  if (list(q.entityTypeUris)) p.entityTypes = q.entityTypeUris;
  if (list(q.ownerUris)) p.ownerIds = q.ownerUris;
  if (list(q.stateTypes)) p.stateTypes = q.stateTypes;
  if (list(q.participantUris)) p.hasParticipantUris = q.participantUris;
  const assigned = [...(list(q.assignedTo) || []), ...(q.assignedToViewer === true && me ? [me] : [])];
  if (assigned.length) p.assignedTo = [...new Set(assigned)];
  const created = [...(list(q.createdBy) || []), ...(q.createdByViewer === true && me ? [me] : [])];
  if (created.length) p.createdBy = [...new Set(created)];
  if (q.unassigned === true) p.unassigned = true;
  const t = q.eventTime;
  if (t && t.min != null) p.eventStartTimeMin = new Date(t.min).toISOString();
  if (t && t.max != null) p.eventStartTimeMax = new Date(t.max).toISOString();
  return p;
}

// The inverse of searchQueryParams: a view's filter as a saved search's stored query, so "save this query as a
// search" keeps what the pills are showing. It lives beside its inverse so one test can round-trip the pair.
// Two asymmetries are deliberate, not oversights:
//   - `participant: 'me'` has no viewer-relative form in the stored schema (it has participantUris and no
//     participantsViewer, unlike assignedTo/createdBy), so it is baked in as the user's own uri. A search saved
//     from Meetings therefore names you rather than "whoever is viewing" — correct for a personal search.
//   - `window: 'recent'` becomes a concrete eventTime range at save time, since the stored schema's preset
//     vocabulary (recent/upcoming/today/past) is not translated on the way back out.
function filterToSearchQuery(filter = {}, me) {
  const q = {};
  const kinds = Array.isArray(filter.types) && filter.types.length ? filter.types : null;
  if (kinds) q.types = [...new Set(kinds.map((k) => KIND_NODE_TYPE[k]).filter(Boolean))];
  if (Array.isArray(filter.states) && filter.states.length) q.stateTypes = [...filter.states];
  if (typeof filter.text === 'string' && filter.text.trim()) q.textQuery = filter.text.trim();
  const a = filter.assignee;
  // 'me' without a signed-in user stores nothing: falling through to the uri branch would write the literal
  // string 'me' as a user-profile uri, which matches nobody and reads as a real filter for ever after.
  if (a === 'me') { if (me) q.assignedToViewer = true; }
  else if (a === 'unassigned') q.unassigned = true;
  else if (a && a !== 'anyone') q.assignedTo = [a];
  if (filter.participant === 'me' && me) q.participantUris = [me];
  if (filter.window === 'recent') {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 7);
    q.eventTime = { min: start.getTime(), max: start.getTime() + 14 * 864e5 };
  }
  return q;
}

// The other direction: a saved search's stored query as a view filter, so the pills that edit a view can edit a
// saved search too. Two things make this lossy, and both guess deliberately rather than refuse:
//   - Several view kinds share one node type (tasks and docs are both `text`), so a stored `text` reads as tasks
//     when the query also constrains task state and as docs otherwise — the same reading viewRows applies at its
//     docsWithoutTasks line when it separates those two.
//   - A query can say things no pill can (attributes, workflowStates, visibility, several assignees at once).
//     Those are dropped here rather than approximated, so what comes back is exactly what the pills can show.
// Saving therefore rewrites the query from the pills alone: anything in the first bullet survives, anything in the
// second does not, which is why saving is an explicit action on a saved search rather than a write per keystroke.
const NODE_TYPE_KIND = { event: 'meetings', chat: 'chats', canvas: 'canvases', agent: 'agents', skill: 'skills', search: 'searches', space: 'spaces', 'user-profile': 'people' };
function searchQueryToFilter(query, me) {
  const q = query || {};
  const list = (v) => (Array.isArray(v) && v.length ? v : null);
  const states = (list(q.stateTypes) || []).filter((s) => STATE_TYPES.includes(s));
  const types = list(q.types);
  const kinds = types ? [...new Set(types.map((t) => (t === 'text' ? (states.length ? 'tasks' : 'docs') : NODE_TYPE_KIND[t])).filter((k) => VIEW_KINDS.includes(k)))] : [];
  const assigned = list(q.assignedTo) || [];
  const f = {
    types: kinds.length ? kinds : null,
    states: states.length ? states : null,
    text: typeof q.textQuery === 'string' ? q.textQuery : '',
    participant: me && (list(q.participantUris) || []).includes(me) ? 'me' : null,
    window: q.eventTime && (q.eventTime.min != null || q.eventTime.max != null) ? 'recent' : null,
  };
  // assignedToViewer and an assignedTo that happens to be the signed-in user mean the same thing to a pill ("You"),
  // so both come back as 'me' — writing it out again as assignedToViewer, which is what the viewer-relative pill means.
  if (q.assignedToViewer === true || (me && assigned.includes(me))) f.assignee = 'me';
  else if (q.unassigned === true) f.assignee = 'unassigned';
  else f.assignee = assigned.find((uri) => USER.test(uri)) || 'anyone';
  return f;
}

module.exports = { parseQuery, searchParams, needsTypes, viewParams, searchQueryParams, filterToSearchQuery, searchQueryToFilter, validViewFilter, viewTypes, VIEW_PRESETS, VIEW_KINDS, KIND_VIEWS, hideRules, isHidden };
