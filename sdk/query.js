'use strict';
// Search queries with #filters (docs/OUTLINER.md Addendum 6/10): "lex #task" -> text 'lex', tags ['task'].
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

// ---- Tasks view / Library filters (Addendum 10/11) ----
const DEFAULT_TASK_FILTER = { states: ['proposed', 'open'], assignee: 'me' };
const DEFAULT_LIBRARY_FILTER = { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' };
const LIBRARY_KINDS = ['meetings', 'tasks', 'docs', 'chats', 'canvases', 'agents', 'skills'];
const KIND_NODE_TYPE = { meetings: 'event', docs: 'text', chats: 'chat', canvases: 'canvas', agents: 'agent', skills: 'skill' };

// assignee: 'me' | 'anyone' | 'unassigned' | <user-profile uri>
function assigneeParams(assignee, me) {
  if (assignee === 'anyone') return {};
  if (assignee === 'unassigned') return { unassigned: true };
  return { assignedTo: [assignee === 'me' || !assignee ? me : assignee] };
}

// listNodes params for the Tasks view: states null = all four
function taskParams(f, me, limit = 500) {
  return { nodeTypes: ['text'], stateTypes: f.states || STATE_TYPES, ...assigneeParams(f.assignee, me), limit, sortOptions: UPDATE_DESC };
}

// One listNodes per selected kind: [{ kind, params }]. 'docs' returns all text nodes; the caller drops those with a state.
function libraryQueries(f, me, limit = 100) {
  const text = String(f.text || '').trim();
  return (f.types || LIBRARY_KINDS).map((kind) => {
    if (!LIBRARY_KINDS.includes(kind)) throw new Error('unknown library type: ' + kind);
    const params = kind === 'tasks' ? taskParams(f, me, limit) : { nodeTypes: [KIND_NODE_TYPE[kind]], limit, sortOptions: UPDATE_DESC };
    if (text) params.textQuery = text;
    return { kind, params };
  });
}

module.exports = { parseQuery, searchParams, needsTypes, taskParams, libraryQueries, DEFAULT_TASK_FILTER, DEFAULT_LIBRARY_FILTER, LIBRARY_KINDS };
