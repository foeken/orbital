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
  const project = { label: 'Project', hue: 268 }; // a typed tag with the type's colour (docs/OUTLINER.md §5)
  const docs = titles.map((text, i) => ({ id: 'mockdoc' + i, text, kind: 'document', done: 0, hasChildren: true, icon: 'task', tags: [task] }));
  docs[2].tags = [task, project];
  docs[0].state = 'proposed'; // Inbox; the rest are In Progress (open) unless done
  // Completed: out of the default filter, and when it is let back in the window decides which of the two is old news
  for (const [text, closedDaysAgo] of [['Renew the data agreement', 2], ['Send the Q3 board deck', 45]]) docs.push({ id: 'mockdoc' + docs.length, text, kind: 'document', done: 1, state: 'closed', closedDaysAgo, hasChildren: true, icon: 'task', tags: [task] });
  docs.push({ id: 'mockdoc' + titles.length, text: 'Studio programme', kind: 'document', hasChildren: true, hue: 268, tags: [project] }); // typed, not a task: plain bullet tinted with the type hue
  // a space: pinned, its "content" is the documents it owns (document Nodes, not blocks)
  const spaceDocs = [
    { id: 'mockspacedoc0', text: 'Studio LT charter', kind: 'document', hasChildren: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] },
    { id: 'mockspacedoc1', text: 'Draft the LT agenda', kind: 'document', done: 0, hasChildren: true, icon: 'task', tags: [task] },
  ];
  const space = { id: 'tana:space:mock', text: 'Studio LT', kind: 'document', hasChildren: true, icon: 'space', hue: 150, tags: [{ label: 'space', color: 'grey' }] };
  // other library kinds (chats, canvases, agents, skills, saved searches): read-only rows, plain bullet + kind chip
  const kinds = ['chat', 'canvas', 'agent', 'skill', 'search'].map((k, i) => ({ id: 'tana:' + k + ':mock' + i, text: 'Sample ' + k, kind: 'document', hasChildren: true, tags: [{ label: k, color: 'grey' }] }));
  // the workspace's types (the Types view): the space each lives in is the row's subtext, 'Library' when it has none.
  // The home space is also what decides which documents can be given the type (api.docTypes below).
  const types = [['Project', space.id, 268], ['Decision Record', space.id, 150], ['Co-Worker', null, 32]]
    .map(([text, ownerUri, hue], i) => ({ id: 'tana:type:mock' + i, text, kind: 'document', hasChildren: true, hue, ownerUri,
      meta: ownerUri ? space.text : 'Library', tags: [{ label: 'type', color: 'grey' }] }));
  // The icons a type can be given: main searches 3.5k of them, the mock carries four, in the channel's shape.
  const glyph = (d) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><path d="' + d + '" fill="none" stroke="currentColor" stroke-width="var(--nucleo-stroke-width, 1.5)" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  const mockIcons = [
    { name: 'nc-rocket', label: 'rocket', tags: 'launch,ship,start', svg: glyph('M9 1.75c3 2 4.25 5 4.25 8l-4.25 4-4.25-4c0-3 1.25-6 4.25-8Z') },
    { name: 'nc-flask', label: 'flask', tags: 'lab,experiment,science', svg: glyph('M7.25 1.75v4.5l-3.5 7a1 1 0 0 0 .9 1.5h8.7a1 1 0 0 0 .9-1.5l-3.5-7v-4.5') },
    { name: 'nc-book', label: 'book', tags: 'read,note,library', svg: glyph('M3.75 3.25h4.5a1 1 0 0 1 1 1v10.5a1 1 0 0 0-1-1h-4.5Zm10.5 0h-4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 1 1-1h4.5Z') },
    { name: 'nc-user-key', label: 'user-key', tags: 'person,account,access', svg: glyph('M9 7.25a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Zm-6 9v-1.5a4.5 4.5 0 0 1 4.5-4.5h3') },
  ];
  const typeIconChoices = {}; // type uri -> icon name, the app-local choice main keeps in SQLite
  // chats (api.chats): newest first; "MCP: …" ones carry meta 'MCP' and are hidden from every list and search while
  // the Cmd+K switch is on (mcpOff below; the per-view includeMcp filter is still gone, #247)
  const chats = ['Draft the Studio memo', 'MCP: list open tasks', 'Summarise the leadership notes', 'MCP: create meeting note', 'Rewrite the agreement clause']
    .map((text, i) => ({ id: 'tana:chat:mockchat' + i, text, kind: 'document', hasChildren: true, tags: [{ label: 'chat', color: 'grey' }], meta: /^MCP:/.test(text) ? 'MCP' : undefined }));
  let mcpOff = false; // the app-local switch, off every launch of the mock
  // meetings over the past and next 7 days (day offset from today, start hour or null = all day); roots meta = weekday + time, search meta = weekday + day of month + time
  const dateMeta = {};
  const meetingEdits = {}; // id -> { start, end, allDay, location, participants, attendees }: what Change time / location / Add attendee edit
  const meetings = [['Last week retro', -6, 10], ['Board prep', -2, 14], ['Leadership sync', 0, 9], ['Platform Guild', 0, 13], ['1-1 with Sam', 1, 11], ['Offsite', 3, null]].map(([text, off, h], i) => {
    const d = new Date(); d.setDate(d.getDate() + off);
    const time = h == null ? ', all day' : ' ' + h + ':00–' + (h + 1) + ':00';
    dateMeta['mockmeeting' + i] = WD[d.getDay()] + ' ' + d.getDate() + time;
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h ?? 0).getTime();
    meetingEdits['mockmeeting' + i] = { start, end: start + (h == null ? 864e5 : 36e5), allDay: h == null, location: i === 2 ? 'Room 4.12' : '', participants: ['tana:user-profile:robin'], attendees: [] };
    return { id: 'mockmeeting' + i, text, meta: WD[d.getDay()] + time, kind: 'document', hasChildren: true, icon: 'meeting', tags: [meeting] };
  });
  // Meetings, Chats and People are no longer views. Their documents remain — the Library lists every kind, and a
  // saved search can name any subset of them — so only the pages are gone, not the content they used to show.
  const views = [{ id: 'inbox', title: 'Inbox', icon: 'inbox', nodes: [] }, { id: 'library', title: 'Library', icon: 'library', nodes: docs }, { id: 'types', title: 'Types', icon: 'type', nodes: types }];
  const all = [...docs, ...meetings, ...spaceDocs, space, ...kinds, ...chats, ...types];
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
    library: { types: ['tasks'], states: ['proposed', 'open', 'closed', 'not_now'], assignee: 'anyone', text: '', completedWithin: 3 },
    types: { types: ['types'], states: null, assignee: 'anyone', text: '' },
  };
  const stateOf = (d) => d.state || (d.done == null ? null : d.done ? 'closed' : 'open');
  // main applies the completed window to what the graph answers (sdk/query.js); the mock has no graph, so it ages
  // its own two completed rows the same way — 2 days and 45 days old, so each choice shows something different.
  const inWindow = (d, f) => stateOf(d) !== 'closed' || completedWindow(f) === 'all' || (d.closedDaysAgo || 0) <= completedWindow(f);
  const listed = (d, f) => (!f.states || f.states.includes(stateOf(d))) && inWindow(d, f) && (!f.assignee || f.assignee === 'me' || f.assignee === 'anyone');
  const kindOf = (d) => (d.icon === 'member' ? 'people' : d.icon === 'task' ? 'tasks' : d.icon === 'meeting' ? 'meetings' : d.tags && ['chat', 'canvas', 'agent', 'skill', 'search', 'type'].includes(d.tags[0].label) ? d.tags[0].label + 's' : 'docs');
  const created = {};   // documents made with createDocument
  const searchQueries = {}; // saved search id -> the filter its stored query holds
  const notifyChoices = {}; // doc id -> an explicit watch choice; absent means the default rule decides
  const settling = new Set(); // a brand-new document: the first taskMeta read fails while main is still subscribing it
  const unlisted = [];  // created tasks/meetings the roots "query" has not caught up with yet: listed after the next refresh()
  const sidebar = ['mockdoc2', 'mockmeeting2', space.id], datePins = { mockdoc2: [localDate()] }; // pins: sidebar order, personal date pins per doc
  const hubPins = {}; // hub id -> the documents pinned on that meeting or space, which is where the real list lives too
  // Typed fields, so the page under the title can be tried without the main process: one holds two lines, because
  // a field holds what a node holds and the second line is the part that used to be invisible.
  // A field value is an outline like any other, kept under the id the page asks for it by ("<doc>|<field>"), so the
  // mock needs no field editor of its own either: children, setText, indent and the rest already work by id.
  const FIELD_KEY = 'tana:type:mock?attribute=n5e1hgxz';
  // An options field and a link field too (renderer/fields.js), defined on the Project type so its page lists them.
  const mockDefs = { 'tana:type:mock0': [
    { key: 'lvl00001', title: 'Level', type: 'options', options: [{ label: 'High' }, { label: 'Medium' }, { label: 'Low' }] },
    { key: 'src00001', title: 'Sources', type: 'link', cardinality: 'multiple', to: [{ uri: 'tana:type:mock1', name: 'Decision Record' }] },
  ] };
  const mockFields = (docId) => (docId === 'mockdoc1' ? [{ key: FIELD_KEY, label: 'Discuss with', text: 'Stan Engbers', segments: [{ text: 'Stan Engbers' }] },
    ...mockDefs['tana:type:mock0'].map((d) => ({ key: 'tana:type:mock0?attribute=' + d.key, label: d.title, text: '', lines: [], type: d.type, cardinality: d.cardinality, options: d.options, to: d.to }))] : []);
  const content = Object.fromEntries(all.map((d, i) => [d.id, [
    block('Context', [], 2),
    block('First point about task ' + i, [block('Detail A'), block('Detail B', [block('Deeper detail')])]),
    // main resolves an inline mention's target in the same batch the rows use and hands back its icon (main/documents.js)
    block([{ text: 'Discuss with ' }, { mention: { label: 'Sam Okafor', uri: 'tana:user-profile:sam', icon: 'member' } }, { text: ' and see ' }, { mention: { label: titles[2], uri: 'mockdoc2', icon: 'task' } }]),
    // a line that is only a mention: Tana's full-reference presentation, so the row shows (and checks off) that task
    block([{ mention: { label: 'Stale label', uri: 'mockdoc1' } }]),
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
  // Tana's notifications inbox as main/inbox.js hands it over: the page's rows, already phrased, newest first. The three
  // writes answer with the unread count and tell onInbox, which is what the inbox's live change does in main.
  const INBOX = 'orbital:notifications', inboxCbs = [];
  const note = (id, hours, segments, type, sourceUri, unread) => ({ id, text: segments.map((s) => s.text).join(''), kind: 'block', block: 'bullet', editable: false, unread, segments, hasChildren: false, children: [],
    createdAt: new Date(Date.now() - hours * 36e5).toISOString(), notification: { type, sourceUri, threadUri: null } });
  const strong = (text) => ({ text, marks: { bold: true } });
  content[INBOX] = [
    note('mocknote0', 0.3, [strong('Sam Okafor'), { text: ' assigned you to a task' }, { text: '. ' + docs[1].text.replace(/[.!?]+$/, '') + '.' }], 'task-assignment', docs[1].id, true),
    note('mocknote1', 3, [strong('Priya Raman'), { text: ' added you to ' }, strong(meetings[2].text)], 'event-access', meetings[2].id, true),
    note('mocknote2', 27, [{ text: 'You were added to ' }, strong(spaceDocs[0].text)], 'document-access', spaceDocs[0].id, false),
    note('mocknote3', 50, [strong('Tomas Ilves'), { text: ' archived ' }, strong(types[2].text)], 'type-archived', types[2].id, false),
  ];
  const inboxUnread = () => content[INBOX].filter((n) => n.unread).length;
  const tellInbox = () => { const n = inboxUnread(); setTimeout(() => inboxCbs.forEach((cb) => cb(n)), 0); return n; };
  // Tana's AI proposals as main/proposals.js hands them over: the proposed documents, read-only, each carrying where it
  // was proposed. Approving or rejecting one takes it off the page; the update is Tana's to approve, as in main.
  const PROPOSALS = 'orbital:proposals';
  const proposed = (d, hours, operation, where, group) => ({ ...d, id: 'mockproposal' + (++seq), proposal: { chatUri: 'tana:chat:mock', proposedUri: 'mockproposal' + seq, operation, group,
    approvable: operation === 'create', reason: operation === 'create' ? null : 'Tana merges this change itself: approve it in Tana',
    note: (operation === 'create' ? 'Proposed' : 'Change proposed') + ' in ' + where + (operation === 'create' ? '' : ' · approve in Tana'), proposedAt: new Date(Date.now() - hours * 36e5).toISOString() } });
  content[PROPOSALS] = [proposed(docs[2], 1, 'create', meetings[1].text, 'mine'), proposed(docs[3], 5, 'create', meetings[3].text, 'others'),
    proposed(spaceDocs[0], 30, 'update', 'Private AI chat', 'mine')];
  { const a = proposed({ id: 'x', text: 'Sync FinOps risk update to Slite', title: 'Sync FinOps risk update to Slite', kind: 'document', icon: 'doc', hasChildren: true }, 2, 'create', 'Slite Risk Document Update', 'mine'); Object.assign(a.proposal, { action: true, systems: ['Slite'], approvable: true }); content[PROPOSALS].unshift(a); } // an action: its approve reads Send to Slite
  // The Timeline as main/timeline.js hands it over: one row per event, newest first, the node it is about in timeline.uri
  const at = (hours) => new Date(Date.now() - hours * 36e5).toISOString();
  const event = (key, hours, tone, icon, segments, note, unread, uri, children = []) => ({ id: 'orbital:timeline:' + key, text: segments.map((x) => x.text).join(''), segments, kind: 'block', block: 'bullet', icon, editable: false,
    hasChildren: children.length > 0, children, unread, createdAt: at(hours), timeline: { uri, note, tone } });
  const bold = (text) => ({ text, marks: { bold: true } });
  const tlTask = (d) => ({ ...d, editable: false, checkable: true });
  content['orbital:timeline'] = [
    event('group1', 0.1, 'new', 'robot', [{ text: 'An AI agent added 4 tasks to your Inbox' }], null, true, null, [tlTask(docs[1]), tlTask(docs[3]), tlTask(spaceDocs[0]), tlTask(docs[4])]),
    event('done1', 1, 'done', 'apply', [{ text: 'Priya Raman ' }, bold('completed'), { text: ' ' }, { text: docs[2].text, marks: { strike: true } }], null, true, docs[2].id),
    event('start1', 1.1, 'accepted', 'tlAccepted', [{ text: 'Tomas Ilves ' }, bold('accepted'), { text: ' ' + docs[5].text }], null, false, docs[5].id),
    { ...event('edit1', 1.3, 'edit', 'updated', [{ text: 'Sam Okafor ' }, bold('edited'), { text: ' ' + docs[0].text }], null, false, docs[0].id), timeline: { uri: docs[0].id, note: null, tone: 'edit', change: 'Description added for Christmas activities proposed by Nadia', detail: 'Nadia proposed extending Healthcare\'s Christmas activities, such as karaoke and games, across Nedap to replace separate business unit programmes.' } },
    { ...event('edit2', 2, 'edit', 'updated', [{ text: 'Priya Raman ' }, bold('edited'), { text: ' ' + docs[6].text }], null, false, docs[6].id), timeline: { uri: docs[6].id, note: null, tone: 'edit', change: 'Changed the deadline from Friday to Wednesday' } },
    event('group2', 2.4, 'new', 'tlNew', [{ text: 'Tomas Ilves added a task to your Inbox' }], null, false, null, [tlTask(docs[7])]),
    event('done2', 26, 'done', 'apply', [{ text: 'Sam Okafor ' }, bold('completed'), { text: ' ' }, { text: docs[0].text, marks: { strike: true } }], 'Task completed and a note added about the deadline', false, docs[0].id),
    event('group3', 26.5, 'new', 'tana', [{ text: "Tana's AI added a task to your Inbox" }], null, false, null, [tlTask(docs[9])]),
    event('later1', 27, 'quiet', 'tlLater', [{ text: 'Tomas Ilves ' }, bold('moved to Later'), { text: ' ' + docs[8].text }], null, false, docs[8].id)];
  // an image block (not editable; api.image resolves its uri to a data URL): a 2x2 PNG scaled by width/height
  content.mockdoc0.splice(2, 0, { id: 'img' + (++seq), kind: 'block', type: 'image', image: { uri: 'tana:image:mock', alt: 'Mock image', width: 160, height: 100 }, hasChildren: false, children: [] });
  // inline references (embeds): read-only nodes rendering the target's title/state, like sdk/content.js (editable: false) with main resolving reference.node
  content.mockdoc0.unshift({ id: 'ref' + (++seq), kind: 'block', type: 'reference', editable: false, reference: { uri: 'mockdoc9' }, hasChildren: false, children: [] });
  content.mockdoc0.splice(1, 0, { id: 'ref' + (++seq), kind: 'block', type: 'reference', editable: false, reference: { uri: 'tana:user-profile:sam' }, hasChildren: false, children: [] });
  // a table block, in the shape sdk/content.js reads one: the row is read-only, its cells edit through api.setCell
  const cell = (text, header) => ({ id: 'cell' + (++seq), header: !!header, colspan: 1, rowspan: 1, colwidth: null, paragraph: 'cp' + seq, segments: text ? [{ text }] : [], text, blocks: [] });
  const grid = [[cell('Owner', true), cell('Status', true)], [cell('Robin'), cell('Open')], [cell('Sam'), cell('')]];
  content.mockdoc0.push({ id: 'tbl' + (++seq), kind: 'block', block: 'paragraph', type: 'table', editable: false, text: '', table: { id: 'tbl' + seq, rows: grid, rowCount: 3, columnCount: 2 }, hasChildren: false, children: [] });
  // the values of the mock's options and link fields, one line each; the second link points at a type the field does not list
  content['mockdoc1|tana:type:mock0?attribute=lvl00001'] = [block('Medium'), block('Urgent')];
  content['mockdoc1|tana:type:mock0?attribute=src00001'] = [block([{ mention: { label: 'Decision log', uri: 'mockdoc3', type: 'tana:type:mock1' } }]), block([{ mention: { label: 'Studio LT charter', uri: 'mockspacedoc0', type: 'tana:type:mock2' } }])];
  // a conversation in the shape sdk/chat.js chatRows makes, which renderer/chat.js draws as bubbles
  const chatPart = (id, p) => { const [, bullet] = /^- (.*)$/.exec(p) || []; return { id, text: bullet ?? p, kind: 'block', editable: false, block: bullet ? 'bullet' : 'paragraph', segments: typeof p === 'string' ? [{ text: bullet ?? p }] : p, hasChildren: false, children: [] }; };
  const chatMsg = (mine, parts, minsAgo, notes = []) => {
    const id = 'm' + (++seq), who = mine ? 'Robin Vega' : 'Tana AI';
    const children = [...notes.map((t, j) => ({ ...chatPart(id + '.t' + j, t), note: true, thought: /^Thought for/.test(t) })), ...parts.map((p, j) => (p && p.reference ? { id: id + '.a' + j, kind: 'block', type: 'reference', editable: false, reference: p.reference, hasChildren: false, children: [], ...(p.sub ? { sub: true } : {}) }
      : p && p.proposal ? { id: id + '.p' + j, kind: 'block', text: '', segments: [], editable: false, hasChildren: false, children: [], proposal: p.proposal } : chatPart(id + '.b' + j, p)))];
    return { id, text: who, kind: 'block', editable: false, segments: [{ text: who }], block: 'heading3', heading: 3, chat: { id, mine, author: mine ? 'tana:user-profile:robin' : 'ai', sentAt: Date.now() - minsAgo * 6e4 }, hasChildren: true, children };
  };
  content['tana:chat:mockchat0'] = [
    chatMsg(true, ['Can you draft the Studio memo for Monday?'], 26 * 60),
    chatMsg(false, ['Here is a first draft, based on the leadership notes:', '- Studio becomes a way of working, not an entity', '- Two pilots start in October', '- We review both at the offsite', { reference: { uri: 'mockdoc0', label: 'Studio memo (draft)' } }, { reference: { uri: 'tana:chat:mockchat1', label: 'Subagent: Tana help' }, sub: true },
      { proposal: { chatUri: 'tana:chat:mockchat0', proposedUri: 'tana:action:mock', target: 'tana:action:mock', operation: 'create', metadata: { type: 'action' }, state: 'pending', title: 'Sync FinOps risk update to Slite', approvable: true, systems: ['Slite'] } },
      { proposal: { chatUri: 'tana:chat:mockchat0', proposedUri: 'mockdoc0', target: 'mockdoc0', operation: 'create', metadata: {}, state: 'approved', title: 'Studio memo (draft)', icon: 'doc', approvable: false } }], 26 * 60 - 1, ['Thought for 14 seconds']),
    chatMsg(true, ['Make it shorter'], 25 * 60),
    chatMsg(true, ['and a bit friendlier'], 25 * 60 - 1),
    chatMsg(false, ['Done: three short paragraphs, and a warmer opening.'], 25 * 60 - 2),
    chatMsg(true, ['Perfect, thanks!'], 6),
    chatMsg(false, [[{ text: 'Happy to help. Shall I pin it to ' }, { mention: { label: 'Leadership sync', uri: 'mockmeeting2' } }, { text: '?' }]], 5),
  ];
  // a chat where Tana waits on two questions (sdk/chat.js pendingQuestions): the card takes the composer's place
  const asking = chatMsg(false, ['Before I rewrite the clause, two quick questions.'], 3, ['Waiting for your input']);
  asking.chat.questions = { messageId: asking.chat.id, items: [
    { id: 'q1', question: 'Which version of the agreement should I start from?', multiSelect: false, options: [{ label: 'The signed 2025 version (Recommended)' }, { label: 'The draft Sam shared last week' }, { label: 'Start fresh' }] },
    { id: 'q2', question: 'What should the new clause cover?', multiSelect: true, options: [{ label: 'Data retention', description: 'how long we keep it' }, { label: 'Sub-processors' }, { label: 'Breach notification' }] },
  ] };
  content['tana:chat:mockchat4'] = [chatMsg(true, ['Can you rewrite the data clause in the agreement?'], 4), asking];
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPoyroWu7WKIX9dU1fWNQAuWQbA8sXmUwAAAABJRU5ErkJggg==';
  const agentAsks = {}; // chatId -> [{ messageId, at }] (askAgent)
  const changed = [], removed = [], statusCbs = [], deleted = new Map(), sensitive = new Set(), codexAssigned = new Set(), codexPrompts = new Map();
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
    deleted.set(docId, { doc: all[i], at: new Date().toISOString(), content: content[docId], views: views.map((view) => ({ view, index: view.nodes.findIndex((node) => node.id === docId) })).filter((entry) => entry.index >= 0) });
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
      return { nodes: [...all, ...members].filter((d) => (!filter.types ? !['people', 'types'].includes(kindOf(d)) : filter.types.includes(kindOf(d)) || (d.tags || []).some((t) => t && filter.types.includes(t.uri)))
        && (!filter.states || (filter.types && !filter.types.includes('tasks')) || listed(d, filter)) // a state only filters tasks (sdk/query.js)
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
    // main/views.js myTasks: the search of that name, made on the Library's filter the first time
    myTasks: async () => { const n = all.find((d) => d.text === 'My Tasks' && d.id.startsWith('tana:search:')); if (n) return info(n); const made = { id: 'tana:search:mockmytasks', text: 'My Tasks', kind: 'document', hasChildren: true, editable: true, tags: [{ label: 'search', color: 'grey' }] }; created[made.id] = made; content[made.id] = []; all.push(made); searchQueries[made.id] = { filter: structuredClone(filters.library) }; return info(made); },
    // A saved search's stored query as the filter the pills speak, and back. The real channel translates through
    // sdk/query; the mock keeps the filter as it was given, since what it has to match is the channel's shape, not
    // the document's. A sample search that predates any save opens on the Library's filter rather than on nothing.
    searchFilter: async (id) => structuredClone(searchQueries[id] || { filter: filters.library }),
    setSearchFilter: async (id, filter, sort, group, display) => structuredClone(searchQueries[id] = { filter, sort, group, display }),
    // the rows a staged filter would find: the same selection viewList makes, so editing the pills moves the list
    searchPreview: async (filter) => {
      const text = String(filter.text || '').trim().toLowerCase();
      return structuredClone([...all, ...members].filter((d) => (!filter.types ? kindOf(d) !== 'people' : filter.types.includes(kindOf(d)) || (d.tags || []).some((t) => t && filter.types.includes(t.uri)))
        && (!filter.states || listed(d, filter))
        && d.text.toLowerCase().includes(text)).map(info));
    },
    // references resolve on read, as main does: the row always shows the target's current title and state, and a
    // block whose whole content is one mention is resolved the same way
    children: async (docId) => structuredClone(content[docId] || []).map((n) => {
      const one = n.type !== 'reference' && !n.children?.length && n.segments?.length === 1 && n.segments[0].mention;
      const ref = n.type === 'reference' ? n.reference : one ? { uri: one.uri, label: one.label } : null;
      const target = ref && [...all, ...members].find((d) => d.id === ref.uri);
      return target ? { ...n, reference: { ...ref, node: info(target) } } : n;
    }),
    node: async (docId) => {
      const d = [...all, ...members].find((x) => x.id === docId);
      if (d) return info(d);
      if (created[docId]) return created[docId];
      throw new Error('unknown document ' + docId);
    },
    members: async () => members.map(info),
    // a meeting's time, place and people (main/meetings.js): every mock meeting is one the mock user organises
    meetingInfo: async (docId) => {
      if (!meetingEdits[docId]) throw new Error('Not a meeting');
      return structuredClone({ id: docId, editable: true, ...meetingEdits[docId] });
    },
    editMeeting: async (docId, change) => {
      const m = meetingEdits[docId], d = all.find((x) => x.id === docId);
      if (!m) throw new Error('Not a meeting');
      if ('start' in change) { Object.assign(m, { start: change.start, end: change.end, allDay: false }); const s = new Date(change.start), hm = (t) => new Date(t).toTimeString().slice(0, 5); d.meta = WD[s.getDay()] + ' ' + hm(change.start) + '–' + hm(change.end); }
      if ('location' in change) m.location = change.location;
      for (const p of change.attendees || []) {
        m.attendees.push({ key: p.email ? 'email:' + p.email.toLowerCase() : 'tana:mock' + (++seq), email: p.email, identityUri: p.email ? undefined : p.userUri });
        if (p.userUri && !m.participants.includes(p.userUri)) m.participants.push(p.userUri);
      }
      emit(docId);
      return structuredClone({ id: docId, editable: true, ...m });
    },
    attendeeSuggestions: async () => [
      { email: 'sam@example.com', displayName: 'Sam Okafor', eventCount: 31, identityUri: 'tana:user-profile:sam' },
      { email: 'dana@partner.example', displayName: 'Dana Brooks', eventCount: 4 },
    ],
    // relationships of a node (main.js related): pinned edges, task outcomes and note documents
    related: async (docId) => {
      const doc = all.find((d) => d.id === docId);
      // anything that is not a meeting still has backlinks: one mock document mentions it
      const mentions = all.filter((d) => d.icon === 'doc' && d.id !== docId).slice(0, 1).map(info);
      if (!doc || doc.icon !== 'meeting') return { fields: mockFields(docId), definitions: mockDefs[docId] && structuredClone(mockDefs[docId]), pinned: [], outcomes: [], notes: [], backlinks: mentions.length ? [{ label: 'Mentioned in', rows: mentions }] : [] };
      const pick = (n) => n && info(n);
      return {
        summary: 'Mock meeting summary for ' + doc.text,
        call: { url: 'https://meet.google.com/klm-nopq-rst', label: 'meet.google.com/klm-nopq-rst' },
        pinned: [pick(all.find((d) => d.icon === 'doc')), pick(all.find((d) => d.icon === 'task'))].filter(Boolean),
        outcomes: all.filter((d) => d.icon === 'task').slice(1, 3).map(info),
        notes: [pick(all.find((d) => d.icon === 'doc' && d.text))].filter(Boolean),
        backlinks: mentions.length ? [{ label: 'Mentioned in', rows: mentions }] : [],
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
      const meta = structuredClone(taskDetails.get(docId) || { assignees: [], restricted: undefined, participants: [], audience: 'unknown' });
      const people = meta.restricted ? meta.participants.map((p) => p.uri) : meta.audience === 'everyone' ? members.map((m) => m.id) : null; // main names the audience's people (sdk/node.js)
      return { ...meta, ...(people ? { people } : {}), watched: !!notifyChoices[docId] };
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
      return [...all, ...members].filter((d) => d.text.toLowerCase().includes(text) && tokens.every((t) => hit(d, t)) && !(mcpOff && /^MCP:/.test(d.text))).slice(0, 20).map((d) => ({ ...info(d), meta: dateMeta[d.id] || d.meta }));
    },
    mcpHidden: async () => mcpOff,
    setMcpHidden: async (on) => { mcpOff = !!on; emit(null); return mcpOff; },
    setOpenAIKey: async (key) => { if (!String(key || '').trim()) throw new Error('OpenAI API key cannot be empty'); return true; },
    // Set type: the mock keeps main's two rules so the page behaves the same without the main process — a type that
    // lives in a space fits only a document in that space, a Library type fits anything (main/documents.js).
    // fields that hold choices or links (main/documents.js setField, defineField, addTypeField), without Tana's checks
    setField: async (docId, key, lines) => mut(docId, () => { content[docId + '|' + key] = lines.map((line) => block(line)); emit(docId); }),
    defineField: async (typeUri, attribute, change) => {
      const d = (mockDefs[typeUri] || []).find((x) => x.key === attribute);
      if (!d) throw new Error('no field ' + attribute + ' on this type');
      if ('type' in change && (change.type || undefined) !== d.type) { if (change.type) d.type = change.type; else delete d.type; if (d.type === 'options') d.options = []; else delete d.options; delete d.to; }
      if (change.cardinality) d.cardinality = change.cardinality;
      if (change.options) d.options = change.options.map((label) => ({ label }));
      if (change.to) d.to = change.to.map((t) => ({ ...t, name: (types.find((x) => x.id === t.uri) || {}).text }));
      return structuredClone(d);
    },
    addField: async (typeUri, def) => { (mockDefs[typeUri] ||= []).push({ key: 'fld' + (++seq), ...def, ...(def.type === 'options' ? { options: [] } : {}) }); },
    typeList: async () => types.map((t) => ({ uri: t.id, title: t.text, hue: t.hue })),
    docTypes: async (docId) => {
      const doc = all.find((d) => d.id === docId);
      if (!doc) throw new Error('unknown document');
      const home = spaceDocs.some((d) => d.id === docId) ? space.id : null;
      return structuredClone({
        current: (doc.tags || []).map((t) => t.uri).find(Boolean) || null,
        options: types.map((t) => ({ uri: t.id, title: t.text, hue: t.hue, selectable: !t.ownerUri || t.ownerUri === home,
          reason: !t.ownerUri || t.ownerUri === home ? undefined : 'Lives in ' + space.text })),
      });
    },
    setType: async (docId, typeUri) => {
      const doc = all.find((d) => d.id === docId);
      if (!doc) throw new Error('unknown document');
      const type = typeUri ? types.find((t) => t.id === typeUri) : null;
      if (typeUri && !type) throw new Error('Select a workspace type');
      const kindTags = (doc.tags || []).filter((t) => t && ['task', 'meeting'].includes(t.label));
      doc.tags = type ? [...kindTags, { label: type.text, hue: type.hue, uri: type.id }] : kindTags.length ? kindTags : [{ label: 'doc', color: 'grey' }];
      doc.hue = type ? type.hue : undefined;
      emit(docId);
      return typeUri || null;
    },
    // The model's read of a title, slow enough to show the page thinking: the last capitalised words of the title.
    // Presence: nobody else here in the mock, and nothing to tell
    presenceOpen: async () => true, presenceClose: async () => {}, presenceView: async () => {}, presenceSet: async () => {}, onPresence: () => {},
    // The sidebar's live edges: nothing else writes to the mock, so nothing is ever pushed
    relatedWatch: async () => true, onRelatedChanged: () => {},
    suggestDiscussWith: async (title) => {
      await new Promise((done) => setTimeout(done, 700));
      const names = String(title || '').match(/\b[A-Z][a-z]+(?: [A-Z][a-z]+)*/g) || [];
      return names.length ? names.slice(-2).join(' and ') : null;
    },
    // The model behind Classify type: sure of a type whose name the title says, unsure (and leaning to none) otherwise.
    classifyType: async (docId) => {
      await new Promise((done) => setTimeout(done, 700));
      const doc = all.find((d) => d.id === docId);
      if (!doc) throw new Error('unknown document');
      const title = String(doc.text || '').toLowerCase(), named = types.find((t) => title.includes(t.text.toLowerCase()));
      const choices = [...types.map((t) => ({ uri: t.id, title: t.text, hue: t.hue, p: named ? (t === named ? 0.9 : 0.05 / types.length) : 0.6 / types.length })),
        { uri: null, title: 'No type', p: named ? 0.05 : 0.4 }];
      return { current: (doc.tags || []).map((t) => t.uri).find(Boolean) || null, choices: choices.sort((a, b) => b.p - a.p) };
    },
    // "Discuss with …": the Discussion Task type, invented the first time it is asked for the way main creates it
    // in the Library, and worn by the document. The mock keeps no field values, so only the type shows here.
    discussWith: async (docId, who) => {
      const doc = all.find((d) => d.id === docId);
      if (!doc) throw new Error('unknown document');
      if (!String(who || '').trim()) throw new Error('Who should this be discussed with?');
      let type = types.find((t) => t.text === 'Discussion Task');
      if (!type) { type = { id: 'mocktype' + types.length, text: 'Discussion Task', hue: 200 }; types.push(type); }
      doc.tags = [...(doc.tags || []).filter((t) => t && ['task', 'meeting'].includes(t.label)), { label: type.text, hue: type.hue, uri: type.id }];
      doc.hue = type.hue;
      emit(docId);
      return { typeUri: type.id, key: type.id + '?attribute=discusswith', who: who.trim() };
    },
    // Set icon: four glyphs instead of the 3500 main holds, enough to drive the page without the main process.
    // The shape is the channel's — { name, label, svg }, and { uri, … } for the ones a type is wearing.
    searchIcons: async (query) => {
      const q = String(query || '').trim().toLowerCase();
      return structuredClone(mockIcons.filter((i) => !q || i.label.includes(q) || i.tags.includes(q)).map(({ tags, ...icon }) => icon));
    },
    typeIcons: async () => structuredClone(Object.entries(typeIconChoices).map(([uri, name]) => ({ uri, ...mockIcons.find((i) => i.name === name) }))),
    setTypeIcon: async (typeUri, name) => {
      if (!types.some((t) => t.id === typeUri)) throw new Error('Icons are set on a type');
      const icon = name ? mockIcons.find((i) => i.name === name) : null;
      if (name && !icon) throw new Error('No icon called ' + name);
      if (icon) typeIconChoices[typeUri] = icon.name; else delete typeIconChoices[typeUri];
      const type = types.find((t) => t.id === typeUri);
      type.icon = icon ? icon.name : undefined;
      for (const d of all) if ((d.tags || []).some((t) => t.uri === typeUri)) d.icon = icon ? icon.name : 'type';
      emit(null);
      return icon ? structuredClone({ uri: typeUri, ...icon }) : null;
    },
    // Set colour: this app's own hue for the type (a setting), so the type and everything wearing it change together.
    setTypeHue: async (typeUri, hue) => {
      const type = types.find((t) => t.id === typeUri);
      if (!type) throw new Error('Colours are set on a type');
      if (hue !== null && hue !== 'grey' && (!Number.isInteger(hue) || hue < 0 || hue > 360)) throw new Error('A hue is 0-360, or grey');
      type.hue = hue === null || hue === 'grey' ? undefined : hue; // the mock has no Tana colour underneath to fall back to
      for (const d of all) for (const t of d.tags || []) if (t.uri === typeUri) { t.hue = type.hue; d.hue = type.hue; }
      emit(null);
      return hue;
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
    // a message goes in at once; Tana's answer follows a moment later, the way live updates bring it
    // mentions come back as chips and a skill as its attachment, the way sdk/chat.js reads what main stored
    chatAnswers: async () => ({ ai: true, canWrite: true }), // every mock chat is yours alone
    // answered or skipped: the questions stop waiting, and Tana goes on
    answerChat: async (docId, messageId, answers) => {
      const m = (content[docId] || []).find((r) => r.chat && r.chat.id === messageId);
      if (!m || !m.chat.questions) throw new Error('These questions are no longer waiting for an answer');
      delete m.chat.questions; emit(docId);
      const said = answers ? Object.values(answers).map((a) => [...a.selected, a.custom].filter(Boolean).join(', ')).join('; ') : 'sensible defaults';
      setTimeout(() => { content[docId].push(chatMsg(false, ['Thanks. Going with: ' + said + '.'], 0, ['Thought for 3 seconds'])); emit(docId); }, 1200);
      return { messageId: 'relay', responding: true };
    },
    inviteToChat: async (docId, uri) => {
      const name = (members.find((m) => m.id === uri) || {}).text || 'Someone';
      const line = (text) => ({ id: 'st' + (++seq), text, kind: 'block', editable: false, segments: [{ text }], hasChildren: false, children: [], chat: { id: 'st' + seq, status: true, author: uri } });
      (content[docId] ||= []).push(line(name + ' was added to the chat.'), line('This chat now has multiple participants. Mention @Tana to trigger AI.'));
      emit(docId);
      return { name };
    },
    sendChat: async (docId, text, attachments = [], opts = {}) => {
      const segs = (p) => p.split(/(\[[^\]\n]*\]\([^)\s]+\))/).filter(Boolean).map((t) => { const m = /^\[(.*)\]\((.+)\)$/.exec(t); return m ? { mention: { label: m[1], uri: m[2] } } : { text: t }; });
      const sent = chatMsg(true, [...text.split(/\n{2,}/).map(segs), ...attachments.map((uri) => ({ reference: { uri, label: (all.find((d) => d.id === uri) || {}).text } }))], 0);
      (content[docId] ||= []).push(sent);
      emit(docId);
      if (opts.ai === false) return { messageId: sent.chat.id, responding: false }; // a message to the chat: nobody is asked
      setTimeout(() => { content[docId].push(chatMsg(false, ['Mock answer to: ' + text], 0, ['Thought for 2 seconds'])); emit(docId); }, 1800);
      return { messageId: sent.chat.id, responding: true }; // main answers replyError beside a saved message when the reply could not be asked for
    },
    // @Codex (main/chatagents.js): the question is a message to the chat; the answer is local, here after two and a half seconds
    chatAgents: async () => [{ id: 'codex', label: 'Codex', icon: 'robot' }],
    askAgent: async function (docId, agent, text) { const sent = await this.sendChat(docId, text, [], { ai: false }); (agentAsks[docId] ||= []).push({ messageId: sent.messageId, at: Date.now() }); return { messageId: sent.messageId }; },
    openAgentAsk: async (docId, messageId) => (agentAsks[docId] || []).some((a) => a.messageId === messageId),
    agentReplies: async (docId) => (agentAsks[docId] || []).map((a) => ({ messageId: a.messageId, agent: 'codex', label: 'Codex', ...(Date.now() - a.at < 2500 ? { state: 'working', text: '' } : { state: 'done', text: 'Mock answer from Codex, kept on this device.' }) })),
    newChat: async () => {
      const n = { id: 'tana:chat:mocknew' + (++seq), text: 'New chat', kind: 'document', hasChildren: true, editable: false, icon: 'chat', tags: [{ label: 'chat', color: 'grey' }] };
      created[n.id] = n; content[n.id] = []; all.push(n);
      return info(n);
    },
    // the third kind of pin: the meetings and spaces this document hangs on, which are pins on those documents
    pinState: async (docId) => ({
      sidebar: sidebar.includes(docId), dates: datePins[docId] || [],
      hubs: Object.keys(hubPins).filter((hub) => hubPins[hub].includes(docId))
        .map((hub) => { const n = all.find((d) => d.id === hub); return { id: hub, title: (n && n.text) || hub, kind: n && n.icon === 'space' ? 'space' : 'meeting' }; }),
    }),
    // both answer with the hub's own pinned ids, as main's nodePin does
    pinTo: async (hubId, docId) => { const on = (hubPins[hubId] ||= []); if (!on.includes(docId)) on.push(docId); emit(null); return [...on]; },
    unpinFrom: async (hubId, docId) => { hubPins[hubId] = (hubPins[hubId] || []).filter((id) => id !== docId); emit(null); return [...hubPins[hubId]]; },
    // the meeting this user has joined right now: the mock is always in the first one, so the row has something to name
    currentMeeting: async () => { const m = all.find((d) => d.icon === 'meeting'); return m ? { id: m.id, title: m.text, joinedAt: Date.now() - 600000, callUri: 'tana:call:mock' } : null; },
    pinIds: async () => [...new Set([...sidebar, ...Object.keys(datePins).filter((id) => datePins[id].length)])],
    pinDates: async () => Object.fromEntries(Object.entries(datePins).filter(([, dates]) => dates.length)),
    pin: async (docId, target, date = localDate()) => { if (target === 'sidebar') { if (!sidebar.includes(docId)) sidebar.push(docId); } else (datePins[docId] ||= []).push(date); emit(null); },
    unpin: async (docId, target, date = localDate()) => { if (target === 'sidebar') sidebar.splice(sidebar.indexOf(docId) >>> 0, 1); else datePins[docId] = (datePins[docId] || []).filter((d) => d !== date); emit(null); },
    deleteDocument: async (docId) => { softDelete(docId); step(docId, 'restore'); },
    restoreDocument: async (docId) => { undelete(docId); step(docId, 'delete'); },
    // what Cmd+K "Recently deleted" reads: here it is the mock's own tombstones, newest first
    deletedList: async () => [...deleted].reverse().map(([id, saved]) => ({ id, title: saved.doc.text || 'Untitled', deletedAt: saved.at })),
    sensitiveIds: async () => [...sensitive],
    setSensitive: async (docId, on) => { if (on) sensitive.add(docId); else sensitive.delete(docId); return on; },
    codexIds: async () => [...codexAssigned],
    setCodex: async (docId, on, prompt) => {
      if (on) { codexAssigned.add(docId); if (typeof prompt === 'string' && prompt.trim()) codexPrompts.set(docId, prompt.trim()); }
      else { codexAssigned.delete(docId); codexPrompts.delete(docId); }
      return !!on;
    },
    linkCodexTask: async (docId) => { codexAssigned.add(docId); return true; },
    nodeLink: async (docId) => 'https://home.tana.inc/o/mockorg/l/' + encodeURIComponent(docId),
    // the mock has no participants model, so nothing is watched by default here: the choice is all there is
    notifyState: async (docId) => ({ on: !!notifyChoices[docId], default: false, explicit: docId in notifyChoices }),
    setNotify: async (docId, on) => {
      if (on === null || on === undefined) delete notifyChoices[docId]; else notifyChoices[docId] = !!on;
      return { on: !!notifyChoices[docId], default: false, explicit: docId in notifyChoices };
    },
    newWindow: async () => {},
    splitWindow: async () => {},
    windowLayout: async () => null, setWindowLayout: async () => false, // one page, no shell to lay it out
    openExternal: async (url) => { if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened'); return url; },
    todayNode: async (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + (typeof offset === 'number' ? offset : 0)); const date = typeof offset === 'string' ? offset : d.toLocaleDateString('sv-SE'); const found = all.find((d2) => d2.text === date); if (found) return found.id; const n = { id: 'mockday' + date, text: date, kind: 'document', hasChildren: true, editable: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] }; content[n.id] = []; all.push(n); views[0].nodes.unshift(n); datePins[n.id] = [date]; emit(null); return n.id; },
    weekNode: async () => { const t = new Date(); t.setDate(t.getDate() + 4 - (t.getDay() || 7)); const title = 'Week ' + Math.ceil(((t - new Date(t.getFullYear(), 0, 1)) / 864e5 + 1) / 7) + ' (' + t.getFullYear() + ')'; const found = all.find((d) => d.text === title); if (found) return found.id; const n = { id: 'mockweek', text: title, kind: 'document', hasChildren: true, editable: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] }; content[n.id] = []; all.push(n); views[0].nodes.unshift(n); emit(null); return n.id; },
    setTitle: async (docId, title) => mut(docId, () => { all.find((d) => d.id === docId).text = title; emit(docId); }),
    setDone: async (docId, done) => mut(docId, () => { const d = all.find((x) => x.id === docId); d.done = done ? 1 : 0; d.state = done ? 'closed' : 'open'; emit(docId); }),
    toggleCheckbox: async (docId, id) => mut(docId, () => { const n = locate(content[docId], id).node; n.done = n.done == null ? 0 : n.done ? 0 : 1; emit(docId); }),
    setText: async (docId, id, text) => mut(docId, () => { const n = locate(content[docId], id).node; n.text = plainOf(text); n.segments = segsOf(text); emit(docId); }),
    setCell: async (docId, cellId, text) => mut(docId, () => { const c = content[docId].flatMap((n) => (n.table ? n.table.rows.flat() : [])).find((x) => x.id === cellId); if (!c) throw new Error('no table cell ' + cellId); c.segments = segsOf(text); c.text = plainOf(text); emit(docId); }),
    // the same operations as sdk/content.js tableOp, on the plain grid (no header or last-row guards: main is the rule)
    tableOp: async (docId, cellId, op) => mut(docId, () => {
      const t = content[docId].find((n) => n.table && n.table.rows.some((r) => r.some((c) => c.id === cellId))).table, rows = t.rows;
      const r = rows.findIndex((row) => row.some((c) => c.id === cellId)), c = rows[r].findIndex((x) => x.id === cellId), blank = (h) => cell('', h);
      const swap = (list, a, b) => { if (b >= 0 && b < list.length) [list[a], list[b]] = [list[b], list[a]]; };
      let out = cellId;
      if (op === 'rowBefore' || op === 'rowAfter') { const row = rows[0].map(() => blank(false)); rows.splice(op === 'rowBefore' ? r : r + 1, 0, row); out = row[c].id; }
      else if (op === 'deleteRow') { rows.splice(r, 1); out = (rows[r] || rows[r - 1])[c]?.id; }
      else if (op === 'columnBefore' || op === 'columnAfter') rows.forEach((row, y) => { const n = blank(row[0]?.header); row.splice(op === 'columnBefore' ? c : c + 1, 0, n); if (y === r) out = n.id; });
      else if (op === 'deleteColumn') { rows.forEach((row) => row.splice(c, 1)); out = (rows[r][c] || rows[r][c - 1])?.id; }
      else if (op === 'rowUp' || op === 'rowDown') swap(rows, r, r + (op === 'rowUp' ? -1 : 1));
      else rows.forEach((row) => swap(row, c, c + (op === 'columnLeft' ? -1 : 1)));
      t.rowCount = rows.length; t.columnCount = Math.max(...rows.map((row) => row.length));
      emit(docId); return out;
    }),
    // block types and dividers (the contract the renderer codes against): type in paragraph | heading1-3 | bullet | numbered | code | quote
    setBlockType: async (docId, id, type) => mut(docId, () => {
      const n = locate(content[docId], id).node;
      n.block = type; n.heading = Number((String(type).match(/^heading(\d)$/) || [])[1]) || undefined;
      emit(docId);
    }),
    insertDivider: async (docId, id) => mut(docId, () => { const f = locate(content[docId], id); f.list.splice(f.index + 1, 0, divider()); emit(docId); }),
    insertImage: async (docId, id) => mut(docId, () => {
      const n = { id: 'img' + (++seq), kind: 'block', type: 'image', image: { uri: 'tana:image:mock', alt: null, width: null, height: null }, hasChildren: false, children: [] };
      const inCell = content[docId].flatMap((b) => (b.table ? b.table.rows.flat() : [])).find((c) => c.id === id); // into a table cell, after its text
      if (inCell) { inCell.blocks = [...(inCell.blocks || []), n]; emit(docId); return n.id; }
      const f = id == null ? null : locate(content[docId], id);
      if (!f) content[docId].push(n); else f.list.splice(f.index + 1, 0, n);
      emit(docId); return n.id;
    }),
    insertTable: async (docId, id) => mut(docId, () => { // 3x3 with a header row, like sdk/content.js insertTable
      const rows = [0, 1, 2].map((y) => [0, 1, 2].map(() => ({ id: 'cell' + (++seq), header: y === 0, colspan: 1, rowspan: 1, colwidth: null, paragraph: 'cp' + seq, segments: [], text: '', blocks: [] })));
      const f = locate(content[docId], id), n = { id: 'tbl' + (++seq), kind: 'block', block: 'paragraph', type: 'table', editable: false, text: '', table: { id: 'tbl' + seq, rows, rowCount: 3, columnCount: 3 }, hasChildren: false, children: [] };
      f.list.splice(f.index + 1, 0, n); emit(docId); return rows[0][0].id;
    }),
    insertAfter: async (docId, id, text) => mut(docId, () => {
      const f = id == null ? null : locate(content[docId], id), n = block(text, [], undefined, f && f.node.kind === 'block' && f.node.done != null ? 0 : undefined);
      if (!f) content[docId].push(n); else f.list.splice(f.index + 1, 0, n);
      emit(docId); return n.id;
    }),
    insertChild: async (docId, id, text) => mut(docId, () => { const f = locate(content[docId], id), n = block(text, [], undefined, f.node.kind === 'block' && f.node.done != null ? 0 : undefined); f.node.children.unshift(n); fix(f.node); emit(docId); return n.id; }),
    insertBefore: async (docId, id, text) => mut(docId, () => {
      const f = locate(content[docId], id), n = block(text, [], undefined, f.node.kind === 'block' && f.node.done != null ? 0 : undefined);
      f.list.splice(f.index, 0, n);
      emit(docId); return n.id;
    }),
    split: async (docId, id, before, after, asChild) => mut(docId, () => {
      const f = locate(content[docId], id), done = f.node.kind === 'block' && f.node.done != null ? 0 : undefined;
      f.node.text = plainOf(before); f.node.segments = segsOf(before);
      const n = block(plainOf(after), [], undefined, done);
      n.segments = segsOf(after);
      if (asChild) { f.node.children.unshift(n); fix(f.node); } else f.list.splice(f.index + 1, 0, n);
      emit(docId); return n.id;
    }),
    remove: async (docId, id) => mut(docId, () => { const f = locate(content[docId], id); f.list.splice(f.index, 1); const p = f.trail.at(-1); if (p) fix(p.node); emit(docId); }),
    join: async (docId, id, intoId, value) => mut(docId, () => {
      const into = locate(content[docId], intoId).node; into.text = plainOf(value); into.segments = segsOf(value);
      const f = locate(content[docId], id); f.list.splice(f.index, 1); const p = f.trail.at(-1); if (p) fix(p.node); emit(docId);
    }),
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
    // a drag: the node leaves where it was, children and all, and lands behind afterId, at the top of parentId, or
    // at the top of the outline it was dropped in (which may be one of the document's fields)
    moveTo: async (docId, id, toDocId, parentId, afterId) => mut(docId, () => {
      const f = locate(content[docId], id);
      f.list.splice(f.index, 1);
      const left = f.trail.at(-1);
      if (left) fix(left.node);
      const dest = content[toDocId] || (content[toDocId] = []);
      const after = afterId ? locate(dest, afterId) : null, parent = !after && parentId ? locate(dest, parentId) : null;
      if (after) after.list.splice(after.index + 1, 0, f.node);
      else if (parent) { parent.node.children.unshift(f.node); fix(parent.node); }
      else dest.unshift(f.node);
      emit(docId);
      if (toDocId !== docId) emit(toDocId);
    }),
    // a document dropped into an outline (or an Alt-drag): a row whose whole content is one mention of it
    insertMention: async (toDocId, uri, label, parentId, afterId) => mut(toDocId, () => {
      const dest = content[toDocId] || (content[toDocId] = []);
      const node = block([{ mention: { label: label || uri, uri } }]);
      const after = afterId ? locate(dest, afterId) : null, parent = !after && parentId ? locate(dest, parentId) : null;
      if (after) after.list.splice(after.index + 1, 0, node);
      else if (parent) { parent.node.children.unshift(node); fix(parent.node); }
      else dest.unshift(node);
      emit(toDocId);
      return node.id;
    }),
    undo: () => history(undoStack, redoStack),
    redo: () => history(redoStack, undoStack),
    refresh: async () => { for (const n of unlisted.splice(0)) (n.icon === 'task' ? docs : meetings).push(n); emit(null); },
    login: async () => { status = { ...status, authenticated: true, connected: true, lastSync: new Date().toISOString() }; statusCbs.forEach((cb) => cb(status)); },
    logout: async () => { status = { ...status, authenticated: false, connected: false }; statusCbs.forEach((cb) => cb(status)); },
    status: async () => status,
    onRemoved: (cb) => removed.push(cb),
    onChanged: (cb) => changed.push(cb),
    onStatus: (cb) => statusCbs.push(cb),
    inboxUnread: async () => inboxUnread(),
    inboxSetRead: async (id, read) => { const n = content[INBOX].find((x) => x.id === id); if (n) n.unread = !read; return tellInbox(); },
    inboxMarkAll: async () => { for (const n of content[INBOX]) n.unread = false; return tellInbox(); },
    onInbox: (cb) => inboxCbs.push(cb),
    timelinePages: async (n) => n, // the mock's Timeline is the same rows at any depth
    proposalAnswer: async (chatUri, proposedUri, approve) => {
      const p = content[PROPOSALS].find((n) => n.proposal.proposedUri === proposedUri);
      if (approve && p && !p.proposal.approvable) throw new Error('Tana merges a change itself: approve it in Tana');
      content[PROPOSALS] = content[PROPOSALS].filter((n) => n !== p);
      return [];
    },
  };
}
