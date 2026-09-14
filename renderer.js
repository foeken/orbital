'use strict';

// theme preference (localStorage "theme"): 'light' | 'dark' | 'system'; 'system' follows the macOS appearance (api.systemTheme / api.onSystemTheme)
let themePref = ['dark', 'system'].includes(localStorage.getItem('theme')) ? localStorage.getItem('theme') : 'light';
let theme = themePref === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : themePref; // no flash before api.systemTheme answers
function applyTheme(next) {
  theme = next === 'dark' ? 'dark' : 'light';
  if (theme === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  const pal = document.getElementById('palette'); // by id: this also runs before the palette const exists
  if (pal && !pal.hidden) renderPalette();
}
applyTheme(theme);
function setTheme(next) { themePref = next === 'dark' ? 'dark' : 'light'; localStorage.setItem('theme', themePref); applyTheme(themePref); } // an explicit theme stops following the system
function followSystem(on) {
  themePref = on ? 'system' : theme;
  localStorage.setItem('theme', themePref);
  if (on && tana.systemTheme) tana.systemTheme().then((t) => applyTheme(themePref === 'system' ? t : theme), showError);
  else applyTheme(theme);
}

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
  // other library kinds (chats, canvases, agents, skills): read-only rows, plain bullet + kind chip
  const kinds = ['chat', 'canvas', 'agent', 'skill'].map((k, i) => ({ id: 'tana:' + k + ':mock' + i, text: 'Sample ' + k, kind: 'document', hasChildren: true, tags: [{ label: k, color: 'grey' }] }));
  // chats (api.chats): newest first; "MCP: …" ones carry meta 'MCP' and are hidden unless includeMcp
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
  const views = [{ id: 'inbox', title: 'Inbox', icon: 'inbox', nodes: [] }, { id: 'tasks', title: 'Tasks', icon: 'task', kind: true, nodes: docs }, { id: 'meetings', title: 'Meetings', icon: 'meeting', kind: true, nodes: meetings }, { id: 'library', title: 'Library', icon: 'library', nodes: [] }, { id: 'chats', title: 'Chats', icon: 'chat', kind: true, nodes: [] }];
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
  views.push({ id: 'people', title: 'People', icon: 'member', kind: true, nodes: members });
  const filters = {
    inbox: { types: null, states: ['proposed'], assignee: 'anyone', text: '' },
    tasks: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' },
    meetings: { types: ['meetings'], states: null, assignee: 'anyone', text: '', participant: 'me', window: 'recent' },
    library: { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' },
    chats: { types: ['chats'], states: null, assignee: 'anyone', text: '', mcp: false },
    people: { types: ['people'], states: null, assignee: 'anyone', text: '' },
  };
  const stateOf = (d) => d.state || (d.done == null ? null : d.done ? 'closed' : 'open');
  const listed = (d, f) => (!f.states || f.states.includes(stateOf(d))) && (!f.assignee || f.assignee === 'me' || f.assignee === 'anyone');
  const kindOf = (d) => (d.icon === 'member' ? 'people' : d.icon === 'task' ? 'tasks' : d.icon === 'meeting' ? 'meetings' : d.tags && ['chat', 'canvas', 'agent', 'skill'].includes(d.tags[0].label) ? d.tags[0].label + 's' : 'docs');
  const created = {};   // documents made with createDocument
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
  const info = (d) => ({ id: d.id, title: d.text, kind: 'document', done: d.done, stateType: stateOf(d), icon: d.icon, iconSvg: d.iconSvg, hue: d.hue, editable: d.editable, tags: d.tags, meta: d.meta, me: d.me });
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
        && (!filter.states || listed(d, filter)) && (filter.mcp !== false || d.meta !== 'MCP')
        && d.text.toLowerCase().includes(text)).map(info), truncated: false };
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
    setIcon: async (docId, svg) => { (all.find((d) => d.id === docId) || created[docId]).iconSvg = svg || undefined; emit(null); },
    sensitiveIds: async () => [...sensitive],
    setSensitive: async (docId, on) => { if (on) sensitive.add(docId); else sensitive.delete(docId); return on; },
    nodeLink: async (docId) => 'https://home.tana.inc/o/mockorg/l/' + encodeURIComponent(docId),
    openExternal: async (url) => { if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened'); return url; },
    todayNode: async () => { const date = new Date().toLocaleDateString('sv-SE'); const found = all.find((d) => d.text === date); if (found) return found.id; const n = { id: 'mocktoday', text: date, kind: 'document', hasChildren: true, editable: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] }; content[n.id] = []; all.push(n); views[0].nodes.unshift(n); datePins[n.id] = [date]; emit(null); return n.id; },
    weekNode: async () => { const t = new Date(); t.setDate(t.getDate() + 4 - (t.getDay() || 7)); const title = 'Week ' + Math.ceil(((t - new Date(t.getFullYear(), 0, 1)) / 864e5 + 1) / 7); const found = all.find((d) => d.text === title); if (found) return found.id; const n = { id: 'mockweek', text: title, kind: 'document', hasChildren: true, editable: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] }; content[n.id] = []; all.push(n); views[0].nodes.unshift(n); emit(null); return n.id; },
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

// ---- segments: [{ text, marks? } | { mention: { label, uri } }] <-> plain text <-> DOM ----
// marks = { bold, italic, strike, code, link: href } on one text run: exactly the shape api.setText takes back.
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }; // today, YYYY-MM-DD
// accepts segments, a plain string, or a Node
const segsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (v ? [{ text: v }] : []) : v.segments || (v.text ? [{ text: v.text }] : []));
const plainOf = (v) => segsOf(v).map((s) => ('text' in s ? s.text : s.mention.label)).join('');
const MARK_TAGS = { code: 'code', strike: 's', italic: 'em', bold: 'strong' }; // innermost first: the order a run is wrapped in
const hasMarks = (marks) => !!marks && Object.keys(marks).length > 0;
const markKey = (marks) => JSON.stringify(Object.entries(marks || {}).sort()); // two runs merge only when their marks match
function markWrap(nodes, marks) {
  let out = nodes;
  for (const [name, tag] of Object.entries(MARK_TAGS)) if (marks[name]) { const el = document.createElement(tag); el.append(...out); out = [el]; }
  if (marks.link) { const a = document.createElement('a'); a.className = 'link'; a.dataset.href = marks.link; a.append(...out); out = [a]; } // outermost: the whole run is one link
  return out;
}
function renderSegs(el, segs) {
  el.replaceChildren(...segs.flatMap((s, i) => {
    // Chromium needs a placeholder newline after a trailing soft break to put the caret on the empty line; readSegs strips it
    if ('text' in s) {
      const text = s.text + (i === segs.length - 1 && s.text.endsWith('\n') ? '\n' : '');
      const nodes = s.marks && s.marks.link ? [document.createTextNode(text)] : linkify(text); // a link mark is already the link
      return hasMarks(s.marks) ? markWrap(nodes, s.marks) : nodes;
    }
    const a = document.createElement('a'); a.className = 'mention'; a.dataset.uri = s.mention.uri; a.contentEditable = 'false'; a.textContent = s.mention.label;
    return [a];
  }));
}
// Plain http(s) URLs inside a text run become clickable without leaving the text editable: readSegs reads the
// anchor back as its own characters, so the stored text is unchanged.
const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.className = 'url'; a.dataset.href = m[0]; a.textContent = m[0];
    out.push(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out.length ? out : [document.createTextNode(text)];
}
// a run's marks are the elements it sits in, so bold inside a link reads back as one run carrying both
function marksOf(el, marks) {
  const name = el.nodeName;
  if (name === 'A') return el.classList.contains('link') ? { ...marks, link: el.dataset.href } : marks; // a.url is the bare-URL linkify, not a mark
  const found = Object.entries(MARK_TAGS).find(([, tag]) => tag === name.toLowerCase())
    || (name === 'B' ? ['bold'] : name === 'I' ? ['italic'] : name === 'STRIKE' || name === 'DEL' ? ['strike'] : null);
  return found ? { ...marks, [found[0]]: true } : marks;
}
function readSegs(el) {
  const segs = [];
  const add = (t, marks) => {
    if (!t) return;
    const last = segs.at(-1);
    if (last && 'text' in last && markKey(last.marks) === markKey(marks)) last.text += t;
    else segs.push(hasMarks(marks) ? { text: t, marks } : { text: t });
  };
  const walk = (parent, marks) => {
    for (const n of parent.childNodes) {
      if (n.nodeType === 1 && n.classList.contains('mention')) { segs.push({ mention: { label: n.textContent, uri: n.dataset.uri } }); continue; }
      if (n.nodeName === 'BR') { add('\n', marks); continue; }
      if (n.nodeType === 1) { walk(n, marksOf(n, marks)); continue; }
      add(n.textContent, marks);
    }
  };
  walk(el, {});
  const last = segs.at(-1);
  if (last && 'text' in last && last.text.endsWith('\n\n')) last.text = last.text.slice(0, -1);
  return segs;
}
// split segments at a plain-text offset; a mention hit by the cut stays whole in the first half
function splitSegs(segs, off) {
  const before = [], after = [];
  for (const s of segs) {
    const len = 'text' in s ? s.text.length : s.mention.label.length;
    if (off >= len) { before.push(s); off -= len; }
    else if (off <= 0) after.push(s);
    else if ('text' in s) { before.push({ ...s, text: s.text.slice(0, off) }); after.push({ ...s, text: s.text.slice(off) }); off = 0; } // marks survive the cut
    else { before.push(s); off = 0; }
  }
  return [before, after];
}
// empty runs go, neighbours with the same marks join: a toggled-off mark leaves one run again, not three
const mergeSegs = (segs) => segs.filter((s) => !('text' in s) || s.text).reduce((out, s) => {
  const last = out.at(-1);
  if (last && 'text' in last && 'text' in s && markKey(last.marks) === markKey(s.marks)) last.text += s.text;
  else out.push({ ...s });
  return out;
}, []);
// one mark set (value) or cleared (null) over [start, end) — the whole block's segments come back, which is what api.setText takes
function markRange(segs, start, end, mark, value) {
  const [before, rest] = splitSegs(segs, start), [middle, after] = splitSegs(rest, end - start);
  return mergeSegs([...before, ...middle.map((s) => {
    if (!('text' in s)) return s;
    const marks = { ...s.marks };
    if (value) marks[mark] = value; else delete marks[mark];
    return hasMarks(marks) ? { text: s.text, marks } : { text: s.text };
  }), ...after]);
}
// the whole selection already carries the mark: that is what makes a toolbar button a toggle
function hasMark(segs, start, end, mark) {
  const runs = splitSegs(splitSegs(segs, start)[1], end - start)[0].filter((s) => 'text' in s && s.text);
  return runs.length > 0 && runs.every((s) => s.marks && s.marks[mark]);
}
const saveValue = (segs) => (segs.some((s) => 'mention' in s || hasMarks(s.marks)) ? segs : plainOf(segs));
const tana = window.api || mockApi();

// ---- state ----
let views = [];              // [{ id, title, icon, nodes: document Node[] }]
let view = localStorage.getItem('view') || 'tasks'; // active view id; the outline shows one view at a time
if (view === 'members') view = 'people';
let authed = false, authChecking = true, signedOut = false;
const extra = new Map();     // docId -> document Node reached through a mention (not in roots)
const paths = new Map();     // docId -> [{ id, title }] location in Tana for the breadcrumb (api.path)
const kids = new Map();      // docId -> Node[] | null (loading)
const open = new Map();      // key -> bool; default: blocks open, documents closed
let zoom = null;             // { docId, nodeId | null, from?: string } from = breadcrumb root label when not the view (e.g. 'Search')
const items = new Map();     // key -> { key, node, docId, parent }, rebuilt on render
const pending = new Map();   // key -> { item, segs, timer } debounced edits
let filterShown = false;
let queue = Promise.resolve();
let scrolledView = null;     // view already scrolled to today's first meeting when it opened
let animView = null;         // view whose rows are already on screen: only then is an arrival/departure worth animating
let linkCtx = null;          // @ linking in progress: { item, segs, start, end, text }
let pinCtx = null;           // relationship pin picker: { pinHub, docId }
let pillCtx = null;          // Cmd+K sublevel for one current view pill
const hotkeys = JSON.parse(localStorage.getItem('hotkeys') || '{}'); // palette row id -> combo ("⇧⌘M")
if (hotkeys.sync) { delete hotkeys.sync; localStorage.setItem('hotkeys', JSON.stringify(hotkeys)); }
// shipped default, recordable and removable like any other: Ctrl+Shift+D opens today's node
if (hotkeys.today === undefined && !localStorage.getItem('todayHotkeySeeded')) {
  hotkeys.today = '⌃⇧D'; localStorage.setItem('hotkeys', JSON.stringify(hotkeys)); localStorage.setItem('todayHotkeySeeded', '1');
}
let pinInfo = null;          // { docId, sidebar, dates } of the palette's document (api.pinState)
let palDoc = null;           // document the Cmd+K context actions apply to (zoomed, else the one whose node is focused)
let palTaskCtx = null;
let dropDoc = null;          // document waiting for an SVG drop ("Set icon…" overlay)
let palReturn = null, dropReturn = null; // { key, offset } of the node focused when a palette / the drop overlay opened; focus goes back there on close
const fresh = new Map();     // docId -> { section, after, node }: documents created here that roots does not list yet, kept in place until it does
let draftSeq = 0;
const DRAFT_KIND = { tasks: 'task', meetings: 'meeting' }; // what Enter drafts in a view (any other view: a plain doc)
let sel = null;              // multi-select: { keys: Set, anchor: key, focus: key }; the caret leaves the text
let selectionFrozen = false;
const filters = new Map();   // view id -> the persisted query filter
const viewSeq = new Map();   // stale viewList responses never replace a newer filter result
const truncated = new Set();
let members = null;
let sensitiveIds = null, sensitiveVisible = false, sensitiveLoading = null; // marks persist; every launch starts blurred
const sensitiveEls = new Map(); // rendered surface -> document ids; lets a toggle update live DOM without rebuilding it
const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map(); // docId -> { until, wait }: a failed metadata read backs off, it is never given up on
const META_RETRY_MS = 500, META_RETRY_MAX = 30000;
const accessById = new Map(), accessLoading = new Set();
let visibilityPeople = new Set();
let visibilityRoles = new Map();
let menu = null;             // open pill menu: { id, index }
const groupPref = JSON.parse(localStorage.getItem('groupBy') || '{}'); // view id -> 'none' | 'status' | 'assignee' | 'type'
const sortPref = JSON.parse(localStorage.getItem('sortBy') || '{}');   // view id -> 'default' | 'title'
let rootsLoaded = false, connected = false; // for the loading skeleton: shown while the view has no rows and roots/library/connection are still pending
// font size: native page zoom (⇧⌘+ / ⇧⌘− / ⌘0), persisted. Default is one step below native.
const BASE_ZOOM = 0.91;
let zoomFactor = Number(localStorage.getItem('zoom')) || BASE_ZOOM;
function setZoom(f) {
  zoomFactor = Math.min(3, Math.max(0.5, Math.round(f * 100) / 100));
  localStorage.setItem('zoom', String(zoomFactor));
  if (tana.zoom) tana.zoom(zoomFactor);
}
if (zoomFactor !== 1 && tana.zoom) tana.zoom(zoomFactor);

const $ = (id) => document.getElementById(id);
const outline = $('outline'), filterEl = $('filter'), filterRow = $('filterRow');
// ---- right rail: what a zoomed node is linked to (api.related). These rows are edges, not nodes:
// they open, and a task row toggles, but nothing here ever takes a caret (docs/OUTLINER.md addendum 15).
const railEl = $('rail');
const railGrip = $('railGrip');
const RAIL_MIN = 200, RAIL_MAX = 620;
const railWidth = () => Math.min(RAIL_MAX, Math.max(RAIL_MIN, Number(localStorage.getItem('railWidth')) || 272));
railEl.style.width = railWidth() + 'px';
// drag the grip to resize the sidebar; the width persists like the other view preferences
railGrip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const startX = e.clientX, startWidth = railEl.getBoundingClientRect().width;
  railGrip.classList.add('dragging'); railGrip.setPointerCapture(e.pointerId);
  const move = (ev) => { railEl.style.width = Math.min(RAIL_MAX, Math.max(RAIL_MIN, startWidth - (ev.clientX - startX))) + 'px'; };
  const up = () => {
    railGrip.classList.remove('dragging');
    railGrip.removeEventListener('pointermove', move); railGrip.removeEventListener('pointerup', up);
    localStorage.setItem('railWidth', String(Math.round(railEl.getBoundingClientRect().width)));
  };
  railGrip.addEventListener('pointermove', move); railGrip.addEventListener('pointerup', up);
});
const relatedBy = new Map(); // docId -> related payload, or null while loading
const railClosed = new Set(JSON.parse(localStorage.getItem('railClosed') || '[]'));
const CHEV = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';
const allDocs = () => views.flatMap((s) => s.nodes);
const sectionOf = (docId) => views.find((s) => s.nodes.some((n) => n.id === docId));
const viewOf = () => views.find((s) => s.id === view) || views[0];
const keyFor = (docId, node) => (node.kind === 'document' ? docId : docId + '/' + node.id);
const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), node, docId, parent }; items.set(item.key, item); return item; };
const docOf = (id) => allDocs().find((d) => d.id === id) || extra.get(id);
const isSpace = (node) => node.id.startsWith('tana:space:'); // its children are documents; no draft child
const childrenOf = (item) => (item.node.kind === 'document' ? kids.get(item.docId) : item.node.children || []);
const hasKids = (item) => { const c = childrenOf(item); return Array.isArray(c) ? c.length > 0 : !!item.node.hasChildren; };
const isOpen = (item) => (open.has(item.key) ? open.get(item.key) : item.node.kind === 'block');
const canInsertChild = (item) => item.node.kind === 'document' || hasKids(item) || item.node.done != null || ['paragraph', 'bullet', 'numbered'].includes(item.node.block);
const canExpand = (item) => hasKids(item) || (!item.node.draft && canEditItem(item));
function draftNode(parent) { // shown under an expanded empty node; created on the first typed character
  return { id: 'draft:' + parent.key, text: '', kind: 'block', done: parent.node?.kind !== 'document' && parent.node?.done != null ? 0 : undefined, draft: true };
}
// Draft documents stay local until their first title character, then use their selected native kind/type.
function draftDocNode(kind, option = {}) {
  const nativeKind = kind === 'custom' ? 'doc' : kind;
  return { id: 'draftdoc:' + (++draftSeq), text: '', kind: 'document', draft: kind, createOptions: { kind, ...(option.typeUri ? { typeUri: option.typeUri } : {}) }, icon: option.icon || nativeKind, tags: option.tags || [{ label: nativeKind, color: nativeKind === 'meeting' ? 'gold' : 'grey' }], done: nativeKind === 'task' ? 0 : undefined, hasChildren: false };
}
// a tag chip: { label, color: 'grey' | 'gold' } or { label, hue } (type colour: background hsl(hue 80% 92%), text hsl(hue 45% 30%), see styles.css .chip.hue)
function chipEl(t, nodeHue) {
  const c = document.createElement('span');
  const hue = t.hue != null ? t.hue : nodeHue;
  c.className = 'chip ' + (hue != null ? 'hue' : t.color || 'grey'); c.append('#');
  const label = document.createElement('span'); label.className = 'chip-label'; label.textContent = ' ' + t.label; c.append(label);
  if (hue != null) c.style.setProperty('--hue', String(hue));
  return c;
}
// Block types (api.setBlockType): readOutline carries one as node.block ('paragraph' | 'heading1-3' | 'bullet' |
// 'numbered' | 'code' | 'quote' | 'divider'), with node.heading still set for the headings. A divider is an atomic
// block like an image: it shows, focuses and deletes, never edits.
const BLOCK_TYPES = [['paragraph', 'Text'], ['heading1', 'Heading 1'], ['heading2', 'Heading 2'], ['heading3', 'Heading 3'],
  ['bullet', 'Bullet List'], ['numbered', 'Numbered List'], ['code', 'Code Block'], ['quote', 'Quote']];
const BLOCK_LABEL = new Map(BLOCK_TYPES);
const BLOCK_GLYPH = { paragraph: 'T', heading1: 'H1', heading2: 'H2', heading3: 'H3', bullet: '•', numbered: '1.', code: '</>', quote: '❝', divider: '—' };
const blockTypeOf = (node) => (BLOCK_LABEL.has(node.block) ? node.block : node.heading ? 'heading' + node.heading : 'paragraph');
const headingOf = (node) => node.heading || Number((blockTypeOf(node).match(/^heading(\d)$/) || [])[1]) || 0;
// the icon slot of a palette/menu row: a real icon where we have one, else the text glyph. The icon sits in the
// same slot so it matches the weight of H1/•/1. beside it.
function glyphSvg(type) { return type === 'code' ? '<span class="glyph icon">' + iconSvg('code') + '</span>' : '<span class="glyph">' + (BLOCK_GLYPH[type] || '') + '</span>'; }
const images = new Map(); // image uri -> data URL (or the pending api.image promise)
const isImage = (node) => node.type === 'image';
const isDivider = (node) => node.block === 'divider' || node.type === 'divider';
const isAtomic = (node) => isImage(node) || isDivider(node); // shown, focusable, never editable
const isReference = (node) => node.type === 'reference';
const referenceTarget = (node) => node.reference?.node ? asDoc(node.reference.node) : null;
const referenceLabel = (node) => referenceTarget(node)?.text || node.reference?.label || node.text || node.reference?.uri || 'Unavailable reference';
// An error from an action is transient: it clears when the next action succeeds, so a stale message never
// outlives the problem it described.
const showError = (e) => { const el = $('error'); el.textContent = e ? String(e.message || e) : ''; el.hidden = !e; };
const run = (fn) => (queue = queue.then(fn).then((value) => { showError(null); return value; }, showError));
const texts = () => [...outline.querySelectorAll('.node:not(.leaving) .text')]; // a row on its way out is not a keyboard stop
const titleEl = $('title');  // zoomed into a document: contenteditable with data-key = that document's key
const keyOfEl = (el) => (el.closest('.node') || el).dataset.key;
const textEl = (key) => outline.querySelector('.node[data-key="' + CSS.escape(key) + '"] > .line .text') || (titleEl.isContentEditable && titleEl.dataset.key === key ? titleEl : null);
const nodeElOf = (key) => outline.querySelector('.node[data-key="' + CSS.escape(key) + '"]');
const titleCheck = $('titleCheck'); // zoomed into a task: its checkbox before the title
const taskInfoEl = $('taskInfo');
titleCheck.onmousedown = (e) => e.preventDefault();
const nodeEls = (el) => [...el.parentElement.children].filter((c) => c.classList.contains('node') && !c.classList.contains('leaving')); // visible siblings of a .node element
const ICONS = window.ICONS || {}; // icons.js: Tana line icon set (Nucleo export), greyscale via currentColor
// glyphs for the Library kinds the icon set lacks (chat, canvas, agent, skill): single-stroke line icons in the same 18px grid
const STROKE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">';
const LIB_ICONS = {
  chat: STROKE + '<path d="M9 2.75c-3.6 0-6.25 2.35-6.25 5.25 0 1.45.65 2.75 1.7 3.7L3.75 15.25l3.35-1.35c.6.15 1.25.25 1.9.25 3.6 0 6.25-2.35 6.25-5.25S12.6 2.75 9 2.75z"/></svg>',
  canvas: STROKE + '<path d="M2.75 12.25c1.5-3.5 3-5.25 4.25-5.25 1.75 0 1.75 5.25 3.5 5.25 1.25 0 2.75-2.25 4.75-6.5"/></svg>',
  agent: STROKE + '<rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2"/><path d="M6 9.75a3 3 0 0 0 6 0"/><path d="M6.5 6.5h.01M11.5 6.5h.01" stroke-width="1.5"/></svg>',
  skill: STROKE + '<rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2"/><path d="M10.75 5.5l-3.5 7"/></svg>',
  // placeholder while a row's visibility is still being read: the audience icons in the same 18px grid, drawn open
  pending: STROKE + '<path d="M9 11.75C10.5188 11.75 11.75 10.5188 11.75 9C11.75 7.48122 10.5188 6.25 9 6.25C7.48122 6.25 6.25 7.48122 6.25 9C6.25 10.5188 7.48122 11.75 9 11.75Z"/><path d="M10.4277 3.3967C9.97907 3.3022 9.50347 3.25 8.99997 3.25C8.49647 3.25 8.02087 3.3022 7.57227 3.3967"/><path d="M3.59241 5.7576C4.03861 5.2786 4.56019 4.81329 5.16119 4.41629"/><path d="M2.0443 10.1133C1.6519 9.42061 1.6519 8.57951 2.0443 7.88681"/><path d="M14.4077 5.7576C13.9615 5.2786 13.4399 4.81329 12.8389 4.41629"/><path d="M10.4277 14.6033C9.97907 14.6978 9.50347 14.75 8.99997 14.75C8.49647 14.75 8.02087 14.6978 7.57227 14.6033"/><path d="M3.59241 12.2424C4.03861 12.7214 4.56019 13.1867 5.16119 13.5837"/><path d="M14.4077 12.2424C13.9615 12.7214 13.4399 13.1867 12.8389 13.5837"/><path d="M15.9557 10.1133C16.3481 9.42061 16.3481 8.57951 15.9557 7.88681"/></svg>',
};
const iconSvg = (icon) => ICONS[icon === 'meeting' ? 'calendar' : icon] || LIB_ICONS[icon] || '';
const isTask = (node) => node.kind === 'document' && node.icon === 'task';
const isCheckboxBlock = (node) => node?.kind === 'block' && node.done != null;
function visibleTags(node) {
  const tags = node.tags || [];
  return isTask(node) && tags.some((tag) => tag.label !== 'task') ? tags.filter((tag) => tag.label !== 'task') : tags;
}
function appendTags(el, node) { for (const tag of visibleTags(node)) el.append(chipEl(tag, node.hue)); }
const canEditNode = (node) => !!node && node.editable !== false;
function canEditItem(item) {
  if (!canEditNode(item.node)) return false;
  for (let parent = item.parent; parent; parent = parent.parent) if (parent.node.kind === 'document') return canEditNode(parent.node);
  return canEditNode(docOf(item.docId) || item.node);
}
// A reference and a divider are read-only rows, but they are still blocks of a writable document: they can be moved and removed.
const canEditStructure = (item) => canEditItem(item) || ((item.node.type === 'reference' || isDivider(item.node)) && canEditNode(docOf(item.docId)));
// an inline reference renders the referenced document's title: editing the row edits that document, and a read-only
// target stays read-only. The containing document counts too: a chat's attachment row would otherwise offer to
// rename the attached document (only a positively read-only container blocks, so ordinary embeds are unchanged).
const canEditText = (item) => (isReference(item.node) ? canEditNode(referenceTarget(item.node)) && docOf(item.docId)?.editable !== false : canEditItem(item));
const chatIcon = (n) => n.icon || ((n.tags || []).some((t) => t.label === 'chat') ? 'chat' : undefined);
const nodeIcon = (n) => chatIcon(n) || ((n.tags || []).some((t) => t.label === 'agent') ? 'agent' : undefined);
const asDoc = (n) => ({ ...n, kind: 'document', text: n.text ?? n.title ?? '', hasChildren: true, icon: nodeIcon(n) }); // api.node / search / library result -> document Node
// a draft row keeps a local "draftdoc:N" id until it is created, and the main process knows nothing about it
const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
function sensitiveHidden(id) {
  return !sensitiveVisible && typeof id === 'string' && (sensitiveIds === null || sensitiveIds.has(id));
}
function blurSensitive(el, ...ids) {
  const present = ids.filter(isRealId);
  sensitiveEls.set(el, present);
  el.classList.toggle('sensitive', present.some(sensitiveHidden));
  return el;
}
function refreshSensitive() {
  for (const [el, ids] of sensitiveEls) {
    if (!el.isConnected) sensitiveEls.delete(el);
    else el.classList.toggle('sensitive', ids.some(sensitiveHidden));
  }
}
function loadSensitive() {
  if (!sensitiveLoading) sensitiveLoading = Promise.resolve(tana.sensitiveIds ? tana.sensitiveIds() : [])
    .then((ids) => { sensitiveIds = new Set(ids); }, showError);
  return sensitiveLoading;
}
// recently viewed documents (localStorage "recent"), most recent first, max 20
const recent = () => { try { return (JSON.parse(localStorage.getItem('recent')) || []).map((n) => asDoc(!n.icon && !n.tags?.length && n.id?.startsWith('tana:text:') ? { ...n, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] } : n)); } catch { return []; } };
function recordRecent(n) {
  const entry = { id: n.id, title: n.text ?? n.title ?? '', icon: n.icon, tags: n.tags, meta: n.meta, hue: n.hue };
  localStorage.setItem('recent', JSON.stringify([entry, ...recent().filter((r) => r.id !== n.id)].slice(0, 20)));
}
function forgetRecent(id) {
  try {
    const rows = JSON.parse(localStorage.getItem('recent') || '[]');
    localStorage.setItem('recent', JSON.stringify(rows.filter((row) => row && row.id !== id)));
  } catch { localStorage.removeItem('recent'); }
}
// A recorded row keeps the title and meta it had when it was opened, and a meeting's meta ages: when the node is
// loaded now, the palette shows what it says today rather than what it said then.
const recentRows = () => recent().map((row) => { const live = docOf(row.id); return live ? { ...row, text: live.text, meta: live.meta, hue: live.hue } : row; });
// index of the first meeting dated today or later. The list is oldest first over [today-7, today+7) and the meta
// only carries a weekday ("Mon 9:00–9:30"), so walk the weekday sequence from the window start (same weekday as today).
// ponytail: a gap of 7+ days without meetings under-counts a week; then nothing is marked and the view stays at the top
function todayIndex(nodes) {
  let d = 0, prev = new Date().getDay();
  for (let i = 0; i < nodes.length; i++) {
    const wd = WD.indexOf((nodes[i].meta || '').slice(0, 3));
    if (wd < 0) continue;
    d += (wd - prev + 7) % 7; prev = wd;
    if (d >= 7) return i;
  }
  return -1;
}

async function loadRoots() {
  await loadSensitive(); // privacy gate: no document reaches the first render before the local marks do
  const drafts = views.flatMap((s) => s.nodes.map((node, i) => ({ view: s.id, i, node })).filter((d) => d.node.draft)); // a refresh must not drop a draft being typed
  views = (await tana.roots()).map((s) => ({ ...s, title: s.id === 'people' ? 'People' : s.title, icon: s.id === 'library' ? 'library' : s.icon, nodes: s.nodes.map(asDoc) }));
  rootsLoaded = true;
  for (const [id, f] of fresh) { // a created document stays where it was drafted until the roots query lists it
    const s = views.find((x) => x.id === f.section);
    if (!s || s.nodes.some((n) => n.id === id)) fresh.delete(id);
    else s.nodes.splice(s.nodes.findIndex((n) => n.id === f.after) + 1, 0, f.node);
  }
  for (const d of drafts) { const s = views.find((x) => x.id === d.view); if (s) s.nodes.splice(d.i, 0, d.node); }
}
async function reload(docId) { kids.set(docId, await tana.children(docId)); }
function loadView(id = view) {
  const filter = filters.get(id);
  if (!filter || !tana.viewList) return Promise.resolve();
  const seq = (viewSeq.get(id) || 0) + 1;
  viewSeq.set(id, seq);
  return tana.viewList(id, filter).then((result) => {
    if (viewSeq.get(id) !== seq) return;
    const target = views.find((item) => item.id === id);
    if (!target) return;
    const drafts = target.nodes.map((node, i) => ({ node, i })).filter((item) => item.node.draft);
    target.nodes = (result.nodes || []).map(asDoc);
    if (result.truncated) truncated.add(id); else truncated.delete(id);
    for (const [docId, f] of fresh) if (f.section === id) {
      if (target.nodes.some((node) => node.id === docId)) fresh.delete(docId);
      else target.nodes.splice(target.nodes.findIndex((node) => node.id === f.after) + 1, 0, f.node);
    }
    for (const draft of drafts) target.nodes.splice(draft.i, 0, draft.node);
    render();
  }, showError);
}
function loadFilters() {
  Promise.all(views.map(async (item) => filters.set(item.id, await tana.viewFilter(item.id)))).then(() => { loadView(); render(); }, showError);
}
function setViewF(patch) {
  const id = view, next = { ...filters.get(id), ...patch };
  filters.set(id, next); render();
  run(async () => { filters.set(id, await tana.setViewFilter(id, next)); await loadView(id); });
}
const clearFilter = (f = {}) => ({ types: null, states: null, assignee: 'anyone', text: '', participant: f.participant || null, window: f.window || null });
const sameList = (a, b) => JSON.stringify(a ? [...a].sort() : a) === JSON.stringify(b ? [...b].sort() : b);
function sameFilter(a = {}, b = {}) {
  return sameList(a.types || null, b.types || null) && sameList(a.states || null, b.states || null)
    && (a.assignee || 'anyone') === (b.assignee || 'anyone') && String(a.text || '') === String(b.text || '')
    && (a.participant || null) === (b.participant || null) && (a.window || null) === (b.window || null) && !!a.mcp === !!b.mcp;
}
function viewFiltered() {
  const filter = filters.get(view);
  return !!filter && !sameFilter(filter, clearFilter(filter));
}
function clearFilters() { setViewF(clearFilter(filters.get(view))); }
function ensureLoaded(item) {
  if (item.node.kind !== 'document' || kids.has(item.docId)) return;
  kids.set(item.docId, null);
  reload(item.docId).then(render, showError);
}

// ---- caret helpers (contenteditable: text nodes + non-editable mention anchors) ----
function caretOffset(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.focusNode)) return null;
  const r = document.createRange(); r.selectNodeContents(el); r.setEnd(sel.focusNode, sel.focusOffset);
  return r.toString().length;
}
function setCaret(el, offset) {
  el.focus();
  let left = Math.max(0, Math.min(offset, el.textContent.length));
  const r = document.createRange(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let t, placed = false;
  while ((t = walker.nextNode())) {
    if (left <= t.data.length) {
      const a = t.parentNode !== el && t.parentNode.closest('.mention');
      if (a) { if (left === 0) r.setStartBefore(a); else r.setStartAfter(a); } else r.setStart(t, left); // never inside a mention
      placed = true; break;
    }
    left -= t.data.length;
  }
  if (!placed) r.setStart(el, el.childNodes.length);
  r.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
function focused() {
  const el = document.activeElement;
  if (el === titleEl && titleEl.isContentEditable) return { key: titleEl.dataset.key, offset: caretOffset(titleEl) };
  return el && el.classList.contains('text') && outline.contains(el) ? { key: keyOfEl(el), offset: caretOffset(el) } : null;
}
// [node, offset] for a plain-text offset inside el (the DOM point the same character sits at)
function textPoint(el, offset) {
  let left = Math.max(0, Math.min(offset, el.textContent.length));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let t;
  while ((t = walker.nextNode())) { if (left <= t.data.length) return [t, left]; left -= t.data.length; }
  return [el, el.childNodes.length];
}
// put the selection back after a formatting round trip re-rendered the node
function selectRange(key, start, end) {
  const el = textEl(key);
  if (!el) return;
  el.focus();
  const r = document.createRange(), [sn, so] = textPoint(el, start), [en, eo] = textPoint(el, end);
  r.setStart(sn, so); r.setEnd(en, eo);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
// [start, end] plain-text offsets of a non-empty selection inside el, else null
function selectionOffsets(el) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const pre = document.createRange(); pre.selectNodeContents(el);
  pre.setEnd(r.startContainer, r.startOffset); const start = pre.toString().length;
  pre.setEnd(r.endContainer, r.endOffset); const end = pre.toString().length;
  return end > start ? [start, end] : null;
}
function placeCaret(key, offset) {
  const el = textEl(key);
  if (el) setCaret(el, offset == null ? el.textContent.length : offset);
}
// caret into keys[i] (at offset) when it still exists, else the nearest surviving node: previous ones first, then following
function caretNear(keys, i, offset) {
  for (const k of [keys[i], ...keys.slice(0, i).reverse(), ...keys.slice(i + 1)]) if (k && textEl(k)) return placeCaret(k, k === keys[i] ? offset : null);
}
// true when the caret sits on the first (up) / last (down) visual line of el
function atEdge(el, dir) {
  const sel = getSelection();
  if (!sel.rangeCount) return true;
  const rects = sel.getRangeAt(0).getClientRects();
  if (!rects.length) return true;
  const r = rects[0], box = el.getBoundingClientRect(), lh = r.height || 20;
  return dir === 'up' ? r.top - box.top < lh / 2 : box.bottom - r.bottom < lh / 2;
}

// ---- render ----
let rendering = false; // a focusout caused by swapping elements out during a render is not the user leaving a node
let renderDeferred = false;
let caretOnOpen = false; // set when a node is opened: the first render with its children puts the caret where typing works
// An empty ordinary row is already somewhere to type; an image, divider or reference row is not.
const typableRow = (n) => !!n && n.kind === 'block' && !isAtomic(n) && !isReference(n) && !plainOf(n).length;
// Opening a node leaves a row to type in: the local draft row the empty document case has always shown, which stays
// out of Tana until its first typed character (materialise) and is discarded by anything else.
// A block with children appends through insertAfter(last); an empty block uses insertChild.
function withDraftTail(list, parent) {
  if (!Array.isArray(childrenOf(parent)) || isSpace(parent.node) || !canEditItem(parent) || !canInsertChild(parent)) return list;
  if (typableRow(list.at(-1))) return list;
  return [...list, draftNode(parent)];
}
function editingRow() {
  const el = document.activeElement;
  return !!(el && el.isContentEditable && (el === titleEl || outline.contains(el)));
}
// A row arriving in or dropping out of a view is shown, not swapped in silently: an arrival fades in over a green
// tint, and a row that left is put back where it was over a red tint and fades away. Within one view only, since
// switching views, zooming and the first paint replace every row and must not flash.
function animateRows(before) {
  if (animView !== view) { animView = view; return; }
  const rows = [...outline.children].filter((el) => el.classList.contains('node'));
  const keys = new Set(rows.map((el) => el.dataset.key));
  const old = [...before.keys()];
  const arrived = rows.filter((el) => !before.has(el.dataset.key) && !el.classList.contains('draft'));
  const gone = old.filter((key) => !keys.has(key) && !key.startsWith('draft'));
  // ponytail: above a handful, the list changed rather than an item moving in or out (filtering, a reload, a new
  // set of rows), and it neither reads as an arrival nor is worth a few hundred ghost rows. Raise if it feels shy.
  const BULK = 25;
  if (arrived.length > BULK || gone.length > BULK) return;
  for (const el of arrived) el.classList.add('entering');
  for (const key of gone) {
    const el = before.get(key);
    const next = old.slice(old.indexOf(key) + 1).find((k) => keys.has(k)); // back where it was: before the first row that outlived it
    if (!el.classList.contains('leaving')) { // one that is already on its way out: the renders that keep coming must not cut it short
      el.classList.add('leaving'); el.classList.remove('selected', 'entering'); // a row that just arrived and left again only leaves
      for (const t of el.querySelectorAll('[contenteditable]')) t.removeAttribute('contenteditable');
      setTimeout(() => el.remove(), 500); // not animationend: reduced motion runs no animation and the row must still go
    }
    outline.insertBefore(el, (next && nodeElOf(next)) || null);
  }
}
// The render that would drop the row you are typing in is deferred until the caret leaves (complete a task and the
// Tasks filter no longer wants it). Dim it meanwhile: it stays where it is, and the deferred render fades it out
// like any other row that left.
function markFalling() {
  const f = zoom ? null : focused(), el = f && nodeElOf(f.key), v = viewOf();
  if (el && v) el.classList.toggle('falling', !v.nodes.some((n) => keyFor(n.id, n) === f.key));
}
function render(force = false) {
  if (force !== true && (editingRow() || selectionFrozen)) { renderDeferred = true; markFalling(); return; }
  renderDeferred = false; rendering = true;
  try { renderOutline(); } finally { rendering = false; }
}
// Metadata and sync may finish between keystrokes. Apply their deferred render only after the caret leaves editable rows.
document.addEventListener('focusout', () => queueMicrotask(() => { if (renderDeferred && !editingRow() && !selectionFrozen) render(); }));
function renderOutline() {
  const saved = focused();
  // a live update must not eat a selection: the formatting toolbar acts on it, and a re-render lands mid-toggle
  const savedSel = saved && document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('text') ? selectionOffsets(document.activeElement) : null;
  items.clear();
  let trail = null;
  if (zoom) { trail = resolveZoom(); if (!trail) zoom = null; }
  const parent = trail && trail.at(-1);
  let list, hidden = 0;
  if (parent) {
    if (!parent.node.draft) ensureLoaded(parent);
    list = parent.node.draft ? [] : childrenOf(parent) || [];
    list = withDraftTail(list, parent); // an open node always has a row to type in; a read-only one (every chat) never does
    outline.replaceChildren(...list.map((n) => childEl(n, parent)));
  } else {
    const v = viewOf(), docs = v ? v.nodes : [];
    const q = filterEl.value.trim().toLowerCase();
    list = q ? docs.filter((n) => n.text.toLowerCase().includes(q)) : docs;
    hidden = docs.length - list.length;
    list = sortRows(list); // Default leaves the view's own order alone
    const groups = groupsOf(list); // null when the view is not grouped: one flat list, as before
    if (groups) list = groups.flatMap((g) => g.nodes); // keyboard order follows what is on screen
    const before = new Map([...outline.children].filter((el) => el.classList.contains('node')).map((el) => [el.dataset.key, el]));
    outline.replaceChildren(...(groups
      ? groups.flatMap((g) => [groupHeadEl(g.title), ...g.nodes.map((n) => nodeEl(n, n.id, null))])
      : list.map((n) => nodeEl(n, n.id, null))));
    animateRows(before);
    const today = view === 'meetings' && !groups ? outline.children[todayIndex(list)] : null;
    if (today) today.dataset.today = '';
    if (list.length && !outline.hidden && scrolledView !== view) { // a view opens scrolled to today's first meeting (else the top)
      scrolledView = view;
      if (today) today.scrollIntoView({ block: 'start' }); else outline.parentElement.scrollTop = 0;
    }
  }
  if (parent && !list.length) {
    const note = document.createElement('div');
    note.className = 'empty-note'; note.textContent = kids.get(parent.docId) === null ? 'Loading…' : 'No content';
    outline.append(note);
  }
  // the page title is the zoom target itself: documents use setTitle, blocks use setText through the same debounce
  const editable = parent && !isAtomic(parent.node) && !isReference(parent.node) && canEditText(parent);
  if (editable) titleEl.contentEditable = 'plaintext-only'; else titleEl.removeAttribute('contenteditable');
  titleEl.dataset.key = editable ? parent.key : '';
  titleEl.textContent = editable && pending.has(parent.key) ? plainOf(pending.get(parent.key).segs) : parent ? parent.node.text : viewOf() ? viewOf().title : 'Tana';
  blurSensitive(titleEl, parent && parent.docId);
  // zoomed task: its checkbox before the title (toggleDone, like row checkboxes; Cmd+Enter in the title too)
  const zoomedTask = parent && isTask(parent.node);
  titleCheck.hidden = !zoomedTask; titleCheck.checked = zoomedTask && !!parent.node.done;
  titleCheck.disabled = zoomedTask && !canEditItem(parent);
  titleCheck.onclick = zoomedTask && canEditItem(parent) ? () => toggleDone(parent) : null;
  titleEl.classList.toggle('done', zoomedTask && !!parent.node.done);
  // assignees and visibility now live at the top of the sidebar (railMetaRows); under the title only the chips remain
  const titleTags = zoomedTask && visibleTags(parent.node).some((tag) => tag.label !== 'task');
  taskInfoEl.hidden = !titleTags; taskInfoEl.replaceChildren();
  if (titleTags) appendTags(taskInfoEl, parent.node);
  blurSensitive(taskInfoEl, parent && parent.docId);
  renderFields(parent);
  renderCrumbs(trail);
  renderRail(parent);
  const showPills = !parent && authed && pillsApply();
  renderPills(showPills);
  filterRow.hidden = !!parent || !(filterShown || filterEl.value);
  filterRow.classList.toggle('empty', !filterEl.value);
  $('filtered').textContent = [hidden ? hidden + ' items filtered out' : '', truncated.has(view) ? 'Showing the first 1,000 results' : ''].filter(Boolean).join(' · ');
  // Cached rows remain usable while auth and sync reconnect; reserve the skeleton for an empty outline.
  const loading = !parent && !outline.children.length && (authChecking || !rootsLoaded || !filters.has(view) || (authed && !connected));
  $('skeleton').classList.toggle('gone', !loading);
  if (!parent && !list.length && !loading && !filterEl.value) { // an empty view says so; a filtered-out list is explained by the count below it
    const note = document.createElement('div');
    note.className = 'empty-note'; note.textContent = 'Nothing here yet';
    if (viewFiltered()) { // the view is empty because of its filters, not because there is nothing there
      const clear = document.createElement('button');
      clear.className = 'clearfilters'; clear.textContent = 'Clear filters'; clear.onclick = clearFilters;
      note.append(' ', clear);
    }
    outline.append(note);
  }
  applySel();
  if (saved && savedSel) selectRange(saved.key, savedSel[0], savedSel[1]);
  else if (saved) placeCaret(saved.key, saved.offset);
  // the caret lands in that typable row once per open: a later render (a live update, a refresh) must not pull it back
  if (caretOnOpen && parent && Array.isArray(childrenOf(parent))) {
    caretOnOpen = false;
    const last = list.at(-1), el = last && palette.hidden && !focused() ? textEl(keyFor(parent.docId, last)) : null;
    if (el && el.isContentEditable && !el.textContent) setCaret(el, 0);
  }
}

function resolveZoom() {
  const doc = docOf(zoom.docId);
  if (!doc) return null;
  let item = mkItem(zoom.docId, doc, null);
  const trail = [item];
  if (zoom.nodeId) {
    const found = locate(kids.get(zoom.docId) || [], zoom.nodeId);
    if (!found) return kids.has(zoom.docId) && kids.get(zoom.docId) !== null ? null : trail;
    for (const t of found.trail) trail.push(item = mkItem(zoom.docId, t.node, item));
    trail.push(item = mkItem(zoom.docId, found.node, item));
  }
  return trail;
}

// The zoomed node's own fields (type attributes) under the title; the values come with api.related.
function renderFields(parent) {
  const el = $('fields');
  const data = parent && parent.node.kind === 'document' ? relatedBy.get(parent.docId) : null;
  const fields = (data && data.fields) || [];
  el.hidden = !fields.length;
  el.replaceChildren();
  for (const field of fields) {
    const row = document.createElement('div'); row.className = 'field';
    const icon = document.createElement('span'); icon.className = 'ricon'; icon.innerHTML = iconSvg('field');
    row.append(icon);
    // the type names its fields; an unreadable type leaves the value to speak for itself
    if (field.label) { const label = document.createElement('span'); label.className = 'flabel'; label.textContent = field.label; row.append(label); }
    const value = document.createElement('span');
    value.className = 'fvalue'; value.textContent = field.text || '';
    if (tana.setField && canEditItem(parent)) { // a field value is ordinary text on this document
      value.contentEditable = 'plaintext-only'; value.spellcheck = false;
      value.onblur = () => { const next = value.textContent.trim(); if (next !== (field.text || '')) { field.text = next; run(() => tana.setField(parent.docId, field.key, next)); } };
      value.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); value.blur(); } else if (e.key === 'Escape') { e.preventDefault(); value.textContent = field.text || ''; value.blur(); } };
    }
    row.append(value);
    el.append(row);
  }
  blurSensitive(el, parent && parent.docId);
}
// api.related for the zoomed document, fetched once per id; a failure simply leaves the rail empty
function loadRelated(docId) {
  if (!tana.related || !isRealId(docId) || relatedBy.has(docId)) return;
  relatedBy.set(docId, null);
  tana.related(docId).then((data) => { relatedBy.set(docId, data); render(); }, () => { relatedBy.delete(docId); });
}
function railRow(node) {
  const row = document.createElement('div');
  row.className = 'rrow' + (node.done ? ' done' : '');
  row.tabIndex = -1; row.dataset.id = node.id;
  if (isTask(node)) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!node.done; check.tabIndex = -1;
    check.disabled = !canEditNode(node);
    check.onmousedown = (e) => e.preventDefault();
    check.onclick = (e) => { e.stopPropagation(); toggleRelated(node); };
    row.append(check);
  } else {
    const icon = document.createElement('span');
    icon.className = 'ricon ' + (node.icon || 'doc') + (node.hue != null ? ' hue' : '');
    if (node.hue != null) icon.style.setProperty('--hue', String(node.hue));
    icon.innerHTML = node.iconSvg || iconSvg(node.icon || 'doc');
    row.append(icon);
  }
  const title = document.createElement('span');
  title.className = 'rtitle'; title.textContent = node.text || node.title || 'Untitled';
  blurSensitive(title, node.id);
  row.append(title);
  appendTags(row, node);
  // the sidebar is narrow: a tag shows as its "#" in the type's colour and expands on hover (CSS), with the full
  // label available to the pointer and to assistive tech
  for (const chip of row.querySelectorAll('.chip')) { chip.title = chip.textContent.trim(); blurSensitive(chip, node.id); }
  // that expansion narrows the title, which could re-wrap it and jump the row under the pointer: hold the title to
  // the line count it already has, so the label truncates instead and the row keeps its height
  const holdLines = () => { const lh = parseFloat(getComputedStyle(title).lineHeight) || 19; title.style.webkitLineClamp = String(Math.max(1, Math.round(title.offsetHeight / lh))); };
  const freeLines = () => { title.style.webkitLineClamp = ''; };
  row.onmouseenter = holdLines; row.onmouseleave = freeLines;
  row.onfocus = holdLines; row.onblur = freeLines;
  row.onclick = () => goTo(node.id);
  row.onkeydown = (e) => railKey(e, node, row);
  return row;
}
function toggleRelated(node) {
  if (!canEditNode(node) || !tana.setDone) return;
  const done = node.done ? 0 : 1;
  node.done = done;
  run(async () => { await tana.setDone(node.id, !!done); });
  render(true);
}
const railRowEls = () => [...railEl.querySelectorAll('.rrow')];
function focusRail(index = 0) {
  const rows = railRowEls();
  if (!rows.length) return false;
  rows[Math.max(0, Math.min(rows.length - 1, index))].focus();
  return true;
}
// Up/Down/Escape work the same on every sidebar row, including the task metadata rows above Pinned
function railMove(e, row) {
  const rows = railRowEls(), i = rows.indexOf(row);
  if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)].focus(); return true; }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) rows[i - 1].focus(); return true; }
  if (e.key === 'Escape' || (e.key === 'ArrowLeft' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.focus(); return true; }
  return false;
}
function railKey(e, node, row) {
  if (railMove(e, row)) return;
  if (e.key === 'Enter') { e.preventDefault(); goTo(node.id); }
  else if (e.key === ' ') { e.preventDefault(); toggleRelated(node); }
  else if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleRailSection(row.dataset.section); } // collapse the section the focused row is in
  else if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (railClosed.has(row.dataset.section)) toggleRailSection(row.dataset.section); }
}
// A meeting's call link (api.related().call), at the very top of the sidebar so it can be joined from there.
function railCallRow(data) {
  const call = data && data.call;
  if (!call || !call.url || !tana.openExternal) return null; // no call, no row
  return { id: 'call', icon: 'video', label: call.label || call.url, run: () => run(() => tana.openExternal(call.url)) };
}
// The zoomed task's own metadata, at the top of the sidebar: who it is assigned to and who can see it. Both open the
// pickers the palette already uses (api.setAssignees / api.setSharing). Nothing known, nothing shown.
function railMetaRows(node, accessNode = node) {
  // The sidebar describes any document, not only tasks: a doc can be link-shared or live in a space too.
  const summary = taskSummary(node) || documentSummary(node);
  const writable = canEditNode(node);
  const rows = summary?.assignees ? [{
    id: 'assignees',
    icon: summary.assignees === 'Unassigned' ? 'unassigned' : 'member',
    label: summary.assignees === 'Unassigned' ? 'Unassigned' : 'Assigned to ' + summary.assignees,
    run: writable && tana.taskMeta && tana.setAssignees ? () => openAssigneePalette(node) : null,
  }] : [];
  if (summary?.audience) rows.push({ // an unverifiable audience is not a row: there is nothing to show or change
    id: 'visibility', icon: summary.audience.icon, label: summary.audience.label,
    run: tana.accessOptions ? () => openVisibility(accessNode, summary.scope) : null,
  });
  // link sharing is a separate fact from the Tana audience, and read-only here: Tana owns that switch
  if (summary?.linkShared) rows.push({ id: 'linkShared', icon: 'globe', label: 'Anyone with the link', run: null });
  if (tana.nodeLink && tana.openExternal && isRealId(node.id)) rows.push({
    id: 'showInTana', icon: 'tana', label: 'Show in Tana',
    run: () => run(async () => tana.openExternal(await tana.nodeLink(node.id))),
  });
  return rows;
}
function railMetaEl(row) {
  const el = document.createElement('div');
  el.className = 'rrow rmeta' + (row.run ? '' : ' fixed'); // not .meta: that is the grey inline meta text of an outline row
  el.tabIndex = -1; el.dataset.id = 'meta:' + row.id;
  const icon = document.createElement('span'); icon.className = 'ricon'; icon.innerHTML = iconSvg(row.icon);
  const title = document.createElement('span'); title.className = 'rtitle'; title.textContent = row.label;
  el.append(icon, title);
  el.onclick = row.run || null;
  el.onkeydown = (e) => { if (railMove(e, el)) return; if (row.run && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.run(); } };
  return el;
}
function toggleRailSection(label) {
  if (railClosed.has(label)) railClosed.delete(label); else railClosed.add(label);
  localStorage.setItem('railClosed', JSON.stringify([...railClosed]));
  render(true);
}
function railGroups(data) {
  return data ? [
    ['Pinned', data.pinned || [], data.pinHub],
    ['Outcomes', data.outcomes],
    ['References', data.notes],
  ].filter(([, rows, action]) => (rows && rows.length) || action) : [];
}
function railPinAction(pinHub, docId) {
  const row = railMetaEl({ id: 'pinNew', icon: 'pin', label: 'Pin something…', run: () => togglePalette('search', null, { pinHub, docId }) });
  row.dataset.id = 'action:pinNew';
  return row;
}
// Pinned / Outcomes / References for the zoomed document; a writable pin hub keeps Pinned available when empty.
function renderRail(parent) {
  const active = document.activeElement, keep = active && active.classList && active.classList.contains('rrow') ? active.dataset.id : null;
  railEl.replaceChildren();
  const docId = parent && parent.node.kind === 'document' && !parent.node.draft ? parent.docId : null;
  if (!docId) { railEl.hidden = railGrip.hidden = true; return; }
  loadRelated(docId);
  const data = relatedBy.get(docId);
  // Event views immediately follow their write-up document. Sharing still belongs to the event itself.
  const accessNode = data?.pinHub?.startsWith('tana:event:') ? { id: data.pinHub } : parent.node;
  const meta = railMetaRows(parent.node, accessNode);
  if (sensitiveIds?.has(docId)) meta.unshift({ id: 'sensitive', icon: 'lock', label: 'Sensitive', run: null });
  const call = railCallRow(data);
  if (call) meta.unshift(call);
  // "Notes" is what api.related calls them; in the sidebar they read as References
  const groups = railGroups(data);
  railEl.hidden = railGrip.hidden = !groups.length && !meta.length;
  const sectionHead = (label) => { // every sidebar section collapses the same way, Details included
    const head = document.createElement('button');
    head.className = 'rhead' + (railClosed.has(label) ? ' closed' : '');
    head.tabIndex = -1; head.innerHTML = CHEV; head.append(label);
    head.onclick = () => toggleRailSection(label);
    railEl.append(head);
    return !railClosed.has(label);
  };
  if (meta.length && sectionHead('Details')) for (const row of meta) { const el = railMetaEl(row); el.dataset.section = 'Details'; railEl.append(el); }
  for (const [label, rows, pinHub] of groups) {
    if (!sectionHead(label)) continue;
    for (const node of rows) { const row = railRow(asDoc(node)); row.dataset.section = label; railEl.append(row); }
    if (pinHub) { const row = railPinAction(pinHub, docId); row.dataset.section = label; railEl.append(row); }
  }
  if (keep) { const again = railEl.querySelector('.rrow[data-id="' + keep + '"]'); if (again) again.focus(); }
}
// The date of a meeting crumb, in the form the Meetings list and search already show (main.js eventMeta): read off
// the event row when the app has it, else fetched once through api.node, which carries the same formatted string.
const eventWhen = new Map(); // event id -> its meta string ('' when it has none), null while the fetch is in flight
function crumbWhen(id) {
  if (typeof id !== 'string' || !id.startsWith('tana:event:')) return null;
  const known = docOf(id);
  if (known && known.meta) return known.meta;
  if (!eventWhen.has(id) && tana.node) {
    eventWhen.set(id, null);
    tana.node(id).then((n) => { eventWhen.set(id, n.meta || ''); if (n.meta) render(); }, () => eventWhen.delete(id));
  }
  return eventWhen.get(id) || null;
}
function renderCrumbs(trail) {
  const nav = $('crumbs');
  nav.hidden = !trail;
  if (!trail) return;
  const back = () => { zoom = null; render(); };
  nav.replaceChildren();
  // location in Tana (owner chain from api.path, e.g. "Library" or "Automation Guild › Meeting"), loaded once per document.
  // A document reached through a space (zoom.via) starts at the space's location; the spaces follow as crumbs.
  const root = zoom.via ? zoom.via[0] : zoom, rootId = root.docId;
  const path = paths.get(rootId);
  if (!path && tana.path && isRealId(rootId)) { paths.set(rootId, []); tana.path(rootId).then((p) => { paths.set(rootId, p); if (zoom && (zoom.via ? zoom.via[0] : zoom).docId === rootId) render(); }).catch(() => {}); }
  for (const [i, p] of (path && path.length ? path : [{ id: '', title: root.from || (viewOf() ? viewOf().title : 'Tana') }]).entries()) {
    if (i) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; nav.append(sep); }
    const a = document.createElement('a');
    // ancestors can share a title (a meeting named after its space), so each crumb shows its kind icon
    if (p.icon) { const ricon = document.createElement('span'); ricon.className = 'ricon ' + p.icon; ricon.innerHTML = iconSvg(p.icon); a.append(ricon); }
    a.append(p.title);
    const when = crumbWhen(p.id); // a meeting crumb also says when it was: two meetings often share a title
    if (when) { const date = document.createElement('span'); date.className = 'cdate'; date.textContent = when; a.append(date); }
    blurSensitive(a, p.id);
    a.onclick = p.id === 'library' ? () => setView('library') : p.id ? () => goTo(p.id) : back;
    nav.append(a);
  }
  for (const v of zoom.via || []) {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement('a'); a.textContent = (docOf(v.docId) || {}).text || 'Untitled'; blurSensitive(a, v.docId); a.onclick = () => { zoom = v; render(); };
    nav.append(sep, a);
  }
  for (const item of trail.slice(0, -1)) { // ancestors only: the page title already shows the current node
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement('a'); a.textContent = item.node.text || 'Untitled'; blurSensitive(a, item.docId); a.onclick = () => zoomTo(item);
    nav.append(sep, a);
  }
}

// a child row: document children (inside a space) are their own document, so their key, children and edits go by their own id
const childEl = (n, item) => nodeEl(n, n.kind === 'document' ? n.id : item.docId, item);
function nodeEl(node, docId, parent) {
  const item = mkItem(docId, node, parent);
  const target = referenceTarget(node), display = target || node, reference = isReference(node);
  const has = hasKids(item), opened = isOpen(item);
  const expandable = has || (!node.draft && canEditItem(item) && (node.kind === 'document' || node.done != null || ['paragraph', 'bullet', 'numbered'].includes(node.block)));
  const el = document.createElement('div');
  const heading = headingOf(node); // a heading arrives as node.heading or as the heading1-3 block type
  const blockClass = node.kind === 'block' ? ' t-' + (isDivider(node) ? 'divider' : blockTypeOf(node)) : '';
  el.className = 'node ' + node.kind + (reference ? ' reference' : '') + blockClass + (heading ? ' h' + heading : '') + (display.done ? ' done' : '') + (has ? ' has' : '') + (has && !opened ? ' collapsed' : '') + (node.draft ? ' draft' : '');
  el.dataset.key = item.key;
  const line = document.createElement('div'); line.className = 'line';
  const chev = document.createElement('button'); chev.className = 'chev'; chev.tabIndex = -1;
  chev.onmousedown = (e) => e.preventDefault();
  chev.classList.toggle('off', !expandable); // hidden glyph, kept in the layout so the row never shifts
  const bullet = document.createElement('span'); bullet.className = 'bullet'; bullet.title = 'Zoom in';
  if (display.iconSvg) { bullet.classList.add('icon', 'custom'); bullet.innerHTML = display.iconSvg; }
  else if (display.icon) { bullet.classList.add('icon', display.icon); bullet.innerHTML = iconSvg(display.icon); }
  if (!display.iconSvg && display.hue != null) { bullet.classList.add('hue'); bullet.style.setProperty('--hue', String(display.hue)); } // type hue tints the icon and the plain bullet alike
  bullet.onmousedown = (e) => e.preventDefault();
  if (!node.draft) bullet.onclick = () => reference ? openReference(node) : zoomTo(item);
  line.append(chev, bullet);
  if (isTask(display) || isCheckboxBlock(display)) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!display.done; check.tabIndex = -1;
    check.onmousedown = (e) => e.preventDefault();
    check.disabled = reference ? !canEditNode(display) : !canEditItem(item);
    check.onclick = reference && canEditNode(display) ? () => toggleReference(node) : canEditItem(item) ? () => (isTask(node) ? toggleDone(item) : toggleCheckbox(item)) : null;
    line.append(check);
  }
  const body = document.createElement('div'); body.className = 'body'; // text + meta + chips; only .text is editable
  const text = document.createElement('span');
  text.className = 'text';
  if (isImage(node)) { // focusable, not editable: keeps its place in texts() so Up/Down/Backspace work like any block
    text.classList.add('image'); text.tabIndex = -1;
    const img = document.createElement('img'), { uri, alt, width, height } = node.image;
    if (alt) img.alt = img.title = alt;
    if (width && height) { img.width = width; img.height = height; }
    const show = (url) => { images.set(uri, url); img.src = url; text.classList.remove('loading'); };
    const cached = images.get(uri);
    if (typeof cached === 'string') img.src = cached;
    else { text.classList.add('loading'); (cached || images.set(uri, tana.image(uri)).get(uri)).then(show, (e) => { images.delete(uri); showError(e); }); }
    text.append(img);
  } else if (isDivider(node)) { // atomic like an image: focusable so Up/Down and Backspace still reach it
    text.classList.add('divider'); text.tabIndex = -1;
    text.append(document.createElement('hr'));
  } else {
    if (canEditText(item)) text.contentEditable = 'plaintext-only'; else text.tabIndex = -1;
    text.spellcheck = false;
    renderSegs(text, pending.has(item.key) ? pending.get(item.key).segs : reference ? [{ text: referenceLabel(node) }] : segsOf(node));
  }
  body.append(text);
  if (display.meta) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = display.meta; body.append(m); }
  // every row describes who can see it, not only task rows; the fetch waits until the row is on screen
  const taskInfo = taskSummary(display, true) || documentSummary(display, true);
  if (taskInfo) body.append(taskMetaEl(taskInfo));
  else if (observeMeta(el, display)) body.append(taskMetaEl({ assignees: '', pending: true })); // hold the slot: the real icon lands in the same place, so the row never shifts
  appendTags(body, display);
  // a node shared with a whole space names it as a sub-line under the title, the way Tana describes its location
  if (taskInfo && taskInfo.audience && taskInfo.audience.space) {
    const sub = document.createElement('div');
    sub.className = 'subtext'; sub.textContent = taskInfo.audience.space;
    body.append(sub);
  }
  blurSensitive(body, docId, target && target.id);
  line.append(body);
  line.onclick = (e) => { if (!e.metaKey && !e.shiftKey && !reference && (e.target === line || e.target === body || e.target.parentElement === text)) setCaret(text, text.textContent.length); };
  // a reference row: the bullet zooms into the target, a click selects the row, a click on the selected row puts the caret where you clicked
  if (reference) line.onmousedown = (e) => {
    if (e.metaKey || e.shiftKey || e.target.closest('.check') || e.target.closest('.bullet') || e.target.closest('.chev')) return;
    if (selKeys().includes(item.key) && canEditText(item)) return;
    e.preventDefault(); sel = { keys: new Set([item.key]), anchor: item.key, focus: item.key }; leaveText(); applySel();
  };
  el.append(line);
  // expanded = real children shown, or an explicitly opened empty node (which shows one draft child)
  const expanded = expandable && (has ? opened : !node.draft && open.get(item.key) === true);
  chev.classList.toggle('closed', !expanded); chev.title = expanded ? 'Collapse' : 'Expand';
  chev.onclick = () => setOpen(item, !expanded);
  if (expanded) {
    const wrap = document.createElement('div'); wrap.className = 'children';
    const c = childrenOf(item);
    if (c == null) { ensureLoaded(item); wrap.classList.add('loading'); wrap.textContent = 'Loading…'; }
    else if (c.length) wrap.append(...c.map((k) => childEl(k, item)));
    else if (!isSpace(node) && canEditItem(item) && (node.kind === 'document' || node.done != null || ['paragraph', 'bullet', 'numbered'].includes(node.block))) wrap.append(nodeEl(draftNode(item), docId, item));
    el.append(wrap);
  }
  return el;
}

// a draft becomes real on its first typed character: created with that text, caret kept
async function materialise(item, el) {
  const { parent, node } = item, oldKey = item.key, text = el.textContent;
  let key, real;
  await run(async () => {
    if (node.kind === 'document') {
      const n = await tana.createDocument(text, node.createOptions || { kind: node.draft });
      real = { ...n, text: n.title ?? n.text ?? '', hasChildren: true };
      const s = sectionOf(node.id), i = s ? s.nodes.indexOf(node) : -1;
      if (i >= 0) { s.nodes.splice(i, 1, real); fresh.set(real.id, { section: s.id, after: i ? s.nodes[i - 1].id : null, node: real }); }
      if (zoom?.docId === node.id) zoom = { ...zoom, docId: real.id };
      key = real.id;
    } else {
      const last = childrenOf(parent)?.at(-1);
      const id = parent.node.kind === 'document' || last ? await tana.insertAfter(parent.docId, last?.id || null, text) : await tana.insertChild(parent.docId, parent.node.id, text);
      await reload(parent.docId);
      await inheritCheckbox(parent, id); // old preload bridges lack native insert inheritance; current bridge already returns done: 0
      key = parent.docId + '/' + id;
      real = locate(kids.get(parent.docId) || [], id)?.node || { ...node, id, text };
    }
  });
  if (!key || !real) {
    item.busy = false;
    if (parent) { await reload(parent.docId); render(true); }
    return;
  }
  const latest = el.textContent; // typed on while the create was in flight
  if (key && slashCtx && slashCtx.key === item.key) slashCtx = { key }; // the "/" menu opened on the draft: follow it to the real node
  item.key = key; item.docId = real.kind === 'document' ? real.id : item.docId; item.node = real; delete item.busy; delete item.node.draft;
  items.delete(oldKey); items.set(key, item);
  const host = el === titleEl ? el : el.closest('.node');
  if (host) { host.dataset.key = key; host.classList.remove('draft'); }
  renderDeferred = true; // refresh the row chrome after the user leaves; the active contenteditable stays untouched
  if (latest !== text) scheduleSave(item, [{ text: latest }]);
}
function dropDraft(item) {
  if (item.node.kind === 'document') { const s = sectionOf(item.docId); if (s) s.nodes.splice(s.nodes.indexOf(item.node), 1); }
  else open.delete(item.parent.key);
  render(true);
}
function dropDrafts() { for (const s of views) s.nodes = s.nodes.filter((n) => !n.draft); } // navigating away drops empty draft documents
// Enter on a collapsed top-level document (or with nothing focused in an empty view): a draft sibling document below it
function draftDoc(after) {
  const s = viewOf();
  if (!s) return;
  if (after) flush(after.key);
  const node = draftDocNode(DRAFT_KIND[s.id] || 'doc');
  s.nodes.splice(after ? s.nodes.indexOf(after.node) + 1 : 0, 0, node);
  render(true);
  placeCaret(node.id, 0);
}

// ---- edits (debounced) ----
function scheduleSave(item, segs) {
  if (!canEditText(item)) return;
  const p = pending.get(item.key);
  if (p) clearTimeout(p.timer);
  pending.set(item.key, { item, segs, timer: setTimeout(() => flush(item.key), 400) });
}
function dropPending(key) { const p = pending.get(key); if (p) { clearTimeout(p.timer); pending.delete(key); } }
function flush(key) {
  const p = pending.get(key);
  if (!p) return;
  dropPending(key);
  const { item, segs } = p, text = plainOf(segs);
  if (!canEditText(item)) return;
  if (isReference(item.node)) { // the row edits the referenced document's title
    if (text === referenceLabel(item.node)) return;
    item.node.reference.node.title = text;
    return run(() => tana.setTitle(item.node.reference.uri, text));
  }
  if (text === item.node.text && JSON.stringify(segs) === JSON.stringify(segsOf(item.node))) return;
  if (item.node.kind === 'block' && (typeof item.node.id !== 'string' || !item.node.id)) {
    return run(async () => { await reload(item.docId); render(true); throw new Error('This outline row no longer exists'); });
  }
  item.node.text = text; item.node.segments = segs;
  run(async () => {
    try { await (item.node.kind === 'document' ? tana.setTitle(item.docId, text) : tana.setText(item.docId, item.node.id, saveValue(segs))); }
    catch (e) { if (item.node.kind === 'block') { await reload(item.docId); render(true); } throw e; }
  });
}
function insertAtCaret(el, str) {
  if (caretOffset(el) == null) setCaret(el, el.textContent.length);
  document.execCommand('insertText', false, str); // keeps mention anchors intact and fires 'input'
}

// ---- structural operations ----
async function splitNode(item, el, off) {
  if (!canEditItem(item)) return;
  const { docId, node } = item;
  const original = readSegs(el), [before, after] = splitSegs(original, off);
  let newId, asChild = false, splitDraft, splitKey, typed = after, typedOffset = 0;
  const splitList = (parent) => parent?.node?.kind === 'block' ? parent.node.children : kids.get(docId);
  const readSplitDraft = () => {
    const draftEl = splitKey && typeof textEl === 'function' && textEl(splitKey);
    if (draftEl) { typed = readSegs(draftEl); typedOffset = typeof caretOffset === 'function' ? caretOffset(draftEl) ?? 0 : 0; }
  };
  const addSplitDraft = (list, index) => {
    splitDraft = { id: 'draft:split:' + node.id + ':' + Date.now(), text: plainOf(after), segments: after, kind: 'block', done: node.kind === 'block' && node.done != null ? 0 : undefined, draft: true, pendingSplit: true };
    list.splice(index, 0, splitDraft);
    splitKey = docId + '/' + splitDraft.id;
    render(true); placeCaret(splitKey, 0);
  };
  if (node.kind === 'document') {
    flush(item.key);
    const list = splitList(item);
    if (Array.isArray(list)) addSplitDraft(list, list.length);
    // ponytail: no prepend op in the contract; a document's new child is appended (first child when the doc is empty)
    await run(async () => {
      newId = await tana.insertAfter(docId, null, '');
      readSplitDraft();
      await reload(docId);
    });
    open.set(item.key, true);
  } else {
    dropPending(item.key);
    asChild = hasKids(item) && isOpen(item);
    const list = splitList(asChild ? item : item.parent);
    if (Array.isArray(list)) {
      if (JSON.stringify(before) !== JSON.stringify(original)) { node.text = plainOf(before); node.segments = before; }
      addSplitDraft(list, asChild ? 0 : list.indexOf(node) + 1);
    }
    await run(async () => {
      if (JSON.stringify(before) !== JSON.stringify(original)) await tana.setText(docId, node.id, saveValue(before));
      newId = asChild ? await tana.insertChild(docId, node.id, plainOf(after)) : await tana.insertAfter(docId, node.id, plainOf(after));
      if (after.some((s) => 'mention' in s)) await tana.setText(docId, newId, after); // insert ops take plain text; restore the mentions
      readSplitDraft();
      await reload(docId);
      if (asChild) await inheritCheckbox(item, newId);
    });
  }
  render(true);
  if (newId) {
    const key = docId + '/' + newId, real = typeof items !== 'undefined' && items.get(key);
    if (real && JSON.stringify(typed) !== JSON.stringify(after)) { renderSegs(textEl(key), typed); scheduleSave(real, typed); }
    placeCaret(key, typedOffset);
  }
}

async function shiftNode(item, el, op, arg) {
  if (!canEditStructure(item)) return;
  flush(item.key);
  const off = caretOffset(el);
  if (op === 'indent') {
    const siblings = childrenOf(item.parent) || [], prev = siblings[siblings.indexOf(item.node) - 1];
    if (prev) open.set(keyFor(item.docId, prev), true);
  }
  await run(async () => { await tana[op](item.docId, item.node.id, arg); await reload(item.docId); });
  render(true);
  placeCaret(item.key, off);
}

async function removeNode(item, el) {
  if (!canEditStructure(item)) return;
  const keys = texts().map(keyOfEl), i = keys.indexOf(item.key);
  dropPending(item.key);
  await run(async () => { await tana.remove(item.docId, item.node.id); await reload(item.docId); });
  render(true);
  caretNear(keys, i, null);
}
async function removeDocument(item) {
  if (!canEditItem(item) || !tana.deleteDocument || !tana.accessOptions) return;
  flush(item.key);
  await run(async () => {
    const access = await tana.accessOptions(item.docId);
    if (!access?.deletable) throw new Error(access?.reason || 'This document cannot be deleted');
    await tana.deleteDocument(item.docId); invalidateNode(item.docId); await loadRoots();
  });
  render(true);
}
function removeZoomedBlock() {
  const item = resolveZoom()?.at(-1);
  if (item?.node.kind === 'block') removeNode(item);
  else if (item?.node.kind === 'document') removeDocument(item);
}
// Cmd+Z / Cmd+Shift+Z: undo/redo through the API (never the browser's contenteditable history), then re-read what changed
// ponytail: the API returns only the docId; the caret stays in the focused node or moves to the nearest surviving one
async function history(op) {
  flushAll();
  const saved = focused(), keys = texts().map(keyOfEl);
  await run(async () => {
    const docId = await tana[op]();
    await loadRoots();
    if (docId && kids.has(docId)) await reload(docId);
  });
  render(true);
  if (saved && !focused()) caretNear(keys, keys.indexOf(saved.key), saved.offset);
}

function setOpen(item, value) {
  if (value && !canExpand(item)) return;
  if (value && !hasKids(item) && item.node.kind !== 'document' && item.node.done == null && !['paragraph', 'bullet', 'numbered'].includes(item.node.block)) return;
  open.set(item.key, value); render(true);
}
function toggleDone(item) {
  if (!canEditItem(item) || !isTask(item.node) || item.node.draft) return;
  item.node.done = item.node.done ? 0 : 1;
  if (zoom && zoom.docId === item.docId) extra.set(item.docId, item.node); // the page stays open when the task leaves the filtered view
  render(true);
  run(() => tana.setDone(item.docId, item.node.done));
}
function toggleCheckbox(item) {
  if (!canEditItem(item) || item.node.kind !== 'block' || !tana.toggleCheckbox) return;
  run(async () => { await tana.toggleCheckbox(item.docId, item.node.id); await reload(item.docId); });
}
async function inheritCheckbox(parent, nodeId) {
  if (!nodeId || parent.node?.kind !== 'block' || parent.node.done == null || !tana.toggleCheckbox) return;
  const child = locate(kids.get(parent.docId) || [], nodeId);
  if (child && child.node.done != null) return;
  await tana.toggleCheckbox(parent.docId, nodeId);
  await reload(parent.docId);
}
function zoomTo(item) {
  flushAll(); dropDrafts(); caretOnOpen = true;
  if (item.node.kind === 'document') recordRecent(item.node);
  let top = item; while (top.parent && top.parent.docId === item.docId) top = top.parent; // the item's document row (itself, or an ancestor in the same document)
  const same = zoom && zoom.docId === item.docId;
  const via = same ? zoom.via : top.parent && zoom ? [...(zoom.via || []), zoom] : undefined; // a document inside a zoomed space: the space stays in the crumb
  if (via && !docOf(item.docId)) extra.set(item.docId, top.node);
  zoom = { docId: item.docId, nodeId: item.node.kind === 'document' ? null : item.node.id, from: same ? zoom.from : undefined, via };
  render(true);
  followSummary(item.docId);
}
function openReference(node) {
  const target = referenceTarget(node);
  if (!target || !node.reference?.uri) return;
  extra.set(node.reference.uri, target);
  openDoc(node.reference.uri, 'Reference');
}
function toggleReference(node) {
  const target = referenceTarget(node);
  if (!target || !isTask(target) || !canEditNode(target)) return;
  const done = target.done ? 0 : 1; // referenceTarget() hands back a copy: write the new state where the row reads it
  node.reference.node = { ...node.reference.node, done };
  extra.set(target.id, { ...target, done });
  render(true);
  run(() => tana.setDone(target.id, done));
}
function setView(id) { dropDrafts(); view = id; localStorage.setItem('view', id); zoom = null; sel = null; menu = null; loadView(id); render(true); }
// zoom into a document, switching to its view first when it belongs to another one; from = breadcrumb root instead of the view
function openDoc(docId, from) {
  flushAll(); dropDrafts(); caretOnOpen = true;
  const s = from ? null : sectionOf(docId);
  if (s && s.id !== view) { view = s.id; localStorage.setItem('view', view); }
  const doc = allDocs().find((d) => d.id === docId) || extra.get(docId);
  if (doc) recordRecent(doc);
  zoom = { docId, nodeId: null, from };
  render(true);
  followSummary(docId);
}
// An event has no content of its own, so a meeting opens at its write-up. Every zoom passes through here, so the
// redirect behaves the same from a list row, search, the rail, a pin, a breadcrumb or a link.
function followSummary(docId) {
  if (!tana.summaryUri || typeof docId !== 'string' || !docId.startsWith('tana:event:')) return;
  tana.summaryUri(docId).then((uri) => { if (uri && zoom && zoom.docId === docId) goTo(uri); }, () => {});
}
async function goTo(uri) {
  if (!allDocs().some((d) => d.id === uri) && !extra.has(uri)) {
    try { const n = await tana.node(uri); extra.set(uri, { ...n, text: n.title || '', hasChildren: true }); }
    catch (e) { return showError(e); }
  }
  openDoc(uri);
}
function flushAll() { for (const key of [...pending.keys()]) flush(key); }
// Up past the first node: the editable page title (zoomed), else the last filter pill
function focusAbove(el) {
  if (el) flush(keyOfEl(el));
  const p = $('pills').lastElementChild;
  if (titleEl.isContentEditable) setCaret(titleEl, titleEl.textContent.length);
  else if (p && !$('pills').hidden) { if (el) el.blur(); p.focus(); }
}

// ---- multi-select: an arbitrary set (Cmd+click), with one anchored sibling range for Shift+Up/Down and Shift+click ----
function rangeKeys(anchor, focus) {
  const a = nodeElOf(anchor), f = nodeElOf(focus);
  if (!a || !f || a.parentElement !== f.parentElement) return f ? [focus] : [];
  const sibs = nodeEls(a).map((n) => n.dataset.key), i = sibs.indexOf(anchor), j = sibs.indexOf(focus);
  return i < 0 || j < 0 ? [] : sibs.slice(Math.min(i, j), Math.max(i, j) + 1);
}
function selKeys() { // visible selected keys in outline order; stale rows simply fall out of the set
  if (!sel) return [];
  const keys = [...items.keys()].filter((key) => sel.keys.has(key) && nodeElOf(key));
  if (!keys.length) return [];
  if (!nodeElOf(sel.anchor)) sel.anchor = keys.at(-1);
  if (!nodeElOf(sel.focus)) sel.focus = keys.at(-1);
  return keys;
}
function applySel() {
  for (const n of outline.querySelectorAll('.node.selected')) n.classList.remove('selected');
  for (const k of selKeys()) nodeElOf(k).classList.add('selected');
}
function leaveText() { const el = document.activeElement; if (el && (outline.contains(el) || el === titleEl) && (el.isContentEditable || el.classList.contains('text'))) { flush(keyOfEl(el)); el.blur(); } }
function toggleSel(key) {
  const keys = new Set(sel ? sel.keys : []);
  if (keys.has(key)) keys.delete(key); else keys.add(key);
  sel = { keys, anchor: key, focus: key };
  leaveText(); applySel();
  if (!keys.size && selectionFrozen) { selectionFrozen = false; if (renderDeferred) render(); }
}
function rangeSelTo(key, anchor) {
  if (!sel) sel = { keys: new Set([anchor]), anchor, focus: anchor };
  const extras = new Set(sel.keys);
  for (const old of rangeKeys(sel.anchor, sel.focus)) extras.delete(old);
  sel.anchor = anchor; sel.focus = key;
  sel.keys = new Set([...extras, ...rangeKeys(anchor, key)]);
  leaveText(); applySel();
}
function extendSel(item, dir) { // grow (or shrink) the range from the focus end; the caret leaves the text
  if (!sel) sel = { keys: new Set([item.key]), anchor: item.key, focus: item.key };
  const f = nodeElOf(sel.focus), next = f && nodeEls(f)[nodeEls(f).indexOf(f) + dir];
  if (next) rangeSelTo(next.dataset.key, sel.anchor);
}
function clearSel(key) { sel = null; selectionFrozen = false; render(); if (key) placeCaret(key); }
function blockSelection(keys, contiguous, action) {
  const its = keys.map((key) => items.get(key));
  const first = its[0];
  if (!first || its.some((it) => !it || it.node.kind !== 'block' || !canEditStructure(it) || it.docId !== first.docId || it.parent !== first.parent)) {
    showError(new Error(action + ' requires writable sibling blocks'));
    return null;
  }
  if (contiguous) {
    const sibs = childrenOf(first.parent) || [], indexes = its.map((it) => sibs.indexOf(it.node)).sort((a, b) => a - b);
    if (indexes.some((index, i) => index < 0 || (i && index !== indexes[i - 1] + 1))) {
      showError(new Error(action + ' requires a contiguous selection of writable sibling blocks'));
      return null;
    }
  }
  return its;
}
async function removeSel(keys) { // Cmd+Shift+Backspace: every selected block, last first; caret to the node before the range
  const all = texts().map(keyOfEl), before = all[all.indexOf(keys[0]) - 1], its = keys.map((k) => items.get(k));
  sel = null;
  for (const it of its) dropPending(it.key);
  await run(async () => { await tana.removeMany(its[0].docId, its.map((it) => it.node.id)); await reload(its[0].docId); });
  render(true);
  const k = before || texts().map(keyOfEl)[0];
  if (k) placeCaret(k); else focusAbove();
}
async function moveSel(keys, dir) { // Cmd+Shift+Up/Down: the whole range, one api.move per node in the order that keeps them adjacent; keys are node ids so the selection follows
  const its = keys.map((k) => items.get(k)), sibs = childrenOf(its[0].parent) || [];
  if (dir === 'up' ? sibs.indexOf(its[0].node) === 0 : sibs.indexOf(its.at(-1).node) === sibs.length - 1) return;
  await run(async () => { await tana.moveMany(its[0].docId, its.map((it) => it.node.id), dir); await reload(its[0].docId); });
  render(true);
}
// Tab / Shift+Tab on a selection: the whole range shifts together and stays selected (keys are node ids, which the shift keeps).
// Older preload bridges fall back to per-row calls; the current plural bridge keeps this one undo step.
async function indentSel(keys, op) {
  const its = keys.map((k) => items.get(k)), docId = its[0].docId, ids = its.map((it) => it.node.id);
  if (op === 'indent') {
    const sibs = childrenOf(its[0].parent) || [], prev = sibs[sibs.indexOf(its[0].node) - 1];
    if (!prev) return; // the range starts at the top: there is nothing to indent under
    open.set(keyFor(docId, prev), true);
  }
  const many = tana[op + 'Many'];
  await run(async () => {
    if (many) await many(docId, ids);
    else for (const id of op === 'indent' ? ids : [...ids].reverse()) await tana[op](docId, id); // outdent runs last-first, the way moveMany does, so the range keeps its order
    await reload(docId);
  });
  // a live update landing between two per-row calls sees the range half moved, and selKeys() collapses a range whose
  // rows no longer share a parent; the rows themselves moved together, so put the selection back on them
  sel = { keys: new Set(keys), anchor: keys[0], focus: keys[keys.length - 1] };
  render();
}
function selKey(e) { // keys while a selection is active (nothing focused); document nodes: delete/move ignored
  const mod = e.metaKey || e.ctrlKey, keys = selKeys();
  if (!keys.length) return false;
  const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (e.shiftKey && !mod && vert) extendSel(items.get(sel.focus), e.key === 'ArrowUp' ? -1 : 1);
  else if (e.key === 'Backspace' && (!mod || e.shiftKey)) { if (blockSelection(keys, false, 'Remove')) removeSel(keys); }
  else if (mod && e.shiftKey && vert) { if (blockSelection(keys, true, 'Move')) moveSel(keys, e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (e.key === 'Tab' && !mod) { if (blockSelection(keys, true, e.shiftKey ? 'Outdent' : 'Indent')) indentSel(keys, e.shiftKey ? 'outdent' : 'indent'); }
  else if (e.key === 'Escape' || (e.key.startsWith('Arrow') && !mod)) clearSel(sel.focus);
  else return false;
  return true;
}

// ---- filter pills shared by every view ----
const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
const TYPES = [['meetings', 'Meetings', 'meeting'], ['tasks', 'Tasks', 'task'], ['docs', 'Docs', 'doc'], null, ['chats', 'Chats', 'chat'], ['canvases', 'Canvases', 'canvas'], ['agents', 'Agents', 'agent'], ['skills', 'Skills', 'skill'], ['spaces', 'Spaces', 'space'], ['people', 'People', 'member']];
const toggleIn = (all, list, v) => { if (!list) return [v]; const next = all.filter((x) => list.includes(x) !== (x === v)); return next.length ? next : null; }; // null = any
const names = (pairs, list) => (list ? pairs.filter((p) => p && list.includes(p[0])).map((p) => p[1]).join(', ') : null);
// ---- group by: plain headings over the rows the view already loaded, no extra query ----
const GROUPS = [['none', 'None'], ['status', 'Status'], ['assignee', 'Assignee'], ['type', 'Type']];
const FALLBACK = { status: 'No status', assignee: 'Unassigned', type: 'No type' };
const groupBy = () => (GROUPS.some(([id]) => id === groupPref[view]) ? groupPref[view] : 'none');
function setGroupBy(id) { groupPref[view] = id; localStorage.setItem('groupBy', JSON.stringify(groupPref)); render(); }
// main.js toNode now passes stateType, so all four states (Inbox, In Progress, Completed, Later) separate here.
// done (0/1 for tasks, undefined otherwise) stays the fallback for rows that carry no state, which can only tell
// Completed from In Progress.
const stateOf = (n) => n.stateType || (n.done == null ? null : n.done ? 'closed' : 'open');
function groupKey(n, by) {
  if (by === 'status') return Object.fromEntries(STATES)[stateOf(n)] || FALLBACK.status;
  // ponytail: a task with several assignees is filed under the first one, like the row's own summary reads
  if (by === 'assignee') { const meta = taskMetaById.get(n.id), uri = meta && meta.assignees[0]; return uri ? memberName(uri) : FALLBACK.assignee; }
  return (visibleTags(n)[0] || {}).label || FALLBACK.type;
}
// [{ title, nodes }] in a fixed order: the status sequence as the Status menu lists it, names alphabetically,
// the "nothing here" group last. Only groups with rows are returned.
function groupRows(list, by) {
  const buckets = new Map();
  for (const n of list) { const k = groupKey(n, by); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(n); }
  const fixed = by === 'status' ? STATES.map((s) => s[1]) : [], last = FALLBACK[by];
  const rank = (t) => (t === last ? 2 : fixed.includes(t) ? 0 : 1);
  return [...buckets.keys()]
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? fixed.indexOf(a) - fixed.indexOf(b) : a.localeCompare(b)))
    .map((title) => ({ title, nodes: buckets.get(title) }));
}
function groupsOf(list) {
  const by = groupBy();
  if (by === 'none') return null;
  if (by === 'assignee') loadMembers(); // the names for the headings; without them a heading falls back to the member uri
  return groupRows(list, by);
}
// ---- sort: the same rows in another order, again without asking the backend for anything ----
// Only what a row actually carries can be sorted on. main.js toNode passes updatedAt and createdAt as ISO 8601
// strings, so they compare as strings; a row that carries neither (an older cached row) keeps its place at the end.
const SORTS = [['default', 'Default'], ['updated', 'Updated'], ['created', 'Created'], ['title', 'Title']];
const SORT_KEY = { updated: (n) => n.updatedAt, created: (n) => n.createdAt, title: (n) => (n.text || n.title || '').toLowerCase() };
const NEWEST_FIRST = new Set(['updated', 'created']); // times read newest first; Title stays A→Z
// People read as a list of names, so that page sorts A→Z until the user says otherwise; every other view keeps the
// order its query returned.
const sortBy = () => (SORTS.some(([id]) => id === sortPref[view]) ? sortPref[view] : view === 'people' ? 'title' : 'default');
function setSortBy(id) { sortPref[view] = id; localStorage.setItem('sortBy', JSON.stringify(sortPref)); render(); }
function sortRows(list) {
  const id = sortBy(), key = SORT_KEY[id];
  if (!key) return list; // Default: the order the view produced
  const desc = NEWEST_FIRST.has(id);
  return [...list].sort((a, b) => {
    const x = key(a), y = key(b);
    if (!x || !y) return x ? -1 : y ? 1 : 0; // a row without the field sorts last, in the order it came in
    return desc ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
  });
}
// a heading is not a node: no key, no caret, no bullet, and nodeEls() already skips anything without .node
function groupHeadEl(title) { const el = document.createElement('div'); el.className = 'ghead'; el.textContent = title; return el; }
// main answers [] until its sync client is up, so an empty list means "not yet", never "nobody": keeping it would
// leave every assignee, group heading and Assigned menu showing a raw tana:user-profile: uri for the rest of the
// session. Only a list with someone in it counts as loaded; anything else is asked again.
let membersAsked = 0;
function loadMembers() {
  if ((members && members.length) || !tana.members || Date.now() - membersAsked < META_RETRY_MS) return;
  membersAsked = Date.now();
  tana.members().then((m) => {
    members = m;
    if (!m.length) setTimeout(render, META_RETRY_MS); // a render asks again, the way loadTaskMeta retries
    if (!$('pills').hidden) renderPills(true); if (!palette.hidden) renderPalette(); render(); // so the Assigned pill reads "You (<name>)"
  }, showError);
}
const me = () => (members || []).find((m) => m.me);
const memberName = (uri) => { const member = (members || []).find((m) => m.id === uri); return member ? member.title || member.text : uri; };
const AUDIENCES = {
  'only-me': { icon: 'lock', label: 'Visible only to you' },
  people: { icon: 'userLock', label: 'Visible to selected people' },
  space: { icon: 'houseLock', label: 'Visible to space members' },
  everyone: { icon: 'users', label: 'Visible to everyone' },
};
function audienceInfo(audience, audienceSpace) {
  const scope = typeof audience === 'string' ? audience : audience?.scope;
  const info = AUDIENCES[scope];
  if (!info) return null;
  const title = audience?.title || audienceSpace?.title;
  // a space audience names the space, so a row can read "Robin Vega · Platform Guild"
  return scope === 'space' && title ? { ...info, label: 'Visible to members of ' + title, space: title } : info;
}
function loadTaskMeta(docId) {
  // Metadata is supplemental. Calling it before the sync client connects retries on every render.
  const backoff = taskMetaFailed.get(docId);
  if (!connected || !tana.taskMeta || !isRealId(docId) || taskMetaById.has(docId) || taskMetaLoading.has(docId) || (backoff && Date.now() < backoff.until)) return;
  taskMetaLoading.add(docId);
  tana.taskMeta(docId).then((meta) => {
    taskMetaLoading.delete(docId); taskMetaFailed.delete(docId); taskMetaById.set(docId, meta);
    if (!palette.hidden && palDoc && palDoc.id === docId) renderPalette();
    render();
  }, () => { // a brand-new document can still be settling in main: wait, then let the next render ask again
    taskMetaLoading.delete(docId);
    const wait = Math.min(META_RETRY_MAX, backoff ? backoff.wait * 2 : META_RETRY_MS);
    taskMetaFailed.set(docId, { until: Date.now() + wait, wait });
    setTimeout(() => { if (!taskMetaById.has(docId)) render(); }, wait);
  });
}
// One metadata read is a document bootstrap plus a graph lookup, so with every row wanting an audience icon the
// request only goes out once the row is on screen. Rows further down stay quiet until they scroll into view.
let metaSeen = null;
function observeMeta(el, node) {
  if (!node || node.kind !== 'document' || !isRealId(node.id) || taskMetaById.has(node.id)) return false;
  metaSeen ||= new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { metaSeen.unobserve(entry.target); loadTaskMeta(entry.target.dataset.metaFor); }
  }, { rootMargin: '150px' });
  el.dataset.metaFor = node.id;
  metaSeen.observe(el);
  return true; // the row is waiting on an answer, so it can hold the icon's place
}
// lazy: read the cache but leave the fetching to observeMeta (list rows); the sidebar asks for its one document itself
function taskSummary(node, lazy) {
  if (!isTask(node) || !tana.taskMeta) return null;
  const meta = taskMetaById.get(node.id);
  if (!meta) { if (!lazy) loadTaskMeta(node.id); return null; }
  if (meta.assignees.length) loadMembers(); // names need the member list; loading it re-renders when it arrives
  const scope = typeof meta.audience === 'string' ? meta.audience : meta.audience?.scope;
  return { assignees: meta.assignees.length ? meta.assignees.map(memberName).join(', ') : 'Unassigned', audience: audienceInfo(meta.audience, meta.audienceSpace), scope, unknownAudience: scope === 'unknown', linkShared: !!meta.linkShared };
}
// the same facts for a document that is not a task: no assignee, but it can be shared or public
function documentSummary(node, lazy) {
  if (node.kind !== 'document' || !tana.taskMeta || !isRealId(node.id)) return null;
  const meta = taskMetaById.get(node.id);
  if (!meta) { if (!lazy) loadTaskMeta(node.id); return null; }
  const audience = audienceInfo(meta.audience, meta.audienceSpace);
  if (!audience && !meta.linkShared) return null;
  return { assignees: '', audience, scope: typeof meta.audience === 'string' ? meta.audience : meta.audience?.scope, unknownAudience: false, linkShared: !!meta.linkShared };
}
function taskMetaEl(summary) {
  const el = document.createElement('span');
  el.className = 'meta' + (summary.pending ? ' pending' : ''); el.textContent = summary.assignees;
  // the icons stand 6px apart, but the first one needs no gap of its own: a row with no assignee name in front of it
  // (every doc and meeting row) already has the 8px the .meta span carries, and 14px reads as a hole
  const gap = () => (el.textContent || el.children.length ? '6px' : '0');
  // an icon in the 14px slot; no label means it carries no information of its own (the placeholder)
  const iconEl = (name, label) => {
    const icon = document.createElement('span');
    if (label) { icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label); icon.title = label; } else icon.setAttribute('aria-hidden', 'true');
    icon.style.cssText = 'display:inline-block;width:14px;height:14px;margin-left:' + gap() + ';vertical-align:-2px';
    icon.innerHTML = iconSvg(name);
    const svg = icon.firstElementChild; if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
    return icon;
  };
  if (summary.pending) el.append(iconEl('pending', null)); // the answer is still on its way: same slot, same size
  if (summary.assignees === 'Unassigned') {
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true'); icon.title = 'Unassigned';
    icon.style.cssText = 'display:inline-block;width:14px;height:14px;margin-right:4px;vertical-align:-2px';
    icon.innerHTML = iconSvg('unassigned');
    const svg = icon.firstElementChild; if (svg) { svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); }
    el.prepend(icon);
  }
  if (summary.audience) el.append(iconEl(summary.audience.icon, summary.audience.label));
  else if (summary.unknownAudience) el.append(' · Visibility unknown');
  // link sharing is separate from the Tana audience: anyone with the url can read it
  if (summary.linkShared) el.append(iconEl('globe', 'Anyone with the link'));
  return el;
}
function setTaskAssignees(doc, assignees) {
  const meta = taskMetaById.get(doc.id);
  if (!meta || !tana.setAssignees) return;
  const frozen = !!(palTaskCtx?.fromSelection && sel);
  if (frozen) selectionFrozen = true;
  run(async () => {
    try {
      await tana.setAssignees(doc.id, assignees);
      taskMetaById.set(doc.id, { ...meta, assignees });
      if (!palette.hidden && palMode === 'assignees' && palDoc?.id === doc.id) closePalette();
      render();
    } catch (e) {
      if (frozen) { selectionFrozen = false; if (renderDeferred) render(); }
      showError(e);
      if (!palette.hidden && palMode === 'assignees' && palDoc?.id === doc.id) renderPalette();
    }
  });
}
function assigneeRows(q) {
  if (!palDoc || !isTask(palDoc)) return [];
  loadMembers(); loadTaskMeta(palDoc.id);
  const meta = taskMetaById.get(palDoc.id), ids = meta ? meta.assignees : [];
  const toggle = (uri) => ids.includes(uri) ? ids.filter((id) => id !== uri) : [...ids, uri];
  const rows = [{ group: 'Assignees', icon: 'unassigned', label: 'Unassigned', hint: ids.length ? '' : '✓', keepOpen: true, run: () => setTaskAssignees(palDoc, []) }];
  for (const member of members || []) if (!q || memberName(member.id).toLowerCase().includes(q)) rows.push({ group: 'Assignees', icon: 'member', label: memberName(member.id), hint: ids.includes(member.id) ? '✓' : '', keepOpen: true, run: () => setTaskAssignees(palDoc, toggle(member.id)) });
  return rows;
}
function openAssigneePalette(doc, ctx) {
  palTaskCtx = ctx || null;
  palDoc = doc; palMode = 'assignees'; palRows = []; palIndex = 0; palBusy = false;
  palette.hidden = false; palInput.placeholder = 'Assign task to…'; palInput.value = '';
  loadMembers(); loadTaskMeta(doc.id); renderPalette(); palInput.focus();
}
function taskActionContext() {
  const keys = selKeys(), fromSelection = keys.length > 0;
  const selected = fromSelection ? keys.map((key) => items.get(key)).filter(Boolean) : palDoc ? [{ node: palDoc, docId: palDoc.id }] : [];
  const docs = [], seen = new Set();
  for (const item of selected) {
    const doc = item.node;
    if (!doc || doc.draft || !isTask(doc) || !canEditNode(doc) || seen.has(item.docId)) continue;
    seen.add(item.docId); docs.push(doc);
  }
  if (!fromSelection && !docs.length) return null;
  return { docs, selected: selected.length, skipped: selected.length - docs.length, fromSelection, multi: keys.length > 1 };
}
function taskResult(ctx, changed) {
  if (!ctx.skipped) return;
  const tasks = changed === 1 ? 'task' : 'tasks', rows = ctx.skipped === 1 ? 'row' : 'rows';
  setTimeout(() => showNote(`Updated ${changed} ${tasks}; skipped ${ctx.skipped} non-task or read-only ${rows}`), 0);
}
function applyTaskChange(ctx, call) {
  const frozen = !!(ctx.fromSelection && sel);
  if (frozen) selectionFrozen = true;
  run(async () => {
    try {
      const changed = await call();
      closePalette(); taskResult(ctx, changed);
    } catch (e) {
      if (frozen) { selectionFrozen = false; if (renderDeferred) render(); }
      throw e;
    }
  });
}
function statusRows(q) {
  if (!palTaskCtx?.docs.length) return [];
  const current = palTaskCtx.docs.length === 1 ? stateOf(palTaskCtx.docs[0]) : null;
  return STATES.filter(([, label]) => !q || label.toLowerCase().includes(q)).map(([state, label]) => ({
    group: 'Status', icon: 'status', label, hint: state === current ? '✓' : '', keepOpen: true,
    run: () => applyTaskChange(palTaskCtx, () => palTaskCtx.multi ? tana.setStateMany(palTaskCtx.docs.map((doc) => doc.id), state) : tana.setState(palTaskCtx.docs[0].id, state)),
  }));
}
function openStatusPalette(ctx) {
  palTaskCtx = ctx; palMode = 'status'; palRows = []; palIndex = 0; palBusy = false;
  palette.hidden = false; palInput.placeholder = 'Set status to…'; palInput.value = '';
  renderPalette(); palInput.focus();
}
function manyAssigneeRows(q) {
  if (!palTaskCtx?.docs.length) return [];
  loadMembers();
  const apply = (uris) => applyTaskChange(palTaskCtx, () => tana.setAssigneesMany(palTaskCtx.docs.map((doc) => doc.id), uris));
  const rows = [{ group: 'Assignees', icon: 'unassigned', label: 'Unassigned', keepOpen: true, run: () => apply([]) }];
  for (const member of members || []) if (!q || memberName(member.id).toLowerCase().includes(q)) rows.push({ group: 'Assignees', icon: 'member', label: memberName(member.id), keepOpen: true, run: () => apply([member.id]) });
  return rows;
}
function openManyAssigneePalette(ctx) {
  palTaskCtx = ctx; palMode = 'assigneesMany'; palRows = []; palIndex = 0; palBusy = false;
  palette.hidden = false; palInput.placeholder = 'Assign tasks to…'; palInput.value = '';
  loadMembers(); renderPalette(); palInput.focus();
}
function taskActionRows(group = 'Actions') {
  const ctx = taskActionContext();
  if (!ctx) return [];
  if (ctx.multi) {
    const count = ctx.docs.length, noun = count === 1 ? 'task' : 'tasks', hint = ctx.skipped ? `${ctx.skipped} skipped` : '';
    return [
      { id: 'status', group, icon: 'status', label: `Set status for ${count} ${noun}`, hint, disabled: !count || !tana.setStateMany, keepOpen: true, run: () => openStatusPalette(ctx) },
      { id: 'assign', group, icon: 'member', label: `Assign ${count} ${noun} to`, hint, disabled: !count || !tana.setAssigneesMany, keepOpen: true, run: () => openManyAssigneePalette(ctx) },
    ];
  }
  if (!ctx.docs.length) return [];
  const doc = ctx.docs[0], rows = [];
  if (tana.setState) rows.push({ id: 'status', group, icon: 'status', label: 'Set status', hint: Object.fromEntries(STATES)[stateOf(doc)] || '', keepOpen: true, run: () => openStatusPalette(ctx) });
  if (tana.taskMeta && tana.setAssignees) {
    loadTaskMeta(doc.id);
    const meta = taskMetaById.get(doc.id), hint = meta && meta.assignees.length ? meta.assignees.map(memberName).join(', ') : meta ? 'Unassigned' : 'Loading…';
    rows.push({ id: 'assign', group, icon: 'member', label: 'Edit assignees', hint, keepOpen: true, run: () => openAssigneePalette(doc, ctx) });
  }
  return rows;
}
// With rows selected, what acts on them comes first: at that moment the palette is about the selection, not the app.
// Every row carries a stable id even though its label counts the selection, because Cmd+Shift+K records a hotkey per
// id and a hotkey only fires with the palette closed — which is exactly when a selection is live.
function selectionRows() {
  const keys = selKeys();
  if (!keys.length) return [];
  const seen = new Set(), nodes = [];
  for (const key of keys) {
    const node = items.get(key)?.node;
    if (node && !node.draft && isRealId(node.id) && !seen.has(node.id)) { seen.add(node.id); nodes.push(node); }
  }
  const ids = nodes.map((node) => node.id), rows = [];
  if (ids.length && tana.setSensitive && sensitiveIds) {
    const marked = ids.every((id) => sensitiveIds.has(id)), noun = ids.length === 1 ? 'item' : 'items';
    rows.push({ id: 'sensitive', group: 'Selection', icon: 'lock', label: `${marked ? 'Unmark' : 'Mark'} ${ids.length} ${noun} as sensitive`, run: () => setSensitiveMark(ids, !marked) });
  }
  if (nodes.length && tana.insertAfter && tana.setText) {
    const noun = nodes.length === 1 ? 'item' : 'items';
    if (tana.todayNode) rows.push({ id: 'addToday', group: 'Selection', icon: 'addTo', label: `Add ${nodes.length} ${noun} to today node`, run: () => addToDateNode(nodes, 'today') });
    if (tana.weekNode) rows.push({ id: 'addWeek', group: 'Selection', icon: 'addTo', label: `Add ${nodes.length} ${noun} to week node`, run: () => addToDateNode(nodes, 'week') });
  }
  rows.push(...taskActionRows('Selection'));
  // Destructive, so it sits at the end of the group. Documents are soft-deleted (Cmd+Z restores them), blocks go
  // through the same one-step removal as Cmd+Shift+Backspace.
  const its = keys.map((key) => items.get(key)).filter(Boolean);
  if (its.length && tana.deleteDocument) {
    const noun = its.length === 1 ? 'item' : 'items';
    rows.push({ id: 'delete', group: 'Selection', icon: 'trash', label: `Delete ${its.length} ${noun}`, run: () => removeSelection(keys) });
  }
  return rows;
}
// Every selected node lands as a mention at the end of the day's or the week's node — the reference Tana itself
// writes for an @ link, so the two documents stay independent.
function addToDateNode(nodes, target) {
  return run(async () => {
    const docId = target === 'week' ? await tana.weekNode() : await tana.todayNode();
    for (const node of nodes) {
      const block = await tana.insertAfter(docId, null, node.text || '');
      await tana.setText(docId, block, [{ mention: { uri: node.id, label: node.text || '' } }]);
    }
    showNote(`Added ${nodes.length} ${nodes.length === 1 ? 'item' : 'items'} to the ${target === 'week' ? 'week' : 'today'} node`);
  });
}
// One selection, two kinds of removal: rows that are documents are deleted one by one (each undoable on its own),
// blocks reuse the existing single-step block removal.
async function removeSelection(keys) {
  const its = keys.map((key) => items.get(key)).filter(Boolean);
  if (!its.length) return;
  if (its.every((it) => it.node.kind === 'block')) return removeSel(keys);
  sel = null;
  await run(async () => {
    for (const it of its) {
      if (it.node.kind !== 'document' || !canEditItem(it)) throw new Error('Only writable documents and blocks can be deleted');
      const access = await tana.accessOptions(it.docId);
      if (!access?.deletable) throw new Error(access?.reason || 'This document cannot be deleted');
      await tana.deleteDocument(it.docId); invalidateNode(it.docId);
    }
    await loadRoots();
  });
  render(true);
}
function loadAccess(docId) {
  if (!tana.accessOptions || accessById.has(docId) || accessLoading.has(docId)) return;
  accessLoading.add(docId);
  tana.accessOptions(docId).then((access) => { accessLoading.delete(docId); accessById.set(docId, access); if (!palette.hidden && palDoc?.id === docId) renderPalette(); }, (e) => { accessLoading.delete(docId); showError(e); });
}
function applySharing(doc, selection) {
  run(async () => {
    try {
      await tana.setSharing(doc.id, selection);
      accessById.delete(doc.id); taskMetaById.delete(doc.id);
      if (typeof closePalette === 'function') closePalette(); await loadRoots(); render();
    } catch (e) {
      if (typeof showError === 'function') showError(e);
      if (/reload|access changed/i.test(String(e.message || e))) {
        accessById.delete(doc.id); taskMetaById.delete(doc.id); palMode = 'visibility'; loadAccess(doc.id); loadTaskMeta(doc.id); renderPalette();
      }
    }
  });
}
function banSvg() { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1" fill="none" stroke="currentColor" stroke-linejoin="round"><line x1="3.873" y1="14.127" x2="14.118" y2="3.882"></line><circle cx="9" cy="9" r="7.25"></circle></g></svg>'; }
function visibilityRows(q) {
  if (!palDoc) return [];
  const access = accessById.get(palDoc.id);
  if (!access?.sharing) return [{ group: 'Visibility', ...(access?.reason ? { svg: banSvg() } : {}), label: access?.reason || 'Checking permission…', disabled: true }];
  loadTaskMeta(palDoc.id);
  const hasParticipants = taskMetaById.has(palDoc.id);
  const rules = new Set(access.rules || []), inherit = audienceInfo(access.inheritAudience);
  return [
    rules.has('me') && { group: 'Visibility', icon: 'lock', label: 'Only me', keepOpen: true, run: () => applySharing(palDoc, { rule: 'me' }) },
    rules.has('people') && { group: 'Visibility', icon: 'userLock', label: 'Selected people…', disabled: !hasParticipants, keepOpen: true, run: () => openVisibilityPeople(palDoc) },
    rules.has('inherit') && { group: 'Visibility', icon: 'houseLock', label: inherit ? 'Inherit: ' + inherit.label : 'Inherit location audience', keepOpen: true, run: () => applySharing(palDoc, { rule: 'inherit', token: access.sharingToken }) },
  ].filter(Boolean).filter((row) => row.label.toLowerCase().includes(q));
}
function openVisibilityPalette(doc) {
  palDoc = doc; palMode = 'visibility'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Choose visibility'; palInput.value = ''; loadAccess(doc.id); loadTaskMeta(doc.id); renderPalette(); palInput.focus();
}
// A document that is already shared with selected people opens at that list: the mode is settled, the people are what
// changes. Anything else (and a doc whose participants or sharing rules say the list cannot be edited) starts at the
// mode picker as before. The full picker stays one Cmd+K "Edit visibility" away.
function openVisibility(doc, scope) {
  const access = accessById.get(doc.id);
  if (scope !== 'people' || !taskMetaById.has(doc.id) || !(access?.rules || []).includes('people')) return openVisibilityPalette(doc);
  palDoc = doc; palette.hidden = false;
  loadAccess(doc.id); // Apply still goes through the same sharing rules
  openVisibilityPeople(doc);
}
function openVisibilityPeople(doc) {
  const meta = taskMetaById.get(doc.id);
  if (!meta) return;
  visibilityPeople = new Set(meta.participants.map((p) => p.uri).filter((id) => id && id !== me()?.id));
  visibilityRoles = new Map(meta.participants.map((p) => [p.uri, p.role]).filter(([id]) => id && id !== me()?.id));
  palMode = 'visibilityPeople'; palRows = []; palIndex = 0; palInput.placeholder = 'Select people'; palInput.value = '';
  loadMembers(); renderPalette(); palInput.focus();
}
function visibilityPeopleRows(q) {
  if (!palDoc) return [];
  loadMembers();
  const people = (members || []).filter((member) => !member.me && memberName(member.id).toLowerCase().includes(q));
  const back = { group: 'Visibility', label: 'Back to visibility', keepOpen: true, run: backPalette };
  const apply = { group: 'Visibility', label: 'Apply selected people', disabled: !visibilityPeople.size, keepOpen: true, run: () => applySharing(palDoc, { rule: 'people', participants: [...visibilityPeople].map((uri) => ({ uri, role: visibilityRoles.get(uri) || 'editor' })) }) };
  return [back, apply, ...people.map((member) => ({ group: 'People', icon: 'member', label: memberName(member.id), hint: visibilityPeople.has(member.id) ? '✓' : '', keepOpen: true, run: () => { if (visibilityPeople.has(member.id)) visibilityPeople.delete(member.id); else { visibilityPeople.add(member.id); visibilityRoles.set(member.id, 'editor'); } renderPalette(); } }))];
}
function searchSpacesNow() {
  if (!palDoc || !tana.searchSpaces) return;
  const query = palInput.value.trim(), seq = ++palSeq; palBusy = true;
  tana.searchSpaces(query).then((nodes) => {
    if (seq !== palSeq || palMode !== 'spaces') return;
    palRows = nodes.map(asDoc).map((node) => ({ group: 'Spaces', ...docRow(node, node.selectable ? '' : 'No permission', () => previewMoveToSpace(palDoc, node)), disabled: !node.selectable, keepOpen: true }));
    palIndex = 0; palBusy = false; renderPalette();
  }, showError);
}
function openMovePalette(doc) {
  clearTimeout(palTimer); palTimer = null; ++palSeq;
  palDoc = doc; palMode = 'spaces'; palRows = []; palIndex = 0; palBusy = false; palette.hidden = false;
  palInput.placeholder = 'Search spaces'; palInput.value = ''; searchSpacesNow(); palInput.focus();
}
function audienceLabel(audience) { return audienceInfo(audience)?.label || 'Audience cannot be verified'; }
function previewMoveToSpace(doc, space) {
  if (!tana.previewMove) return;
  const seq = ++palSeq; palBusy = true;
  tana.previewMove(doc.id, space.id).then((preview) => {
    if (seq !== palSeq || palMode !== 'spaces') return;
    palBusy = false;
    if (!preview.allowed) { showError(new Error(preview.reason || 'This space cannot be selected')); return renderPalette(); }
    palMode = 'moveConfirm'; palIndex = 2;
    palRows = [
      { group: 'Move', label: 'Before: ' + audienceLabel(preview.before), disabled: true },
      { group: 'Move', label: 'After: ' + audienceLabel(preview.after), disabled: true },
      { group: 'Move', icon: 'space', label: 'Move to ' + (preview.target?.title || space.text || 'space'), keepOpen: true, run: () => moveToSpace(doc, space, preview.token) },
      { group: 'Move', label: 'Cancel', keepOpen: true, run: () => openMovePalette(doc) },
    ];
    renderPalette();
  }, showError);
}
function moveToSpace(doc, space, token) {
  run(async () => {
    try {
      await tana.moveToSpace(doc.id, space.id, token);
      paths.delete(doc.id); extra.set(doc.id, asDoc(doc)); closePalette(); await loadRoots(); render();
    } catch (e) {
      showError(e);
      if (/preview.*again|explicitly confirm|access changed/i.test(String(e.message || e))) openMovePalette(doc);
    }
  });
}
function pillDefs() {
  const f = filters.get(view);
  if (!f) return [];
  const defs = [], save = setViewF, one = f.types && f.types.length === 1 && TYPES.find((t) => t && t[0] === f.types[0]);
  // A kind page (Tasks, Meetings, Chats, People) is that kind: only the Library and the Inbox pick their kinds.
  if (!(views.find((v) => v.id === view) || {}).kind) defs.push({ id: 'type', value: names(TYPES, f.types) || 'Any type', icon: one ? one[2] : 'any', rows: () => [
    { label: 'Any type', icon: 'any', checked: !f.types, run: () => save({ types: null }) },
    ...TYPES.map((t) => (t ? { label: t[1], icon: t[2], keepOpen: true, checked: !!f.types && f.types.includes(t[0]), run: () => save({ types: toggleIn(TYPES.filter(Boolean).map((x) => x[0]), f.types, t[0]) }) } : { div: true })), // multi-select: the menu stays open to tick more
  ] });
  if (!f.types || f.types.includes('tasks')) {
    defs.push({ id: 'status', label: 'Status', icon: 'status', value: names(STATES, f.states) || 'Any', rows: () => [
      { label: 'Any status', checked: !f.states, run: () => save({ states: null }) },
      ...STATES.map(([v, l]) => ({ label: l, keepOpen: true, checked: !!f.states && f.states.includes(v), run: () => save({ states: toggleIn(STATES.map((s) => s[0]), f.states, v) }) })), // multi-select, like the type list
    ] });
    loadMembers();
    const you = 'You' + (me() ? ' (' + me().title + ')' : '');
    const a = f.assignee, m = (members || []).find((x) => x.id === a), who = a === 'anyone' ? 'Anyone' : a === 'unassigned' ? 'Unassigned' : a === 'me' || !a ? you : m ? m.title : '…';
    defs.push({ id: 'assigned', label: 'Assigned to', icon: 'assigned', value: who, rows: () => [
      { label: 'Anyone', checked: a === 'anyone', run: () => save({ assignee: 'anyone' }) },
      { label: you, checked: a === 'me' || !a, run: () => save({ assignee: 'me' }) },
      { label: 'Unassigned', checked: a === 'unassigned', run: () => save({ assignee: 'unassigned' }) },
      { head: 'Members' },
      ...(members || []).filter((x) => !x.me).map((x) => ({ label: x.title, checked: a === x.id, run: () => save({ assignee: x.id }) })),
    ] });
  }
  if (!f.types || f.types.includes('chats')) defs.push({ id: 'mcp', label: 'MCP chats', active: !!f.mcp, toggle: () => save({ mcp: !f.mcp }) });
  // sorting and grouping are view preferences, not queries: they re-order and re-section the rows the view already has
  defs.push({ id: 'sort', label: 'Sort', icon: 'sort', value: SORTS.find(([id]) => id === sortBy())[1], rows: () => SORTS.map(([id, label]) => ({ label, checked: sortBy() === id, run: () => setSortBy(id) })) });
  defs.push({ id: 'group', label: 'Group', icon: 'group', value: GROUPS.find(([id]) => id === groupBy())[1], rows: () => GROUPS.map(([id, label]) => ({ label, checked: groupBy() === id, run: () => setGroupBy(id) })) });
  return defs;
}
const pillsApply = () => filters.has(view);
const pillName = (def) => def.label || def.id[0].toUpperCase() + def.id.slice(1);
function pillCommandRows() {
  return (pillsApply() ? pillDefs() : []).map((def) => ({
    id: 'pill:' + def.id, group: 'View options', icon: def.icon,
    label: 'Set view option: ' + pillName(def) + (def.value ? ' ' + def.value : ''),
    keepOpen: !!def.rows, run: def.rows ? () => openPillPalette(def.id) : def.toggle,
  }));
}
function renderPills(show) {
  const box = $('pills'), defs = show ? pillDefs() : [];
  box.hidden = !defs.length;
  const focusedId = box.contains(document.activeElement) && document.activeElement.closest('.pill') ? document.activeElement.closest('.pill').dataset.id : null;
  if (menu && !defs.some((d) => d.id === menu.id)) menu = null;
  box.replaceChildren(...defs.map((d) => {
    const pill = document.createElement('div'); pill.className = 'pill' + (d.active ? ' active' : '') + (menu && menu.id === d.id ? ' open' : ''); pill.tabIndex = 0; pill.dataset.id = d.id; pill.setAttribute('role', 'button');
    if (d.toggle) pill.setAttribute('aria-pressed', String(!!d.active));
    if (d.icon) { const s = document.createElement('span'); s.innerHTML = iconSvg(d.icon); pill.append(s.firstChild); }
    if (d.label) pill.append(d.label);
    if (d.value) { const b = document.createElement('b'); b.textContent = d.value; pill.append(b); }
    pill.onmousedown = (e) => { if (e.target.closest('.menu')) e.preventDefault(); }; // menu clicks keep the pill focused
    pill.onclick = (e) => { if (d.toggle) d.toggle(); else if (!e.target.closest('.menu')) { menu = menu && menu.id === d.id ? null : { id: d.id, index: 0 }; renderPills(true); pill.focus(); } };
    pill.onkeydown = (e) => pillKeys(e, d, pill);
    if (menu && menu.id === d.id) pill.append(menuEl(d));
    return pill;
  }));
  const again = focusedId && box.querySelector('.pill[data-id="' + focusedId + '"]');
  if (again) again.focus();
  const open = box.querySelector('.menu'); // stop before the window edge; the rows scroll inside
  if (open) open.style.maxHeight = Math.min(360, innerHeight - open.getBoundingClientRect().top - 12) + 'px';
  const active = box.querySelector('.menu .mrow.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
}
function menuEl(d) {
  const rows = d.rows(), el = document.createElement('div'); el.className = 'menu';
  const pick = rows.filter((r) => r.label); // navigable rows
  menu.index = Math.max(0, Math.min(menu.index, pick.length - 1));
  for (const r of rows) {
    const row = document.createElement('div');
    if (r.head) { row.className = 'mhead'; row.textContent = r.head; el.append(row); continue; }
    if (r.div) { row.className = 'mdiv'; el.append(row); continue; }
    row.className = 'mrow' + (pick.indexOf(r) === menu.index ? ' active' : '');
    if (rows.some((x) => x.icon)) { const i = document.createElement('span'); i.className = 'micon'; i.innerHTML = r.icon ? iconSvg(r.icon) : ''; row.append(i); }
    const l = document.createElement('span'); l.className = 'mlabel'; l.textContent = r.label; row.append(l);
    if (r.checked && r.label !== 'Any status' && r.label !== 'Any type' && r.label !== 'Anyone') { const t = document.createElement('span'); t.className = 'tick'; t.textContent = '✓'; row.append(t); }
    row.onclick = () => pickMenuRow(r, pick);
    el.append(row);
  }
  return el;
}
// Choosing an option closes the menu, so it stops covering the list it just filtered. Multi-select rows (the type
// and status ticks) keep it open; the single-choice row that ends the selection ("Any type", "Any status", an
// assignee) closes it like every other choice.
function pickMenuRow(r, pick) {
  if (!r || !menu) return;
  menu.index = pick.indexOf(r);
  if (!r.keepOpen) menu = null;
  r.run();
  renderPills(true);
}
function pillKeys(e, d, pill) {
  const open = menu && menu.id === d.id, pick = open ? d.rows().filter((r) => r.label) : [];
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : pick.length - 1)) % pick.length; renderPills(true); }
  else if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickMenuRow(pick[menu.index], pick); }
  else if (open && e.key === 'Escape') { e.preventDefault(); menu = null; renderPills(true); }
  else if (open && e.key === 'Tab') { menu = null; renderPills(true); }
  else if (d.toggle && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d.toggle(); }
  else if (!open && !d.toggle && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) { e.preventDefault(); menu = { id: d.id, index: 0 }; renderPills(true); }
  else if (!open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); const s = e.key === 'ArrowLeft' ? pill.previousElementSibling : pill.nextElementSibling; if (s) s.focus(); }
  else if (!open && e.key === 'Escape') { e.preventDefault(); pill.blur(); }
}
document.addEventListener('mousedown', (e) => { if (menu && !(e.target.closest && e.target.closest('.pill'))) { menu = null; renderPills(true); } });
// ---- page title (zoomed into a document): edits go through the same debounce as node text; Enter -> first child, Esc restores ----
titleEl.addEventListener('input', () => { const item = items.get(titleEl.dataset.key); if (!item) return; if (item.node.draft && !item.busy) { item.busy = true; materialise(item, titleEl); } else if (!item.node.draft) scheduleSave(item, [{ text: titleEl.textContent }]); });
titleEl.addEventListener('blur', () => { const item = items.get(titleEl.dataset.key); if (item?.node.draft && !item.busy && !titleEl.textContent) { zoom = null; return dropDraft(item); } flush(titleEl.dataset.key); });
titleEl.addEventListener('keydown', (e) => {
  const item = items.get(titleEl.dataset.key);
  if (!titleEl.isContentEditable || !item) return;
  if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); removeDocument(item); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleDone(item); }
  else if (e.key === 'Enter') { e.preventDefault(); flush(item.key); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); dropPending(item.key); titleEl.textContent = item.node.text; titleEl.blur(); }
  else if (e.key === 'ArrowDown' && atEdge(titleEl, 'down')) { const first = texts()[0]; if (first) { e.preventDefault(); flush(item.key); setCaret(first, 0); } }
});
// the document Cmd+K context actions apply to: the zoomed one, else the document whose node is focused
function currentDoc() {
  const f = focused(), item = f && items.get(f.key);
  const docId = zoom ? zoom.docId : item ? item.docId : null;
  const d = docId && (allDocs().find((x) => x.id === docId) || extra.get(docId));
  return d && !d.draft ? d : null;
}
// ---- pins (api.pinState / pin / unpin): what the palette needs is whether this document is pinned, not the tree ----
function loadPins() {
  const doc = palDoc;
  if (!doc || !tana.pinState) { pinInfo = null; return; }
  tana.pinState(doc.id).then((s) => {
    pinInfo = s ? { docId: doc.id, ...s } : null;
    if (!palette.hidden && palMode === 'cmd') renderPalette();
  }, showError);
}
function pinAction(op, target) { run(async () => { await tana[op](pinInfo.docId, target); loadPins(); }); }
function invalidatePinCaches(id, includeRecent = true) {
  if (pinInfo && pinInfo.docId === id) pinInfo = null;
  if (includeRecent) forgetRecent(id);
  palRows = palRows.filter((row) => row.id !== 'pinned:' + id);
}
function invalidateNode(id) {
  invalidatePinCaches(id);
  extra.delete(id); paths.delete(id); kids.delete(id); fresh.delete(id); taskMetaById.delete(id);
  for (const section of views) section.nodes = section.nodes.filter((node) => node.id !== id);
  palRows = palRows.filter((row) => row.node?.id !== id);
  if (palDoc?.id === id) { palDoc = null; pinInfo = null; }
  if (dropDoc?.id === id) dropDoc = null;
  if (zoom?.docId === id) zoom = null;
}
// ---- custom icons (api.setIcon): "Set icon…" drop overlay, or an .svg dropped straight onto a document line ----
function setIcon(docId, svg) {
  const d = allDocs().find((x) => x.id === docId) || extra.get(docId);
  if (d) d.iconSvg = svg || undefined;
  render();
  run(() => tana.setIcon(docId, svg));
}
function setSensitiveMark(ids, on) {
  run(async () => {
    for (const id of [ids].flat()) {
      await tana.setSensitive(id, on);
      if (on) sensitiveIds.add(id); else sensitiveIds.delete(id);
    }
    refreshSensitive();
  });
}
function toggleSensitiveVisibility() {
  sensitiveVisible = !sensitiveVisible;
  refreshSensitive();
}
function startDrop(doc) {
  dropDoc = doc; dropReturn = focused();
  $('dropText').textContent = 'Drop an SVG file to set the icon of ' + (doc.text || doc.title || 'Untitled');
  $('drop').hidden = false;
  if (document.activeElement) document.activeElement.blur(); // keys go to the overlay (document listener), not into a node
}
function endDrop() {
  dropDoc = null; $('drop').hidden = true; $('dropFile').value = '';
  if (dropReturn) placeCaret(dropReturn.key, dropReturn.offset);
  dropReturn = null;
}
function readSvg(file, cb) {
  if (!file || !(file.type === 'image/svg+xml' || /\.svg$/i.test(file.name))) return showError('Drop an .svg file');
  const r = new FileReader(); r.onload = () => cb(r.result); r.readAsText(file);
}
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const line = !dropDoc && e.target.closest && e.target.closest('.line'), item = line && items.get(line.parentElement.dataset.key);
  const doc = dropDoc || (item && item.node.kind === 'document' && item.node);
  if (!doc) return;
  readSvg(e.dataTransfer.files[0], (svg) => { endDrop(); setIcon(doc.id, svg); });
});
$('drop').onclick = endDrop;
$('dropFile').onchange = () => { const doc = dropDoc; readSvg($('dropFile').files[0], (svg) => { endDrop(); setIcon(doc.id, svg); }); };

// ---- @ linking: replace the selection with a mention chosen (or created) in the search palette ----
// document titles are plain strings in Tana: there the picked item's title goes in as text (setTitle), no mention segment
// copy to the clipboard and say so where errors already appear, since a copy has no other visible result
function showNote(note) {
  const el = $('error');
  el.textContent = note; el.hidden = false;
  setTimeout(() => { if (el.textContent === note) showError(null); }, 2000);
}
async function copyText(text, note) { await navigator.clipboard.writeText(text); showNote(note); }
function startLink(item, el, [start, end]) {
  flush(item.key);
  const segs = readSegs(el);
  togglePalette('search', { item, segs, start, end, text: plainOf(segs).slice(start, end) });
}
async function linkTo(ctx, mention) {
  const { item, segs, start, end } = ctx;
  const isDoc = item.node.kind === 'document';
  const next = [...splitSegs(segs, start)[0], isDoc ? { text: mention.label } : { mention }, ...splitSegs(segs, end)[1]];
  item.node.text = plainOf(next); item.node.segments = isDoc ? undefined : next;
  await run(async () => { if (isDoc) await tana.setTitle(item.docId, item.node.text); else { await tana.setText(item.docId, item.node.id, next); await reload(item.docId); } });
  render();
  placeCaret(item.key, start + mention.label.length);
}
function createAndLink(ctx) {
  tana.createDocument(ctx.text).then((n) => { extra.set(n.id, { ...n, text: n.title || '', hasChildren: true }); return linkTo(ctx, { label: n.title, uri: n.id }); }, showError);
}
function cancelLink() { const c = linkCtx; linkCtx = null; if (c) placeCaret(c.item.key, c.end); }

// ---- selection toolbar: marks and block styles for the current selection, like Tana's floating toolbar ----
// Keyboard first: ⌘B / ⌘I / ⇧⌘S / ⌘E toggle the marks, "@" links, Tab moves into the toolbar (Left/Right between
// buttons, Down opens the style menu, Enter runs, Escape hands the caret back with the selection still there).
const toolbarEl = $('toolbar');
const MARK_KEYS = { b: 'bold', i: 'italic', e: 'code' };
const TOOL_MARKS = [['bold', 'B', 'b', 'Bold ⌘B'], ['italic', 'I', 'i', 'Italic ⌘I'], ['strike', 'S', 's', 'Strikethrough ⇧⌘S'], ['code', '', 'c', 'Code ⌘E']];
let toolCtx = null;       // { key, start, end }: the selection every toolbar action applies to
let toolMenu = null;      // open style dropdown: { index }
let toolDismissed = null; // the selection Escape dismissed; it comes back when the selection changes
const toolItem = () => (toolCtx ? items.get(toolCtx.key) : null);
const toolSegs = () => { const el = toolCtx && textEl(toolCtx.key); return el ? readSegs(el) : []; };
const sameRange = (a, b) => !!a && !!b && a.key === b.key && a.start === b.start && a.end === b.end;
function hideToolbar(dismiss) { toolbarEl.hidden = true; toolMenu = null; toolDismissed = dismiss ? toolCtx : null; }
function updateToolbar() {
  if (!toolbarEl.hidden && toolbarEl.contains(document.activeElement)) return; // the toolbar has the keyboard: leave it alone
  const el = document.activeElement;
  const item = el && el.classList && el.classList.contains('text') && outline.contains(el) ? items.get(keyOfEl(el)) : null;
  const range = item && canEditText(item) && item.node.kind === 'block' && !isAtomic(item.node) ? selectionOffsets(el) : null;
  if (!range) return hideToolbar();
  const next = { key: item.key, start: range[0], end: range[1] };
  if (sameRange(toolDismissed, next)) return;
  toolDismissed = null; toolCtx = next;
  renderToolbar();
}
document.addEventListener('selectionchange', updateToolbar);
function renderToolbar() {
  const item = toolItem();
  if (!item) return hideToolbar();
  const segs = toolSegs();
  toolbarEl.replaceChildren();
  const style = document.createElement('button');
  style.type = 'button'; style.className = 'tbtn style' + (toolMenu ? ' open' : ''); style.dataset.id = 'style';
  style.title = 'Text style'; style.append(BLOCK_LABEL.get(blockTypeOf(item.node)) || 'Text');
  const caret = document.createElement('span'); caret.className = 'tcaret'; caret.innerHTML = CHEV; style.append(caret);
  style.onclick = toggleStyleMenu;
  toolbarEl.append(style);
  if (toolMenu) style.append(styleMenuEl(item));
  for (const [mark, label, cls, title] of TOOL_MARKS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = mark; b.title = title;
    if (label) b.textContent = label; else b.innerHTML = iconSvg('code'); // code uses the icon, the rest are letters
    b.className = 'tbtn ' + cls + (hasMark(segs, toolCtx.start, toolCtx.end, mark) ? ' on' : '');
    b.setAttribute('aria-pressed', String(b.className.includes(' on')));
    b.onclick = () => applyMark(mark);
    toolbarEl.append(b);
  }
  const at = document.createElement('button');
  at.type = 'button'; at.className = 'tbtn at'; at.dataset.id = 'link'; at.title = 'Link to a document (@)'; at.textContent = '@';
  at.onclick = linkSelection;
  toolbarEl.append(at);
  toolbarEl.hidden = false;
  placeToolbar();
}
function placeToolbar() {
  const sel = getSelection();
  if (!sel.rangeCount || !toolbarEl.getBoundingClientRect) return;
  const rects = sel.getRangeAt(0).getClientRects(), r = rects[0] || sel.getRangeAt(0).getBoundingClientRect();
  if (!r) return;
  const width = toolbarEl.getBoundingClientRect().width || 280;
  toolbarEl.style.left = Math.max(8, Math.min(innerWidth - width - 8, r.left)) + 'px';
  toolbarEl.style.top = Math.max(8, r.top - 44) + 'px';
}
function styleMenuEl(item) {
  const el = document.createElement('div'); el.className = 'menu';
  BLOCK_TYPES.forEach(([type, label], i) => {
    const row = document.createElement('div'); row.className = 'mrow' + (i === toolMenu.index ? ' active' : '');
    const icon = document.createElement('span'); icon.className = 'micon'; icon.innerHTML = glyphSvg(type);
    const text = document.createElement('span'); text.className = 'mlabel'; text.textContent = label;
    row.append(icon, text);
    if (blockTypeOf(item.node) === type) { const tick = document.createElement('span'); tick.className = 'tick'; tick.textContent = '✓'; row.append(tick); }
    row.onclick = () => applyBlockType(type);
    el.append(row);
  });
  return el;
}
function focusToolbar() { const b = toolbarEl.querySelector('.tbtn'); if (b) b.focus(); }
function toggleStyleMenu() {
  const item = toolItem();
  const at = item ? BLOCK_TYPES.findIndex(([type]) => type === blockTypeOf(item.node)) : 0;
  toolMenu = toolMenu ? null : { index: Math.max(0, at) };
  renderToolbar(); focusToolbar();
}
// the caret goes back where it was, selection intact, so Escape never costs the user their selection
function returnToSelection() { const ctx = toolCtx; hideToolbar(true); if (ctx) selectRange(ctx.key, ctx.start, ctx.end); }
toolbarEl.addEventListener('mousedown', (e) => e.preventDefault()); // clicking a button must not drop the selection it acts on
toolbarEl.addEventListener('keydown', (e) => {
  const buttons = [...toolbarEl.querySelectorAll('.tbtn')], i = Math.max(0, buttons.indexOf(document.activeElement));
  if (toolMenu) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); toolMenu.index = (toolMenu.index + (e.key === 'ArrowDown' ? 1 : BLOCK_TYPES.length - 1)) % BLOCK_TYPES.length; renderToolbar(); focusToolbar(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyBlockType(BLOCK_TYPES[toolMenu.index][0]); }
    else if (e.key === 'Escape') { e.preventDefault(); toolMenu = null; renderToolbar(); focusToolbar(); }
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]; if (next) next.focus(); }
  else if (e.key === 'ArrowDown' && buttons[i] && buttons[i].dataset.id === 'style') { e.preventDefault(); toggleStyleMenu(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (buttons[i]) buttons[i].click(); }
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); returnToSelection(); }
});
// a mark toggle re-sends the whole block with the marks split at the selection (the renderer never computes Loro offsets)
async function applyMark(mark, value) {
  const ctx = toolCtx, item = toolItem(), el = ctx && textEl(ctx.key);
  if (!ctx || !item || !el || item.node.kind !== 'block' || !canEditText(item)) return;
  dropPending(ctx.key);
  const segs = readSegs(el);
  const next = markRange(segs, ctx.start, ctx.end, mark, value === undefined ? (hasMark(segs, ctx.start, ctx.end, mark) ? null : true) : value);
  item.node.text = plainOf(next); item.node.segments = next;
  renderSegs(el, next); // the mark shows before the round trip finishes
  await run(() => tana.setText(item.docId, item.node.id, saveValue(next)));
  render(true);
  selectRange(ctx.key, ctx.start, ctx.end);
}
function toggleMarkKey(item, el, mark) {
  const range = selectionOffsets(el);
  if (!range) return; // no selection: nothing to mark (and the browser's own bold never runs)
  toolCtx = { key: item.key, start: range[0], end: range[1] };
  applyMark(mark);
}
async function applyBlockType(type) {
  const ctx = toolCtx, item = toolItem();
  toolMenu = null;
  if (!item || item.node.kind !== 'block' || !tana.setBlockType) return renderToolbar();
  flush(item.key);
  await run(async () => { await tana.setBlockType(item.docId, item.node.id, type); await reload(item.docId); });
  render(true);
  if (ctx) selectRange(ctx.key, ctx.start, ctx.end);
}
function linkSelection() { // the @ button runs the same linking flow as typing "@" over a selection
  const ctx = toolCtx, item = toolItem(), el = ctx && textEl(ctx.key);
  hideToolbar();
  if (item && el) startLink(item, el, [ctx.start, ctx.end]);
}

// ---- "/" at the start of an empty node: block types, a divider, then what api.creationOptions offers ----
let slashCtx = null; // { key } the node holding the "/"; kept until another palette mode opens
function slashTarget() { return slashCtx ? items.get(slashCtx.key) : null; }
function openSlash(item) {
  slashCtx = { key: item.key };
  togglePalette('slash');
  loadCreationChoices();
}
function slashRows(q) {
  const rows = [...BLOCK_TYPES.filter(([type]) => type !== 'paragraph'), ['divider', 'Divider']].map(([type, label]) => ({
    group: 'Blocks', svg: glyphSvg(type), label,
    disabled: type === 'divider' ? !tana.insertDivider : !tana.setBlockType,
    run: () => runSlashBlock(type),
  }));
  // Doc and Task are always offered; the workspace types come from the same source as the Cmd+K "Create new…" list
  const choices = creationChoices.some((c) => c.kind === 'doc') ? creationChoices : [{ kind: 'doc', title: 'Doc', icon: 'doc', selectable: true }, ...creationChoices];
  for (const choice of choices) rows.push({
    group: choice.kind === 'custom' ? 'Workspace types' : 'Create', icon: choice.icon, svg: choice.iconSvg, hue: choice.hue,
    label: 'Create ' + choice.title, hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable,
    run: () => createFromSlash(choice),
  });
  if (palBusy) rows.push({ group: 'Create', label: 'Loading choices…', disabled: true });
  return rows.filter((r) => r.label.toLowerCase().includes(q));
}
async function runSlashBlock(type) {
  const item = slashTarget();
  if (!item || item.node.kind !== 'block') return;
  dropPending(item.key);
  const { docId, node } = item;
  await run(async () => {
    await tana.setText(docId, node.id, []); // the "/" was the command, not text
    if (type === 'divider') await tana.insertDivider(docId, node.id);
    else await tana.setBlockType(docId, node.id, type);
    await reload(docId);
  });
  node.text = ''; node.segments = [];
  render();
  placeCaret(item.key, 0);
}
function createFromSlash(choice) {
  const item = slashTarget();
  if (item && item.node.kind === 'block') {
    dropPending(item.key);
    item.node.text = ''; item.node.segments = [];
    run(() => tana.setText(item.docId, item.node.id, []));
  }
  startCreation(choice);
}

// ---- navigation ----
function moveTo(el, dir, offset) {
  const all = texts(), target = all[all.indexOf(el) + dir];
  if (!target) { if (dir < 0) focusAbove(el); return; }
  flush(keyOfEl(el));
  setCaret(target, offset);
}

// ---- events ----
outline.addEventListener('keydown', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  const item = items.get(keyOfEl(el)), mod = e.metaKey || e.ctrlKey;
  const off = caretOffset(el), len = el.textContent.length, collapsed = getSelection().isCollapsed;
  const isDoc = item.node.kind === 'document';
  if (isAtomic(item.node)) { // image or divider, not editable: Backspace / ⌘⇧⌫ removes, Up/Down step past, Shift+Up/Down select, ⌘⇧Up/Down moves; everything else is swallowed
    const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown', dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.key === 'Backspace') removeNode(item, el);
    else if (vert && e.shiftKey && mod) shiftNode(item, el, 'move', dir < 0 ? 'up' : 'down');
    else if (vert && e.shiftKey) extendSel(item, dir);
    else if (vert && !mod) moveTo(el, dir, 0);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') moveTo(el, e.key === 'ArrowLeft' ? -1 : 1, e.key === 'ArrowLeft' ? Infinity : 0);
    else if (e.key === 'Tab') shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent');
    else if (e.key === 'Escape') el.blur();
    else if (mod) return; // ⌘K / ⌘S / ⌘Z … reach the document handler
    return e.preventDefault();
  }
  if (!canEditItem(item)) {
    if (isReference(item.node) && canEditStructure(item)) {
      const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown', dir = e.key === 'ArrowUp' ? 'up' : 'down';
      const editing = canEditText(item);
      if (e.key === 'Backspace' && (!editing || (off === 0 && collapsed))) removeNode(item, el);
      else if (vert && e.shiftKey && mod) shiftNode(item, el, 'move', dir);
      else if (vert && e.shiftKey) extendSel(item, dir === 'up' ? -1 : 1);
      else if (vert && !mod) moveTo(el, dir === 'up' ? -1 : 1, editing ? off : 0);
      else if (e.key === 'Escape') { if (editing) flush(item.key); el.blur(); }
      else if (mod) return;
      else if (editing && e.key !== 'Enter' && e.key !== 'Tab') return; // typing edits the referenced document's title
      return e.preventDefault();
    }
    if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); }
    else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
    else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
    else if (e.key === 'ArrowLeft' && !mod && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
    else if (e.key === 'ArrowRight' && !mod && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
    else if (!(mod && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 's'))) e.preventDefault();
    return;
  }
  if (item.node.draft) { // empty draft: Enter/Tab do nothing, Backspace drops it (caret to the node above); typing creates it (input handler)
    if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault();
    if (e.key === 'Backspace' && len === 0) { e.preventDefault(); const all = texts(), prev = all[all.indexOf(el) - 1], k = prev && keyOfEl(prev); dropDraft(item); return k ? placeCaret(k) : focusAbove(); }
    if (e.key !== 'Escape' && !(e.key.startsWith('Arrow') && !mod)) return;
  }
  // formatting: the toolbar's toggles from the keyboard, and Tab/Escape into and out of the toolbar itself
  if (e.key === 'Escape' && !toolbarEl.hidden) { e.preventDefault(); returnToSelection(); }
  else if (e.key === 'Tab' && !e.shiftKey && !toolbarEl.hidden) { e.preventDefault(); focusToolbar(); }
  else if (mod && !e.shiftKey && MARK_KEYS[e.key.toLowerCase()]) { e.preventDefault(); toggleMarkKey(item, el, MARK_KEYS[e.key.toLowerCase()]); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); toggleMarkKey(item, el, 'strike'); }
  else if (e.key === 'Escape') { e.preventDefault(); flush(item.key); el.blur(); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); } // multi-select over siblings
  else if (e.key === '@' && !collapsed) { const range = selectionOffsets(el); if (range) { e.preventDefault(); startLink(item, el, range); } } // no selection: "@" is typed
  else if (e.key === 'Enter' && mod) { e.preventDefault(); if (isDoc) toggleDone(item); else toggleCheckbox(item); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertAtCaret(el, '\n'); }
  else if (e.key === 'Enter' && isDoc && item.parent) e.preventDefault(); // document child (inside a space): nothing to split or draft yet
  else if (e.key === 'Enter' && isDoc && !zoom && !isOpen(item)) { e.preventDefault(); draftDoc(item); } // collapsed document in a view: draft sibling document
  else if (e.key === 'Enter') { e.preventDefault(); splitNode(item, el, off ?? len); }
  else if (e.key === 'Tab') { e.preventDefault(); if (!isDoc) shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent'); }
  // a document row is the document: the same shortcut deletes it (reversibly, like the zoomed title), not just blocks
  else if (e.key === 'Backspace' && mod && e.shiftKey) { e.preventDefault(); if (isDoc) removeDocument(item); else removeNode(item, el); }
  else if (e.key === 'Backspace' && off === 0 && collapsed) { e.preventDefault(); if (!isDoc && len === 0) removeNode(item, el); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && mod && e.shiftKey) { e.preventDefault(); if (!isDoc) shiftNode(item, el, 'move', e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (e.key === 'ArrowUp' && mod && !e.shiftKey) { e.preventDefault(); setOpen(item, false); }
  else if (e.key === 'ArrowDown' && mod && !e.shiftKey) { e.preventDefault(); setOpen(item, true); } // an empty node opens onto a draft child
  else if (e.key === 'ArrowUp' && !mod && atEdge(el, 'up')) { e.preventDefault(); moveTo(el, -1, off); }
  else if (e.key === 'ArrowDown' && !mod && atEdge(el, 'down')) { e.preventDefault(); moveTo(el, 1, off); }
  else if (e.key === 'ArrowLeft' && off === 0 && collapsed) { e.preventDefault(); moveTo(el, -1, Infinity); }
  else if (e.key === 'ArrowRight' && off === len && collapsed) { e.preventDefault(); moveTo(el, 1, 0); }
});
outline.addEventListener('input', (e) => {
  const el = e.target.closest && e.target.closest('.text');
  if (!el) return;
  const item = items.get(keyOfEl(el));
  if (!canEditText(item)) return;
  if (!item.node.draft) scheduleSave(item, readSegs(el));
  else if (!item.busy && !item.node.pendingSplit) { item.busy = true; materialise(item, el); }
  if (item.node.kind === 'block' && el.textContent === '/' && palette.hidden) openSlash(item); // "/" alone in a node is the command menu
});
outline.addEventListener('focusout', (e) => {
  const el = e.target, item = el.classList && el.classList.contains('text') && items.get(keyOfEl(el));
  if (!item) return;
  if (!item.node.draft) flush(item.key);
  // left empty by the user: no node is created. Deferred one microtask because during focusout nothing is focused yet,
  // so the re-render would find no caret to keep; by then the row the caret moved to (Arrow keys, a click) holds it.
  else if (!rendering && !el.textContent && !item.busy && el.isConnected) queueMicrotask(() => {
    if (!rendering && !el.textContent && !item.busy && el.isConnected && document.activeElement !== el) dropDraft(item);
  });
});
outline.addEventListener('mousedown', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.mention')) e.preventDefault();
  const line = e.target.closest('.line');
  if (!line || e.target.closest('.check, .bullet, .chev, a')) return;
  const key = line.parentElement.dataset.key;
  if (e.metaKey) { // Cmd+click: add or remove this row, and make it the keyboard range anchor
    e.preventDefault(); toggleSel(key);
  } else if (e.shiftKey) { // Shift+click: replace the anchored range while retaining other Cmd-selected rows
    e.preventDefault();
    const f = focused(), anchor = sel ? sel.anchor : f ? f.key : key;
    rangeSelTo(key, anchor);
  }
});
outline.addEventListener('focusin', () => { // the caret is back in a node
  if (!sel) return;
  sel = null; selectionFrozen = false;
  for (const n of outline.querySelectorAll('.selected')) n.classList.remove('selected');
  if (renderDeferred) queueMicrotask(() => { if (!editingRow()) render(); });
});
outline.addEventListener('click', (e) => {
  if (!e.target.closest) return;
  const mention = e.target.closest('.mention');
  if (mention) { e.preventDefault(); return goTo(mention.dataset.uri); }
  const url = e.target.closest('a.url, a.link'); // a bare URL and a link mark both open in the browser, like Tana
  if (url && tana.openExternal) { e.preventDefault(); run(() => tana.openExternal(url.dataset.href)); }
});

filterEl.addEventListener('input', render);
filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { filterEl.value = ''; filterShown = false; render(); filterEl.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); const first = texts()[0]; if (first) setCaret(first, 0); }
});
filterEl.addEventListener('blur', () => { if (!filterEl.value) { filterShown = false; render(); } });
$('clear').onclick = () => { filterEl.value = ''; render(); filterEl.focus(); };
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey, inFilter = document.activeElement === filterEl;
  const hotkey = mod && !inFilter && Object.keys(hotkeys).find((id) => hotkeys[id] === comboOf(e));
  if (dropDoc) { if (e.defaultPrevented) return; if (e.key === 'Escape') { e.preventDefault(); endDrop(); } else if (e.key === 'Enter') { e.preventDefault(); $('dropFile').click(); } } // (the palette's Enter that started drop mode is already handled)
  else if (mod && e.key === 'k') { e.preventDefault(); togglePalette('cmd'); }
  else if (mod && (e.key === '0' || (e.shiftKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')))) { e.preventDefault(); setZoom(e.key === '0' ? BASE_ZOOM : zoomFactor * (e.key === '-' || e.key === '_' ? 1 / 1.1 : 1.1)); }
  else if (mod && e.key === 's') { e.preventDefault(); togglePalette('search'); }
  else if (!palette.hidden) return;
  else if (sel && document.activeElement === document.body && (e.defaultPrevented || selKey(e))) e.preventDefault(); // selection keys; a Shift+Arrow already handled in the node stops here (focus is on body by now)
  else if (mod && e.shiftKey && e.key === 'Backspace' && document.activeElement === document.body && zoom) { e.preventDefault(); removeZoomedBlock(); }
  else if (mod && e.key === 'ArrowRight' && !railEl.hidden) { e.preventDefault(); focusRail(); } // into the relationships rail; Escape or Cmd+Left comes back
  else if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') && !inFilter) { e.preventDefault(); history(e.key.toLowerCase() === 'y' || e.shiftKey ? 'redo' : 'undo'); }
  else if (mod && e.key === 'f') { e.preventDefault(); if (zoom) return; filterShown = true; render(); filterEl.focus(); }
  else if (hotkey) { e.preventDefault(); runAction(hotkey); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !mod && document.activeElement === document.body) { // nothing focused: enter the outline
    const all = texts(), el = e.key === 'ArrowDown' ? all[0] : all.at(-1);
    if (el) { e.preventDefault(); setCaret(el, e.key === 'ArrowDown' ? 0 : el.textContent.length); }
  }
  else if (e.key === 'Enter' && !mod && document.activeElement === document.body && !zoom && viewOf() && !viewOf().nodes.length) { e.preventDefault(); draftDoc(null); } // empty view: first draft
  else if (e.key === 'Escape' && document.activeElement === document.body && filterEl.value) { filterEl.value = ''; filterShown = false; render(); }
});

// ---- palette: Cmd+K commands (Views, Actions, matching Documents while typing) or Cmd+S live search (api.search) ----
const palette = $('palette'), palInput = $('paletteInput'), palList = $('paletteList');
let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer, creationChoices = [];
// hint defaults to the node's own meta, so a meeting keeps its date and time in every palette list
const docRow = (n, hint, run) => ({ node: n, icon: n.icon, svg: n.iconSvg, label: n.text ?? n.title, tags: visibleTags(n), hint: hint === undefined ? n.meta : hint, run });
function paletteRows(q) {
  const selection = selectionRows();
  const rows = [...selection, ...views.map((s) => ({ id: 'view:' + s.id, group: 'Views', icon: s.icon, label: s.title, run: () => setView(s.id) }))];
  rows.push(...pillCommandRows());
  if (tana.creationOptions) rows.push({ id: 'create', group: 'Actions', icon: 'createNew', label: 'Create new…', keepOpen: true, run: openCreationPalette });
  rows.push({ id: 'sync', group: 'Actions', icon: 'sync', label: 'Sync', run: () => run(() => tana.refresh()) });
  // the list of titles hidden from every view and from search, edited in the palette itself
  if (tana.filters) rows.push({ id: 'hidden', group: 'Actions', icon: 'hidden', label: 'Edit hidden items', keepOpen: true, run: openHiddenPalette });
  if (palDoc && tana.setSensitive && sensitiveIds) {
    const marked = sensitiveIds.has(palDoc.id);
    rows.push({ group: 'Actions', icon: 'lock', label: marked ? 'Unmark as sensitive' : 'Mark as sensitive', run: () => setSensitiveMark(palDoc.id, !marked) });
  }
  if (tana.sensitiveIds) rows.push({ id: 'sensitiveVisibility', group: 'Actions', icon: 'hidden', label: 'Toggle sensitive visibility', hint: sensitiveVisible ? 'Shown' : 'Blurred', run: toggleSensitiveVisibility });
  // today's node: a document titled with the date, pinned to today; created and pinned when it does not exist yet
  if (tana.todayNode) rows.push({ id: 'today', group: 'Actions', icon: 'today', label: 'Show today node', run: () => run(async () => goTo(await tana.todayNode())) });
  // the week this day sits in, as its own "Week 38" document, created when it does not exist yet
  if (tana.weekNode) rows.push({ id: 'week', group: 'Actions', icon: 'week', label: 'Go to week node', run: () => run(async () => goTo(await tana.weekNode())) });
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  rows.push({ id: 'theme', group: 'Actions', icon: 'darkLight', label: 'Toggle ' + (dark ? 'light' : 'dark') + ' mode', run: () => setTheme(dark ? 'light' : 'dark') });
  if (tana.systemTheme) rows.push({ id: 'systemTheme', group: 'Actions', icon: 'darkLight', label: 'Toggle system dark/light mode', hint: themePref === 'system' ? 'Following macOS' : '', run: () => followSystem(themePref !== 'system') });
  if (signedOut) rows.push({ id: 'login', group: 'Actions', label: 'Log in to Tana', run: () => tana.login().catch(showError) });
  if (pinInfo && palDoc && pinInfo.docId === palDoc.id) { // context actions for the current document (no ids: their labels depend on state, so no hotkeys)
    const sb = pinInfo.sidebar, td = pinInfo.dates.includes(localDate());
    rows.push({ group: 'Actions', icon: 'pin', label: sb ? 'Unpin from sidebar' : 'Pin to sidebar', run: () => pinAction(sb ? 'unpin' : 'pin', 'sidebar') });
    rows.push({ group: 'Actions', icon: 'pinDate', label: td ? 'Unpin from today' : 'Pin to today', run: () => pinAction(td ? 'unpin' : 'pin', 'today') });
  }
  // the node's web link, for pasting into Slack or a doc
  if (palDoc && tana.nodeLink && isRealId(palDoc.id)) {
    rows.push({ id: 'copyLink', group: 'Actions', icon: 'link', label: 'Copy link', run: () => run(async () => copyText(await tana.nodeLink(palDoc.id), 'Link copied')) });
  }
  if (palDoc && tana.setIcon) {
    rows.push({ group: 'Actions', icon: 'setIcon', label: 'Set Image', run: () => startDrop(palDoc) });
    if (palDoc.iconSvg) rows.push({ group: 'Actions', label: 'Remove icon', run: () => setIcon(palDoc.id, null) });
  }
  if (!selection.length) rows.push(...taskActionRows());
  if (palDoc && tana.accessOptions) {
    loadAccess(palDoc.id);
    const access = accessById.get(palDoc.id);
    if (access?.sharing) rows.push({ group: 'Actions', icon: 'lock', label: 'Edit visibility', run: () => openVisibilityPalette(palDoc) });
    if (access?.move) rows.push({ group: 'Actions', icon: 'space', label: 'Move to space', keepOpen: true, run: () => openMovePalette(palDoc) });
  }
  if (q) for (const s of views) for (const n of s.nodes) rows.push({ ...docRow(n, n.meta || s.title, () => openDoc(n.id)), id: 'doc:' + n.id, group: 'Documents' });
  let docsLeft = 8;
  return rows.filter((r) => (!q || r.label.toLowerCase().includes(q)) && (r.group !== 'Documents' || docsLeft-- > 0)).map((r) => (hotkeys[r.id] ? { ...r, kbd: hotkeys[r.id] } : r));
}
// a recorded hotkey runs its palette row's action (views/sync/login by id; documents wherever they live)
function runAction(id) {
  const row = paletteRows('').find((r) => r.id === id);
  if (row) row.run(); else if (id.startsWith('doc:')) goTo(id.slice(4));
}
// Cmd+K renders the exact same rows as the header pill. Multi-select rows stay here; a single choice returns to commands.
function pillRows(q) {
  const def = (pillsApply() ? pillDefs() : []).find((item) => item.id === pillCtx);
  if (!def?.rows) return [];
  let group = pillName(def);
  return def.rows().flatMap((row) => {
    if (row.head) { group = row.head; return []; }
    if (!row.label || !row.label.toLowerCase().includes(q)) return [];
    return [{ group, icon: row.icon, label: row.label, hint: row.checked ? '✓' : '', keepOpen: true, run: () => {
      row.run();
      if (row.keepOpen) renderPalette(); else openCommandPalette();
    } }];
  });
}
function openPillPalette(id) {
  pillCtx = id; palMode = 'pill'; palRows = []; palIndex = 0;
  palInput.placeholder = 'Choose ' + id; palInput.value = ''; renderPalette(); palInput.focus();
}
function openCommandPalette() {
  pillCtx = null; palMode = 'cmd'; palRows = []; palIndex = 0;
  palInput.placeholder = 'Search or run a command'; palInput.value = ''; renderPalette(); palInput.focus();
}
function backPalette() {
  if (palMode === 'pill') openCommandPalette();
  else if (palMode === 'visibilityPeople') openVisibilityPalette(palDoc);
  else closePalette();
}
// ---- hidden items (api.filters): titles every view and search skips, edited from Cmd+K ----
// The rule lives in the group header because that is the one line in the palette that wraps.
const HIDDEN_GROUP = 'Hidden items · whole title, case-insensitive; end with * to match a prefix';
let hiddenList = null; // null while api.filters() is in flight
const hiddenApply = (call) => run(async () => { hiddenList = await call(); renderPalette(); }); // resolves once the views have refreshed
function hiddenRows(q) {
  const rows = (hiddenList || []).filter((pattern) => pattern.toLowerCase().includes(q.toLowerCase()))
    .map((pattern) => ({ group: HIDDEN_GROUP, icon: 'any', label: pattern, hint: (pattern.endsWith('*') ? 'Prefix' : 'Exact') + ' · ↩ unhides', keepOpen: true, run: () => hiddenApply(() => tana.removeFilter(pattern)) }));
  if (q) rows.unshift({ group: HIDDEN_GROUP, icon: 'createNew', label: 'Hide "' + q + '"', hint: q.endsWith('*') ? 'Prefix' : 'Exact', keepOpen: true, run: () => { palInput.value = ''; hiddenApply(() => tana.addFilter(q)); } });
  if (!rows.length) rows.push({ group: HIDDEN_GROUP, label: hiddenList ? 'Nothing is hidden yet' : 'Loading…', disabled: true });
  return rows;
}
function openHiddenPalette() {
  palMode = 'hidden'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Type a title to hide'; palInput.value = '';
  hiddenList = null; renderPalette(); palInput.focus();
  hiddenApply(() => tana.filters());
}
function creationRows(q) {
  if (palBusy) return [{ group: 'Create new', label: 'Loading choices…', disabled: true }];
  return creationChoices.filter((choice) => choice.title.toLowerCase().includes(q)).map((choice) => ({ group: choice.kind === 'custom' ? 'Workspace types' : 'Create new', icon: choice.icon, svg: choice.iconSvg, hue: choice.hue, label: choice.title, hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable, keepOpen: true, run: () => startCreation(choice) }));
}
function openCreationPalette() {
  palMode = 'create'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Choose what to create'; palInput.value = ''; renderPalette(); palInput.focus();
  loadCreationChoices();
}
// the create choices feed both the Cmd+K "Create new…" list and the "/" menu
function loadCreationChoices() {
  if (!tana.creationOptions) return;
  const seq = ++palSeq, mode = palMode; palBusy = true;
  tana.creationOptions().then((result) => {
    if (seq !== palSeq || palMode !== mode) return;
    creationChoices = result.options || []; palBusy = false; renderPalette();
  }, (e) => { if (seq === palSeq && palMode === mode) { palBusy = false; showError(e); renderPalette(); } });
}
function creationSection(choice) {
  const id = choice.kind === 'task' ? 'tasks' : choice.kind === 'meeting' || choice.appliesTo === 'events' ? 'meetings' : choice.kind === 'chat' ? 'chats' : 'library';
  return views.find((section) => section.id === id) || viewOf();
}
function startCreation(choice) {
  const section = creationSection(choice), tags = choice.kind === 'custom' ? [{ label: choice.title, hue: choice.hue }] : undefined;
  const node = draftDocNode(choice.kind, { typeUri: choice.typeUri, icon: choice.icon, tags });
  section.nodes.unshift(node); view = section.id; localStorage.setItem('view', view);
  closePalette(); zoom = { docId: node.id, nodeId: null }; render(); setCaret(titleEl, 0);
  loadView(view); // the target view may not have fetched its rows yet
}
// search result / pin: zoom into it wherever it lives (api.node shape -> extra); from = breadcrumb root when not opened in its view
function openResult(n, from) {
  if (!allDocs().some((d) => d.id === n.id)) extra.set(n.id, asDoc(n));
  openDoc(n.id, from);
}
// result rows pick a document: open it, or link it when the palette was opened with "@" on a selection (Create row first)
function resultRows(nodes, group) {
  nodes = nodes.map(asDoc);
  const ctx = linkCtx, pin = pinCtx;
  const rows = nodes.map((n) => ({ ...docRow(n, n.meta, () => (ctx ? linkTo(ctx, { label: n.title ?? n.text, uri: n.id }) : pin ? pinResult(pin, n) : openResult(n, 'Search'))), group }));
  if (!ctx) return rows;
  return [{ create: true, label: 'Create “' + ctx.text + '”', hint: '⌘↩', run: () => createAndLink(ctx) }, ...rows];
}
function pinResult(ctx, node) {
  return run(async () => {
    await tana.pinTo(ctx.pinHub, node.id);
    relatedBy.delete(ctx.pinHub); relatedBy.delete(ctx.docId); render();
  });
}
function searchNow() {
  const q = palInput.value.trim(), seq = ++palSeq;
  palTimer = null; palBusy = !!q;
  if (!q) { palRows = resultRows(recentRows(), 'RECENTLY VIEWED'); return renderPalette(); }
  tana.search(q).then((nodes) => {
    if (seq !== palSeq || palMode !== 'search') return; // stale response
    palRows = resultRows(nodes);
    // Linking: a result is only the obvious choice when its title starts with what was typed. A full-text hit
    // that merely mentions the words is not, so "Create" stays selected and Enter creates.
    const starts = nodes.findIndex((n) => (n.title ?? n.text ?? '').toLowerCase().startsWith(q.toLowerCase()));
    palIndex = linkCtx ? (starts < 0 ? 0 : starts + 1) : 0;
    palBusy = false;
    renderPalette();
  }, showError);
}
function renderPalette() {
  const q = palInput.value.trim();
  if (palMode === 'cmd') palRows = paletteRows(q.toLowerCase());
  else if (palMode === 'create') palRows = creationRows(q.toLowerCase());
  else if (palMode === 'slash') palRows = slashRows(q.toLowerCase());
  else if (palMode === 'assignees') palRows = assigneeRows(q.toLowerCase());
  else if (palMode === 'assigneesMany') palRows = manyAssigneeRows(q.toLowerCase());
  else if (palMode === 'status') palRows = statusRows(q.toLowerCase());
  else if (palMode === 'visibility') palRows = visibilityRows(q.toLowerCase());
  else if (palMode === 'visibilityPeople') palRows = visibilityPeopleRows(q.toLowerCase());
  else if (palMode === 'hidden') palRows = hiddenRows(q);
  else if (palMode === 'pill') palRows = pillRows(q.toLowerCase());
  palIndex = Math.max(0, Math.min(palIndex, palRows.length - 1));
  const els = [];
  palRows.forEach((r, i) => {
    if (r.group && (!i || palRows[i - 1].group !== r.group)) { const h = document.createElement('div'); h.className = 'group'; h.textContent = r.group; els.push(h); }
    const row = document.createElement('div'); row.className = 'row' + (i === palIndex ? ' active' : '') + (r.disabled ? ' disabled' : ''); row.dataset.index = i;
    const icon = document.createElement('span'); icon.className = 'ricon' + (r.node ? ' ' + (r.svg ? 'custom' : r.icon || 'dot') : r.svg ? ' custom' : ''); icon.innerHTML = r.svg || (r.icon ? iconSvg(r.icon) : '');
    const rowHue = r.node ? r.node.hue : r.hue; // documents and "Create new…" type choices both carry the type hue
    if (!r.svg && rowHue != null) { icon.classList.add('hue'); icon.style.setProperty('--hue', String(rowHue)); }
    const label = document.createElement('span'); label.className = 'label'; label.textContent = r.label;
    for (const t of r.tags || []) label.append(chipEl(t, r.node && r.node.hue));
    blurSensitive(label, r.node && r.node.id);
    row.append(icon, label);
    if (r.right) { const s = document.createElement('span'); s.className = 'ricon right'; s.innerHTML = iconSvg(r.right); row.append(s); }
    if (r.kbd) { const k = document.createElement('kbd'); k.textContent = r.kbd; row.append(k); }
    if (r.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = r.hint; blurSensitive(h, r.node && r.node.id); row.append(h); }
    row.onmousedown = (e) => e.preventDefault();
    row.onclick = () => runRow(r);
    els.push(row);
  });
  if (!palRows.some((r) => palMode === 'cmd' || palMode === 'slash' || palMode === 'hidden' || r.node) && (palMode === 'cmd' || palMode === 'slash' || (q && !palBusy))) { const n = document.createElement('div'); n.className = 'group'; n.textContent = 'No results'; els.push(n); }
  palList.replaceChildren(...els);
  const active = palList.querySelector('.row.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
// opens the palette in mode, closes it when already open in that mode; opening one mode closes the other.
// link = @ linking context; pin = relationship pin context. Both reuse search results.
function togglePalette(mode, link, pin) {
  const show = palette.hidden || palMode !== mode || !!link || !!pin;
  cancelLink(); pinCtx = null; pillCtx = null;
  palette.hidden = !show;
  if (!show) { clearTimeout(palTimer); palTimer = null; return returnFocus(); }
  if (!palReturn) palReturn = focused(); // switching modes keeps the original return target
  linkCtx = link || null;
  pinCtx = pin || null;
  if (mode !== 'slash') slashCtx = null;
  palMode = mode; palRows = []; palIndex = 0; palBusy = false; clearTimeout(palTimer); palTimer = null;
  if (mode === 'cmd') { palDoc = currentDoc(); palTaskCtx = null; loadPins(); }
  palInput.placeholder = mode === 'search' ? 'Search Tana' : mode === 'slash' ? 'Choose a block type or create' : 'Search or run a command';
  palInput.value = link ? link.text : '';
  if (mode === 'search') searchNow(); else renderPalette();
  palInput.focus();
}
function closePalette() { palette.hidden = true; clearTimeout(palTimer); palTimer = null; cancelLink(); pinCtx = null; pillCtx = null; returnFocus(); }
// back to the node that had the caret when the palette opened (the @ link path places its own caret)
function returnFocus() { const r = palReturn; palReturn = null; if (r && !focused()) placeCaret(r.key, r.offset); }
function runRow(r) { if (!r || r.disabled) return; if (!r.keepOpen) closePalette(); r.run(); }
// Up/Down step over rows that cannot run (info lines, unavailable choices) so the keyboard never lands on a dead row
function nextPalIndex(rows, index, step) {
  const n = rows.length;
  for (let i = 1; i <= n; i++) { const next = ((index + step * i) % n + n) % n; if (!rows[next].disabled) return next; }
  return index;
}
palInput.addEventListener('input', () => {
  palIndex = 0;
  if (palMode === 'cmd' || palMode === 'create' || palMode === 'slash' || palMode === 'assignees' || palMode === 'assigneesMany' || palMode === 'status' || palMode === 'visibility' || palMode === 'visibilityPeople' || palMode === 'hidden' || palMode === 'pill') return renderPalette();
  if (palMode === 'spaces') { palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchSpacesNow, 150); return; }
  palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchNow, 150);
});
palInput.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backPalette(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && palRows.length) { e.preventDefault(); e.stopPropagation(); palIndex = nextPalIndex(palRows, palIndex, e.key === 'ArrowDown' ? 1 : -1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (palBusy && (palMode === 'spaces' || palMode === 'search')) return; const r = mod && linkCtx ? palRows.find((row) => row.create) : palRows[palIndex]; if (r) runRow(r); } // ⌘↩ always creates for an @ selection
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); const r = palRows[palIndex]; if (palMode === 'cmd' && r && r.id) openRecorder(r); }
});
palette.addEventListener('mousedown', (e) => { if (e.target === palette) closePalette(); });

// ---- hotkeys: Cmd+Shift+K on a Cmd+K row records a combo (localStorage "hotkeys"); the outline dispatches it ----
const KEYNAMES = { Enter: '↩', Backspace: '⌫', Tab: '⇥', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space' };
// "⌃⌥⇧⌘" + key ("M", "1", "↩"); modifiers alone while only they are pressed
function comboOf(e) {
  const mods = (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '');
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return mods;
  return mods + (/^(Key|Digit)/.test(e.code) ? e.code.slice(-1) : KEYNAMES[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key));
}
const validCombo = (c) => /[⌘⌃]/.test(c) && c.replace(/[⌃⌥⇧⌘]/g, '') !== ''; // ⌘ or ⌃ plus a key, so typing is never hijacked
const recorder = $('recorder');
let rec = null; // { row, combo }
function openRecorder(row) { rec = { row, combo: '' }; $('recTitle').textContent = row.label; recorder.hidden = false; showCombo(); }
function showCombo() {
  $('recKeys').replaceChildren(...(rec.combo.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) || []).map((s) => { const k = document.createElement('span'); k.textContent = s; return k; }));
  $('recSave').disabled = !validCombo(rec.combo);
}
function closeRecorder() { rec = null; recorder.hidden = true; renderPalette(); palInput.focus(); }
const saveHotkeys = () => localStorage.setItem('hotkeys', JSON.stringify(hotkeys));
$('recReset').onclick = () => { delete hotkeys[rec.row.id]; saveHotkeys(); closeRecorder(); };
$('recCancel').onclick = closeRecorder;
$('recSave').onclick = () => { if (validCombo(rec.combo)) { hotkeys[rec.row.id] = rec.combo; saveHotkeys(); closeRecorder(); } };
for (const b of recorder.querySelectorAll('button')) b.onmousedown = (e) => e.preventDefault(); // keep the keyboard focus where it is
document.addEventListener('keydown', (e) => { // capture: the recorder sees every key before the palette input does
  if (!rec) return;
  e.preventDefault(); e.stopPropagation();
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey; // plain keys drive the buttons (a combo needs ⌘/⌃ anyway)
  if (plain && e.key === 'Escape') return closeRecorder();
  if (plain && e.key === 'Enter') return $('recSave').click();
  if (plain && e.key === 'Backspace') return $('recReset').click();
  rec.combo = comboOf(e); showCombo();
}, true);

// ---- status ----
function authView(s) {
  const checking = s.authChecking === true, authenticated = s.authenticated === true;
  const signedOut = s.authChecking === false && s.authenticated === false;
  const unresolved = !checking && !authenticated && !signedOut;
  return { checking, authenticated, signedOut, showLogin: signedOut, showOutline: checking || authenticated || unresolved, error: checking ? null : s.error };
}
function showStatus(s) {
  const state = authView(s);
  const wasConnected = connected;
  authed = state.authenticated; authChecking = state.checking; signedOut = state.signedOut; connected = !!s.connected;
  // The first fetch of a view can run before the sync client exists and fail quietly, so the view refetches the
  // moment the connection comes up; otherwise the Library or Chats stay empty until a filter is touched.
  if (connected && !wasConnected) { taskMetaFailed.clear(); loadView(); }
  $('loginBox').hidden = !state.showLogin;
  outline.hidden = $('filtered').hidden = !state.showOutline;
  showError(state.error);
  render(); // auth/connection state drives the skeleton; a newly visible outline applies the view's opening scroll
}
$('login').onclick = () => tana.login().catch(showError);

// ---- live updates ----
tana.onChanged((docId) => {
  if (docId) { taskMetaById.delete(docId); if (typeof taskMetaFailed !== 'undefined') taskMetaFailed.delete(docId); }
  const work = [loadRoots()];
  if (docId && kids.has(docId)) work.push(reload(docId));
  if (!docId) loadPins();
  Promise.all(work).then(() => docId ? undefined : loadView()).then(render, showError); // cached roots first, then the active query wins
});
function removeStale(id) {
  invalidateNode(id); loadPins();
  loadRoots().then(render, showError);
}
function unpinStale(id) {
  invalidatePinCaches(id, false); loadPins(); render();
}
if (tana.onRemoved) tana.onRemoved(removeStale);
if (tana.onUnpinned) tana.onUnpinned(unpinStale);
tana.onStatus(showStatus);
if (tana.onSystemTheme) tana.onSystemTheme((t) => { if (themePref === 'system') applyTheme(t); }); // macOS appearance changes re-theme a running window
if (themePref === 'system') followSystem(true);
loadRoots().then(render, showError).then(loadFilters);
tana.status().then(showStatus, showError);
