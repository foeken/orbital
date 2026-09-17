'use strict';
// The in-file mock of window.api, used only when preload did not run, so the UI can be exercised without the main process. locate() is shared with the real code.

// ---- shared helper: find a node in a nested Node[] with its ancestry ----
function locate(list, id, trail = []) {
  for (let i = 0; i < list.length; i++) {
    const node = list[i];
    if (node.id === id) return { list, index: i, node, trail };
    const found = locate(node.children || [], id, [...trail, { list, index: i, node }]);
    if (found) return found;
  }
  return null;
}

// ---- mock api, used ONLY when preload did not run (no window.api) ----
function mockApi() {
  const titles = ['Schedule something with Sam Okafor and Dana Brooks', 'Reporting project needs more support and a clearer timeline.',
    'Check out the new editor', 'Should we start a shared cost tracking system with Finance?', 'Discuss the two open transfers with Chris Lund',
    'Organise working sessions on guardrails for teams with Studio', 'Contact Dana B about the workshop', 'Ask and tell about the data agreement', 'The laptop refresh discussion',
    'Ask Studio teams for risks (with deadline Sun, Nov 1)', 'Organise session with Kim Halvorsen around the role definition', 'Create a board presentation on the one-year roadmap'];
  let seq = 0;
  const block = (text, children = [], heading, done) => {
    const node = { id: 'b' + (++seq), text: plainOf(text), segments: segsOf(text), kind: 'block', heading, hasChildren: children.length > 0, children };
    if (done != null) node.done = done;
    return node;
  };
  const typed = (type, text) => ({ ...block(text), block: type }); // a block carrying one of the api.setBlockType types
  const divider = () => ({ id: 'b' + (++seq), kind: 'block', block: 'divider', editable: false, hasChildren: false, children: [] }); // nothing to edit, like sdk/content.js
  const task = { label: 'task', color: 'grey' }, meeting = { label: 'meeting', color: 'gold' };
  const project = { label: 'Project', hue: 268 }; // a typed tag with the type's colour (Addendum 12)
  const docs = titles.map((text, i) => ({ id: 'mockdoc' + i, text, kind: 'document', done: 0, hasChildren: true, icon: 'task', tags: [task] }));
  docs[2].tags = [task, project];
  docs[0].state = 'proposed'; // Inbox; the rest are In Progress (open) unless done
  for (const text of ['Renew the data agreement', 'Send the Q3 board deck']) docs.push({ id: 'mockdoc' + docs.length, text, kind: 'document', done: 1, state: 'closed', hasChildren: true, icon: 'task', tags: [task] }); // Completed: hidden by the default filter
  docs.push({ id: 'mockdoc' + titles.length, text: 'Studio programme', kind: 'document', hasChildren: true, hue: 268, tags: [project] }); // typed, not a task: plain bullet tinted with the type hue
  // a space: pinned, its "content" is the documents it owns (document Nodes, not blocks)
  const spaceDocs = [
    { id: 'mockspacedoc0', text: 'Studio LT charter', kind: 'document', hasChildren: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] },
    { id: 'mockspacedoc1', text: 'Draft the LT agenda', kind: 'document', done: 0, hasChildren: true, icon: 'task', tags: [task] },
  ];
  const space = { id: 'tana:space:mock', text: 'Studio LT', kind: 'document', hasChildren: true, icon: 'space', hue: 150, tags: [{ label: 'space', color: 'grey' }] };
  // other library kinds (chats, canvases, agents, skills, saved searches): read-only rows, plain bullet + kind chip
  const kinds = ['chat', 'canvas', 'agent', 'skill', 'search'].map((k, i) => ({ id: 'tana:' + k + ':mock' + i, text: 'Sample ' + k, kind: 'document', hasChildren: true, tags: [{ label: k, color: 'grey' }] }));
  // chats (api.chats): newest first; "MCP: …" ones carry meta 'MCP' but are no longer hidden (the includeMcp toggle was removed, #247)
  const chats = ['Draft the Studio memo', 'MCP: list open tasks', 'Summarise the leadership notes', 'MCP: create meeting note', 'Rewrite the agreement clause']
    .map((text, i) => ({ id: 'tana:chat:mockchat' + i, text, kind: 'document', hasChildren: true, tags: [{ label: 'chat', color: 'grey' }], meta: /^MCP:/.test(text) ? 'MCP' : undefined }));
  // meetings over the past and next 7 days (day offset from today, start hour or null = all day); roots meta = weekday + time, search meta = weekday + day of month + time
  const dateMeta = {};
  const meetings = [['Last week retro', -6, 10], ['Board prep', -2, 14], ['Leadership sync', 0, 9], ['Platform Guild', 0, 13], ['1-1 with Sam', 1, 11], ['Offsite', 3, null]].map(([text, off, h], i) => {
    const d = new Date(); d.setDate(d.getDate() + off);
    const time = h == null ? ', all day' : ' ' + h + ':00–' + (h + 1) + ':00';
    dateMeta['mockmeeting' + i] = WD[d.getDay()] + ' ' + d.getDate() + time;
    return { id: 'mockmeeting' + i, text, meta: WD[d.getDay()] + time, kind: 'document', hasChildren: true, icon: 'meeting', tags: [meeting] };
  });
  // Meetings, Chats and People are no longer views. Their documents remain — the Library lists every kind, and a
  // saved search can name any subset of them — so only the pages are gone, not the content they used to show.
  const views = [{ id: 'inbox', title: 'Inbox', icon: 'inbox', nodes: [] }, { id: 'library', title: 'Library', icon: 'library', nodes: docs }];
  const all = [...docs, ...meetings, ...spaceDocs, space, ...kinds, ...chats];
  for (const node of all) node.editable = true;
  // org members (user profiles): searchable, linkable, and the "Assigned to" menu; me = the signed-in user
  const members = [['robin', 'Robin Vega', true], ['sam', 'Sam Okafor'], ['priya', 'Priya Raman'], ['tomas', 'Tomas Ilves']]
    .map(([k, text, me]) => ({ id: 'tana:user-profile:' + k, text, kind: 'document', hasChildren: true, icon: 'member', editable: false, tags: [{ label: 'member', color: 'grey' }], me }));
  const taskDetails = new Map(docs.map((doc, i) => [doc.id, {
    assignees: i % 3 ? [members[i % members.length].id] : [],
    restricted: i % 2 === 0,
    participants: i % 2 === 0 ? [{ uri: members[0].id, type: 'user', role: 'admin' }] : [{ uri: members[0].id, type: 'user', role: 'admin' }, { uri: members[1].id, type: 'user', role: 'editor' }],
    audience: i % 2 === 0 ? 'only-me' : 'everyone',
  }]));
  const filters = {
    inbox: { types: null, states: ['proposed'], assignee: 'anyone', text: '' },
    tasks: { types: ['tasks'], states: ['proposed', 'open', 'not_now'], assignee: 'me', text: '' },
    library: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' },
  };
  const stateOf = (d) => d.state || (d.done == null ? null : d.done ? 'closed' : 'open');
  const listed = (d, f) => (!f.states || f.states.includes(stateOf(d))) && (!f.assignee || f.assignee === 'me' || f.assignee === 'anyone');
  const kindOf = (d) => (d.icon === 'member' ? 'people' : d.icon === 'task' ? 'tasks' : d.icon === 'meeting' ? 'meetings' : d.tags && ['chat', 'canvas', 'agent', 'skill', 'search'].includes(d.tags[0].label) ? d.tags[0].label + 's' : 'docs');
  const created = {};   // documents made with createDocument
  const searchQueries = {}; // saved search id -> the filter its stored query holds
  const notifyChoices = {}; // doc id -> an explicit watch choice; absent means the default rule decides
  const settling = new Set(); // a brand-new document: the first taskMeta read fails while main is still subscribing it
  const unlisted = [];  // created tasks/meetings the roots "query" has not caught up with yet: listed after the next refresh()
  const sidebar = ['mockdoc2', 'mockmeeting2', space.id], datePins = { mockdoc2: [localDate()] }; // pins: sidebar order, personal date pins per doc
  const content = Object.fromEntries(all.map((d, i) => [d.id, [
    block('Context', [], 2),
    block('First point about task ' + i, [block('Detail A'), block('Detail B', [block('Deeper detail')])]),
    block([{ text: 'Discuss with ' }, { mention: { label: 'Sam Okafor', uri: 'tana:user-profile:sam' } }, { text: ' and see ' }, { mention: { label: titles[2], uri: 'mockdoc2' } }]),
    // every mark and block type the outline can receive, so formatting is visible without the main process
    block([{ text: 'Marks: ' }, { text: 'bold', marks: { bold: true } }, { text: ', ' }, { text: 'italic', marks: { italic: true } }, { text: ', ' },
      { text: 'strike', marks: { strike: true } }, { text: ', ' }, { text: 'code', marks: { code: true } }, { text: ', ' },
      { text: 'a link mark', marks: { link: 'https://tana.inc' } }, { text: ' and a bare https://tana.inc URL' }]),
    typed('quote', 'A quote block, set with api.setBlockType.'),
    typed('code', 'const answer = 42;'),
    typed('numbered', 'First numbered item'),
    typed('numbered', 'Second numbered item'),
    divider(),
    block('Second point, a paragraph long enough to wrap onto a second line when the window is narrow so arrow keys can be tested inside a node.'),
    block('Next steps', [block('Call someone'), block('Write the memo')]),
  ]]));
  content['tana:user-profile:sam'] = [block('Sam is a colleague')];
  content[space.id] = spaceDocs;
  // an image block (not editable; api.image resolves its uri to a data URL): a 2x2 PNG scaled by width/height
  content.mockdoc0.splice(2, 0, { id: 'img' + (++seq), kind: 'block', type: 'image', image: { uri: 'tana:image:mock', alt: 'Mock image', width: 160, height: 100 }, hasChildren: false, children: [] });
  // inline references (embeds): read-only nodes rendering the target's title/state, like sdk/content.js (editable: false) with main resolving reference.node
  content.mockdoc0.unshift({ id: 'ref' + (++seq), kind: 'block', type: 'reference', editable: false, reference: { uri: 'mockdoc9' }, hasChildren: false, children: [] });
  content.mockdoc0.splice(1, 0, { id: 'ref' + (++seq), kind: 'block', type: 'reference', editable: false, reference: { uri: 'tana:user-profile:sam' }, hasChildren: false, children: [] });
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPoyroWu7WKIX9dU1fWNQAuWQbA8sXmUwAAAABJRU5ErkJggg==';
  const changed = [], removed = [], statusCbs = [], deleted = new Map(), sensitive = new Set();
  let status = { authenticated: false, authChecking: false, connected: false, syncing: false, lastSync: null, error: null };
  const emit = (docId) => setTimeout(() => changed.forEach((cb) => cb(docId)), 0);
  const fix = (n) => { n.hasChildren = n.children.length > 0; };
  const info = (d) => ({ id: d.id, title: d.text, kind: 'document', done: d.done, stateType: stateOf(d), icon: d.icon, hue: d.hue, editable: d.editable, tags: d.tags, meta: d.meta, me: d.me });
  // undo/redo: whole-state snapshots, one step per mutation (main keeps a global order over per-document Loro UndoManagers).
  // Document delete/restore records an op step instead, like the native bridge where undo restores a soft-deleted document.
  const undoStack = [], redoStack = [];
  const snapshot = () => structuredClone({ docs: Object.fromEntries(all.map((d) => [d.id, { text: d.text, done: d.done }])), content });
  const restore = (s) => { for (const d of all) if (s.docs[d.id]) Object.assign(d, s.docs[d.id]); Object.assign(content, s.content); };
  const mut = (docId, fn) => { undoStack.push({ docId, snap: snapshot() }); redoStack.length = 0; return fn(); };
  const step = (docId, op) => { undoStack.push({ docId, op }); redoStack.length = 0; };
  const history = async (from, to) => {
    const e = from.pop(); if (!e) return null;
    if (e.op) { (e.op === 'delete' ? softDelete : undelete)(e.docId); to.push({ docId: e.docId, op: e.op === 'delete' ? 'restore' : 'delete' }); return e.docId; }
    to.push({ docId: e.docId, snap: snapshot() }); restore(e.snap); emit(e.docId); return e.docId;
  };
  function softDelete(docId) {
    const i = all.findIndex((doc) => doc.id === docId); if (i < 0) throw new Error('unknown document');
    deleted.set(docId, { doc: all[i], content: content[docId], views: views.map((view) => ({ view, index: view.nodes.findIndex((node) => node.id === docId) })).filter((entry) => entry.index >= 0) });
    all.splice(i, 1); for (const view of views) view.nodes = view.nodes.filter((node) => node.id !== docId);
    sidebar.splice(0, sidebar.length, ...sidebar.filter((id) => id !== docId)); delete datePins[docId]; delete content[docId];
    setTimeout(() => removed.forEach((cb) => cb(docId)), 0);
  }
  function undelete(docId) {
    const saved = deleted.get(docId); if (!saved) throw new Error('unknown deleted document');
    all.push(saved.doc); content[docId] = saved.content;
    for (const { view, index } of saved.views) view.nodes.splice(index, 0, saved.doc);
    deleted.delete(docId); emit(null);
  }
  return {
    roots: async () => structuredClone(views),
    viewFilter: async (id) => structuredClone(filters[id]),
    setViewFilter: async (id, filter) => structuredClone(filters[id] = filter),
    viewList: async (_id, filter) => {
      await new Promise((r) => setTimeout(r, 30));
      const text = String(filter.text || '').trim().toLowerCase();
      return { nodes: [...all, ...members].filter((d) => (!filter.types ? kindOf(d) !== 'people' : filter.types.includes(kindOf(d)))
        && (!filter.states || listed(d, filter))
        && d.text.toLowerCase().includes(text)).map(info), truncated: false };
    },
    searches: async () => structuredClone(all.filter((d) => d.id.startsWith('tana:search:')).map(info)),
    // Saving the current view as a search: main translates the filter it owns, so the mock only needs to produce a
    // row of the same shape createDocument does — the real channel returns a Node, and a divergence here is exactly
    // what let a mock-only shape mismatch through once before.
    createSearch: async (viewId, title) => {
      const f = filters[viewId] || {};
      const bits = [];
      if (f.text && f.text.trim()) bits.push('"' + f.text.trim() + '"');
      if (Array.isArray(f.states) && f.states.length) bits.push(f.states.join(', '));
      if (f.assignee === 'me') bits.push('mine'); else if (f.assignee === 'unassigned') bits.push('unassigned');
      const base = { inbox: 'Inbox', tasks: 'Tasks', library: 'Library' }[viewId] || 'Search';
      const n = { id: 'tana:search:mocknew' + (++seq), text: (title && title.trim()) || (bits.length ? base + ' — ' + bits.join(' · ') : base), kind: 'document', hasChildren: true, editable: true, tags: [{ label: 'search', color: 'grey' }] };
      created[n.id] = n; content[n.id] = []; all.push(n);
      searchQueries[n.id] = { filter: structuredClone(f) }; // the query it was saved with, in the vocabulary the channel deals in
      return info(n);
    },
    // A saved search's stored query as the filter the pills speak, and back. The real channel translates through
    // sdk/query; the mock keeps the filter as it was given, since what it has to match is the channel's shape, not
    // the document's. A sample search that predates any save opens on the Library's filter rather than on nothing.
    searchFilter: async (id) => structuredClone(searchQueries[id] || { filter: filters.library }),
    setSearchFilter: async (id, filter, sort, group, display) => structuredClone(searchQueries[id] = { filter, sort, group, display }),
    // the rows a staged filter would find: the same selection viewList makes, so editing the pills moves the list
    searchPreview: async (filter) => {
      const text = String(filter.text || '').trim().toLowerCase();
      return structuredClone([...all, ...members].filter((d) => (!filter.types ? kindOf(d) !== 'people' : filter.types.includes(kindOf(d)))
        && (!filter.states || listed(d, filter))
        && d.text.toLowerCase().includes(text)).map(info));
    },
    // references resolve on read, as main does: the row always shows the target's current title and state
    children: async (docId) => structuredClone(content[docId] || []).map((n) => (n.type === 'reference' ? { ...n, reference: { ...n.reference, node: info([...all, ...members].find((d) => d.id === n.reference.uri)) } } : n)),
    node: async (docId) => {
      const d = [...all, ...members].find((x) => x.id === docId);
      if (d) return info(d);
      if (created[docId]) return created[docId];
      throw new Error('unknown document ' + docId);
    },
    members: async () => members.map(info),
    // relationships of a node (main.js related): pinned edges, task outcomes and note documents
    related: async (docId) => {
      const doc = all.find((d) => d.id === docId);
      if (!doc || doc.icon !== 'meeting') return { pinned: [], outcomes: [], notes: [] };
      const pick = (n) => n && info(n);
      return {
        summary: 'Mock meeting summary for ' + doc.text,
        call: { url: 'https://meet.google.com/klm-nopq-rst', label: 'meet.google.com/klm-nopq-rst' },
        pinned: [pick(all.find((d) => d.icon === 'doc')), pick(all.find((d) => d.icon === 'task'))].filter(Boolean),
        outcomes: all.filter((d) => d.icon === 'task').slice(1, 3).map(info),
        notes: [pick(all.find((d) => d.icon === 'doc' && d.text))].filter(Boolean),
      };
    },
    accessOptions: async (docId) => { const writable = !!all.find((doc) => doc.id === docId)?.editable; return { sharing: writable, move: writable, deletable: writable, rules: writable ? ['me', 'people', 'inherit'] : [], roles: ['editor', 'admin'], sharingToken: 'mock-sharing', inheritAudience: { scope: 'space', title: space.text } }; },
    setSharing: async (docId, selection) => { const meta = taskDetails.get(docId); if (!meta) throw new Error('sharing unavailable'); if (selection.rule === 'inherit' && selection.token !== 'mock-sharing') throw new Error('Reload the audience disclosure and explicitly select inherit'); meta.restricted = selection.rule !== 'inherit'; meta.participants = selection.rule === 'people' ? selection.participants : []; meta.audience = selection.rule === 'me' ? 'only-me' : selection.rule === 'people' ? 'people' : 'unknown'; emit(docId); },
    searchSpaces: async (query) => [info(space)].filter((node) => node.title.toLowerCase().includes(String(query).toLowerCase())).map((node) => ({ ...node, selectable: true })),
    previewMove: async (docId, spaceId) => {
      const doc = all.find((node) => node.id === docId);
      if (!doc || spaceId !== space.id) return { allowed: false, reason: 'space unavailable' };
      const meta = taskDetails.get(docId), before = meta?.restricted ? { scope: meta.audience || 'only-me' } : { scope: 'everyone' };
      const after = meta?.restricted ? before : { scope: 'space', title: space.text };
      return { allowed: true, target: { id: space.id, title: space.text }, before, after, audienceChanged: JSON.stringify(before) !== JSON.stringify(after), requiresConfirmation: JSON.stringify(before) !== JSON.stringify(after), token: 'mock-move' };
    },
    moveToSpace: async (docId, spaceId, token) => { const doc = all.find((node) => node.id === docId); if (!doc || spaceId !== space.id || token !== 'mock-move') throw new Error('space unavailable'); doc.ownerUri = spaceId; emit(null); },
    taskMeta: async (docId) => {
      if (settling.delete(docId)) throw new Error('document is still settling');
      return structuredClone(taskDetails.get(docId) || { assignees: [], restricted: undefined, participants: [], audience: 'unknown' });
    },
    setState: async (docId, state) => { const doc = all.find((d) => d.id === docId && d.icon === 'task'); if (!doc) throw new Error('not a task'); mut(docId, () => { doc.state = state; doc.done = state === 'closed'; }); emit(docId); return 1; },
    setStateMany: async (docIds, state) => { const docs = docIds.map((id) => all.find((d) => d.id === id && d.icon === 'task')); if (docs.some((doc) => !doc)) throw new Error('not a task'); mut(docIds[0], () => { for (const doc of docs) { doc.state = state; doc.done = state === 'closed'; } }); emit(null); return docs.length; },
    setAssignees: async (docId, uris) => { const meta = taskDetails.get(docId); if (!meta) throw new Error('not a task'); meta.assignees = [...new Set(uris)]; emit(docId); },
    setAssigneesMany: async (docIds, uris) => { const metas = docIds.map((id) => taskDetails.get(id)); if (metas.some((meta) => !meta)) throw new Error('not a task'); mut(docIds[0], () => { for (const meta of metas) meta.assignees = [...new Set(uris)]; }); emit(null); return metas.length; },
    image: async (uri) => { await new Promise((r) => setTimeout(r, 30)); if (uri !== 'tana:image:mock') throw new Error('unknown image ' + uri); return PNG; },
    systemTheme: async () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    onSystemTheme: (cb) => matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => cb(e.matches ? 'dark' : 'light')),
    // "#task", "#meeting", "#member", "#<type>" tokens filter; the rest is a substring query; events get date-style meta
    search: async (q) => {
      await new Promise((r) => setTimeout(r, 30));
      const tokens = (q.match(/#\S+/g) || []).map((t) => t.slice(1).toLowerCase()), text = q.replace(/#\S+/g, '').trim().toLowerCase();
      const hit = (d, t) => (['task', 'meeting', 'member'].includes(t) ? d.icon === t : (d.tags || []).some((x) => x.label.toLowerCase() === t));
      return [...all, ...members].filter((d) => d.text.toLowerCase().includes(text) && tokens.every((t) => hit(d, t))).slice(0, 20).map((d) => ({ ...info(d), meta: dateMeta[d.id] || d.meta }));
    },
    creationOptions: async () => ({ options: [
      { id: 'task', kind: 'task', title: 'Task', icon: 'task', selectable: true },
      { id: 'meeting', kind: 'meeting', title: 'Meeting', icon: 'meeting', selectable: true },
      { id: 'chat', kind: 'chat', title: 'Chat', icon: 'chat', selectable: true },
      { id: 'tana:type:mockproject', kind: 'custom', typeUri: 'tana:type:mockproject', title: 'Project', icon: 'doc', hue: 268, selectable: true },
    ], complete: true }),
    createDocument: async (title, { kind = 'doc', typeUri } = {}) => {
      const nativeKind = kind === 'custom' ? 'doc' : kind;
      const n = { id: 'mocknew' + (++seq), text: title, kind: 'document', hasChildren: true, editable: true, icon: nativeKind, tags: kind === 'custom' ? [{ label: 'Project', hue: 268 }] : [{ label: nativeKind, color: nativeKind === 'meeting' ? 'gold' : 'grey' }] };
      if (nativeKind === 'task') { n.done = 0; taskDetails.set(n.id, { assignees: [], restricted: true, participants: [{ uri: members[0].id, type: 'user', role: 'admin' }], audience: 'only-me' }); settling.add(n.id); }
      if (nativeKind === 'meeting') n.meta = WD[new Date().getDay()] + ' 10:00–10:30';
      if (typeUri) n.typeUri = typeUri;
      created[n.id] = n; content[n.id] = []; all.push(n);
      if (nativeKind !== 'doc') unlisted.push(n);
      return info(n);
    },
    pins: async () => sidebar.map((id) => info(all.find((d) => d.id === id))),
    pinState: async (docId) => ({ sidebar: sidebar.includes(docId), dates: datePins[docId] || [] }),
    pin: async (docId, target) => { if (target === 'sidebar') { if (!sidebar.includes(docId)) sidebar.push(docId); } else (datePins[docId] ||= []).push(localDate()); emit(null); },
    unpin: async (docId, target) => { if (target === 'sidebar') sidebar.splice(sidebar.indexOf(docId) >>> 0, 1); else datePins[docId] = (datePins[docId] || []).filter((d) => d !== localDate()); emit(null); },
    deleteDocument: async (docId) => { softDelete(docId); step(docId, 'restore'); },
    restoreDocument: async (docId) => { undelete(docId); step(docId, 'delete'); },
    sensitiveIds: async () => [...sensitive],
    setSensitive: async (docId, on) => { if (on) sensitive.add(docId); else sensitive.delete(docId); return on; },
    nodeLink: async (docId) => 'https://home.tana.inc/o/mockorg/l/' + encodeURIComponent(docId),
    // the mock has no participants model, so nothing is watched by default here: the choice is all there is
    notifyState: async (docId) => ({ on: !!notifyChoices[docId], default: false, explicit: docId in notifyChoices }),
    setNotify: async (docId, on) => {
      if (on === null || on === undefined) delete notifyChoices[docId]; else notifyChoices[docId] = !!on;
      return { on: !!notifyChoices[docId], default: false, explicit: docId in notifyChoices };
    },
    openExternal: async (url) => { if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened'); return url; },
    todayNode: async () => { const date = new Date().toLocaleDateString('sv-SE'); const found = all.find((d) => d.text === date); if (found) return found.id; const n = { id: 'mocktoday', text: date, kind: 'document', hasChildren: true, editable: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] }; content[n.id] = []; all.push(n); views[0].nodes.unshift(n); datePins[n.id] = [date]; emit(null); return n.id; },
    weekNode: async () => { const t = new Date(); t.setDate(t.getDate() + 4 - (t.getDay() || 7)); const title = 'Week ' + Math.ceil(((t - new Date(t.getFullYear(), 0, 1)) / 864e5 + 1) / 7) + ' (' + t.getFullYear() + ')'; const found = all.find((d) => d.text === title); if (found) return found.id; const n = { id: 'mockweek', text: title, kind: 'document', hasChildren: true, editable: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] }; content[n.id] = []; all.push(n); views[0].nodes.unshift(n); emit(null); return n.id; },
    setTitle: async (docId, title) => mut(docId, () => { all.find((d) => d.id === docId).text = title; emit(docId); }),
    setDone: async (docId, done) => mut(docId, () => { const d = all.find((x) => x.id === docId); d.done = done ? 1 : 0; d.state = done ? 'closed' : 'open'; emit(docId); }),
    toggleCheckbox: async (docId, id) => mut(docId, () => { const n = locate(content[docId], id).node; n.done = n.done == null ? 0 : n.done ? 0 : 1; emit(docId); }),
    setText: async (docId, id, text) => mut(docId, () => { const n = locate(content[docId], id).node; n.text = plainOf(text); n.segments = segsOf(text); emit(docId); }),
    // block types and dividers (the contract the renderer codes against): type in paragraph | heading1-3 | bullet | numbered | code | quote
    setBlockType: async (docId, id, type) => mut(docId, () => {
      const n = locate(content[docId], id).node;
      n.block = type; n.heading = Number((String(type).match(/^heading(\d)$/) || [])[1]) || undefined;
      emit(docId);
    }),
    insertDivider: async (docId, id) => mut(docId, () => { const f = locate(content[docId], id); f.list.splice(f.index + 1, 0, divider()); emit(docId); }),
    insertAfter: async (docId, id, text) => mut(docId, () => {
      const f = id == null ? null : locate(content[docId], id), n = block(text, [], undefined, f && f.node.kind === 'block' && f.node.done != null ? 0 : undefined);
      if (!f) content[docId].push(n); else f.list.splice(f.index + 1, 0, n);
      emit(docId); return n.id;
    }),
    insertChild: async (docId, id, text) => mut(docId, () => { const f = locate(content[docId], id), n = block(text, [], undefined, f.node.kind === 'block' && f.node.done != null ? 0 : undefined); f.node.children.unshift(n); fix(f.node); emit(docId); return n.id; }),
    remove: async (docId, id) => mut(docId, () => { const f = locate(content[docId], id); f.list.splice(f.index, 1); const p = f.trail.at(-1); if (p) fix(p.node); emit(docId); }),
    removeMany: async (docId, ids) => mut(docId, () => { for (const id of [...ids].reverse()) { const f = locate(content[docId], id); f.list.splice(f.index, 1); const p = f.trail.at(-1); if (p) fix(p.node); } emit(docId); }),
    indent: async (docId, id) => mut(docId, () => {
      const f = locate(content[docId], id); if (f.index === 0) return;
      const prev = f.list[f.index - 1]; f.list.splice(f.index, 1); prev.children.push(f.node); fix(prev); emit(docId);
    }),
    outdent: async (docId, id) => mut(docId, () => {
      const f = locate(content[docId], id), p = f.trail.at(-1); if (!p) return;
      f.list.splice(f.index, 1); fix(p.node); p.list.splice(p.index + 1, 0, f.node); emit(docId);
    }),
    move: async (docId, id, dir) => mut(docId, () => {
      const f = locate(content[docId], id), j = f.index + (dir === 'up' ? -1 : 1);
      if (j < 0 || j >= f.list.length) return;
      [f.list[f.index], f.list[j]] = [f.list[j], f.list[f.index]]; emit(docId);
    }),
    moveMany: async (docId, ids, dir) => mut(docId, () => { for (const id of dir === 'up' ? ids : [...ids].reverse()) { const f = locate(content[docId], id), j = f.index + (dir === 'up' ? -1 : 1); if (j >= 0 && j < f.list.length) [f.list[f.index], f.list[j]] = [f.list[j], f.list[f.index]]; } emit(docId); }),
    undo: () => history(undoStack, redoStack),
    redo: () => history(redoStack, undoStack),
    refresh: async () => { for (const n of unlisted.splice(0)) (n.icon === 'task' ? docs : meetings).push(n); emit(null); },
    login: async () => { status = { ...status, authenticated: true, connected: true, lastSync: new Date().toISOString() }; statusCbs.forEach((cb) => cb(status)); },
    status: async () => status,
    onRemoved: (cb) => removed.push(cb),
    onChanged: (cb) => changed.push(cb),
    onStatus: (cb) => statusCbs.push(cb),
  };
}
