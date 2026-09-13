'use strict';
// Search queries with #filters (docs/OUTLINER.md Addendum 6): "lex #task" -> text 'lex', tags ['task'].
// #task = documents with a task state, #meeting = events, #<Type> = documents of that type (title match, case-insensitive).
const { STATE_TYPES } = require('./node');

const SORT = [{ field: 'SORT_FIELD_TEXT_RANK', direction: 'SORT_DIRECTION_DESCENDING' }];

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
  const p = { nodeTypes: ['text', 'event'], limit, sortOptions: SORT };
  if (text) p.textQuery = text;
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t === 'task') { p.nodeTypes = ['text']; p.stateTypes = STATE_TYPES; }
    else if (t === 'meeting') p.nodeTypes = ['event'];
    else if (types.has(t)) p.entityTypes = [...(p.entityTypes || []), types.get(t)];
    else return null;
  }
  return p;
}

// Does a query need the type list? (only #tags other than task/meeting)
const needsTypes = ({ tags }) => tags.some((t) => !['task', 'meeting'].includes(t.toLowerCase()));

module.exports = { parseQuery, searchParams, needsTypes };
