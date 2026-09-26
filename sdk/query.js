'use strict';
// Search queries with #filters (docs/OUTLINER.md §8, Cmd+S search): "sam #task" -> text 'sam', tags ['task'].
// #task = documents with a task state, #meeting = events, #member = user profiles, #<Type> = documents of that type
// (title match, case-insensitive).
const { STATE_TYPES, COMPLETED_WINDOWS } = require('./node');

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
// The one table of view kinds: a kind listed here is a Type pill choice, a filter kind and a saved-search type both ways.
const KIND_NODE_TYPE = { meetings: 'event', tasks: 'text', docs: 'text', chats: 'chat', canvases: 'canvas', agents: 'agent', skills: 'skill', searches: 'search', spaces: 'space', people: 'user-profile', types: 'type' };
const VIEW_KINDS = Object.keys(KIND_NODE_TYPE);
// and back; `text` is tasks or docs, which searchQueryToFilter tells apart by task state
const NODE_TYPE_KIND = Object.fromEntries(Object.entries(KIND_NODE_TYPE).filter(([, t]) => t !== 'text').map(([k, t]) => [t, k]));
// Spaces, people and types are containers, members and schema, not library content: each is listed when asked for by name.
const ANY_KINDS = VIEW_KINDS.filter((k) => !['people', 'spaces', 'types'].includes(k));
// Meetings, Chats and People are no longer views: each was a fixed query over a single kind, which is what a saved
// search is — except a search can be renamed, re-aimed and kept. The kinds themselves stay in VIEW_KINDS above, so
// those lists remain one search away rather than being lost with the pages.
const VIEW_PRESETS = {
  inbox: { types: null, states: ['proposed'], assignee: 'anyone' },
  // The My Tasks saved search: every task in every state, whoever has it, completed ones for three days (#113).
  library: { types: ['tasks'], states: ['proposed', 'open', 'closed', 'not_now'], assignee: 'anyone', text: '', completedWithin: 3 },
  // The workspace's schema, with the space each type lives in (main/views.js puts the space title on the row).
  types: { types: ['types'] },
};
// A page that is a kind — its type was its identity, so it was not offered as a filter and a stored one could not
// override it — was the last thing KIND_VIEWS and viewTypes were for. Tasks was the last of them: no view is a
// kind page now, every view chooses what it lists, and a filter is used exactly as it is given.

// assignee: 'me' | 'anyone' | 'unassigned' | <user-profile uri>
function assigneeParams(assignee, me) {
  if (assignee === 'anyone') return {};
  if (assignee === 'unassigned') return { unassigned: true };
  return { assignedTo: [assignee === 'me' || !assignee ? me : assignee] };
}

// audience: 'everyone' lists what everyone in the org can see (#253). The graph can only ask Tana's "Open" (restricted:
// false, which includes whatever a restricted space or meeting holds), so that is the query and access.js
// everyoneOnly narrows the answer, the way completedWithin is applied after the query.
const FILTER_KEYS = new Set(['types', 'states', 'assignee', 'text', 'participant', 'window', 'completedWithin', 'fields', 'audience']);
const USER = /^tana:user-profile:[0-9a-z]{26}$/;
// A filter's types may also name the workspace's own types (`tana:type:` uris, #139): every Risk, say. They are sent as
// entityTypes, which the graph ORs among themselves and ANDs with the kinds (verified live 2026-09-25: Risk 18 +
// Project 5 = 23 together). Only types chosen means what they are, whatever kind, so the task-only filters stay off:
// a risk has no state, and the Library's "every state" would otherwise have emptied the list.
const TYPE_URI = /^tana:type:[0-9a-z]{26}$/;
const splitTypes = (types) => { const all = Array.isArray(types) ? types : []; return { kinds: all.filter((t) => !TYPE_URI.test(t)), typeUris: all.filter((t) => TYPE_URI.test(t)) }; };
const tasksInScope = (types) => { const { kinds, typeUris } = splitTypes(types); return kinds.length ? kinds.includes('tasks') : !typeUris.length; };
// Completed tasks are the one thing a list drowns in, so a window says how far back they still count: 3 days, 7
// days, 30 days, or All. Whether they appear at all is the Status filter's business and only its — this never hides them,
// it only ages them out, which is why it has no "off" and why its value is kept while Completed is out of Status.
// The clock is the task's own `state.enteredAt`: when it entered the state it is in, which for a closed task is
// when it was completed. Not update time, which moves for an edit or a re-sync long after the work was done. The
// graph's index carries it on every node it lists (Node.TaskState.entered_at), so this costs no extra read — and
// the request has no field for it, so the window is applied to what the query answers rather than asked for.
// Rolling and absolute: exactly N×24h back from now, so "does today count" has no answer to get wrong at a
// boundary. A closed task whose enteredAt is missing or unreadable cannot be shown to be recent, so a window
// leaves it out; All has no clock and keeps every one of them.
const completedWindow = (within) => (COMPLETED_WINDOWS.includes(within) ? within : 7); // unset, or a stale value, is the default
function completedInWindow(n, within, now = Date.now()) {
  const days = completedWindow(within);
  if (days === 'all' || !n || !n.state || n.state.type !== 'closed') return true;
  return Date.parse(n.state.enteredAt) >= now - days * 864e5; // NaN compares false: an unknown time is not a recent one
}
function validViewFilter(f) {
  return !!f && !Array.isArray(f) && typeof f === 'object' && Object.keys(f).every((k) => FILTER_KEYS.has(k))
    && (f.types === undefined || f.types === null || Array.isArray(f.types) && f.types.every((x) => VIEW_KINDS.includes(x) || TYPE_URI.test(x)))
    && (f.states === undefined || f.states === null || Array.isArray(f.states) && f.states.every((x) => STATE_TYPES.includes(x)))
    && (f.assignee === undefined || ['me', 'anyone', 'unassigned'].includes(f.assignee) || USER.test(f.assignee))
    && (f.text === undefined || typeof f.text === 'string')
    && (f.participant === undefined || f.participant === null || f.participant === 'me')
    && (f.window === undefined || f.window === null || f.window === 'recent')
    && (f.completedWithin === undefined || COMPLETED_WINDOWS.includes(f.completedWithin))
    && (f.audience === undefined || f.audience === null || f.audience === 'everyone')
    // a type page's field pills: Tana's own stored attributes ({ refs, textMatches, date } per field key), which
    // filterToSearchQuery passes on and attributeFilters cleans the way Tana does
    && (f.fields === undefined || f.fields === null || (typeof f.fields === 'object' && !Array.isArray(f.fields)
      && Object.entries(f.fields).every(([k, v]) => FIELD_KEY.test(k) && !!v && typeof v === 'object' && !Array.isArray(v))));
}
const FIELD_KEY = /^tana:type:[0-9a-z]{26}\?attribute=[0-9a-z]+$/;
// A filter's field values count only while it lists one workspace type alone, the one they belong to: beside another
// type or a kind they would silently drop every row of those, and no pill would show why.
function typeFields(f) {
  const { kinds, typeUris } = splitTypes(f.types);
  if (kinds.length || typeUris.length !== 1 || !f.fields) return null;
  const own = Object.fromEntries(Object.entries(f.fields).filter(([k]) => k.startsWith(typeUris[0] + '?attribute=')));
  return Object.keys(own).length ? own : null;
}

function viewParams(f, me, limit = 1000) {
  if (!validViewFilter(f)) throw new Error('invalid view filter');
  // No kinds selected is "any kind we list", never an unconstrained query: nodeTypes: [] is no filter at all to the
  // graph, which answers with images, calls and transcripts that no view can render.
  const { kinds: chosen, typeUris } = splitTypes(f.types), kinds = chosen.length ? chosen : ANY_KINDS;
  const p = {
    nodeTypes: [...new Set(kinds.map((k) => KIND_NODE_TYPE[k]))], limit,
    sortOptions: f.types && f.types.length === 1 && f.types[0] === 'meetings'
      ? [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: 'SORT_DIRECTION_ASCENDING' }] : UPDATE_DESC,
    mode: 'LIST_NODES_MODE_WITH_COUNT',
  };
  if (typeUris.length) p.entityTypes = typeUris;
  // A state and an assignee only mean something while tasks are in the selection, which is exactly when those two
  // pills are shown. Applying a hidden filter is how picking People in the Library returned nothing: no person has
  // a task state, so the saved "Inbox, In Progress" quietly emptied the list.
  if (tasksInScope(f.types)) {
    if (f.states !== undefined && f.states !== null) p.stateTypes = f.states;
    Object.assign(p, assigneeParams(f.assignee, me));
  }
  if (f.text) p.textQuery = f.text.trim();
  if (f.audience === 'everyone') p.restricted = false;
  const attributes = attributeFilters(typeFields(f), Date.now());
  if (attributes) p.attributeFilters = attributes;
  if (f.participant === 'me') p.hasParticipantUris = [me];
  if (f.window === 'recent') {
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 7);
    p.eventStartTimeMin = start.toISOString();
    p.eventStartTimeMax = new Date(start.getTime() + 14 * 864e5).toISOString();
  }
  return p;
}

// A saved search's stored `query` root container as graph.listNodes params, the way Tana's own client runs one
// (C$ in home.tana.inc/assets/shared-*.js, which also fixes the three the saved-searches spec left open: visibility,
// workflowStates and attributes). Every field is guarded: a real search document omits optional keys rather than
// writing them empty, and protobuf JSON refuses an undefined value, so nothing undefined is ever set.
// `spaces` is the org's space list, for widening a scoped space to its sub-spaces (searchOwners); the caller lists it.
function searchQueryParams(query, me, limit = 1000, now = Date.now(), spaces = []) {
  const q = query || {};
  const list = (v) => (Array.isArray(v) && v.length ? v : undefined);
  const p = { limit, mode: 'LIST_NODES_MODE_WITH_COUNT' };
  // nodeTypes: [] is no filter at all to the graph, which answers with images, calls and transcripts no view can
  // render, so an unconstrained search falls back to the kinds a view lists — the same rule viewParams follows.
  p.nodeTypes = list(q.types) || [...new Set(ANY_KINDS.map((k) => KIND_NODE_TYPE[k]))];
  const eventsOnly = Array.isArray(q.types) && q.types.length === 1 && q.types[0] === 'event';
  if (typeof q.textQuery === 'string' && q.textQuery.trim()) p.textQuery = q.textQuery.trim();
  if (list(q.entityTypeUris)) p.entityTypes = q.entityTypeUris;
  const owners = searchOwners(list(q.ownerUris) || [], spaces);
  if (owners.length) p.ownerIds = owners;
  // A workflow state is an open task in that workflow's state: Tana sends each as a selector beside the plain states.
  const flows = [...new Map((list(q.workflowStates) || []).filter((w) => w && typeof w.workflowUri === 'string' && typeof w.workflowStateId === 'string')
    .map((w) => [w.workflowUri + '#' + w.workflowStateId, { type: 'open', workflowUri: w.workflowUri, workflowStateId: w.workflowStateId }])).values()];
  if (flows.length) p.stateSelectors = [...(list(q.stateTypes) || []).map((type) => ({ type })), ...flows];
  const states = p.stateSelectors ? [...new Set(p.stateSelectors.map((s) => s.type))] : list(q.stateTypes);
  if (states) p.stateTypes = states;
  const seen = visibilityParams(q.visibility, me);
  const participants = [...(list(q.participantUris) || []), ...(seen.hasParticipantUris || [])];
  if (participants.length) p.hasParticipantUris = participants;
  for (const key of ['restricted', 'exactParticipantUris', 'linkShared']) if (seen[key] !== undefined) p[key] = seen[key];
  const assigned = [...(list(q.assignedTo) || []), ...(q.assignedToViewer === true && me ? [me] : [])];
  if (assigned.length && q.unassigned !== true) p.assignedTo = [...new Set(assigned)]; // unassigned wins, as in Tana
  const created = [...(list(q.createdBy) || []), ...(q.createdByViewer === true && me ? [me] : [])];
  if (created.length) p.createdBy = [...new Set(created)];
  if (q.unassigned === true) p.unassigned = true;
  // The event window only applies to a search for events alone; on anything else Tana ignores it.
  const t = eventsOnly ? timeRange(q.eventTime, now) : {};
  if (t.min != null) p.eventStartTimeMin = new Date(t.min).toISOString();
  if (t.max != null) p.eventStartTimeMax = new Date(t.max).toISOString();
  const attributes = attributeFilters(q.attributes, now);
  if (attributes) p.attributeFilters = attributes;
  // Tana's default order: none with text (the server ranks it), start time for events (newest first unless the window
  // is "upcoming"), title for a list of types, last update otherwise. The stored view.sortBy is not read here: the
  // renderer sorts the rows itself, and Orbital writes that key in its own vocabulary.
  if (!p.textQuery) {
    const types = list(q.types) || [], typed = !!list(q.entityTypeUris);
    p.sortOptions = eventsOnly && !typed ? [{ field: 'SORT_FIELD_EVENT_START_TIME', direction: q.eventTime && q.eventTime.preset === 'upcoming' ? 'SORT_DIRECTION_ASCENDING' : 'SORT_DIRECTION_DESCENDING' }]
      : types.length === 1 && types[0] === 'type' && !typed ? [{ field: 'SORT_FIELD_TITLE', direction: 'SORT_DIRECTION_ASCENDING' }] : UPDATE_DESC;
  }
  return p;
}
// The owners a saved search is scoped to, widened the way Tana's runner widens them (C$e and oy in shared-*.js): a
// space stands for itself and every space beneath it, at any depth, so a search scoped to a parent space finds what
// its sub-spaces hold. `spaces` are graph space nodes ({ id, ownerUri, archivedAt }). Archived ones are left out of
// the tree as Tana leaves them out of its own (Mv), which also cuts off what sits under them; a scoped space itself
// always stays. Anything that is not a Tana uri is dropped, and nothing is listed twice.
function searchOwners(ownerUris, spaces = []) {
  // archived = archivedAt after 1970 (Tana's Mv: > 0); unarchive writes 0, which the graph may send as the epoch
  const live = spaces.filter((s) => s && !(Date.parse(s.archivedAt) > 0)), ids = new Set(live.map((s) => s.id)), children = new Map();
  for (const s of live) if (ids.has(s.ownerUri)) children.set(s.ownerUri, [...(children.get(s.ownerUri) || []), s.id]);
  const out = new Set(), stack = ownerUris.filter((u) => typeof u === 'string' && u.startsWith('tana:')).reverse();
  while (stack.length) {
    const uri = stack.pop();
    if (!out.has(uri)) { out.add(uri); stack.push(...(children.get(uri) || [])); }
  }
  return [...out];
}
// visibility (private | shared | restricted | open | link) as the graph's own filters, exactly as Tana maps it (y$).
function visibilityParams(visibility, me) {
  if (visibility === 'private') return me ? { restricted: true, exactParticipantUris: [me] } : {};
  if (visibility === 'shared') return me ? { hasParticipantUris: [me] } : {};
  if (visibility === 'restricted') return { restricted: true };
  if (visibility === 'open') return { restricted: false };
  if (visibility === 'link') return { linkShared: true };
  return {};
}
// A stored { preset } or { min, max } (epoch ms) as a { min, max } window. The presets are Tana's (v$), on local days:
// recent = up to the end of tomorrow, upcoming = from now, past = until now, today = today.
function timeRange(range, now) {
  if (!range || typeof range !== 'object') return {};
  if (range.preset === undefined) return { min: range.min, max: range.max };
  const day = (offset) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset); return d.getTime(); };
  return { recent: { max: day(2) - 1 }, upcoming: { min: now }, past: { max: now }, today: { min: day(0), max: day(1) - 1 } }[range.preset] || {};
}
const TEXT_MODES = { equals: 'MODE_EQUALS', prefix: 'MODE_PREFIX', listContains: 'MODE_LIST_CONTAINS' };
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
// The stored attributes ({ '<type uri>?attribute=<key>': { refs, date, textMatches, numberRanges } }) as the
// request's attributeFilters, keeping only what Tana's client keeps (X2t).
function attributeFilters(attributes, now) {
  const out = {};
  for (const [key, a] of Object.entries(attributes && typeof attributes === 'object' ? attributes : {})) {
    if (!key.startsWith('tana:') || !a || typeof a !== 'object') continue;
    const f = {}, arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    const refs = (Array.isArray(a.refs) ? a.refs : []).filter((r) => typeof r === 'string' && r.startsWith('tana:'));
    if (refs.length) f.refs = refs;
    const date = defined(timeRange(a.date, now));
    if (Object.keys(date).length) f.dateRanges = [date];
    const texts = arr(a.textMatches).filter((m) => typeof m.value === 'string' && m.value.trim() && (m.mode === undefined || Object.hasOwn(TEXT_MODES, m.mode)));
    if (texts.length) f.textMatches = texts.map((m) => ({ value: m.value, mode: TEXT_MODES[m.mode || 'equals'] }));
    const numbers = arr(a.numberRanges).map((r) => defined({ min: r.min, max: r.max })).filter((r) => Object.keys(r).length);
    if (numbers.length) f.numberRanges = numbers;
    if (Object.keys(f).length) out[key] = f;
  }
  return Object.keys(out).length ? out : undefined;
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
  const { kinds: chosen, typeUris } = splitTypes(kinds);
  if (chosen.length) q.types = [...new Set(chosen.map((k) => KIND_NODE_TYPE[k]).filter(Boolean))];
  if (typeUris.length) q.entityTypeUris = typeUris;
  // the view's rule (viewParams): a state or an assignee is only stored while tasks are in scope
  const tasks = tasksInScope(filter.types);
  if (tasks && Array.isArray(filter.states) && filter.states.length) q.stateTypes = [...filter.states];
  if (typeof filter.text === 'string' && filter.text.trim()) q.textQuery = filter.text.trim();
  const fields = typeFields(filter);
  if (fields) q.attributes = fields;
  const a = tasks ? filter.assignee : 'anyone';
  // 'me' without a signed-in user stores nothing: falling through to the uri branch would write the literal
  // string 'me' as a user-profile uri, which matches nobody and reads as a real filter for ever after.
  if (a === 'me') { if (me) q.assignedToViewer = true; }
  else if (a === 'unassigned') q.unassigned = true;
  else if (a && a !== 'anyone') q.assignedTo = [a];
  if (filter.participant === 'me' && me) q.participantUris = [me];
  if (filter.audience === 'everyone') q.visibility = 'open'; // Tana's nearest: its client lists this superset (#253)
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
//   - A query can say things no pill can (workflowStates, visibility, several assignees at once, attributes unless
//     the query lists one workspace type alone — then they are that type's field pills).
//     Those are dropped here rather than approximated, so what comes back is exactly what the pills can show.
// Saving therefore rewrites the query from the pills alone: anything in the first bullet survives, anything in the
// second does not, which is why saving is an explicit action on a saved search rather than a write per keystroke.
function searchQueryToFilter(query, me) {
  const q = query || {};
  const list = (v) => (Array.isArray(v) && v.length ? v : null);
  const states = (list(q.stateTypes) || []).filter((s) => STATE_TYPES.includes(s));
  const types = list(q.types);
  const kinds = types ? [...new Set(types.map((t) => (t === 'text' ? (states.length ? 'tasks' : 'docs') : NODE_TYPE_KIND[t])).filter((k) => VIEW_KINDS.includes(k)))] : [];
  const assigned = list(q.assignedTo) || [];
  const typed = (list(q.entityTypeUris) || []).filter((u) => TYPE_URI.test(u));
  const f = {
    types: kinds.length || typed.length ? [...kinds, ...typed] : null,
    states: states.length ? states : null,
    text: typeof q.textQuery === 'string' ? q.textQuery : '',
    participant: me && (list(q.participantUris) || []).includes(me) ? 'me' : null,
    window: q.eventTime && (q.eventTime.min != null || q.eventTime.max != null) ? 'recent' : null,
  };
  const stored = q.attributes && typeof q.attributes === 'object' && !Array.isArray(q.attributes) ? q.attributes : {};
  const fields = Object.fromEntries(Object.entries(stored).filter(([k, v]) => FIELD_KEY.test(k) && !!v && typeof v === 'object' && !Array.isArray(v)));
  if (!kinds.length && typeFields({ types: typed, fields })) f.fields = typeFields({ types: typed, fields });
  // assignedToViewer and an assignedTo that happens to be the signed-in user mean the same thing to a pill ("You"),
  // so both come back as 'me' — writing it out again as assignedToViewer, which is what the viewer-relative pill means.
  if (q.assignedToViewer === true || (me && assigned.includes(me))) f.assignee = 'me';
  else if (q.unassigned === true) f.assignee = 'unassigned';
  else f.assignee = assigned.find((uri) => USER.test(uri)) || 'anyone';
  return f;
}

// The live query that says when a saved search's answer may have moved (#148): its ListNodes params cut down to what
// a live query can say (sdk/livequery.js LISTS), so it is a superset of the search. Text, owners, attributes, event
// windows and visibility are left out, which costs a re-read that finds nothing new, never a change that is missed.
// Newest change first, so whatever moves in scope reaches its head and is reported as added or changed.
function liveTrigger(p) {
  const q = { types: p.nodeTypes || [], orderBy: ['-updatedAt'], limit: 100 };
  for (const [from, to] of [['entityTypes', 'entityTypeUris'], ['stateTypes', 'stateTypes'], ['assignedTo', 'assignedTo'], ['createdBy', 'createdBy'], ['hasParticipantUris', 'hasParticipantUris']]) if (p[from] && p[from].length) q[to] = p[from];
  if (p.unassigned) q.unassigned = true;
  return q;
}

module.exports = { liveTrigger, parseQuery, searchParams, needsTypes, viewParams, searchQueryParams, searchOwners, filterToSearchQuery, searchQueryToFilter, validViewFilter, VIEW_PRESETS, VIEW_KINDS, KIND_NODE_TYPE, hideRules, isHidden, completedWindow, completedInWindow };
