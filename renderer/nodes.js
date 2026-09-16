'use strict';
// The item model over Node trees (keys, children, editability), display helpers (chips, glyphs, tags, sensitive blur, recently viewed) and loading the views from the api.

const CHEV = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>';
const allDocs = () => views.flatMap((s) => s.nodes);
const sectionOf = (docId) => views.find((s) => s.nodes.some((n) => n.id === docId));
const viewOf = () => views.find((s) => s.id === view) || views[0];
const keyFor = (docId, node) => (node.kind === 'document' ? docId : docId + '/' + node.id);
// An item keeps its identity across renders: the row's event handlers hold it, so a reused row (render.js) keeps
// working, and a rebuilt one sees the current node through the same object. rendered is the set of keys this render
// touched; renderOutline drops the rest when it is done.
const rendered = new Set();
const mkItem = (docId, node, parent) => {
  const key = keyFor(docId, node);
  let item = items.get(key);
  if (item) { item.node = node; item.docId = docId; item.parent = parent; } else { item = { key, node, docId, parent }; items.set(key, item); }
  rendered.add(key);
  return item;
};
// docOf is asked once per block row of a zoomed document, so a linear scan over every view's rows became quadratic;
// hits are cached until the next render clears them (a miss still scans: extra fills between renders).
const docCache = new Map();
const docOf = (id) => { let d = docCache.get(id); if (!d) { d = allDocs().find((x) => x.id === id) || extra.get(id); if (d) docCache.set(id, d); } return d; };
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
// The same SVG parsed once, then cloned per row: rows used to re-parse their icon markup on every render.
const iconTemplates = new Map();
function iconNode(icon) {
  let t = iconTemplates.get(icon);
  if (t === undefined) { const tpl = document.createElement('template'); tpl.innerHTML = iconSvg(icon); t = tpl.content.firstElementChild; iconTemplates.set(icon, t); }
  return t ? t.cloneNode(true) : null;
}
const isTask = (node) => node.kind === 'document' && node.icon === 'task';
// an unchecked Inbox task: its (dashed) box accepts it, In Progress, before a second click completes it
const acceptsFirst = (node) => isTask(node) && !node.done && node.stateType === 'proposed';
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
  for (const s of views) if (s.truncated) truncated.add(s.id); else if (s.truncated === false) truncated.delete(s.id); // roots carry the cap flag, so a refresh needs no second query
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
  // The rows arrive while the caret is still in the row that was just expanded (⌘↓), which a plain render() would
  // wait out, leaving "Loading…" until the caret moves; this render is the answer to that keypress, so it is forced.
  // A failed load closes the row again and forgets the attempt, so the next ⌘↓ retries instead of loading forever.
  reload(item.docId).then(() => render(true), (e) => { kids.delete(item.docId); open.set(item.key, false); showError(e); render(true); });
}
