'use strict';

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
  const titles = ['Schedule something with Lex van Velsen and Roni Wiener', 'Metrics project needs more support and information. Timeline on hold.',
    'Check out OpenUp', 'Should we kickstart a FTE/Employee cost tracking system with Finance/HR', 'Discuss two cross-boarders with Jeroen Oostewechel',
    'Organise working sessions on guardrails for teams with Foundry', 'Contact Mark W for dinner', 'Ask and tell about Tana DPA', 'The blue laptop discussion',
    'Ask Foundry teams for risks (with deadline Sun, Nov 1)', 'Organise session with Arjan Pragt around the role definition', "Create RvC presentation on Nedap's one-year AI vision"];
  let seq = 0;
  const block = (text, children = [], heading) => ({ id: 'b' + (++seq), text: plainOf(text), segments: segsOf(text), kind: 'block', heading, hasChildren: children.length > 0, children });
  const task = { label: 'task', color: 'grey' }, meeting = { label: 'meeting', color: 'gold' };
  const project = { label: 'Project', hue: 268 }; // a typed tag with the type's colour (Addendum 12)
  const docs = titles.map((text, i) => ({ id: 'mockdoc' + i, text, kind: 'document', done: 0, hasChildren: true, icon: 'task', tags: [task] }));
  docs[2].tags = [task, project];
  docs[0].state = 'proposed'; // Inbox; the rest are In Progress (open) unless done
  for (const text of ['Renew the Tana DPA', 'Send the Q3 board deck']) docs.push({ id: 'mockdoc' + docs.length, text, kind: 'document', done: 1, state: 'closed', hasChildren: true, icon: 'task', tags: [task] }); // Completed: hidden by the default filter
  docs.push({ id: 'mockdoc' + titles.length, text: 'Foundry programme', kind: 'document', hasChildren: true, tags: [project] }); // typed, not a task: plain bullet
  // a space: pinned, its "content" is the documents it owns (document Nodes, not blocks)
  const spaceDocs = [
    { id: 'mockspacedoc0', text: 'Foundry LT charter', kind: 'document', hasChildren: true, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] },
    { id: 'mockspacedoc1', text: 'Draft the LT agenda', kind: 'document', done: 0, hasChildren: true, icon: 'task', tags: [task] },
  ];
  const space = { id: 'tana:space:mock', text: 'Foundry LT', kind: 'document', hasChildren: true, icon: 'space', tags: [{ label: 'space', color: 'grey' }] };
  // other library kinds (chats, canvases, agents, skills): read-only rows, plain bullet + kind chip
  const kinds = ['chat', 'canvas', 'agent', 'skill'].map((k, i) => ({ id: 'tana:' + k + ':mock' + i, text: 'Sample ' + k, kind: 'document', hasChildren: true, tags: [{ label: k, color: 'grey' }] }));
  // chats (api.chats): newest first; "MCP: …" ones carry meta 'MCP' and are hidden unless includeMcp
  const chats = ['Draft the Foundry memo', 'MCP: list open tasks', 'Summarise the NLT notes', 'MCP: create meeting note', 'Rewrite the DPA clause']
    .map((text, i) => ({ id: 'tana:chat:mockchat' + i, text, kind: 'document', hasChildren: true, tags: [{ label: 'chat', color: 'grey' }], meta: /^MCP:/.test(text) ? 'MCP' : undefined }));
  // meetings over the past and next 7 days (day offset from today, start hour or null = all day); roots meta = weekday + time, search meta = weekday + day of month + time
  const dateMeta = {};
  const meetings = [['Last week retro', -6, 10], ['Board prep', -2, 14], ['NLT', 0, 9], ['Heads of Technology', 0, 13], ['1-1 with Lex', 1, 11], ['Offsite', 3, null]].map(([text, off, h], i) => {
    const d = new Date(); d.setDate(d.getDate() + off);
    const time = h == null ? ', all day' : ' ' + h + ':00–' + (h + 1) + ':00';
    dateMeta['mockmeeting' + i] = WD[d.getDay()] + ' ' + d.getDate() + time;
    return { id: 'mockmeeting' + i, text, meta: WD[d.getDay()] + time, kind: 'document', hasChildren: true, icon: 'meeting', tags: [meeting] };
  });
  const sections = [{ id: 'tasks', title: 'Tasks', icon: 'task', nodes: docs }, { id: 'meetings', title: 'Meetings', icon: 'meeting', nodes: meetings }, { id: 'library', title: 'Library', icon: 'doc', nodes: [] }, { id: 'chats', title: 'Chats', icon: 'chat', nodes: [] }];
  const all = [...docs, ...meetings, ...spaceDocs, space, ...kinds, ...chats];
  // org members (user profiles): searchable, linkable, and the "Assigned to" menu; me = the signed-in user
  const members = [['andre', 'André Foeken', true], ['lex', 'Lex van Velsen'], ['brage', 'Brage Bang'], ['rogier', 'Rogier (Nedap)']]
    .map(([k, text, me]) => ({ id: 'tana:user-profile:' + k, text, kind: 'document', hasChildren: true, icon: 'member', tags: [{ label: 'member', color: 'grey' }], me }));
  // Tasks view filter (api.taskFilter / setTaskFilter): states null = any; assignee 'me' | 'anyone' | 'unassigned' | member uri (mock tasks are all mine)
  let filter = { states: ['proposed', 'open'], assignee: 'me' };
  const stateOf = (d) => d.state || (d.done ? 'closed' : 'open');
  const listed = (d, f = filter) => (!f.states || f.states.includes(stateOf(d))) && (f.assignee === 'me' || f.assignee === 'anyone');
  // Library filter (api.libraryFilter / setLibraryFilter / library): types null = any
  let libFilter = { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' };
  const kindOf = (d) => (d.icon === 'task' ? 'tasks' : d.icon === 'meeting' ? 'meetings' : d.tags && ['chat', 'canvas', 'agent', 'skill'].includes(d.tags[0].label) ? d.tags[0].label + 's' : 'docs');
  const created = {};   // documents made with createDocument
  const unlisted = [];  // created tasks/meetings the roots "query" has not caught up with yet: listed after the next refresh()
  const sidebar = ['mockdoc2', 'mockmeeting2', space.id], datePins = { mockdoc2: [localDate()] }; // pins: sidebar order, personal date pins per doc
  const content = Object.fromEntries(all.map((d, i) => [d.id, [
    block('Context', [], 2),
    block('First point about task ' + i, [block('Detail A'), block('Detail B', [block('Deeper detail')])]),
    block([{ text: 'Discuss with ' }, { mention: { label: 'Lex van Velsen', uri: 'tana:user-profile:lex' } }, { text: ' and see ' }, { mention: { label: titles[2], uri: 'mockdoc2' } }]),
    block('Second point, a paragraph long enough to wrap onto a second line when the window is narrow so arrow keys can be tested inside a node.'),
    block('Next steps', [block('Call someone'), block('Write the memo')]),
  ]]));
  content['tana:user-profile:lex'] = [block('Lex is a colleague')];
  content[space.id] = spaceDocs;
  // an image block (not editable; api.image resolves its uri to a data URL): a 2x2 PNG scaled by width/height
  content.mockdoc0.splice(2, 0, { id: 'img' + (++seq), kind: 'block', type: 'image', image: { uri: 'tana:image:mock', alt: 'Mock image', width: 160, height: 100 }, hasChildren: false, children: [] });
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGPoyroWu7WKIX9dU1fWNQAuWQbA8sXmUwAAAABJRU5ErkJggg==';
  const changed = [], statusCbs = [];
  let status = { authenticated: false, connected: false, syncing: false, lastSync: null, error: null };
  const emit = (docId) => setTimeout(() => changed.forEach((cb) => cb(docId)), 0);
  const fix = (n) => { n.hasChildren = n.children.length > 0; };
  const info = (d) => ({ id: d.id, title: d.text, kind: 'document', done: d.done, icon: d.icon, tags: d.tags, meta: d.meta, me: d.me });
  // undo/redo: whole-state snapshots, one step per mutation (main keeps a global order over per-document Loro UndoManagers)
  const undoStack = [], redoStack = [];
  const snapshot = () => structuredClone({ docs: all.map((d) => ({ text: d.text, done: d.done })), content });
  const restore = (s) => { all.forEach((d, i) => Object.assign(d, s.docs[i])); Object.assign(content, s.content); };
  const mut = (docId, fn) => { undoStack.push({ docId, snap: snapshot() }); redoStack.length = 0; return fn(); };
  const history = async (from, to) => { const e = from.pop(); if (!e) return null; to.push({ docId: e.docId, snap: snapshot() }); restore(e.snap); emit(e.docId); return e.docId; };
  return {
    roots: async () => structuredClone(sections.map((s) => (s.id === 'tasks' ? { ...s, nodes: s.nodes.filter((d) => listed(d)) } : s))),
    children: async (docId) => structuredClone(content[docId] || []),
    node: async (docId) => {
      const d = [...all, ...members].find((x) => x.id === docId);
      if (d) return info(d);
      if (created[docId]) return created[docId];
      throw new Error('unknown document ' + docId);
    },
    members: async () => members.map(info),
    image: async (uri) => { await new Promise((r) => setTimeout(r, 30)); if (uri !== 'tana:image:mock') throw new Error('unknown image ' + uri); return PNG; },
    taskFilter: async () => structuredClone(filter),
    setTaskFilter: async (f) => { filter = structuredClone(f); emit(null); },
    libraryFilter: async () => structuredClone(libFilter),
    setLibraryFilter: async (f) => { libFilter = { ...libFilter, ...structuredClone(f) }; },
    library: async (f) => {
      await new Promise((r) => setTimeout(r, 30));
      const ff = { ...libFilter, ...(f || {}) }, text = String(ff.text || '').trim().toLowerCase();
      return all.filter((d) => (!ff.types || ff.types.includes(kindOf(d))) && (kindOf(d) !== 'tasks' || listed(d, ff)) && d.text.toLowerCase().includes(text)).slice(0, 100).map(info);
    },
    chats: async ({ includeMcp = false } = {}) => { await new Promise((r) => setTimeout(r, 30)); return chats.filter((d) => includeMcp || d.meta !== 'MCP').map(info); },
    // "#task", "#meeting", "#member", "#<type>" tokens filter; the rest is a substring query; events get date-style meta
    search: async (q) => {
      await new Promise((r) => setTimeout(r, 30));
      const tokens = (q.match(/#\S+/g) || []).map((t) => t.slice(1).toLowerCase()), text = q.replace(/#\S+/g, '').trim().toLowerCase();
      const hit = (d, t) => (['task', 'meeting', 'member'].includes(t) ? d.icon === t : (d.tags || []).some((x) => x.label.toLowerCase() === t));
      return [...all, ...members].filter((d) => d.text.toLowerCase().includes(text) && tokens.every((t) => hit(d, t))).slice(0, 20).map((d) => ({ ...info(d), meta: dateMeta[d.id] || d.meta }));
    },
    createDocument: async (title, { kind = 'doc' } = {}) => {
      const n = { id: 'mocknew' + (++seq), text: title, kind: 'document', hasChildren: true, icon: kind, tags: [{ label: kind, color: kind === 'meeting' ? 'gold' : 'grey' }] };
      if (kind === 'task') n.done = 0;
      if (kind === 'meeting') n.meta = WD[new Date().getDay()] + ' 10:00–10:30';
      created[n.id] = n; content[n.id] = []; all.push(n);
      if (kind !== 'doc') unlisted.push(n);
      return info(n);
    },
    pins: async () => sidebar.map((id) => info(all.find((d) => d.id === id))),
    pinState: async (docId) => ({ sidebar: sidebar.includes(docId), dates: datePins[docId] || [] }),
    pin: async (docId, target) => { if (target === 'sidebar') { if (!sidebar.includes(docId)) sidebar.push(docId); } else (datePins[docId] ||= []).push(localDate()); emit(null); },
    unpin: async (docId, target) => { if (target === 'sidebar') sidebar.splice(sidebar.indexOf(docId) >>> 0, 1); else datePins[docId] = (datePins[docId] || []).filter((d) => d !== localDate()); emit(null); },
    setIcon: async (docId, svg) => { (all.find((d) => d.id === docId) || created[docId]).iconSvg = svg || undefined; emit(null); },
    setTitle: async (docId, title) => mut(docId, () => { all.find((d) => d.id === docId).text = title; emit(docId); }),
    setDone: async (docId, done) => mut(docId, () => { const d = all.find((x) => x.id === docId); d.done = done ? 1 : 0; d.state = done ? 'closed' : 'open'; emit(docId); }),
    setText: async (docId, id, text) => mut(docId, () => { const n = locate(content[docId], id).node; n.text = plainOf(text); n.segments = segsOf(text); emit(docId); }),
    insertAfter: async (docId, id, text) => mut(docId, () => {
      const n = block(text);
      if (id == null) content[docId].push(n); else { const f = locate(content[docId], id); f.list.splice(f.index + 1, 0, n); }
      emit(docId); return n.id;
    }),
    insertChild: async (docId, id, text) => mut(docId, () => { const n = block(text), f = locate(content[docId], id); f.node.children.unshift(n); fix(f.node); emit(docId); return n.id; }),
    remove: async (docId, id) => mut(docId, () => { const f = locate(content[docId], id); f.list.splice(f.index, 1); const p = f.trail.at(-1); if (p) fix(p.node); emit(docId); }),
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
    undo: () => history(undoStack, redoStack),
    redo: () => history(redoStack, undoStack),
    refresh: async () => { for (const n of unlisted.splice(0)) (n.icon === 'task' ? docs : meetings).push(n); emit(null); },
    login: async () => { status = { ...status, authenticated: true, connected: true, lastSync: new Date().toISOString() }; statusCbs.forEach((cb) => cb(status)); },
    status: async () => status,
    onChanged: (cb) => changed.push(cb),
    onStatus: (cb) => statusCbs.push(cb),
  };
}

// ---- segments: [{ text } | { mention: { label, uri } }] <-> plain text <-> DOM ----
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const localDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }; // today, YYYY-MM-DD
// accepts segments, a plain string, or a Node
const segsOf = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? (v ? [{ text: v }] : []) : v.segments || (v.text ? [{ text: v.text }] : []));
const plainOf = (v) => segsOf(v).map((s) => ('text' in s ? s.text : s.mention.label)).join('');
function renderSegs(el, segs) {
  el.replaceChildren(...segs.map((s, i) => {
    // Chromium needs a placeholder newline after a trailing soft break to put the caret on the empty line; readSegs strips it
    if ('text' in s) return document.createTextNode(s.text + (i === segs.length - 1 && s.text.endsWith('\n') ? '\n' : ''));
    const a = document.createElement('a'); a.className = 'mention'; a.dataset.uri = s.mention.uri; a.contentEditable = 'false'; a.textContent = s.mention.label;
    return a;
  }));
}
function readSegs(el) {
  const segs = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 1 && n.classList.contains('mention')) { segs.push({ mention: { label: n.textContent, uri: n.dataset.uri } }); continue; }
    const t = n.nodeName === 'BR' ? '\n' : n.textContent;
    if (!t) continue;
    const last = segs.at(-1);
    if (last && 'text' in last) last.text += t; else segs.push({ text: t });
  }
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
    else if ('text' in s) { before.push({ text: s.text.slice(0, off) }); after.push({ text: s.text.slice(off) }); off = 0; }
    else { before.push(s); off = 0; }
  }
  return [before, after];
}
const saveValue = (segs) => (segs.some((s) => 'mention' in s) ? segs : plainOf(segs));
const tana = window.api || mockApi();

// ---- state ----
let sections = [];           // [{ id, title, icon, nodes: document Node[] }]
let view = localStorage.getItem('view') || 'tasks'; // active section id; the outline shows one view at a time
let authed = false;
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
let linkCtx = null;          // @ linking in progress: { item, segs, start, end, text }
const hotkeys = JSON.parse(localStorage.getItem('hotkeys') || '{}'); // palette row id -> combo ("⇧⌘M")
let pins = [], pinInfo = null; // Cmd+K: sidebar pins (api.pins) and { docId, sidebar, dates } of the palette's document (api.pinState)
let palDoc = null;           // document the Cmd+K context actions apply to (zoomed, else the one whose node is focused)
let dropDoc = null;          // document waiting for an SVG drop ("Set icon…" overlay)
let palReturn = null, dropReturn = null; // { key, offset } of the node focused when a palette / the drop overlay opened; focus goes back there on close
const fresh = new Map();     // docId -> { section, after, node }: documents created here that roots does not list yet, kept in place until it does
let draftSeq = 0;
const DRAFT_KIND = { tasks: 'task', meetings: 'meeting' }; // what Enter drafts in a view (any other view: a plain doc)
let sel = null;              // multi-select: { anchor: key, focus: key } over visible siblings, rendered as .selected; the caret leaves the text
// view filters (api.taskFilter / api.libraryFilter, persisted by main); members = api.members() for the Assigned menu ("You" = the one flagged me)
let taskF = { states: ['proposed', 'open'], assignee: 'me' }, libF = { types: ['tasks'], states: ['proposed', 'open'], assignee: 'me', text: '' };
let members = null, libRows = null, libSeq = 0, libTimer;
let chatRows = null, chatSeq = 0, showMcp = localStorage.getItem('mcp') === '1'; // Chats view: api.chats({ includeMcp }) rows; the MCP toggle persists
let menu = null;             // open pill menu: { id, index }
let rootsLoaded = false, connected = false; // for the loading skeleton: shown while the view has no rows and roots/library/connection are still pending
// font size: native page zoom (⇧⌘+ / ⇧⌘− / ⇧⌘0), persisted
let zoomFactor = Number(localStorage.getItem('zoom')) || 1;
function setZoom(f) {
  zoomFactor = Math.min(3, Math.max(0.5, Math.round(f * 100) / 100));
  localStorage.setItem('zoom', String(zoomFactor));
  if (tana.zoom) tana.zoom(zoomFactor);
}
if (zoomFactor !== 1 && tana.zoom) tana.zoom(zoomFactor);

const $ = (id) => document.getElementById(id);
const outline = $('outline'), filterEl = $('filter'), filterRow = $('filterRow');
const allDocs = () => sections.flatMap((s) => s.nodes);
const sectionOf = (docId) => sections.find((s) => s.nodes.some((n) => n.id === docId));
const viewOf = () => sections.find((s) => s.id === view) || sections[0];
const keyFor = (docId, node) => (node.kind === 'document' ? docId : docId + '/' + node.id);
const mkItem = (docId, node, parent) => { const item = { key: keyFor(docId, node), node, docId, parent }; items.set(item.key, item); return item; };
const docOf = (id) => allDocs().find((d) => d.id === id) || extra.get(id);
const isSpace = (node) => node.id.startsWith('tana:space:'); // its children are documents; no draft child
const childrenOf = (item) => (item.node.kind === 'document' ? kids.get(item.docId) : item.node.children || []);
const hasKids = (item) => { const c = childrenOf(item); return Array.isArray(c) ? c.length > 0 : !!item.node.hasChildren; };
const isOpen = (item) => (open.has(item.key) ? open.get(item.key) : item.node.kind === 'block');
const draftNode = (parent) => ({ id: 'draft:' + parent.key, text: '', kind: 'block', draft: true }); // shown under an expanded empty node; created on the first typed character
// draft document for a view: rendered like a real task/meeting/doc, created with api.createDocument(text, { kind }) on the first typed character
const draftDocNode = (kind) => ({ id: 'draftdoc:' + (++draftSeq), text: '', kind: 'document', draft: kind, icon: kind, tags: [{ label: kind, color: kind === 'meeting' ? 'gold' : 'grey' }], done: 0, hasChildren: false });
// a tag chip: { label, color: 'grey' | 'gold' } or { label, hue } (type colour: background hsl(hue 80% 92%), text hsl(hue 45% 30%), see styles.css .chip.hue)
function chipEl(t) {
  const c = document.createElement('span');
  c.className = 'chip ' + (t.hue != null ? 'hue' : t.color || 'grey'); c.textContent = '# ' + t.label;
  if (t.hue != null) c.style.setProperty('--hue', String(t.hue));
  return c;
}
const images = new Map(); // image uri -> data URL (or the pending api.image promise)
const isImage = (node) => node.type === 'image';
const showError = (e) => { const el = $('error'); el.textContent = e ? String(e.message || e) : ''; el.hidden = !e; };
const run = (fn) => (queue = queue.then(fn).catch(showError));
const texts = () => [...outline.querySelectorAll('.text')];
const titleEl = $('title');  // zoomed into a document: contenteditable with data-key = that document's key
const keyOfEl = (el) => (el.closest('.node') || el).dataset.key;
const textEl = (key) => outline.querySelector('.node[data-key="' + CSS.escape(key) + '"] > .line .text') || (titleEl.isContentEditable && titleEl.dataset.key === key ? titleEl : null);
const nodeElOf = (key) => outline.querySelector('.node[data-key="' + CSS.escape(key) + '"]');
const titleCheck = $('titleCheck'); // zoomed into a task: its checkbox before the title
titleCheck.onmousedown = (e) => e.preventDefault();
const nodeEls = (el) => [...el.parentElement.children].filter((c) => c.classList.contains('node')); // visible siblings of a .node element
const ICONS = window.ICONS || {}; // icons.js: Tana line icon set (Nucleo export), greyscale via currentColor
// glyphs for the Library kinds the icon set lacks (chat, canvas, agent, skill): single-stroke line icons in the same 18px grid
const STROKE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">';
const LIB_ICONS = {
  chat: STROKE + '<path d="M9 2.75c-3.6 0-6.25 2.35-6.25 5.25 0 1.45.65 2.75 1.7 3.7L3.75 15.25l3.35-1.35c.6.15 1.25.25 1.9.25 3.6 0 6.25-2.35 6.25-5.25S12.6 2.75 9 2.75z"/></svg>',
  canvas: STROKE + '<path d="M2.75 12.25c1.5-3.5 3-5.25 4.25-5.25 1.75 0 1.75 5.25 3.5 5.25 1.25 0 2.75-2.25 4.75-6.5"/></svg>',
  agent: STROKE + '<rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2"/><path d="M6 9.75a3 3 0 0 0 6 0"/><path d="M6.5 6.5h.01M11.5 6.5h.01" stroke-width="1.5"/></svg>',
  skill: STROKE + '<rect x="2.75" y="2.75" width="12.5" height="12.5" rx="2"/><path d="M10.75 5.5l-3.5 7"/></svg>',
};
const iconSvg = (icon) => ICONS[icon === 'meeting' ? 'calendar' : icon] || LIB_ICONS[icon] || '';
const isTask = (node) => node.kind === 'document' && node.icon === 'task';
const asDoc = (n) => ({ ...n, kind: 'document', text: n.text ?? n.title ?? '', hasChildren: true }); // api.node / search / library result -> document Node
// recently viewed documents (localStorage "recent"), most recent first, max 20
const recent = () => { try { return (JSON.parse(localStorage.getItem('recent')) || []).map((n) => !n.icon && !n.tags?.length && n.id?.startsWith('tana:text:') ? { ...n, icon: 'doc', tags: [{ label: 'doc', color: 'grey' }] } : n); } catch { return []; } };
function recordRecent(n) {
  const entry = { id: n.id, title: n.text ?? n.title ?? '', icon: n.icon, tags: n.tags, meta: n.meta };
  localStorage.setItem('recent', JSON.stringify([entry, ...recent().filter((r) => r.id !== n.id)].slice(0, 20)));
}
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
  sections = await tana.roots();
  rootsLoaded = true;
  const lib = sections.find((s) => s.id === 'library');
  if (lib) lib.nodes = libRows || []; // the Library view lists api.library(libF) rows, fetched by loadLibrary
  const ch = sections.find((s) => s.id === 'chats');
  if (ch) ch.nodes = chatRows || []; // the Chats view lists api.chats rows, fetched by loadChats
  for (const [id, f] of fresh) { // a created document stays where it was drafted until the roots query lists it
    const s = sections.find((x) => x.id === f.section);
    if (!s || s.nodes.some((n) => n.id === id)) fresh.delete(id);
    else s.nodes.splice(s.nodes.findIndex((n) => n.id === f.after) + 1, 0, f.node);
  }
}
async function reload(docId) { kids.set(docId, await tana.children(docId)); }
// Library rows for the current filter (stale responses dropped), then roots so the section carries them
function loadLibrary() {
  if (!tana.library) return;
  const seq = ++libSeq;
  tana.library(libF).then(async (rows) => { if (seq !== libSeq) return; libRows = rows.map(asDoc); await loadRoots(); render(); }, showError);
}
function loadChats() {
  if (!tana.chats) return;
  const seq = ++chatSeq;
  tana.chats({ includeMcp: showMcp }).then(async (rows) => { if (seq !== chatSeq) return; chatRows = rows.map(asDoc); await loadRoots(); render(); }, showError);
}
function setMcp(on) { showMcp = on; localStorage.setItem('mcp', on ? '1' : '0'); render(); loadChats(); }
function loadFilters() {
  Promise.all([tana.taskFilter && tana.taskFilter(), tana.libraryFilter && tana.libraryFilter()]).then(([t, l]) => {
    if (t) taskF = t;
    if (l) libF = l;
    if (view === 'library') loadLibrary(); else render();
  }, showError);
}
function setTaskF(patch) { taskF = { ...taskF, ...patch }; render(); run(() => tana.setTaskFilter(taskF)); } // main refreshes roots and emits onChanged(null)
function setLibF(patch) { libF = { ...libF, ...patch }; render(); if (tana.setLibraryFilter) run(() => tana.setLibraryFilter(libF)); loadLibrary(); }
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
function render() {
  const saved = focused();
  items.clear();
  let trail = null;
  if (zoom) { trail = resolveZoom(); if (!trail) zoom = null; }
  const parent = trail && trail.at(-1);
  let list, hidden = 0;
  if (parent) {
    ensureLoaded(parent);
    list = childrenOf(parent) || [];
    if (!list.length && childrenOf(parent) && parent.node.kind === 'document' && !isSpace(parent.node)) list = [draftNode(parent)]; // empty document: one draft child, so Down from the title has somewhere to go
    outline.replaceChildren(...list.map((n) => childEl(n, parent)));
  } else {
    const v = viewOf(), docs = v ? v.nodes : [];
    const q = filterEl.value.trim().toLowerCase();
    list = q ? docs.filter((n) => n.text.toLowerCase().includes(q)) : docs;
    hidden = docs.length - list.length;
    outline.replaceChildren(...list.map((n) => nodeEl(n, n.id, null)));
    const today = outline.children[todayIndex(list)];
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
  // the page title: editable in place when zoomed into a document (setTitle through the usual debounce)
  const editable = parent && parent.node.kind === 'document' && !parent.node.draft;
  if (editable) titleEl.contentEditable = 'plaintext-only'; else titleEl.removeAttribute('contenteditable');
  titleEl.dataset.key = editable ? parent.key : '';
  titleEl.textContent = editable && pending.has(parent.key) ? plainOf(pending.get(parent.key).segs) : parent ? parent.node.text : viewOf() ? viewOf().title : 'Tana';
  // zoomed task: its checkbox before the title (toggleDone, like row checkboxes; Cmd+Enter in the title too)
  const zoomedTask = editable && isTask(parent.node);
  titleCheck.hidden = !zoomedTask; titleCheck.checked = zoomedTask && !!parent.node.done;
  titleCheck.onclick = zoomedTask ? () => toggleDone(parent) : null;
  titleEl.classList.toggle('done', zoomedTask && !!parent.node.done);
  renderCrumbs(trail);
  const showPills = !parent && authed && (view === 'tasks' || view === 'library' || view === 'chats');
  renderPills(showPills);
  $('libSearch').hidden = !(showPills && view === 'library');
  if (!$('libSearch').hidden && document.activeElement !== $('libText')) $('libText').value = libF.text || '';
  filterRow.hidden = !!parent || !(filterShown || filterEl.value);
  filterRow.classList.toggle('empty', !filterEl.value);
  $('filtered').textContent = hidden ? hidden + ' items filtered out' : '';
  $('skeleton').classList.toggle('gone', !(!parent && !list.length && (!rootsLoaded || (view === 'library' && libRows === null) || (view === 'chats' && chatRows === null) || (authed && !connected))));
  applySel();
  if (saved) placeCaret(saved.key, saved.offset);
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

function renderCrumbs(trail) {
  const nav = $('crumbs');
  nav.hidden = !trail;
  if (!trail) return;
  const back = () => { zoom = null; render(); };
  nav.replaceChildren();
  // location in Tana (owner chain from api.path, e.g. "Library" or "AI Enablement › Meeting"), loaded once per document.
  // A document reached through a space (zoom.via) starts at the space's location; the spaces follow as crumbs.
  const root = zoom.via ? zoom.via[0] : zoom, rootId = root.docId;
  const path = paths.get(rootId);
  if (!path && tana.path) { paths.set(rootId, []); tana.path(rootId).then((p) => { paths.set(rootId, p); if (zoom && (zoom.via ? zoom.via[0] : zoom).docId === rootId) render(); }).catch(() => {}); }
  for (const [i, p] of (path && path.length ? path : [{ id: '', title: root.from || (viewOf() ? viewOf().title : 'Tana') }]).entries()) {
    if (i) { const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›'; nav.append(sep); }
    const a = document.createElement('a'); a.textContent = p.title; a.onclick = back; nav.append(a);
  }
  for (const v of zoom.via || []) {
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement('a'); a.textContent = (docOf(v.docId) || {}).text || 'Untitled'; a.onclick = () => { zoom = v; render(); };
    nav.append(sep, a);
  }
  for (const item of trail.slice(0, -1)) { // ancestors only: the page title already shows the current node
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '›';
    const a = document.createElement('a'); a.textContent = item.node.text || 'Untitled'; a.onclick = () => zoomTo(item);
    nav.append(sep, a);
  }
}

// a child row: document children (inside a space) are their own document, so their key, children and edits go by their own id
const childEl = (n, item) => nodeEl(n, n.kind === 'document' ? n.id : item.docId, item);
function nodeEl(node, docId, parent) {
  const item = mkItem(docId, node, parent);
  const has = hasKids(item), opened = isOpen(item);
  const el = document.createElement('div');
  el.className = 'node ' + node.kind + (node.heading ? ' h' + node.heading : '') + (node.done ? ' done' : '') + (has ? ' has' : '') + (has && !opened ? ' collapsed' : '') + (node.draft ? ' draft' : '');
  el.dataset.key = item.key;
  const line = document.createElement('div'); line.className = 'line';
  const chev = document.createElement('button'); chev.className = 'chev'; chev.tabIndex = -1; chev.title = opened ? 'Collapse' : 'Expand';
  chev.onmousedown = (e) => e.preventDefault();
  chev.onclick = () => setOpen(item, !opened);
  const bullet = document.createElement('span'); bullet.className = 'bullet'; bullet.title = 'Zoom in';
  if (node.iconSvg) { bullet.classList.add('icon', 'custom'); bullet.innerHTML = node.iconSvg; }
  else if (node.icon) { bullet.classList.add('icon', node.icon); bullet.innerHTML = iconSvg(node.icon); }
  bullet.onmousedown = (e) => e.preventDefault();
  if (!node.draft) bullet.onclick = () => zoomTo(item);
  line.append(chev, bullet);
  if (isTask(node)) {
    const check = document.createElement('input');
    check.type = 'checkbox'; check.className = 'check'; check.checked = !!node.done; check.tabIndex = -1;
    check.onmousedown = (e) => e.preventDefault();
    check.onclick = () => toggleDone(item);
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
  } else {
    text.contentEditable = 'plaintext-only'; text.spellcheck = false;
    renderSegs(text, pending.has(item.key) ? pending.get(item.key).segs : segsOf(node));
  }
  body.append(text);
  if (node.meta) { const m = document.createElement('span'); m.className = 'meta'; m.textContent = node.meta; body.append(m); }
  for (const t of node.tags || []) body.append(chipEl(t));
  line.append(body);
  line.onclick = (e) => { if (e.target === line || e.target === body || e.target.parentElement === text) setCaret(text, text.textContent.length); };
  el.append(line);
  // expanded = real children shown, or an explicitly opened empty node (which shows one draft child)
  const expanded = has ? opened : !node.draft && open.get(item.key) === true;
  chev.classList.toggle('closed', !expanded); chev.title = expanded ? 'Collapse' : 'Expand';
  chev.onclick = () => setOpen(item, !expanded);
  if (expanded) {
    const wrap = document.createElement('div'); wrap.className = 'children';
    const c = childrenOf(item);
    if (c == null) { ensureLoaded(item); wrap.classList.add('loading'); wrap.textContent = 'Loading…'; }
    else if (c.length) wrap.append(...c.map((k) => childEl(k, item)));
    else if (!isSpace(node)) wrap.append(nodeEl(draftNode(item), docId, item));
    el.append(wrap);
  }
  return el;
}

// a draft becomes real on its first typed character: created with that text, caret kept
async function materialise(item, el) {
  const { parent, node } = item, text = el.textContent, off = caretOffset(el);
  let key;
  await run(async () => {
    if (node.kind === 'document') {
      const n = await tana.createDocument(text, { kind: node.draft }), real = { ...n, text: n.title ?? n.text ?? '', hasChildren: true };
      const s = sectionOf(node.id), i = s ? s.nodes.indexOf(node) : -1;
      if (i >= 0) { s.nodes.splice(i, 1, real); fresh.set(real.id, { section: s.id, after: i ? s.nodes[i - 1].id : null, node: real }); }
      key = real.id;
    } else {
      const id = parent.node.kind === 'document' ? await tana.insertAfter(parent.docId, null, text) : await tana.insertChild(parent.docId, parent.node.id, text);
      await reload(parent.docId);
      key = parent.docId + '/' + id;
    }
  });
  const latest = el.textContent, latestOff = caretOffset(el) ?? off; // typed on while the create was in flight
  render();
  const real = items.get(key);
  if (!real) return;
  if (latest !== text) { renderSegs(textEl(key), [{ text: latest }]); scheduleSave(real, [{ text: latest }]); }
  placeCaret(key, latestOff);
}
function dropDraft(item) {
  if (item.node.kind === 'document') { const s = sectionOf(item.docId); if (s) s.nodes.splice(s.nodes.indexOf(item.node), 1); }
  else open.delete(item.parent.key);
  render();
}
function dropDrafts() { for (const s of sections) s.nodes = s.nodes.filter((n) => !n.draft); } // navigating away drops empty draft documents
// Enter on a collapsed top-level document (or with nothing focused in an empty view): a draft sibling document below it
function draftDoc(after) {
  const s = viewOf();
  if (!s) return;
  if (after) flush(after.key);
  const node = draftDocNode(DRAFT_KIND[s.id] || 'doc');
  s.nodes.splice(after ? s.nodes.indexOf(after.node) + 1 : 0, 0, node);
  render();
  placeCaret(node.id, 0);
}

// ---- edits (debounced) ----
function scheduleSave(item, segs) {
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
  if (text === item.node.text && JSON.stringify(segs) === JSON.stringify(segsOf(item.node))) return;
  item.node.text = text; item.node.segments = segs;
  run(() => (item.node.kind === 'document' ? tana.setTitle(item.docId, text) : tana.setText(item.docId, item.node.id, saveValue(segs))));
}
function insertAtCaret(el, str) {
  if (caretOffset(el) == null) setCaret(el, el.textContent.length);
  document.execCommand('insertText', false, str); // keeps mention anchors intact and fires 'input'
}

// ---- structural operations ----
async function splitNode(item, el, off) {
  const { docId, node } = item;
  const [before, after] = splitSegs(readSegs(el), off);
  let newId;
  if (node.kind === 'document') {
    flush(item.key);
    // ponytail: no prepend op in the contract; a document's new child is appended (first child when the doc is empty)
    await run(async () => { newId = await tana.insertAfter(docId, null, ''); await reload(docId); });
    open.set(item.key, true);
  } else {
    dropPending(item.key);
    const asChild = hasKids(item) && isOpen(item);
    await run(async () => {
      if (JSON.stringify(before) !== JSON.stringify(segsOf(node))) { node.text = plainOf(before); node.segments = before; await tana.setText(docId, node.id, saveValue(before)); }
      newId = asChild ? await tana.insertChild(docId, node.id, plainOf(after)) : await tana.insertAfter(docId, node.id, plainOf(after));
      if (after.some((s) => 'mention' in s)) await tana.setText(docId, newId, after); // insert ops take plain text; restore the mentions
      await reload(docId);
    });
  }
  render();
  if (newId) placeCaret(docId + '/' + newId, 0);
}

async function shiftNode(item, el, op, arg) {
  flush(item.key);
  const off = caretOffset(el);
  if (op === 'indent') {
    const siblings = childrenOf(item.parent) || [], prev = siblings[siblings.indexOf(item.node) - 1];
    if (prev) open.set(keyFor(item.docId, prev), true);
  }
  await run(async () => { await tana[op](item.docId, item.node.id, arg); await reload(item.docId); });
  render();
  placeCaret(item.key, off);
}

async function removeNode(item, el) {
  const keys = texts().map(keyOfEl), i = keys.indexOf(item.key);
  dropPending(item.key);
  await run(async () => { await tana.remove(item.docId, item.node.id); await reload(item.docId); });
  render();
  caretNear(keys, i, null);
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
  render();
  if (saved && !focused()) caretNear(keys, keys.indexOf(saved.key), saved.offset);
}

function setOpen(item, value) { open.set(item.key, value); render(); }
function toggleDone(item) {
  if (!isTask(item.node) || item.node.draft) return;
  item.node.done = item.node.done ? 0 : 1;
  if (zoom && zoom.docId === item.docId) extra.set(item.docId, item.node); // the page stays open when the task leaves the filtered view
  render();
  run(() => tana.setDone(item.docId, item.node.done));
}
function zoomTo(item) {
  flushAll(); dropDrafts();
  if (item.node.kind === 'document') recordRecent(item.node);
  let top = item; while (top.parent && top.parent.docId === item.docId) top = top.parent; // the item's document row (itself, or an ancestor in the same document)
  const same = zoom && zoom.docId === item.docId;
  const via = same ? zoom.via : top.parent && zoom ? [...(zoom.via || []), zoom] : undefined; // a document inside a zoomed space: the space stays in the crumb
  if (via && !docOf(item.docId)) extra.set(item.docId, top.node);
  zoom = { docId: item.docId, nodeId: item.node.kind === 'document' ? null : item.node.id, from: same ? zoom.from : undefined, via };
  render();
}
function setView(id) { dropDrafts(); view = id; localStorage.setItem('view', id); zoom = null; sel = null; menu = null; if (id === 'library') loadLibrary(); if (id === 'chats') loadChats(); render(); }
// zoom into a document, switching to its view first when it belongs to another one; from = breadcrumb root instead of the view
function openDoc(docId, from) {
  flushAll(); dropDrafts();
  const s = from ? null : sectionOf(docId);
  if (s && s.id !== view) { view = s.id; localStorage.setItem('view', view); }
  const doc = allDocs().find((d) => d.id === docId) || extra.get(docId);
  if (doc) recordRecent(doc);
  zoom = { docId, nodeId: null, from };
  render();
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

// ---- multi-select: a contiguous range of visible siblings (Shift+Up/Down, Shift+click); blocks can be deleted/moved as one ----
function selKeys() { // keys from anchor to focus in sibling order; a stale or cross-parent selection collapses
  if (!sel) return [];
  const a = nodeElOf(sel.anchor), f = nodeElOf(sel.focus);
  if (!a || !f) { sel = null; return []; }
  if (a.parentElement !== f.parentElement) { sel.anchor = sel.focus; return [sel.focus]; }
  const sibs = nodeEls(a).map((n) => n.dataset.key), i = sibs.indexOf(sel.anchor), j = sibs.indexOf(sel.focus);
  return sibs.slice(Math.min(i, j), Math.max(i, j) + 1);
}
function applySel() { for (const k of selKeys()) nodeElOf(k).classList.add('selected'); }
function leaveText() { const el = document.activeElement; if (el && (outline.contains(el) || el === titleEl) && (el.isContentEditable || el.classList.contains('text'))) { flush(keyOfEl(el)); el.blur(); } }
function extendSel(item, dir) { // grow (or shrink) the range from the focus end; the caret leaves the text
  if (!sel) sel = { anchor: item.key, focus: item.key };
  const f = nodeElOf(sel.focus), next = f && nodeEls(f)[nodeEls(f).indexOf(f) + dir];
  if (next) sel.focus = next.dataset.key;
  leaveText(); render();
}
function clearSel(key) { sel = null; render(); if (key) placeCaret(key); }
async function removeSel(keys) { // Cmd+Shift+Backspace: every selected block, last first; caret to the node before the range
  const all = texts().map(keyOfEl), before = all[all.indexOf(keys[0]) - 1], its = keys.map((k) => items.get(k));
  sel = null;
  for (const it of its) dropPending(it.key);
  await run(async () => { for (const it of [...its].reverse()) await tana.remove(it.docId, it.node.id); await reload(its[0].docId); });
  render();
  const k = before || texts().map(keyOfEl)[0];
  if (k) placeCaret(k); else focusAbove();
}
async function moveSel(keys, dir) { // Cmd+Shift+Up/Down: the whole range, one api.move per node in the order that keeps them adjacent; keys are node ids so the selection follows
  const its = keys.map((k) => items.get(k)), sibs = childrenOf(its[0].parent) || [];
  if (dir === 'up' ? sibs.indexOf(its[0].node) === 0 : sibs.indexOf(its.at(-1).node) === sibs.length - 1) return;
  await run(async () => { for (const it of dir === 'up' ? its : [...its].reverse()) await tana.move(it.docId, it.node.id, dir); await reload(its[0].docId); });
  render();
}
function selKey(e) { // keys while a selection is active (nothing focused); document nodes: delete/move ignored
  const mod = e.metaKey || e.ctrlKey, keys = selKeys();
  if (!keys.length) return false;
  const blocks = items.get(keys[0]).node.kind === 'block', vert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
  if (e.shiftKey && !mod && vert) extendSel(items.get(sel.focus), e.key === 'ArrowUp' ? -1 : 1);
  else if (mod && e.shiftKey && e.key === 'Backspace') { if (blocks) removeSel(keys); }
  else if (mod && e.shiftKey && vert) { if (blocks) moveSel(keys, e.key === 'ArrowUp' ? 'up' : 'down'); }
  else if (e.key === 'Escape' || (e.key.startsWith('Arrow') && !mod)) clearSel(sel.focus);
  else return false;
  return true;
}

// ---- filter pills (Tasks: Status, Assigned to; Library: Type + those two when tasks are listed) with dropdown menus ----
const STATES = [['proposed', 'Inbox'], ['open', 'In Progress'], ['closed', 'Completed'], ['not_now', 'Later']];
const TYPES = [['meetings', 'Meetings', 'meeting'], ['tasks', 'Tasks', 'task'], ['docs', 'Docs', 'doc'], null, ['chats', 'Chats', 'chat'], ['canvases', 'Canvases', 'canvas'], ['agents', 'Agents', 'agent'], ['skills', 'Skills', 'skill']];
const toggleIn = (all, list, v) => { if (!list) return [v]; const next = all.filter((x) => list.includes(x) !== (x === v)); return next.length ? next : null; }; // null = any
const names = (pairs, list) => (list ? pairs.filter((p) => p && list.includes(p[0])).map((p) => p[1]).join(', ') : null);
function loadMembers() { if (!members && tana.members) { members = []; tana.members().then((m) => { members = m; if (!$('pills').hidden) renderPills(true); }, showError); } } // re-render so the Assigned pill reads "You (<name>)"
const me = () => (members || []).find((m) => m.me);
function pillDefs() {
  if (view === 'chats') return [{ id: 'mcp', label: 'MCP chats', value: showMcp ? 'shown' : 'hidden', toggle: () => setMcp(!showMcp) }]; // a toggle, no menu
  const lib = view === 'library', f = lib ? libF : taskF, save = lib ? setLibF : setTaskF, defs = [];
  if (lib) defs.push({ id: 'type', value: names(TYPES, f.types) || 'Any type', icon: f.types && f.types.length === 1 ? TYPES.find((t) => t && t[0] === f.types[0])[2] : null, rows: () => [
    { label: 'Any type', checked: !f.types, run: () => save({ types: null }) },
    ...TYPES.map((t) => (t ? { label: t[1], icon: t[2], checked: !!f.types && f.types.includes(t[0]), run: () => save({ types: toggleIn(TYPES.filter(Boolean).map((x) => x[0]), f.types, t[0]) }) } : { div: true })),
  ] });
  if (!lib || !f.types || f.types.includes('tasks')) {
    defs.push({ id: 'status', label: 'Status', value: names(STATES, f.states) || 'Any', rows: () => [
      { label: 'Any status', checked: !f.states, run: () => save({ states: null }) },
      ...STATES.map(([v, l]) => ({ label: l, checked: !!f.states && f.states.includes(v), run: () => save({ states: toggleIn(STATES.map((s) => s[0]), f.states, v) }) })),
    ] });
    loadMembers();
    const you = 'You' + (me() ? ' (' + me().title + ')' : '');
    const a = f.assignee, m = (members || []).find((x) => x.id === a), who = a === 'anyone' ? 'Anyone' : a === 'unassigned' ? 'Unassigned' : a === 'me' || !a ? you : m ? m.title : '…';
    defs.push({ id: 'assigned', label: 'Assigned to', value: who, rows: () => [
      { label: 'Anyone', checked: a === 'anyone', run: () => save({ assignee: 'anyone' }) },
      { label: you, checked: a === 'me' || !a, run: () => save({ assignee: 'me' }) },
      { label: 'Unassigned', checked: a === 'unassigned', run: () => save({ assignee: 'unassigned' }) },
      { head: 'Members' },
      ...(members || []).filter((x) => !x.me).map((x) => ({ label: x.title, checked: a === x.id, run: () => save({ assignee: x.id }) })),
    ] });
  }
  return defs;
}
function renderPills(show) {
  const box = $('pills'), defs = show ? pillDefs() : [];
  box.hidden = !defs.length;
  const focusedId = box.contains(document.activeElement) && document.activeElement.closest('.pill') ? document.activeElement.closest('.pill').dataset.id : null;
  if (menu && !defs.some((d) => d.id === menu.id)) menu = null;
  box.replaceChildren(...defs.map((d) => {
    const pill = document.createElement('div'); pill.className = 'pill' + (menu && menu.id === d.id ? ' open' : ''); pill.tabIndex = 0; pill.dataset.id = d.id; pill.setAttribute('role', 'button');
    if (d.icon) { const s = document.createElement('span'); s.innerHTML = iconSvg(d.icon); pill.append(s.firstChild); }
    if (d.label) pill.append(d.label);
    const b = document.createElement('b'); b.textContent = d.value; pill.append(b);
    pill.onmousedown = (e) => { if (e.target.closest('.menu')) e.preventDefault(); }; // menu clicks keep the pill focused
    pill.onclick = (e) => { if (d.toggle) d.toggle(); else if (!e.target.closest('.menu')) { menu = menu && menu.id === d.id ? null : { id: d.id, index: 0 }; renderPills(true); pill.focus(); } };
    pill.onkeydown = (e) => pillKeys(e, d, pill);
    if (menu && menu.id === d.id) pill.append(menuEl(d));
    return pill;
  }));
  const again = focusedId && box.querySelector('.pill[data-id="' + focusedId + '"]');
  if (again) again.focus();
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
    row.onclick = () => { menu.index = pick.indexOf(r); r.run(); };
    el.append(row);
  }
  return el;
}
function pillKeys(e, d, pill) {
  const open = menu && menu.id === d.id, pick = open ? d.rows().filter((r) => r.label) : [];
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); menu.index = (menu.index + (e.key === 'ArrowDown' ? 1 : pick.length - 1)) % pick.length; renderPills(true); }
  else if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick[menu.index].run(); }
  else if (open && e.key === 'Escape') { e.preventDefault(); menu = null; renderPills(true); }
  else if (open && e.key === 'Tab') { menu = null; renderPills(true); }
  else if (d.toggle && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); d.toggle(); }
  else if (!open && !d.toggle && (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown')) { e.preventDefault(); menu = { id: d.id, index: 0 }; renderPills(true); }
  else if (!open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); const s = e.key === 'ArrowLeft' ? pill.previousElementSibling : pill.nextElementSibling; if (s) s.focus(); }
  else if (!open && e.key === 'Escape') { e.preventDefault(); pill.blur(); }
}
document.addEventListener('mousedown', (e) => { if (menu && !(e.target.closest && e.target.closest('.pill'))) { menu = null; renderPills(true); } });
// Library search box: server-side text, debounced 300 ms; Enter applies now, Down moves on to the pills
$('libText').addEventListener('input', () => { clearTimeout(libTimer); libTimer = setTimeout(() => setLibF({ text: $('libText').value.trim() }), 300); });
$('libText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(libTimer); setLibF({ text: $('libText').value.trim() }); }
  else if (e.key === 'Escape') { e.preventDefault(); $('libText').value = ''; clearTimeout(libTimer); setLibF({ text: '' }); $('libText').blur(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); const p = $('pills').firstElementChild; if (p) p.focus(); }
});

// ---- page title (zoomed into a document): edits go through the same debounce as node text; Enter -> first child, Esc restores ----
titleEl.addEventListener('input', () => { const item = items.get(titleEl.dataset.key); if (item) scheduleSave(item, [{ text: titleEl.textContent }]); });
titleEl.addEventListener('blur', () => flush(titleEl.dataset.key));
titleEl.addEventListener('keydown', (e) => {
  const item = items.get(titleEl.dataset.key);
  if (!titleEl.isContentEditable || !item) return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleDone(item); }
  else if (e.key === 'Enter') { e.preventDefault(); flush(item.key); const first = texts()[0]; if (first) setCaret(first, 0); else titleEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); dropPending(item.key); titleEl.textContent = item.node.text; titleEl.blur(); }
  else if (e.key === '@' && !getSelection().isCollapsed) { const range = selectionOffsets(titleEl); if (range) { e.preventDefault(); startLink(item, titleEl, range); } }
  else if (e.key === 'ArrowDown' && atEdge(titleEl, 'down')) { const first = texts()[0]; if (first) { e.preventDefault(); flush(item.key); setCaret(first, 0); } }
});
// the document Cmd+K context actions apply to: the zoomed one, else the document whose node is focused
function currentDoc() {
  const f = focused(), item = f && items.get(f.key);
  const docId = zoom ? zoom.docId : item ? item.docId : null;
  const d = docId && (allDocs().find((x) => x.id === docId) || extra.get(docId));
  return d && !d.draft ? d : null;
}
// ---- pins (api.pins / pinState / pin / unpin) ----
function loadPins() {
  if (!tana.pins) return;
  const doc = palDoc;
  Promise.all([tana.pins(), doc && tana.pinState(doc.id)]).then(([p, s]) => {
    pins = p; pinInfo = s ? { docId: doc.id, ...s } : null;
    if (!palette.hidden && palMode === 'cmd') renderPalette();
  }, showError);
}
function pinAction(op, target) { run(async () => { await tana[op](pinInfo.docId, target); loadPins(); }); }
// ---- custom icons (api.setIcon): "Set icon…" drop overlay, or an .svg dropped straight onto a document line ----
function setIcon(docId, svg) {
  const d = allDocs().find((x) => x.id === docId) || extra.get(docId);
  if (d) d.iconSvg = svg || undefined;
  render();
  run(() => tana.setIcon(docId, svg));
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
  if (item.node.draft) { // empty draft: Enter/Tab do nothing, Backspace drops it (caret to the node above); typing creates it (input handler)
    if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault();
    if (e.key === 'Backspace' && len === 0) { e.preventDefault(); const all = texts(), prev = all[all.indexOf(el) - 1], k = prev && keyOfEl(prev); dropDraft(item); return k ? placeCaret(k) : focusAbove(); }
    if (e.key !== 'Escape' && !(e.key.startsWith('Arrow') && !mod)) return;
  }
  if (isImage(item.node)) { // not editable: Backspace / ⌘⇧⌫ removes, Up/Down step past, Shift+Up/Down select, ⌘⇧Up/Down moves; everything else is swallowed
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
  if (e.key === 'Escape') { e.preventDefault(); flush(item.key); el.blur(); }
  else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.shiftKey && !mod) { e.preventDefault(); extendSel(item, e.key === 'ArrowUp' ? -1 : 1); } // multi-select over siblings
  else if (e.key === '@' && !collapsed) { const range = selectionOffsets(el); if (range) { e.preventDefault(); startLink(item, el, range); } } // no selection: "@" is typed
  else if (e.key === 'Enter' && mod) { e.preventDefault(); if (isDoc) toggleDone(item); }
  else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); insertAtCaret(el, '\n'); }
  else if (e.key === 'Enter' && isDoc && item.parent) e.preventDefault(); // document child (inside a space): nothing to split or draft yet
  else if (e.key === 'Enter' && isDoc && !zoom && !isOpen(item)) { e.preventDefault(); draftDoc(item); } // collapsed document in a view: draft sibling document
  else if (e.key === 'Enter') { e.preventDefault(); splitNode(item, el, off ?? len); }
  else if (e.key === 'Tab') { e.preventDefault(); if (!isDoc) shiftNode(item, el, e.shiftKey ? 'outdent' : 'indent'); }
  else if (e.key === 'Backspace' && mod && e.shiftKey) { e.preventDefault(); if (!isDoc) removeNode(item, el); }
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
  if (!item.node.draft) scheduleSave(item, readSegs(el));
  else if (!item.busy) { item.busy = true; materialise(item, el); }
});
outline.addEventListener('focusout', (e) => {
  const el = e.target, item = el.classList && el.classList.contains('text') && items.get(keyOfEl(el));
  if (!item) return;
  if (!item.node.draft) flush(item.key);
  else if (!el.textContent && !item.busy && el.isConnected) dropDraft(item); // left empty: no node is created
});
outline.addEventListener('mousedown', (e) => {
  if (!e.target.closest) return;
  if (e.target.closest('.mention')) e.preventDefault();
  const line = e.shiftKey && e.target.closest('.line');
  if (line) { // Shift+click: range from the focused (or anchored) node to this one
    e.preventDefault();
    const key = line.parentElement.dataset.key, f = focused();
    sel = { anchor: sel ? sel.anchor : f ? f.key : key, focus: key };
    leaveText(); render();
  }
});
outline.addEventListener('focusin', () => { if (sel) { sel = null; for (const n of outline.querySelectorAll('.selected')) n.classList.remove('selected'); } }); // the caret is back in a node
outline.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('.mention'); if (a) { e.preventDefault(); goTo(a.dataset.uri); } });

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
  else if (mod && e.shiftKey && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_' || e.key === '0')) { e.preventDefault(); setZoom(e.key === '0' ? 1 : zoomFactor * (e.key === '-' || e.key === '_' ? 1 / 1.1 : 1.1)); }
  else if (mod && e.key === 's') { e.preventDefault(); togglePalette('search'); }
  else if (mod && e.key === 'r') { e.preventDefault(); run(() => tana.refresh()); } // Sync (no native menu item any more)
  else if (!palette.hidden) return;
  else if (sel && document.activeElement === document.body && (e.defaultPrevented || selKey(e))) e.preventDefault(); // selection keys; a Shift+Arrow already handled in the node stops here (focus is on body by now)
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
let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer;
const docRow = (n, hint, run) => ({ node: n, icon: n.icon, svg: n.iconSvg, label: n.text ?? n.title, tags: n.tags, hint, run });
function paletteRows(q) {
  const rows = sections.map((s) => ({ id: 'view:' + s.id, group: 'Views', icon: s.icon, label: s.title, run: () => setView(s.id) }));
  for (const n of pins) rows.push({ ...docRow(n, undefined, () => openResult(n, sectionOf(n.id) ? undefined : 'Pinned')), id: 'pinned:' + n.id, group: 'Pinned', right: 'pin' }); // in a view: open it there; else breadcrumb "Pinned"
  rows.push({ id: 'sync', group: 'Actions', icon: 'sync', label: 'Sync', kbd: '⌘R', run: () => run(() => tana.refresh()) });
  if (!authed) rows.push({ id: 'login', group: 'Actions', label: 'Log in to Tana', run: () => tana.login().catch(showError) });
  if (pinInfo && palDoc && pinInfo.docId === palDoc.id) { // context actions for the current document (no ids: their labels depend on state, so no hotkeys)
    const sb = pinInfo.sidebar, td = pinInfo.dates.includes(localDate());
    rows.push({ group: 'Actions', icon: 'pin', label: sb ? 'Unpin from sidebar' : 'Pin to sidebar', run: () => pinAction(sb ? 'unpin' : 'pin', 'sidebar') });
    rows.push({ group: 'Actions', icon: 'pinDate', label: td ? 'Unpin from today' : 'Pin to today', run: () => pinAction(td ? 'unpin' : 'pin', 'today') });
  }
  if (palDoc && tana.setIcon) {
    rows.push({ group: 'Actions', label: 'Set icon…', run: () => startDrop(palDoc) });
    if (palDoc.iconSvg) rows.push({ group: 'Actions', label: 'Remove icon', run: () => setIcon(palDoc.id, null) });
  }
  if (q) for (const s of sections) for (const n of s.nodes) rows.push({ ...docRow(n, s.title, () => openDoc(n.id)), id: 'doc:' + n.id, group: 'Documents' });
  let docsLeft = 8;
  return rows.filter((r) => (!q || r.label.toLowerCase().includes(q)) && (r.group !== 'Documents' || docsLeft-- > 0)).map((r) => (hotkeys[r.id] ? { ...r, kbd: hotkeys[r.id] } : r));
}
// a recorded hotkey runs its palette row's action (views/sync/login by id; documents wherever they live)
function runAction(id) {
  const row = paletteRows('').find((r) => r.id === id);
  if (row) row.run(); else if (id.startsWith('doc:')) goTo(id.slice(4));
}
// search result / pin: zoom into it wherever it lives (api.node shape -> extra); from = breadcrumb root when not opened in its view
function openResult(n, from) {
  if (!allDocs().some((d) => d.id === n.id)) extra.set(n.id, asDoc(n));
  openDoc(n.id, from);
}
// result rows pick a document: open it, or link it when the palette was opened with "@" on a selection (Create row first)
function resultRows(nodes, group) {
  const ctx = linkCtx;
  const rows = nodes.map((n) => ({ ...docRow(n, n.meta, () => (ctx ? linkTo(ctx, { label: n.title ?? n.text, uri: n.id }) : openResult(n, 'Search'))), group }));
  if (!ctx) return rows;
  const exists = nodes.some((n) => ((n.title ?? n.text) || '').trim().toLowerCase() === ctx.text.trim().toLowerCase()); // exact title: link, don't offer Create
  return exists ? rows : [{ label: 'Create “' + ctx.text + '”', hint: '⌘↩', run: () => createAndLink(ctx) }, ...rows];
}
function searchNow() {
  const q = palInput.value.trim(), seq = ++palSeq;
  palTimer = null; palBusy = !!q;
  if (!q) { palRows = resultRows(recent(), 'RECENTLY VIEWED'); return renderPalette(); }
  tana.search(q).then((nodes) => {
    if (seq !== palSeq || palMode !== 'search') return; // stale response
    palRows = resultRows(nodes); palIndex = 0; palBusy = false;
    renderPalette();
  }, showError);
}
function renderPalette() {
  const q = palInput.value.trim();
  if (palMode === 'cmd') palRows = paletteRows(q.toLowerCase());
  palIndex = Math.max(0, Math.min(palIndex, palRows.length - 1));
  const els = [];
  palRows.forEach((r, i) => {
    if (r.group && (!i || palRows[i - 1].group !== r.group)) { const h = document.createElement('div'); h.className = 'group'; h.textContent = r.group; els.push(h); }
    const row = document.createElement('div'); row.className = 'row' + (i === palIndex ? ' active' : ''); row.dataset.index = i;
    const icon = document.createElement('span'); icon.className = 'ricon' + (r.node ? ' ' + (r.svg ? 'custom' : r.icon || 'dot') : ''); icon.innerHTML = r.svg || (r.icon ? iconSvg(r.icon) : '');
    const label = document.createElement('span'); label.className = 'label'; label.textContent = r.label;
    for (const t of r.tags || []) label.append(chipEl(t));
    row.append(icon, label);
    if (r.right) { const s = document.createElement('span'); s.className = 'ricon right'; s.innerHTML = iconSvg(r.right); row.append(s); }
    if (r.kbd) { const k = document.createElement('kbd'); k.textContent = r.kbd; row.append(k); }
    if (r.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = r.hint; row.append(h); }
    row.onmousedown = (e) => e.preventDefault();
    row.onclick = () => runRow(r);
    els.push(row);
  });
  if (!palRows.some((r) => palMode === 'cmd' || r.node) && (palMode === 'cmd' || (q && !palBusy))) { const n = document.createElement('div'); n.className = 'group'; n.textContent = 'No results'; els.push(n); }
  palList.replaceChildren(...els);
  const active = palList.querySelector('.row.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
// opens the palette in mode, closes it when already open in that mode; opening one mode closes the other.
// link = @ linking context: search mode prefilled with the selected text
function togglePalette(mode, link) {
  const show = palette.hidden || palMode !== mode || !!link;
  cancelLink();
  palette.hidden = !show;
  if (!show) { clearTimeout(palTimer); palTimer = null; return returnFocus(); }
  if (!palReturn) palReturn = focused(); // switching modes keeps the original return target
  linkCtx = link || null;
  palMode = mode; palRows = []; palIndex = 0; palBusy = false; clearTimeout(palTimer); palTimer = null;
  if (mode === 'cmd') { palDoc = currentDoc(); loadPins(); }
  palInput.placeholder = mode === 'search' ? 'Search Tana' : 'Search or run a command';
  palInput.value = link ? link.text : '';
  if (mode === 'search') searchNow(); else renderPalette();
  palInput.focus();
}
function closePalette() { palette.hidden = true; clearTimeout(palTimer); palTimer = null; cancelLink(); returnFocus(); }
// back to the node that had the caret when the palette opened (the @ link path places its own caret)
function returnFocus() { const r = palReturn; palReturn = null; if (r && !focused()) placeCaret(r.key, r.offset); }
function runRow(r) { closePalette(); r.run(); }
palInput.addEventListener('input', () => {
  palIndex = 0;
  if (palMode === 'cmd') return renderPalette();
  palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchNow, 150);
});
palInput.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && palRows.length) { e.preventDefault(); palIndex = (palIndex + (e.key === 'ArrowDown' ? 1 : palRows.length - 1)) % palRows.length; renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); const r = mod && linkCtx ? palRows[0] : palRows[palIndex]; if (r) runRow(r); } // ⌘↩ = Create row
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
function showStatus(s) {
  const was = authed;
  authed = !!s.authenticated; connected = !!s.connected;
  $('loginBox').hidden = !!s.authenticated;
  outline.hidden = $('filtered').hidden = !s.authenticated;
  showError(s.error);
  render(); // auth/connection state drives the skeleton; a newly visible outline applies the view's opening scroll
}
$('login').onclick = () => tana.login().catch(showError);

// ---- live updates ----
tana.onChanged((docId) => {
  const work = [loadRoots()];
  if (docId && kids.has(docId)) work.push(reload(docId));
  if (!docId) { loadPins(); if (view === 'chats') loadChats(); }
  Promise.all(work).then(render, showError);
});
tana.onStatus(showStatus);
loadRoots().then(render, showError).then(loadFilters);
tana.status().then(showStatus, showError);
