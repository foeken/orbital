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
// A document drawn twice on one page (the Timeline lists a task under Today's Tasks and again where it landed in your
// Inbox) is two rows: the second copy this render gets its own key, after its parent's, or both rows shared one item and
// the last drawn won it — a click on the first box ticked the other copy, and the row clicked only caught up when the
// page was read again, flashing as each read landed.
const mkItem = (docId, node, parent) => {
  let key = keyFor(docId, node);
  if (rendered.has(key) && items.get(key)?.node !== node) key += '@' + (parent ? parent.key : '');
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
// A saved search is the same shape as a space: what it lists are the rows its stored query returns, not content
// anyone typed into it. It stays editable so its title can be renamed — only its body is off limits.
const SEARCH_ID = 'tana:search:';
const isSearchDoc = (node) => !!node && String(node.id || '').startsWith(SEARCH_ID);
const onSearchPage = () => !!zoom && !zoom.nodeId && String(zoom.docId || '').startsWith(SEARCH_ID);
// A type's page is the list of its instances, filtered by its fields: a result page like a saved search, whose filter
// lives in your preferences rather than in a document (typeFilter below). The type's own document has no outline.
const isTypeId = (id) => /^tana:type:[^|?]+$/.test(String(id || ''));
const isTypeDoc = (node) => !!node && isTypeId(node.id);
const onTypePage = () => !!zoom && !zoom.nodeId && isTypeId(zoom.docId);
const childrenOf = (item) => (item.node.kind === 'document' ? kids.get(item.docId) : item.node.children || []);
const hasKids = (item) => {
  if (item.node.timeline?.today) return true;
  const c = childrenOf(item);
  return Array.isArray(c) ? c.length > 0 : !!item.node.hasChildren;
};
const isOpen = (item) => (open.has(item.key) ? open.get(item.key) : item.node.kind === 'block');
const canInsertChild = (item) => item.node.kind === 'document' || hasKids(item) || item.node.done != null || (!isAtomic(item.node) && ['paragraph', 'bullet', 'numbered'].includes(item.node.block));
const canExpand = (item) => hasKids(item) || (!item.node.draft && canEditItem(item));
function draftNode(parent, prev) { // shown under an expanded empty node; created on the first typed character
  // It is drawn as what main will write it as the moment it is typed into (materialise): after a row, whatever
  // that row makes of a sibling; as the first row of a document, plain text; and as a child of a block, a
  // bullet, because a child is a listItem in Tana's schema whatever its parent is.
  const block = prev ? siblingBlock(prev) : parent.node?.kind === 'document' ? siblingBlock(parent.node) : 'bullet';
  return { id: 'draft:' + parent.key, text: '', kind: 'block', block, done: parent.node?.kind !== 'document' && parent.node?.done != null ? 0 : undefined, draft: true };
}
// Draft documents stay local until their first title character, then use their selected native kind/type.
function draftDocNode(kind, option = {}) {
  const nativeKind = kind === 'custom' ? (['task', 'meeting'].includes(option.icon) ? option.icon : 'doc') : kind; // a type with a workflow makes a task (main/documents.js customCreation, #534), so its draft has a box
  // A saved search is the one kind that cannot be created from a title alone: createDocument refuses a search with
  // no query, because searchChildren reads an empty query container as unreadable. The empty query is a real one —
  // writeSearchQuery materialises every key — so a search starts by finding everything and is narrowed by the pills.
  return { id: 'draftdoc:' + (++draftSeq), text: '', kind: 'document', draft: kind, createOptions: { kind, ...(option.typeUri ? { typeUri: option.typeUri } : {}), ...(kind === 'search' ? { query: {} } : {}) }, icon: option.icon || nativeKind, tags: option.tags || [{ label: nativeKind, color: nativeKind === 'meeting' ? 'gold' : 'grey' }], done: nativeKind === 'task' ? 0 : undefined, hasChildren: false };
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
const BLOCK_GLYPH = { paragraph: 'T', heading1: 'H1', heading2: 'H2', heading3: 'H3', bullet: '•', numbered: '1.', quote: '❝', divider: '—' };
// A row with no type of its own is an outline row: every row readOutline returns carries one, so this is the
// mock's rows and anything built by hand. The draft tail states the mode it will be written in (draftNode).
const blockTypeOf = (node) => (BLOCK_LABEL.has(node.block) ? node.block : node.heading ? 'heading' + node.heading : 'bullet');
const headingOf = (node) => node.heading || Number((blockTypeOf(node).match(/^heading(\d)$/) || [])[1]) || 0;
// What the write will make of a new sibling of this row (sdk/content.js insertAfter), so a row the renderer shows
// before the write lands is already the right kind and nothing flashes under the caret: a list row makes a list
// row, a quote stays in its quote, and a heading, a code block or a document's own first row is plain text.
const siblingBlock = (node) => (node.kind === 'block' && ['bullet', 'numbered', 'quote'].includes(node.block) ? node.block : 'paragraph');
// A row that is another node's child rather than one of the document's own rows. Tana keeps children inside their
// parent's listItem, which has no place for a bare paragraph, so only a document's own rows can be plain text
// (sdk/content.js refuses the rest). Zooming does not change the answer: what counts is the row's real parent.
const nestedRow = (item) => item?.parent?.node?.kind === 'block';
// the icon slot of a palette/menu row: a real icon where we have one, else the text glyph. The icon sits in the
// same slot so it matches the weight of H1/•/1. beside it.
function glyphSvg(type) { return ['code', 'table', 'image'].includes(type) ? '<span class="glyph icon">' + iconSvg(type) + '</span>' : '<span class="glyph">' + (BLOCK_GLYPH[type] || '') + '</span>'; }
const images = new Map(); // image uri -> data URL (or the pending api.image promise)
// image uri -> Promise<title | ''>: the title Tana's AI gives an image document after its upload, read once
const imageTitles = new Map();
const imageTitle = (uri) => { if (!imageTitles.has(uri)) imageTitles.set(uri, Promise.resolve(tana.node ? tana.node(uri) : null).then((n) => n?.title || '', () => '')); return imageTitles.get(uri); };
const isImage = (node) => node.type === 'image';
const isDivider = (node) => node.block === 'divider' || node.type === 'divider';
const isAtomic = (node) => isImage(node) || isDivider(node) || !!node.table || !!node.upload; // shown, focusable, never typed into (a table's cells edit on their own: renderer/table.js; an upload is its placeholder: renderer/upload.js)
const isReference = (node) => node.type === 'reference';
// Tana's full-reference presentation: a block whose whole content is one mention stands in for the node it points at
// — its box, its status, its tags — and becomes an ordinary line with a link again the moment anything else is typed.
// Children rule it out: the row stands in for another node, and expanding it opens that node's outline, so a block
// with an outline of its own would have nowhere left to show it.
const oneMention = (segs) => segs.length === 1 && !!segs[0].mention;
const isFullReference = (node) => node.kind === 'block' && !isReference(node) && !node.hasChildren && !node.children?.length && oneMention(segsOf(node));
const referenceTarget = (node) => ((isReference(node) || isFullReference(node)) && node.reference?.node ? asDoc(node.reference.node) : null);
// What the row stands in for *right now*. A save is debounced, so between the keystroke and the write the node still
// carries the segments from before it: a full reference typed into would keep the other node's chrome — its box, its
// tags, its strikethrough — until the write came back, most of a second later. With an edit in flight the row is
// judged by what is in the editor (the same pending segments the text is drawn from), so text beside the chip makes
// it an ordinary line at once, and deleting that text makes it a full reference again. An inline reference (type
// 'reference') is unaffected: typing there edits the target's title, so it never stops pointing at it.
const liveTarget = (node, typing) => (typing && !isReference(node) && !oneMention(typing.segs) ? null : referenceTarget(node));
const referenceLabel = (node) => referenceTarget(node)?.text || node.reference?.label || node.text || node.reference?.uri || 'Unavailable reference';
// A notice ("Link copied", "Classified as …") and an error from an action are both a toast at the foot of the window
// that fades on its own; an error is red and stays longer. The line under the title is only the signed-out state
// with its relogin button (app.js), which writing into it used to wipe out (#123).
let toastTimer = null;
// open: the node the note is about (a task just made, a meeting just pinned to), which a click on the toast opens;
// such a toast stays a little longer, so there is time to reach it (#532)
function showNote(note, error = false, open = null) {
  const el = $('toast');
  el.textContent = note; el.classList.toggle('error', error); el.classList.add('show');
  el.classList.toggle('opens', !!open);
  el.onclick = open ? () => { el.classList.remove('show'); goTo(open); } : null;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), error ? 6000 : open ? 5000 : 2500); // a newer toast gets its own time
}
const showError = (e) => { if (e && !signedOut) showNote(String(e.message || e), true); }; // signed out, what still fails is the old session's
const run = (fn) => (queue = queue.then(fn).then((value) => { showError(null); return value; }, showError));
// A row on its way out is not a keyboard stop.
// A field that holds choices (renderer/fields.js) is one stop, and a caret stop all the same.
// (not a row leaving, nor one in a block or section that is closing up: inert, renderer/motion.js foldRow/foldSection)
const rowsIn = (root) => [...root.querySelectorAll('.node:not(.leaving) .text, .fchoice')].filter((el) => !el.closest('[inert]'));
// A field value's rows are addressed "<document>|<type>?attribute=<key>" (docs/OUTLINER.md): the outline's own
// rows, drawn under the title, where a row is one line of a list rather than a page in its own right.
const inField = (docId) => typeof docId === 'string' && docId.includes('|tana:type:');
// A type row opens on a click or Enter anywhere on it: its page is where it is renamed (renderer/render.js, events.js)
// a table's row too: its title is a column to click into, not text to type in (renderer/views.js tableView)
const opensOnClick = (item) => (isTypeDoc(item.node) && !inField(item.docId)) || (tableRow(item.parent) && !item.node.draft && zoomable(item.node));
// A row that opens on a click opens from what it draws (words, time, chips, faces), never from the empty width beside
// them: those land on the row's own boxes, which span the pane (#518). styles.css draws the pointer the same way.
const onRowBlank = (e) => !!e.target.matches?.('.line, .body');
// `texts()` is the outline's own rows: what "the first node" means, and the list every structural step works in —
// removing a row, merging into the one above, selecting a range. A field's rows are their own list for the same
// reason: they are a different outline, and Backspace at the start of the page's first row must not reach into
// the field above it.
const texts = () => rowsIn(outline).filter((el) => !el.closest('.fvalues'));
const fieldValues = () => ($('fields').hidden ? [] : rowsIn($('fields')));
const rowsBeside = (el) => { const field = el && el.closest('.fvalues'); return field ? rowsIn(field) : texts(); };
// Every stop the caret can reach on the page, in reading order: the title, the fields under it, then the outline.
// Only vertical movement uses this — moving down out of a field into the page is a caret moving, not a row
// changing what it belongs to.
const caretRows = () => [...(titleEl.isContentEditable ? [titleEl] : []), ...fieldValues(), ...rowsIn(outline)];
const titleEl = $('title');  // zoomed into a document: contenteditable with data-key = that document's key
const keyOfEl = (el) => (el.closest('.node') || el).dataset.key;
// Rows are drawn in two places — the page's outline and the fields under the title — and everything that *finds* a
// row has to know both, or a feature works in one and not the other. That was the pattern behind every "it does
// not work in fields" bug: the editor is shared, these three lookups were not.
const rowRoots = () => [outline, $('fields')];
const queryRow = (selector) => { for (const root of rowRoots()) { const found = root.querySelector(selector); if (found) return found; } return null; };
const eachRow = (selector) => rowRoots().flatMap((root) => [...root.querySelectorAll(selector)]);
const inRows = (el) => !!el && rowRoots().some((root) => root.contains(el));
const textEl = (key) => queryRow('.node[data-key="' + CSS.escape(key) + '"] > .line .text') || (titleEl.isContentEditable && titleEl.dataset.key === key ? titleEl : null);
const nodeElOf = (key) => queryRow('.node[data-key="' + CSS.escape(key) + '"]');
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
// Glyphs a type has been given (main/icons.js): the Nucleo set is built into the app but stays in main, so what
// arrives here is the handful actually in use, plus whatever a search page is showing. Registered before the rows
// that name them are drawn (loadRoots below), so a bullet never renders empty and waits for a second render.
const customIcons = new Map(); // 'nc-<label>' -> svg markup
const typeGlyphs = new Map(); // type uri -> the icon name it is drawn with, so the picker knows what it has now
const typeGlyph = (uri) => typeGlyphs.get(uri) || (String(uri).startsWith(SEARCH_ID) ? 'search' : 'type'); // how a type or a saved search is drawn wherever it is listed: its own icon, else the generic one
function registerIcons(list) {
  for (const icon of Array.isArray(list) ? list : []) {
    if (!icon || typeof icon.name !== 'string' || typeof icon.svg !== 'string') continue;
    if (customIcons.get(icon.name) === icon.svg) continue;
    customIcons.set(icon.name, icon.svg);
    iconTemplates.delete(icon.name); // a name that is drawn from new markup must not keep the parsed copy
  }
}
// The whole answer, not a patch: a type whose icon was cleared has to leave the map with it.
function setTypeGlyphs(list) {
  typeGlyphs.clear();
  for (const icon of Array.isArray(list) ? list : []) if (icon && icon.uri) typeGlyphs.set(icon.uri, icon.name);
  registerIcons(list);
}
const iconSvg = (icon) => ICONS[icon === 'meeting' ? 'calendar' : icon] || LIB_ICONS[icon] || customIcons.get(icon) || '';
// The same SVG parsed once, then cloned per row: rows used to re-parse their icon markup on every render.
const iconTemplates = new Map();
function iconNode(icon) {
  let t = iconTemplates.get(icon);
  if (t === undefined) { const tpl = document.createElement('template'); tpl.innerHTML = iconSvg(icon); t = tpl.content.firstElementChild; iconTemplates.set(icon, t); }
  return t ? t.cloneNode(true) : null;
}
// The glyph appended to el, which it answers; a name with no glyph appends nothing. Every icon in the UI is drawn
// this way or through iconNode (scripts/renderer-check.js): a new span is addIcon(span, 'field'), a button that
// swaps its glyph is b.replaceChildren() and then addIcon(b, name).
function addIcon(el, icon) { const svg = icon ? iconNode(icon) : null; if (svg) el.append(svg); return el; }
const isTask = (node) => node.kind === 'document' && node.icon === 'task';
// A member is a fact about other nodes, not a page: nothing zooms into one (bullet, Space, Open node). A type opens as
// the list of its instances (renderer/render.js).
const zoomable = (node) => !!node && !/^tana:user-profile:/.test(node.id || '');
// A task put off is drawn with the zzz glyph instead of the task one: the row still is a task (its box, its
// status, its metadata are unchanged), it only says at a glance that it is asleep.
// A task keeps 'task' as its icon (that is what isTask reads), so its type's glyph — the one a typed document wears
// (main/rows.js) — is chosen here at draw time; Later's own glyph still wins, it says what the task is doing.
// A type or a saved search wears the glyph chosen for it now (typeGlyphs), not the one on the copy a page opened with:
// Set icon changes it under the open page, its title and its tab (#523).
const iconOf = (node) => (isTypeDoc(node) || isSearchDoc(node) ? typeGlyph(node.id) : isTask(node) && node.stateType === 'not_now' ? 'later' : (isTask(node) && typeGlyphs.get((node.tags || []).map((t) => t && t.uri).find(Boolean))) || node.icon);
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
  // the document a row belongs to decides; an app page (Proposals, Notifications, the Timeline) lists documents and owns none
  for (let parent = item.parent; parent; parent = parent.parent) if (parent.node.kind === 'document' && !parent.node.appPage) return canEditNode(parent.node);
  if (item.parent?.node.appPage) return true; // a document listed on one: its own editability, checked above
  return canEditNode(docOf(item.docId) || item.node);
}
// A reference and a divider are read-only rows, but they are still blocks of a writable document: they can be moved and removed.
const canEditStructure = (item) => canEditItem(item) || ((item.node.type === 'reference' || isDivider(item.node) || !!item.node.table) && canEditNode(docOf(item.docId)));
// an inline reference renders the referenced document's title: editing the row edits that document, and a read-only
// target stays read-only. The containing document counts too: a chat's attachment row would otherwise offer to
// rename the attached document (only a positively read-only container blocks, so ordinary embeds are unchanged).
const canEditText = (item) => (isReference(item.node) ? canEditNode(referenceTarget(item.node)) && docOf(item.docId)?.editable !== false : canEditItem(item) || !!item.node.renamable); // renamable: a chat, agent, skill or type, whose title alone can be typed in (#540)
const chatIcon = (n) => n.icon || ((n.tags || []).some((t) => t.label === 'chat') ? 'chat' : undefined);
const nodeIcon = (n) => chatIcon(n) || ((n.tags || []).some((t) => t.label === 'agent') ? 'agent' : undefined);
const asDoc = (n) => ({ ...n, kind: 'document', text: n.text ?? n.title ?? '', hasChildren: true, icon: nodeIcon(n) }); // api.node / search / library result -> document Node
// a draft row keeps a local "draftdoc:N" id until it is created, and the main process knows nothing about it
const isRealId = (id) => typeof id === 'string' && id.startsWith('tana:');
// ---- deleted nodes ----
// A node can be gone while a copy of it is still on screen: a mention typed into a note, a reference row, a page in
// the Back stack. Main knows first and says so three ways — outline:removed, a reference it resolved as deleted, and
// "Node has been deleted" from any read — and all three land in one set, because what the app does about it is the
// same in every case: draw it struck through behind a trash glyph, and refuse to open it.
const isGone = (uri) => typeof uri === 'string' && deletedIds.has(uri);
// main's answer, remembered: a reference drawn as deleted is one the navigation guards must know about too
const markGone = (uri, deleted) => { if (deleted && typeof uri === 'string') deletedIds.add(uri); return isGone(uri); };
// Any read refused because the node is gone. The message is main's (main/documents.js op), carried through the IPC
// wrapper, so it reads "…: Error: Node has been deleted" by the time it arrives here.
function noteGone(uri, e) {
  if (!isRealId(uri) || deletedIds.has(uri) || !/has been deleted/i.test(String((e && e.message) || e || ''))) return false;
  deletedIds.add(uri);
  if (zoom && zoom.docId === uri) zoom = null; // the page it refused to answer for is not a page any more
  renderSoon();
  return true;
}
// ---- Home ----
// Home is the Work View (the default, a saved view: renderer/timeline.js openWorkView), a window you set as Home (Cmd+K
// Set as Home keeps it as it is: the saved view HOME_VIEW, renderer/palette.js), or, chosen before that, the Library or
// a saved search.
// The saved search Home points at, while the list knows it. The list is the only proof we have that a search is still
// there and still readable: main answers it from the graph, and app.js drops a deleted one from it as the deletion
// arrives, so a Home that has gone away shows up here as a search nobody lists.
const homeSearch = () => (homeIsSearch() ? (searches || []).find((s) => s.id === home) : null);
const HOME_VIEW = 'homeView';
const homeView = () => savedViews().find((v) => v.id === HOME_VIEW) || null;
const homeIsSearch = () => home !== 'library' && home !== 'workView' && home !== HOME_VIEW;
// A Home the list has answered on and does not have is stale: it is repaired to the Library rather than left to dangle
// (app.js calls this when the list lands and when a deletion arrives). Before the first answer nothing is concluded.
function repairHome() { if (homeIsSearch() && searchesLoaded && !homeSearch()) setHome('library'); }
const homeId = () => (home === HOME_VIEW && !homeView() ? 'workView' : homeIsSearch() && searchesLoaded && !homeSearch() ? 'library' : home); // a Home window removed from the list leaves the Work View
// What Go to Home names: the search's current title, so a rename in Tana shows through. null while a Home search
// is still unknown — the anchor waits for its name rather than borrowing the Library's.
const homeName = () => { const s = homeSearch(); return s ? s.text || s.title || 'Untitled search' : { library: 'Library', workView: 'Work View', [HOME_VIEW]: 'Home' }[homeId()] || null; };
// In the Work View a half is Home on its own page: the Timeline on the left, My Tasks on the right: the search the
// synced setting names (renderer/app.js asks once connected), so a rename keeps it; until then the search of that title
let myTasksId = null;
const atWorkView = () => !!zoom && !zoom.nodeId && (SIDE ? String(zoom.docId).startsWith(SEARCH_ID) && (myTasksId ? zoom.docId === myTasksId : /^my tasks$/i.test(String((docOf(zoom.docId) || {}).text || '').trim())) : zoom.docId === TIMELINE_PAGE);
// In a saved view a page is Home on the place that view keeps for it ('place', 'place:2', …; {} is its view)
function atSavedView(v) {
  let p = null;
  const as = typeof window !== 'undefined' && window.api && window.api.savedAs ? ':' + window.api.savedAs : SIDE; // a page given another id than the view's (main.js adoptLayout)
  try { p = JSON.parse(v.keys['place' + as] || 'null'); } catch { /* not a place */ }
  return !!p && (p.docId ? !!zoom && zoom.docId === p.docId && (zoom.nodeId || null) === (p.nodeId || null) : !p.myTasks && !zoom && view === v.keys['view' + as]);
}
// the Work View as installed ('workView' its layout) or as updated from Save view, which is judged by its own keys
const workViewNow = () => savedViews().find((v) => v.id === WORK_VIEW.id);
const atHome = () => (homeId() === 'workView' ? (workViewNow().doc === 'workView' ? atWorkView() : atSavedView(workViewNow())) : homeId() === HOME_VIEW ? atSavedView(homeView()) : zoom ? !zoom.nodeId && zoom.docId === homeId() : homeId() === view);
function setHome(id) { home = id; setPref('home', id); render(true); }
// Going Home opens a window, as a saved view is opened, a saved search is a document you open, the Library is a view you switch to.
// A Library or saved-search Home, chosen before Home was a window, is a window of one pane on it (issue #444).
function goHome() {
  const id = homeId();
  if (id === 'workView') return run(openWorkView);
  run(() => openSavedView(id === HOME_VIEW ? homeView() : { name: homeName(), doc: null, keys: { view: 'library', place: id === 'library' ? '{}' : JSON.stringify({ docId: id, nodeId: null }) } }));
}
function sensitiveHidden(id) {
  return !sensitiveVisible && typeof id === 'string' && (sensitiveIds === null || sensitiveIds.has(id));
}
function blurSensitive(el, ...ids) {
  const present = ids.filter(isRealId);
  // The ids ride on the element, so refreshSensitive finds what is on screen by asking the page: a registry of its
  // own kept every row a render had thrown away alive until the next toggle (#262).
  if (present.length) el.dataset.sensitive = present.join(' '); else delete el.dataset.sensitive;
  el.classList.toggle('sensitive', present.some(sensitiveHidden));
  return el;
}
function refreshSensitive() {
  for (const el of document.querySelectorAll('[data-sensitive]')) el.classList.toggle('sensitive', el.dataset.sensitive.split(' ').some(sensitiveHidden));
  retellTitle(); // the tab says Hidden while the title is blurred, and the title again once it is shown
}
function loadSensitive() {
  if (!sensitiveLoading) sensitiveLoading = Promise.resolve(tana.sensitiveIds ? tana.sensitiveIds() : [])
    .then((ids) => { sensitiveIds = new Set(ids); }, showError);
  return sensitiveLoading;
}
// Which documents carry a pin at all (api.pinIds): the mark a row draws, read as one list rather than a pinState
// call per row. Same shape as the sensitive marks above — read once, kept, and re-read whenever a pin is written or
// a global change arrives (loadPins). A set that has not moved redraws nothing, so the read behind every ⌘K costs
// a render only when a pin actually changed.
const isPinned = (id) => !!pinnedIds && pinnedIds.has(id);
function loadPinned(force) {
  if (!tana.pinIds || (pinnedLoading && !force)) return;
  pinnedLoading = Promise.all([tana.pinIds(), tana.pinDates ? tana.pinDates() : {}]).then(([ids, dates]) => {
    const next = new Set(ids), nextDates = new Map(Object.entries(dates || {}));
    if (pinnedIds && next.size === pinnedIds.size && [...next].every((id) => pinnedIds.has(id)) && JSON.stringify([...nextDates]) === JSON.stringify([...datePinsById])) return;
    pinnedIds = next; datePinsById = nextDates;
    renderSoon();
  }, () => {}); // not connected yet: the next read asks again, and until then a row simply carries no mark
}
// The nodes assigned to the local Codex agent, once per launch. Unlike the sensitive marks nothing waits on it: a
// row that renders before the answer lands simply has no badge yet, and the load re-renders.
function loadCodex() {
  if (!codexLoading) codexLoading = Promise.resolve(tana.codexIds ? tana.codexIds() : [])
    .then((ids) => { codexIds = new Set(ids); renderSoon(); }, showError);
  return codexLoading;
}
// What each linked task is doing: one bounded app-server child in main answers for every linked node at once. Read at
// boot, every 30 s while something is linked, and when a link moves (renderer/app.js), never per list reload: those
// come in bursts, and each started a child. A node it says nothing about stays pending.
function loadAgentStates() {
  // No guard on codexIds: it is filled by loadCodex, which is still in flight at boot, so gating on it meant the
  // status was never asked for after a reload and every linked task sat grey until the next refresh. Main knows the
  // links; an answer for none of them is cheap and correct.
  if (!tana.codexStatus) return;
  tana.codexStatus().then((states) => {
    agentStates.clear();
    for (const [id, state] of Object.entries(states || {})) agentStates.set(id, state);
    renderSoon();
  }, () => {}); // a status read that fails leaves the badges as they were; it is not an error the user can act on
  // and where each of them runs: the badge says whether it can be opened from here, so a late answer redraws too
  if (tana.codexTaskHosts) tana.codexTaskHosts().then((hosts) => { agentTaskHosts.clear(); for (const [id, host] of Object.entries(hosts || {})) agentTaskHosts.set(id, host); renderSoon(); }, () => {});
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
// todayIndex lived here: it marked the first meeting dated today or later, so the Meetings view could open on it.
// That view is gone, and no other page opens anywhere but its top, so the walk over weekday metas went with it.

async function loadRoots() {
  await loadSensitive(); // privacy gate: no document reaches the first render before the local marks do
  loadCodex();
  const drafts = views.flatMap((s) => s.nodes.map((node, i) => ({ view: s.id, i, node })).filter((d) => d.node.draft)); // a refresh must not drop a draft being typed
  // The type glyphs come with the roots rather than on their own: a row carries the *name* of its type's icon, so
  // the markup has to be here before the rows are, and a roots load is exactly when the rows change.
  const [roots] = await Promise.all([tana.roots(), tana.typeIcons ? tana.typeIcons().then(setTypeGlyphs, () => {}) : null]);
  views = roots.map((s) => ({ ...s, icon: s.id === 'library' ? 'library' : s.icon, nodes: s.nodes.map(asDoc) }));
  for (const s of views) if (s.truncated) truncated.add(s.id); else if (s.truncated === false) truncated.delete(s.id); // roots carry the cap flag, so a refresh needs no second query
  rootsLoaded = true;
  for (const [id, f] of fresh) { // a created document stays where it was drafted until the roots query lists it
    const s = views.find((x) => x.id === f.section);
    if (!s || s.nodes.some((n) => n.id === id)) fresh.delete(id);
    else s.nodes.splice(s.nodes.findIndex((n) => n.id === f.after) + 1, 0, f.node);
  }
  for (const d of drafts) { const s = views.find((x) => x.id === d.view); if (s) s.nodes.splice(d.i, 0, d.node); }
}
// saved search or type page id -> its newest read: an answer from an older read that lands later is dropped. A preview of staged
// pills (previewRows) takes a number too, so a search staged, or staged and saved, while its stored query was out keeps
// the rows that answer what it shows now. Only those two: every other page takes each answer as it lands, which
// what waits on a reload (the Timeline's paging) counts on.
const reloadSeq = new Map();
const nextRead = (docId) => { const seq = (reloadSeq.get(docId) || 0) + 1; reloadSeq.set(docId, seq); return seq; };
// page id -> the read whose rows are on the page. A read that answered replaces them only when it is newer: a newer one
// that failed decides nothing, so an older answer for the same filter still lands.
const landedRead = new Map();
const landedPreview = new Map(); // saved search id -> the staged filter (as text) the rows on screen answer, while they are a preview's
const lands = (docId, seq) => { if (seq <= (landedRead.get(docId) || 0)) return false; landedRead.set(docId, seq); return true; };
// The stored filter a saved search's page was last loaded or saved with (searchFilters), as text; null while unknown.
const storedFilter = (docId) => { const saved = searchFilters.get(docId); return saved ? JSON.stringify(saved.filter) : null; };
// Whether a read begun at release `since` names a document main has let go of since (app.js forgetReleased): its rows
// would hear no more changes, so they are not kept. Every write of read rows asks it: reload, previewRows, loadRelated.
function releasedSince(since, ids) { return ids.some((id) => (releasedDocs.get(id) || 0) > since); }
const rowIds = (list, out = []) => { for (const row of list || []) if (row) { out.push(row.id); if (row.reference) out.push(row.reference.uri); rowIds(row.children, out); } return out; };
async function reload(docId) {
  const seq = nextRead(docId), search = String(docId).startsWith(SEARCH_ID), asked = search ? storedFilter(docId) : null;
  // A type page asks its filter; an answer to a filter the pills have since moved on from is dropped, or clicking
  // through a menu quickly could leave the page on an older choice than the pills show.
  if (isTypeId(docId)) { const asked = typeFilter(docId), rows = await tana.searchPreview(asked); if (filters.get(docId) === asked && lands(docId, seq)) kids.set(docId, rows); return; } // and a newer read of the same filter wins
  let rows;
  const since = releases;
  // the whole page is in, or the read failed: no later part of it stands in for the page either way (renderer/timeline.js)
  try { rows = await tana.children(docId); } finally { if (docId === TIMELINE_PAGE) timelinePartial = false; }
  // Begun before main let go of this document, or of one its rows list or reference: not cached; a newer read brings
  // them, or the next draw asks again (#406 review).
  if (releasedSince(since, rowIds(rows, [docId.split('|')[0]]))) {
    if (kids.get(docId) == null) { kids.delete(docId); renderSoon(); return; } // loading: let the loading path ask again
    return reload(docId); // cached: those rows stay until a read begun after the release lands (it subscribes the outline's document; reference targets main resolves from the graph)
  }
  // A saved search's stored answer is its rows only while it still answers the stored filter (a Save since replaced
  // it) and no staged pills are on screen; then the newest such answer wins. lands() last: a refused answer claims nothing.
  if (search) { const now = storedFilter(docId); if ((asked && now && asked !== now) || searchRows.has(docId) || !lands(docId, seq)) return; landedPreview.delete(docId); }
  kids.set(docId, syncUploads(docId, rows)); // uploads still running keep their placeholders
}
// A document's rows are not only the ones on its page: every field it has is an outline of that document too,
// loaded under "<document>|<type>?attribute=<key>". Anything that re-reads a document's rows re-reads those with
// it, or an undo, a live update or someone else's edit shows on the page and not in the field beside it.
const outlinesOf = (docId) => [...kids.keys()].filter((id) => id === docId || id.startsWith(docId + '|'));
function loadView(id = view) {
  // widenFilter (renderer/views.js): a view restored with Group by Responsibility asks for Anyone, so its sections
  // are never drawn from a list that cannot fill them. The map is updated too, or the pill would read the old value.
  const filter = widenFilter(id, filters.get(id));
  if (filter !== filters.get(id)) filters.set(id, filter);
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
// Every view's stored filter: at boot, and again whenever another page, window or machine stored one (renderer/app.js
// onSettings). A page that kept its old copy drew stale pills and wrote that copy back over the newer filter with its
// next pill. The view on screen is listed again only when its own filter moved (as loadView would widen it).
function loadFilters() {
  return Promise.all(views.map(async (item) => [item.id, await tana.viewFilter(item.id)])).then((stored) => {
    let moved = false;
    for (const [id, f] of stored) {
      if (JSON.stringify(widenFilter(id, f)) === JSON.stringify(filters.get(id))) continue;
      filters.set(id, f);
      if (id === view) moved = true;
    }
    if (moved) loadView();
    renderSoon();
  }, showError);
}
function setViewF(patch) {
  const id = view, next = { ...filters.get(id), ...patch };
  filters.set(id, next); render();
  run(async () => { filters.set(id, await tana.setViewFilter(id, next)); await loadView(id); });
}
// The pills edit whatever page is in front of you: a view's persisted filter, or a saved search's stored query. One
// key decides which, so pillDefs, pillsApply and every menu stay exactly as they were for both.
const pillKey = () => (onSearchPage() || onTypePage() ? zoom.docId : view);
// A type page's filter: its instances, narrowed by the field pills you last chose for it (kept per type, synced).
function typeFilter(id) {
  if (!filters.has(id)) filters.set(id, { types: [id], fields: pref('typeFields', {})[id] || null });
  return filters.get(id);
}
// Like a view, a change applies at once and is kept: nobody else reads this filter, so there is nothing to Save.
function setTypeF(patch) {
  const id = pillKey(), next = { ...typeFilter(id), ...patch };
  filters.set(id, next);
  setPref('typeFields', { ...pref('typeFields', {}), [id]: next.fields || undefined });
  render();
  run(async () => { await reload(id); render(true); });
}
const searchFilters = new Map(); // saved search id -> { filter, sort, group } as its document stores them, at the last load or save
const searchRows = new Map();    // saved search id -> the staged filter, as JSON, that produced the rows now in kids
// A view persists every pill change as it is made; a saved search is a document other people may be looking at, so
// its edits stay local until Save. That difference is the only reason these two write paths are not one.
// The arrangement counts as an edit too: it is stored in the document beside the query and saved by the same press.
const searchDirty = () => {
  if (!onSearchPage()) return false;
  const saved = searchFilters.get(zoom.docId);
  if (!saved) return false;
  return !sameFilter(filters.get(zoom.docId), saved.filter) || sortBy() !== (saved.sort || 'default') || groupBy() !== (saved.group || 'none')
    || displayKeys().join(',') !== (Array.isArray(saved.display) ? saved.display : DISPLAY_DEFAULT).join(',');
};
// The rows a saved search shows follow the pills above them, or editing a filter would read as doing nothing. While
// the staged filter matches the document, the document's own rows are the right answer and keep the parts of a
// Tana-authored query the filter vocabulary cannot express; once it differs, the preview answers instead — asking
// exactly what Save would store, so nothing changes under the user at the moment they press it.
function previewRows(docId) {
  const saved = searchFilters.get(docId), staged = filters.get(docId);
  if (!saved || !staged || !tana.searchPreview) return;
  if (sameFilter(staged, saved.filter)) {
    if (searchRows.delete(docId)) { kids.set(docId, null); reload(docId).then(() => render(true), (e) => { kids.delete(docId); showError(e); }); }
    return;
  }
  const asked = JSON.stringify(staged);
  if (searchRows.get(docId) === asked) return; // these rows already answer this filter
  searchRows.set(docId, asked);
  const seq = nextRead(docId), since = releases;
  tana.searchPreview(staged).then((rows) => {
    if (JSON.stringify(filters.get(docId)) !== asked) return;
    // names what main let go of while it was out: asked again, unless a newer read is already out (#406 review)
    if (releasedSince(since, rowIds(rows))) { if (reloadSeq.get(docId) === seq) { searchRows.delete(docId); previewRows(docId); } return; }
    // an answer lands only for the pills still on screen and when no newer read has landed; only the newest read asked
    // reports a failure, and one that answered puts its staged filter back beside its rows
    if (lands(docId, seq)) { searchRows.set(docId, asked); landedPreview.set(docId, asked); kids.set(docId, rows); render(); }
  }, (e) => { if (reloadSeq.get(docId) === seq && landedPreview.get(docId) !== asked) { searchRows.delete(docId); showError(e); } }); // rows for these pills already in: a failed retry changes nothing
}
function setSearchF(patch) {
  const id = pillKey();
  filters.set(id, { ...filters.get(id), ...patch }); render();
}
function loadSearchFilter(docId) {
  // Not before the sync client exists: main reads the stored query through op(), which answers a missing client with
  // "not connected to Tana" — logged in main and shown red here. Boot draws the page it reopens before connecting
  // (renderer/app.js restorePlace), so a saved search as the last page hit this on every launch. The render the
  // connection brings asks again.
  if (!connected || !tana.searchFilter || searchFilters.has(docId)) return;
  searchFilters.set(docId, null); // claimed, so the renders while it is in flight do not ask again
  tana.searchFilter(docId).then((saved) => {
    searchFilters.set(docId, saved);
    if (!filters.has(docId)) filters.set(docId, saved.filter); // a local edit already in progress is not overwritten
    // the arrangement it was saved with, unless this session has already chosen another one for this search
    if (saved.sort && sortPref[docId] === undefined) sortPref[docId] = saved.sort;
    if (saved.group && groupPref[docId] === undefined) groupPref[docId] = saved.group;
    if (Array.isArray(saved.display) && displayPref[docId] === undefined) displayPref[docId] = saved.display;
    render();
  }, (e) => { searchFilters.delete(docId); showError(e); });
}
const clearFilter = (f = {}) => ({ types: null, states: null, assignee: 'anyone', text: '', fields: null, audience: null, participant: f.participant || null, window: f.window || null });
const sameList = (a, b) => JSON.stringify(a ? [...a].sort() : a) === JSON.stringify(b ? [...b].sort() : b);
const sameFields = (a, b) => { const json = (f) => JSON.stringify(Object.entries(f || {}).sort(([x], [y]) => x.localeCompare(y))); return json(a) === json(b); };
function sameFilter(a = {}, b = {}) {
  return sameList(a.types || null, b.types || null) && sameList(a.states || null, b.states || null)
    && (a.assignee || 'anyone') === (b.assignee || 'anyone') && String(a.text || '') === String(b.text || '')
    && completedWindow(a) === completedWindow(b) // unset reads as the default, so a stored 7 and an unset one are one filter
    && (a.audience || null) === (b.audience || null)
    && (a.participant || null) === (b.participant || null) && (a.window || null) === (b.window || null)
    && sameFields(a.fields, b.fields);
}
function viewFiltered() {
  const filter = filters.get(view);
  return !!filter && !sameFilter(filter, clearFilter(filter));
}
function clearFilters() { setViewF(clearFilter(filters.get(view))); }
function ensureLoaded(item) {
  // Not before there is a connection to ask: the page a launch reopens (the seeded place in renderer/edit.js) is
  // drawn before the sync client exists, and asking then greeted every start with a red "not connected to Tana".
  // It stays "Loading…", and the render the connection brings with it asks again.
  if (item.node.kind !== 'document' || kids.has(item.docId) || !connected) return;
  kids.set(item.docId, null);
  // The rows arrive while the caret is still in the row that was just expanded (⌘↓), which a plain render() would
  // wait out, leaving "Loading…" until the caret moves; this render is the answer to that keypress, so it is forced.
  // A failed load closes the row again and forgets the attempt, so the next ⌘↓ retries instead of loading forever.
  reload(item.docId).then(() => render(true), (e) => { kids.delete(item.docId); open.set(item.key, false); showError(e); render(true); });
}
