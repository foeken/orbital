'use strict';
// Search queries with #filters (docs/OUTLINER.md Addendum 6/10): "sam #task" -> text 'sam', tags ['task'].
// #task = documents with a task state, #meeting = events, #member = user profiles, #<Type> = documents of that type
// (title match, case-insensitive).
const { STATE_TYPES } = require('./node');

const SORT = [{ field: 'SORT_FIELD_TEXT_RANK', direction: 'SORT_DIRECTION_DESCENDING' }];
const UPDATE_DESC = [{ field: 'SORT_FIELD_UPDATE_TIME', direction: 'SORT_DIRECTION_DESCENDING' }];
const KIND_TAGS = ['task', 'meeting', 'member'];

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
  const p = { nodeTypes: ['text', 'event', 'user-profile'], limit, sortOptions: SORT };
  if (text) p.textQuery = text;
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t === 'task') { p.nodeTypes = ['text']; p.stateTypes = STATE_TYPES; }
    else if (t === 'meeting') p.nodeTypes = ['event'];
    else if (t === 'member') p.nodeTypes = ['user-profile'];
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
const VIEW_KINDS = ['meetings', 'tasks', 'docs', 'chats', 'canvases', 'agents', 'skills', 'people'];
const KIND_NODE_TYPE = { meetings: 'event', tasks: 'text', docs: 'text', chats: 'chat', canvases: 'canvas', agents: 'agent', skills: 'skill', people: 'user-profile' };
const VIEW_PRESETS = {
  inbox: { types: null, states: ['proposed'], assignee: 'anyone' },
  tasks: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me' },
  meetings: { types: ['meetings'], participant: 'me', window: 'recent' },
  library: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' },
  chats: { types: ['chats'], mcp: false },
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

const FILTER_KEYS = new Set(['types', 'states', 'assignee', 'text', 'participant', 'window', 'mcp']);
const USER = /^tana:user-profile:[0-9a-z]{26}$/;
function validViewFilter(f) {
  return !!f && !Array.isArray(f) && typeof f === 'object' && Object.keys(f).every((k) => FILTER_KEYS.has(k))
    && (f.types === undefined || f.types === null || Array.isArray(f.types) && f.types.every((x) => VIEW_KINDS.includes(x)))
    && (f.states === undefined || f.states === null || Array.isArray(f.states) && f.states.every((x) => STATE_TYPES.includes(x)))
    && (f.assignee === undefined || ['me', 'anyone', 'unassigned'].includes(f.assignee) || USER.test(f.assignee))
    && (f.text === undefined || typeof f.text === 'string')
    && (f.participant === undefined || f.participant === null || f.participant === 'me')
    && (f.window === undefined || f.window === null || f.window === 'recent')
    && (f.mcp === undefined || typeof f.mcp === 'boolean');
}

function viewParams(f, me, limit = 1000) {
  if (!validViewFilter(f)) throw new Error('invalid view filter');
  // No kinds selected is "any kind we list", never an unconstrained query: nodeTypes: [] is no filter at all to the
  // graph, which answers with images, calls and transcripts that no view can render.
  const kinds = f.types && f.types.length ? f.types : VIEW_KINDS.filter((k) => k !== 'people');
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

module.exports = { parseQuery, searchParams, needsTypes, viewParams, validViewFilter, viewTypes, VIEW_PRESETS, VIEW_KINDS, KIND_VIEWS, hideRules, isHidden };
