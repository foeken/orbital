'use strict';
// Outline operations over the loro-prosemirror content layout (docs/OUTLINER.md): a block is a LoroMap
// { nodeName, attributes: LoroMap, children: LoroList }; inline content is LoroText runs and mention LoroMaps.
// Outline nodes are paragraphs/headings/blockquotes/codeBlocks; a listItem is the node of its first paragraph
// and its remaining blocks are that node's children; bulletList/orderedList are transparent.
const { LoroMap, LoroList, LoroText } = require('loro-crdt');
const { contentText } = require('./node');

const LISTS = ['bulletList', 'orderedList'];
// Blocks that hold no inline content of their own (Tana's writer gives them attributes but no children list).
const ATOMS = ['horizontalRule', 'image', 'video', 'audio', 'embed'];
const HOLDERS = [...LISTS, 'blockquote'];
// The block types the outliner can switch between; each one is a container plus a leaf node name.
const BLOCK_TYPES = ['paragraph', 'heading1', 'heading2', 'heading3', 'bullet', 'numbered', 'code', 'quote'];
// Tana's schema marks. Its web bundle configures Loro from the ProseMirror mark specs, and none of them declares
// `inclusive`, so every mark ends up with expand 'none'.
const MARKS = ['bold', 'italic', 'strike', 'code', 'link'];
const TEXT_STYLE = Object.fromEntries(MARKS.map((m) => [m, { expand: 'none' }]));
const styled = new WeakSet();
const name = (m) => m.get('nodeName');
const kids = (m) => m.get('children');
// The root content map of a fresh document (events, new docs) is empty; create the doc skeleton on first write.
function rootKids(document) {
  const c = document.content;
  if (!c.get('children')) { c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap()); c.setContainer('children', new LoroList()); }
  return c.get('children');
}
const isList = (m) => LISTS.includes(name(m));
const isQuote = (m) => name(m) === 'blockquote';
const isHolder = (m) => HOLDERS.includes(name(m));
const isItem = (m) => name(m) === 'listItem';
const isMention = (x) => x.kind() === 'Map' && name(x) === 'mention';
const blockId = (m) => { const a = m.get('attributes'); return a ? a.get('blockId') : undefined; };
const newId = () => { let s = ''; while (s.length < 8) s += Math.random().toString(36).slice(2); return s.slice(0, 8); };
// Loro resolves a mark's expand behaviour from this config, so set it once per document before writing marks.
const styleDoc = (document) => { if (!styled.has(document.loro)) { document.loro.configTextStyle(TEXT_STYLE); styled.add(document.loro); } };

function indexOf(list, m) {
  for (let i = 0; i < list.length; i++) if (list.get(i).id === m.id) return i;
  throw new Error('container not in list');
}

function checkDirection(direction) {
  if (direction !== 'up' && direction !== 'down') throw new Error('outline move direction must be up or down');
}

// ---- read

function readOutline(document) {
  const list = kids(document.content);
  return list ? nodes(list) : [];
}
// Blocks Tana's own agent writes can arrive with no blockId at all, and a row with no id cannot be edited, linked
// or split: every write looks its block up by that id. Give each one an id, once, in one transaction — a no-op
// (and no op) for a document that has them all. Lists and quotes are walked; the ids go on the blocks they hold.
function assignBlockIds(document) {
  const missing = [];
  const walk = (list) => { if (!list) return; for (let i = 0; i < list.length; i++) { const b = list.get(i); if (b.kind && b.kind() !== 'Map') continue; if (isList(b) || isQuote(b) || isItem(b)) walk(kids(b)); else if (!blockId(b)) missing.push(b); } };
  walk(kids(document.content));
  if (!missing.length) return 0;
  document.transact(() => { for (const b of missing) { const a = b.get('attributes') || b.setContainer('attributes', new LoroMap()); a.set('blockId', newId()); } });
  return missing.length;
}

function nodes(list, from = 0) {
  const out = [];
  for (let i = from; i < list.length; i++) {
    const b = list.get(i);
    if (isQuote(b)) { out.push(...nodes(kids(b))); continue; } // a blockquote is transparent: its blocks are the nodes
    if (!isList(b)) { out.push(node(b, [])); continue; }
    const items = kids(b);
    for (let j = 0; j < items.length; j++) {
      const c = kids(items.get(j));
      if (c.length) {
        const n = node(c.get(0), nodes(c, 1));
        const checked = items.get(j).get('attributes')?.get('checked');
        if (typeof checked === 'boolean') n.done = checked ? 1 : 0;
        out.push(n);
      }
    }
  }
  return out;
}

function node(block, children) {
  const n = { id: blockId(block), text: kids(block) ? contentText({ content: block }) : '', kind: 'block', hasChildren: children.length > 0, children };
  n.segments = inline(block) || (n.text ? [{ text: n.text }] : []);
  const type = blockType(block);
  if (type) n.block = type;
  if (name(block) === 'embed') {
    const a = block.get('attributes');
    n.type = 'reference'; n.editable = false;
    n.reference = { uri: a.get('tanaUri'), ...(typeof a.get('label') === 'string' ? { label: a.get('label') } : {}) };
  }
  if (name(block) === 'heading') n.heading = block.get('attributes').get('level');
  if (name(block) === 'horizontalRule') n.editable = false; // a divider has nothing to edit
  if (name(block) === 'image') { // { nodeName 'image', attributes { blockId, tanaUri, displayWidth?, displayHeight? }, children [] }; no alt stored
    const a = block.get('attributes');
    n.type = 'image';
    n.image = { uri: a.get('tanaUri'), alt: null, width: a.get('displayWidth') ?? null, height: a.get('displayHeight') ?? null };
  }
  return n;
}

// The bulletList/orderedList/blockquote that owns this node, or null when the block stands on its own.
function holderOf(block) {
  const list = block.parent(), owner = list && list.parent();
  if (!owner) return null;
  if (isQuote(owner)) return owner;
  if (!isItem(owner)) return null;
  const items = owner.parent(), listMap = items && items.parent();
  return listMap && isList(listMap) ? listMap : null;
}

// True when this unit is one of the document's own rows rather than another node's child. A child lives inside
// its parent's listItem — that is the only place Tana's schema keeps children — so anything under a listItem
// belongs to the node that listItem is, however many lists and quotes sit in between.
function atRoot(unit) {
  for (let list = unit.parent(); list; ) {
    const owner = list.parent();
    if (!owner) return true;            // the root children list
    if (isItem(owner)) return false;    // inside a listItem: somebody's child
    if (!isHolder(owner)) return true;  // the content root map
    list = owner.parent();
  }
  return true;
}

// One of BLOCK_TYPES (plus 'divider'), or undefined for blocks that carry their own type (image, embed).
function blockType(block) {
  const n = name(block);
  if (n === 'horizontalRule') return 'divider';
  if (n === 'heading') return 'heading' + (block.get('attributes').get('level') || 1);
  if (n === 'codeBlock') return 'code';
  const holder = holderOf(block);
  const listed = holder ? (isQuote(holder) ? 'quote' : name(holder) === 'orderedList' ? 'numbered' : 'bullet') : null;
  // An image carries its own type rather than a block type, so on its own it has none — but a list row is a list
  // row whatever it holds, and that is what says whether it draws a marker. A quote holds no atoms, so one there
  // reads as standing on its own.
  if (ATOMS.includes(n)) return listed === 'quote' ? undefined : listed || undefined;
  return listed || 'paragraph';
}

// Inline runs of a block as segments; null when the block holds child blocks instead. One LoroText carries several
// segments when its delta is split by marks, which is how Tana stores bold/italic/strike/code/link.
function inline(block) {
  const c = kids(block), out = [];
  if (!c) return out; // atoms (divider, image, embed) have no children list at all
  for (let i = 0; i < c.length; i++) {
    const x = c.get(i);
    if (x.kind() === 'Text') for (const run of x.toDelta()) { const marks = readMarks(run.attributes); out.push(marks ? { text: run.insert, marks } : { text: run.insert }); }
    else if (isMention(x)) { const a = x.get('attributes'); out.push({ mention: { label: a.get('label'), uri: a.get('tanaUri') } }); }
    else if (name(x) === 'hardBreak') out.push({ text: '\n' }); // an inline line break, the same thing the editor writes as a newline
    else return null;
  }
  return out;
}

// Delta attributes -> segment marks. Tana stores {} for bold/italic/strike/code and the link mark's ProseMirror
// attributes ({ href, title, target }) for link; a segment carries the href alone.
function readMarks(attributes) {
  if (!attributes) return null;
  const marks = {};
  for (const key of MARKS) {
    const value = attributes[key];
    if (value == null || value === false) continue;
    if (key !== 'link') marks[key] = true;
    else { const href = typeof value === 'string' ? value : value.href; if (href) marks.link = href; }
  }
  return Object.keys(marks).length ? marks : null;
}

function writeMarks(marks) {
  if (!marks) return null;
  const out = {};
  for (const key of MARKS) {
    if (!marks[key]) continue;
    out[key] = key === 'link' ? { href: String(marks[key]) } : {};
  }
  return Object.keys(out).length ? out : null;
}

// Two mark values mean the same thing when they agree on what the reader sees: presence, or a link's href.
const markValue = (v) => (v == null || v === false ? null : typeof v === 'object' ? (v.href ?? true) : v);

// -> { block, item } where item is the listItem the node represents (null for a bare block).
function locate(list, id) {
  for (let i = 0; i < list.length; i++) {
    const b = list.get(i);
    if (isItem(b) && kids(b).length && blockId(kids(b).get(0)) === id) return { block: kids(b).get(0), item: b };
    if (blockId(b) === id) return { block: b, item: null };
    if (isList(b) || isItem(b) || isQuote(b)) { const r = locate(kids(b), id); if (r) return r; }
  }
  return null;
}

function must(document, id) {
  const r = locate(kids(document.content), id);
  if (!r) throw new Error('no outline node ' + id);
  return r;
}

// A Loro Cursor at a character offset in a block's text: how Tana's editor shares a caret (sdk/presence.js). Offsets
// count characters the way the outline shows them: a mention counts as its label, an inline line break as one. Inside
// a text run the cursor is on that LoroText (as loro-prosemirror places one); at or inside a mention it is on the
// block's children list before it. null when the block is unknown or holds no inline content.
// ponytail: offsets are taken as Loro's unicode positions, so text with astral characters (emoji) before the caret is
// off by one per character; count code points in the caller when that matters.
function cursorAt(document, id, offset) {
  const found = locate(kids(document.content), id), list = found && kids(found.block);
  if (!list) return null;
  let left = Math.max(0, Number(offset) || 0);
  for (let i = 0; i < list.length; i++) {
    const x = list.get(i);
    if (x.kind() === 'Text') { if (left <= x.length) return x.getCursor(left) || null; left -= x.length; continue; }
    const len = isMention(x) ? String(x.get('attributes').get('label') || '').length : name(x) === 'hardBreak' ? 1 : 0;
    if (left < len) return list.getCursor(i) || null;
    left -= len;
  }
  return list.getCursor(list.length) || null; // past the end: after the last inline item
}

// ---- build / copy

function create(list, index, nodeName) {
  const m = list.insertContainer(index, new LoroMap());
  m.set('nodeName', nodeName);
  m.setContainer('attributes', new LoroMap()).set('blockId', newId());
  m.setContainer('children', new LoroList());
  return m;
}

function paragraph(list, index, text) {
  const p = create(list, index, 'paragraph');
  if (text) kids(p).insertContainer(0, new LoroText()).insert(0, text);
  return p;
}

function item(list, index, text, source) {
  const li = create(list, index, 'listItem');
  if (typeof source?.get('attributes')?.get('checked') === 'boolean') li.get('attributes').set('checked', false);
  paragraph(kids(li), 0, text);
  return li;
}

// A bare paragraph turned into the first row of a bullet list, joining an adjacent one. Returns the paragraph, not
// the listItem: the copy wrap makes keeps its blockId, which is the id the caller hands back.
const bulletRow = (list, index, text) => kids(wrap(paragraph(list, index, text))).get(0);

// Deep copy of a block map into list[index] (Loro lists cannot move containers); text runs keep their marks.
function copy(list, index, src) {
  const m = list.insertContainer(index, new LoroMap());
  for (const k of src.keys()) {
    const v = src.get(k);
    if (k === 'attributes') { const a = m.setContainer(k, new LoroMap()); for (const [ak, av] of Object.entries(v.toJSON())) a.set(ak, av); }
    else if (k === 'children') {
      const c = m.setContainer(k, new LoroList());
      for (let i = 0; i < v.length; i++) { const x = v.get(i); if (x.kind() === 'Text') c.insertContainer(i, new LoroText()).applyDelta(x.toDelta()); else copy(c, i, x); }
    } else m.set(k, v);
  }
  return m;
}

// Turn a bare block into a listItem (joining the list of the same kind right before it when there is one);
// returns the listItem.
function wrap(block, listName = 'bulletList') {
  const list = block.parent(), i = indexOf(list, block);
  const prev = i > 0 ? list.get(i - 1) : null;
  const items = prev && name(prev) === listName ? kids(prev) : kids(create(list, i, listName));
  const li = create(items, items.length, 'listItem');
  copy(kids(li), 0, block);
  list.delete(indexOf(list, block), 1);
  return li;
}

// Remove a list or blockquote that became empty, and whatever that empties in turn.
function prune(list) {
  const m = list.parent();
  if (list.length === 0 && m && isHolder(m)) { const l = m.parent(); l.delete(indexOf(l, m), 1); prune(l); }
}

// The listItem that precedes `unit` in outline order (wrapping a bare paragraph into one), or null.
function prevSibling(unit) {
  let list = unit.parent(), i = indexOf(list, unit);
  if (i === 0 && isItem(unit)) { const l = list.parent(); list = l.parent(); i = indexOf(list, l); } // first item: look before its list
  if (i <= (isItem(list.parent()) ? 1 : 0)) return null; // index 0 of a listItem is the parent's own paragraph
  const prev = list.get(i - 1);
  if (isItem(prev)) return prev;
  if (isList(prev)) return kids(prev).get(kids(prev).length - 1);
  return name(prev) === 'paragraph' ? wrap(prev) : null;
}

// ---- operations

// value: a string or segments [{ text, marks? } | { mention: { label, uri } }]. A string replaces the words and
// leaves the existing annotations in place; segments state the marks exactly. Segments are grouped the way Tana
// stores them: consecutive text runs share one LoroText whose delta carries their marks, and every mention is its
// own map. Groups are matched by position: a text container is updated in place (a diffing update keeps concurrent
// edits and the marks of untouched text, then only the annotations that changed are moved), a mention with the same
// uri is kept, anything else is replaced; trailing containers are dropped.
function setText(document, id, value) {
  if (typeof id !== 'string' || !id) throw new Error('outline node id must be a string');
  const target = must(document, id).block;
  if (!kids(target) || name(target) === 'embed') throw new Error('Reference blocks cannot contain editable text');
  const plain = name(target) === 'codeBlock'; // codeBlock content is text* with marks '' in Tana's schema
  const { groups, marked } = inlineGroups(value, plain);
  styleDoc(document);
  document.transact(() => writeInline(kids(must(document, id).block), groups, marked));
}
// The two halves of setText, shared with a typed field's value (sdk/fields.js), which is the same inline layout
// in a paragraph of its own: segments grouped the way Tana stores them, then written into one children list.
function inlineGroups(value, plain = false) {
  const marked = typeof value !== 'string';
  const segs = (marked ? value : [{ text: value }]).filter((s) => s.mention || s.text);
  const groups = [];
  for (const s of segs) {
    if (s.mention && !plain) { groups.push(s); continue; }
    const run = { insert: s.mention ? s.mention.label : s.text };
    const attributes = plain ? null : writeMarks(s.marks);
    if (attributes) run.attributes = attributes;
    const last = groups.length ? groups[groups.length - 1] : null;
    if (last && last.delta) last.delta.push(run); else groups.push({ delta: [run] });
  }
  return { groups, marked };
}
function writeInline(c, groups, marked) {
  groups.forEach((g, i) => {
    const cur = i < c.length ? c.get(i) : null;
    if (cur && g.delta && cur.kind() === 'Text') return applyRuns(cur, g.delta, marked);
    if (cur && g.mention && isMention(cur) && cur.get('attributes').get('tanaUri') === g.mention.uri) return;
    if (cur) c.delete(i, 1);
    if (g.delta) return applyRuns(c.insertContainer(i, new LoroText()), g.delta, marked);
    const m = c.insertContainer(i, new LoroMap());
    m.set('nodeName', 'mention');
    const a = m.setContainer('attributes', new LoroMap());
    a.set('label', g.mention.label);
    a.set('tanaUri', g.mention.uri);
  });
  if (c.length > groups.length) c.delete(groups.length, c.length - groups.length);
}

// Write one text container: the text first (diffed, so unchanged characters keep their identity and marks), then
// mark/unmark over the spans whose annotation actually differs.
function applyRuns(text, delta, marked) {
  text.update(delta.map((d) => d.insert).join(''));
  if (!marked) return; // a plain string says nothing about marks, so the existing ones stay
  const spans = (runs) => { let at = 0; return runs.map((d) => { const s = { start: at, end: at + d.insert.length, attrs: d.attributes || {} }; at = s.end; return s; }); };
  const want = spans(delta), have = spans(text.toDelta());
  const at = (list, i) => list.find((s) => s.start <= i && s.end > i);
  const edges = [...new Set([...want, ...have].flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = edges[i], end = edges[i + 1];
    const next = at(want, start), cur = at(have, start);
    for (const key of MARKS) {
      const a = next && next.attrs[key], b = cur && cur.attrs[key];
      if (markValue(a) === markValue(b)) continue;
      if (markValue(a) === null) text.unmark({ start, end }, key); else text.mark({ start, end }, key, a);
    }
  }
}

// A new row follows the row it comes from: a listItem makes another listItem, so a quote stays inside its quote
// and a numbered item stays numbered, and anything bare makes plain text — a heading and a code block each
// continue as the plain text that follows one. A document's own first row, which has nothing to follow, is plain
// text too, unless the caller says otherwise: `block: 'bullet'` is how a row asked to hold sub-items opens onto a
// list row rather than onto prose.
function insertAfter(document, id, text, before = false, asBlock = null) {
  const bare = (list, index) => (asBlock === 'bullet' ? bulletRow(list, index, text) : paragraph(list, index, text));
  let out = null;
  document.transact(() => {
    const list = rootKids(document);
    if (id == null) { out = blockId(bare(list, list.length)); return; }
    const { block, item: li } = must(document, id);
    const unit = li || block, l = unit.parent(), i = indexOf(l, unit) + (before ? 0 : 1);
    // Either side of a row, the new one is the row's own kind: a listItem beside a listItem (which keeps a quote
    // inside its quote and a numbered item numbered), and plain text beside anything bare — a heading and a code
    // block each continue as the plain text under them rather than as whatever the default mode says.
    out = blockId(li ? kids(item(l, i, text, li)).get(0) : bare(l, i));
  });
  return out;
}

// Enter at the very start of a node: the empty node goes in front and the node keeps its text and children.
function insertBefore(document, id, text) {
  if (id == null) throw new Error('outline node id must be a string');
  return insertAfter(document, id, text, true);
}

// Enter inside a node: what is left of the caret stays, the rest moves to a new sibling (or first child when the
// node shows its children). One transaction, so one undo step puts both halves back the way they were.
function split(document, id, before, after, asChild) {
  const plain = (v) => (typeof v === 'string' ? v : v.map((s) => (s.mention ? s.mention.label : s.text)).join(''));
  let out = null;
  document.transact(() => {
    setText(document, id, before);
    out = asChild ? insertChild(document, id, plain(after)) : insertAfter(document, id, plain(after));
    if (typeof after !== 'string' && after.some((s) => s.mention || s.marks)) setText(document, out, after); // inserts take plain text
  });
  return out;
}

function insertChild(document, id, text) {
  let out = null;
  document.transact(() => {
    const { block, item: li } = must(document, id);
    const owner = li || (name(block) === 'paragraph' ? wrap(block) : null);
    if (!owner) throw new Error('This block cannot contain child nodes'); // bare headings/quotes/code cannot own children in this schema
    const c = kids(owner), second = c.length > 1 ? c.get(1) : null;
    const items = second && isList(second) ? kids(second) : kids(create(c, 1, 'bulletList'));
    out = blockId(kids(item(items, 0, text)).get(0)); // only sibling insertion inherits an explicit checkbox
  });
  return out;
}

function removeUnit(unit) {
  const l = unit.parent();
  l.delete(indexOf(l, unit), 1);
  prune(l);
}

function unit(document, id) {
  const { block, item } = must(document, id);
  return item || block;
}

function selectedUnits(document, ids, { siblings = true } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('outline selection must contain at least one node');
  const seen = new Set(), units = ids.map((id) => {
    if (typeof id !== 'string' || seen.has(id)) throw new Error('outline selection contains duplicate or invalid node ids');
    seen.add(id);
    return unit(document, id);
  });
  if (!siblings) return units;
  const parent = units[0].parent();
  if (!units.every((unit) => unit.parent().id === parent.id)) throw new Error('outline selection must be siblings');
  return units;
}

function remove(document, id) {
  document.transact(() => removeUnit(unit(document, id)));
}

// Multi-select is one user action: one CRDT transaction, so undo restores the whole selection at once.
//
// Deleting is not moving. Moving, indenting and outdenting carry the rows as one block and so need siblings, but a
// selection to delete is just a set of rows, whatever levels they sit on — selecting a row and something inside it
// and pressing delete is an ordinary thing to do, and refusing it ("outline selection must be siblings") left the
// rows on screen gone and the document unchanged. A row inside another selected row needs no delete of its own: it
// goes with the row that holds it.
const insideOf = (unit, ancestor) => {
  for (let node = unit.parent && unit.parent(); node; node = node.parent && node.parent()) if (node.id === ancestor.id) return true;
  return false;
};
function removeMany(document, ids) {
  const units = selectedUnits(document, ids, { siblings: false });
  const outermost = units.filter((unit) => !units.some((other) => other.id !== unit.id && insideOf(unit, other)));
  // Within one list, last first, so the positions of the ones still to go do not move. Each list is finished
  // before the next, so pruning an emptied list never strands a delete that was still to come.
  const lists = new Map();
  for (const unit of outermost) {
    const list = unit.parent();
    if (!lists.has(list.id)) lists.set(list.id, { list, units: [] });
    lists.get(list.id).units.push(unit);
  }
  document.transact(() => {
    for (const { list, units: group } of lists.values()) {
      for (const unit of [...group].sort((a, b) => indexOf(list, b) - indexOf(list, a))) removeUnit(unit);
    }
  });
}

function indentUnit(document, id) {
  const { block, item: li } = must(document, id);
  if (!li && name(block) !== 'paragraph') return;
  const unit = li || block, target = prevSibling(unit);
  if (!target) return;
  const c = kids(target), last = c.get(c.length - 1);
  const items = isList(last) ? kids(last) : kids(create(c, c.length, 'bulletList'));
  if (li) copy(items, items.length, li); else copy(kids(create(items, items.length, 'listItem')), 0, block);
  const l = unit.parent();
  l.delete(indexOf(l, unit), 1);
  prune(l);
}

function outdentUnit(document, id) {
  const { block, item: li } = must(document, id);
  if (!li && name(block) !== 'paragraph') return;
  const unit = li || block, l = unit.parent();
  const parent = li ? l.parent().parent().parent() : l.parent(); // listItem owning this node, or the doc map
  if (!isItem(parent)) return;
  const pl = parent.parent(), at = indexOf(pl, parent) + 1;
  if (li) copy(pl, at, li); else copy(kids(create(pl, at, 'listItem')), 0, block);
  l.delete(indexOf(l, unit), 1);
  prune(l);
}

function indent(document, id) {
  document.transact(() => indentUnit(document, id));
}

function outdent(document, id) {
  document.transact(() => outdentUnit(document, id));
}

// Multi-select is one user action, so a whole range indents in one CRDT transaction and undoes in one step.
// Each id is resolved inside the transaction: the previous row's move has already changed the tree, so units
// cannot be collected up front the way removeMany/moveMany do. selectedUnits still runs first, for its checks.
// ids are in visual order; indent works first-last (each row follows the one above it), outdent last-first.
function indentMany(document, ids) {
  document.transact(() => { selectedUnits(document, ids); for (const id of ids) indentUnit(document, id); });
}

function outdentMany(document, ids) {
  document.transact(() => { selectedUnits(document, ids); for (const id of [...ids].reverse()) outdentUnit(document, id); });
}

// Swap the node with its previous/next sibling: listItems swap within their list, bare blocks swap with the
// neighbouring block (a neighbouring list moves as a whole). No-op at the edges.
function moveUnit(unit, direction) {
  const l = unit.parent(), i = indexOf(l, unit), up = direction === 'up';
  const j = up ? i - 1 : i + 1, first = isItem(l.parent()) ? 1 : 0; // index 0 of a listItem is its own paragraph
  if (j < first || j >= l.length) return;
  copy(l, up ? j : j + 1, unit);
  l.delete(up ? i + 1 : i, 1);
}

function move(document, id, direction) {
  checkDirection(direction);
  document.transact(() => moveUnit(unit(document, id), direction));
}

// ids are in visual order. Moving down works from the end; moving up works from the start.
function moveMany(document, ids, direction) {
  checkDirection(direction);
  const units = selectedUnits(document, ids);
  document.transact(() => {
    for (const unit of direction === 'up' ? units : [...units].reverse()) moveUnit(unit, direction);
  });
}

// ---- moving a node to a place (a drag, docs/OUTLINER.md) ----
// The keyboard moves a row one step at a time; a drag names the place outright, so this takes one: `afterId` is the
// row it lands behind, `parentId` the row it lands inside when there is nothing to land behind, and neither means
// the first row of the outline. `from` is the outline it comes from — another view of the same Loro document (a
// field value, sdk/fields.js) — so dragging a row between a page and one of its fields is one transaction, and one
// undo step, like every other move here.
// The row travels whole: its children, its checkbox and its block ids come with it, and the list or quote it leaves
// behind is pruned when it empties. Both refusals — into itself, and a block that cannot be a list item — are
// decided before anything is written, so a refused drag leaves the outline exactly as it was.
function moveTo(document, id, { parentId = null, afterId = null, from = document } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('outline node id must be a string');
  if (id === parentId || id === afterId) throw new Error('A node cannot move inside itself');
  const src = unit(from, id);
  const target = afterId != null ? unit(document, afterId) : parentId != null ? unit(document, parentId) : null;
  if (target && insideOf(target, src)) throw new Error('A node cannot move inside itself');
  // A listItem's first block is a paragraph, so only a paragraph can be dropped *inside* another row — the rule
  // indentUnit already follows from the other side. Beside one, nothing is refused: the list splits (place).
  if (parentId != null && !isItem(src) && name(src) !== 'paragraph') throw new Error('This block cannot become a list item');
  document.transact(() => {
    // The row is copied out and removed before the destination is opened up: place can split the list it lands in
    // (splitHolder), and a row dropped out of somebody's children lives inside one of the items that split moves,
    // so a place-then-remove left the row deleted under its old parent and copied twice into the outline.
    const root = rootKids(document);
    const moving = copy(root, root.length, src);
    removeUnit(src);
    const { list, index } = dropSlot(document, parentId, afterId);
    place(list, index, moving, parentId != null);
    removeUnit(moving);
  });
}

// The list a drop lands in, and where in it: behind a row, at the top of a row's children (made the way
// insertChild makes them), or at the top of the outline's own rows.
function dropSlot(document, parentId, afterId) {
  if (afterId != null) { const after = unit(document, afterId), list = after.parent(); return { list, index: indexOf(list, after) + 1 }; }
  if (parentId == null) { const list = rootKids(document); return { list, index: 0 }; }
  const { block, item: li } = must(document, parentId);
  const owner = li || (name(block) === 'paragraph' ? wrap(block) : null);
  if (!owner) throw new Error('This block cannot contain child nodes');
  const c = kids(owner), second = c.length > 1 ? c.get(1) : null;
  return { list: second && isList(second) ? kids(second) : kids(create(c, 1, 'bulletList')), index: 0 };
}

// Put a unit where the destination keeps its rows: a list holds listItems and everything else holds bare blocks, so
// a paragraph dropped into a list becomes an item of it and a list row dropped among prose brings a list with it —
// the one already beside it where there is one, so a drop between two bullets does not split them into two lists.
// A bare block dropped beside list rows keeps what it is: the list splits and it stands between the halves, which
// is what a divider dropped into a list does (insertDivider). Only where Tana's schema leaves no choice is it
// wrapped — as somebody's child, and for a paragraph among somebody's children, where a bare one is not a row
// Tana reads back at all (it takes its bullet from the grandparent list; see atRoot).
function place(list, index, src, asChild) {
  const intoItems = isList(list.parent());
  if (isItem(src) === intoItems) return copy(list, index, src);
  if (intoItems) {
    const holder = list.parent();
    if (asChild || (name(src) === 'paragraph' && !atRoot(holder))) return copy(kids(create(list, index, 'listItem')), 0, src);
    // index is 1 or more here: a drop inside a row lands above, so the list always keeps a head
    return copy(holder.parent(), splitHolder(holder, index - 1), src);
  }
  const before = index > 0 ? list.get(index - 1) : null, after = index < list.length ? list.get(index) : null;
  if (before && isList(before)) return copy(kids(before), kids(before).length, src);
  if (after && isList(after)) return copy(kids(after), 0, src);
  return copy(kids(create(list, index, 'bulletList')), 0, src);
}

// Scratchpad: checked belongs to listItem.attributes, never the paragraph or document data.
// Plain -> unchecked; existing checkbox -> toggle. wrap copies inline marks, mentions and blockId.
function toggleCheckbox(document, id) {
  document.transact(() => {
    const found = must(document, id);
    if (!['paragraph', 'heading'].includes(name(found.block))) throw new Error('This block cannot become a checkbox');
    const li = found.item || wrap(found.block);
    const a = li.get('attributes');
    a.set('checked', a.get('checked') === false);
  });
}

// ---- block types

// A block type is a container plus a leaf node name: bullet/numbered live in a listItem, quote in a blockquote,
// and paragraph/heading/code stand on their own, so the types stay mutually exclusive the way Tana's style menu
// presents them. The blockId and the inline content survive a conversion; a node's own children are outdented to
// follow it, because a heading, a quote and a code block cannot own children in Tana's schema.
function setBlockType(document, id, type) {
  if (typeof id !== 'string' || !id) throw new Error('outline node id must be a string');
  if (!BLOCK_TYPES.includes(type)) throw new Error('Unknown block type ' + type);
  document.transact(() => {
    if (ATOMS.includes(name(must(document, id).block))) throw new Error('This block cannot change type');
    if (type === 'paragraph' && !atRoot(unit(document, id))) throw new Error('A child node cannot be plain text');
    // Only a document's own row can be plain text. A child is a block inside its parent's listItem, and a bare
    // paragraph there is not a row Tana can read back: the conversion takes it out of the list its parent keeps
    // its children in, which quietly rearranges the outline around it.

    rehome(document, id, type === 'bullet' ? 'bulletList' : type === 'numbered' ? 'orderedList' : type === 'quote' ? 'blockquote' : null);
    setLeaf(must(document, id).block, type);
  });
}

// Move the node into the container its type needs: out of the list or quote it sits in, then into `wanted`.
function rehome(document, id, wanted) {
  const { block, item } = must(document, id);
  const holder = holderOf(block);
  // A bare block among somebody's children takes its holder from the grandparent list (holderOf, which is what
  // draws it as a list row), but it is not one of that holder's items: an index in its own list means nothing to
  // splitHolder, which moved the wrong row and left the block at the document root. It is left where it is and
  // only enclosed below, which is how it becomes a list row among its siblings.
  const inHolder = !!holder && (item || block).parent().id === kids(holder).id;
  if (inHolder && name(holder) === wanted) return;
  // Between the two list kinds a listItem moves whole, so its children and its checkbox stay with it.
  if (holder && item && isList(holder) && LISTS.includes(wanted)) {
    const inner = item.parent(), i = indexOf(inner, item);
    if (inner.length === 1) return holder.set('nodeName', wanted);
    const outer = holder.parent(), at = splitHolder(holder, i);
    copy(kids(create(outer, at, wanted)), 0, item);
    inner.delete(i, 1);
    prune(inner);
    return;
  }
  if (inHolder) {
    const unit = item || block, inner = unit.parent(), i = indexOf(inner, unit);
    const outer = holder.parent(), at = splitHolder(holder, i);
    if (item) { const c = kids(item); for (let j = 0; j < c.length; j++) copy(outer, at + j, c.get(j)); } // the node, then its children
    else copy(outer, at, block);
    inner.delete(i, 1);
    prune(inner);
  }
  if (wanted) enclose(must(document, id).block, wanted);
}

// Split a list or blockquote after its child at `index`: the children behind it continue in a copy of the holder,
// and the returned index in the holder's own list is where the extracted child belongs, in outline order.
function splitHolder(holder, index) {
  const inner = kids(holder), outer = holder.parent(), at = indexOf(outer, holder) + 1, tail = inner.length - index - 1;
  if (tail > 0) {
    const rest = create(outer, at, name(holder));
    for (let j = 0; j < tail; j++) copy(kids(rest), j, inner.get(index + 1 + j));
    inner.delete(index + 1, tail);
  }
  return at;
}

// Put a bare block inside a fresh listItem or blockquote (joining an adjacent list of the same kind).
function enclose(block, holderName) {
  if (holderName !== 'blockquote') return wrap(block, holderName);
  const list = block.parent(), quote = create(list, indexOf(list, block), 'blockquote');
  copy(kids(quote), 0, block);
  list.delete(indexOf(list, block), 1);
  return quote;
}

function setLeaf(block, type) {
  const want = type === 'code' ? 'codeBlock' : type.startsWith('heading') ? 'heading' : 'paragraph';
  const attributes = block.get('attributes');
  if (want === 'codeBlock' && name(block) !== 'codeBlock') flatten(block);
  if (name(block) !== want) block.set('nodeName', want);
  if (want === 'heading') attributes.set('level', Number(type.slice(-1)));
  else if (attributes.get('level') !== undefined) attributes.delete('level');
}

// A codeBlock holds plain text in Tana's schema (content text*, marks ''): keep the words, drop marks and mentions.
function flatten(block) {
  const c = kids(block), text = contentText({ content: block });
  if (c.length) c.delete(0, c.length);
  if (text) c.insertContainer(0, new LoroText()).insert(0, text);
}

// Tana's divider is a childless horizontalRule block (its web bundle builds these atoms with attributes only).
function insertDivider(document, id) {
  let out = null;
  if (id != null && typeof id !== 'string') throw new Error('outline node id must be a string');
  document.transact(() => {
    const list = rootKids(document);
    if (id == null) { out = divider(list, list.length); return; }
    const { block, item } = must(document, id);
    const holder = holderOf(block);
    const unit = item || block;
    // A list holds listItems only, so a rule between two items splits the list instead of joining it.
    // Only where this row is an item of that list: a bare block among somebody's children is not, and splitting by
    // its index put the rule outside the list altogether instead of beside the row it was asked for.
    if (holder && isList(holder) && unit.parent().id === kids(holder).id) { out = divider(holder.parent(), splitHolder(holder, indexOf(unit.parent(), unit))); return; }
    const l = unit.parent();
    out = divider(l, indexOf(l, unit) + 1);
  });
  return out;
}

function divider(list, index) {
  const m = list.insertContainer(index, new LoroMap()), id = newId();
  m.set('nodeName', 'horizontalRule');
  m.setContainer('attributes', new LoroMap()).set('blockId', id);
  return id;
}

// A document dropped into an outline cannot move there — it lives in Tana, not inside this node — so what lands is
// a reference to it: one block whose whole content is a mention, which is Tana's full-reference presentation and
// exactly what the renderer draws as the node itself. The place is named the way a drag names it (dropSlot), and
// the row is written as a list row or as prose, whichever the destination keeps.
function insertMention(document, { uri, label } = {}, { parentId = null, afterId = null } = {}) {
  if (typeof uri !== 'string' || !uri) throw new Error('a reference needs the uri of a node');
  let out = null;
  styleDoc(document);
  document.transact(() => {
    const { list, index } = dropSlot(document, parentId, afterId);
    const block = isList(list.parent()) ? kids(item(list, index, '')).get(0) : paragraph(list, index, '');
    out = blockId(block);
    const { groups, marked } = inlineGroups([{ mention: { label: label || uri, uri } }]);
    writeInline(kids(block), groups, marked);
  });
  return out;
}

module.exports = { cursorAt, readOutline, assignBlockIds, setText, inlineGroups, writeInline, styleDoc, setBlockType, insertDivider, insertAfter, insertBefore, insertChild, insertMention, split, remove, removeMany, indent, indentMany, outdent, outdentMany, move, moveMany, moveTo, toggleCheckbox, newId, BLOCK_TYPES };
