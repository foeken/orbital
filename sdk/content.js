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

// One of BLOCK_TYPES (plus 'divider'), or undefined for blocks that carry their own type (image, embed).
function blockType(block) {
  const n = name(block);
  if (n === 'horizontalRule') return 'divider';
  if (ATOMS.includes(n)) return undefined;
  if (n === 'heading') return 'heading' + (block.get('attributes').get('level') || 1);
  if (n === 'codeBlock') return 'code';
  const holder = holderOf(block);
  if (!holder) return 'paragraph';
  return isQuote(holder) ? 'quote' : name(holder) === 'orderedList' ? 'numbered' : 'bullet';
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
  const target = must(document, id).block;
  if (!kids(target)) throw new Error('Reference blocks cannot contain editable text');
  if (name(target) === 'embed') throw new Error('Reference blocks cannot contain editable text');
  const plain = name(target) === 'codeBlock'; // codeBlock content is text* with marks '' in Tana's schema
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
  styleDoc(document);
  document.transact(() => {
    const c = kids(must(document, id).block);
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
  });
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

function insertAfter(document, id, text) {
  let out = null;
  document.transact(() => {
    const list = rootKids(document);
    if (id == null) { out = blockId(paragraph(list, list.length, text)); return; }
    const { block, item: li } = must(document, id);
    const unit = li || block, l = unit.parent(), i = indexOf(l, unit) + 1;
    out = blockId(li ? kids(item(l, i, text, li)).get(0) : paragraph(l, i, text));
  });
  return out;
}

function insertChild(document, id, text) {
  let out = null;
  document.transact(() => {
    const { block, item: li } = must(document, id);
    const owner = li || (name(block) === 'paragraph' ? wrap(block) : null);
    if (!owner) return; // headings/quotes/code cannot own children in this schema
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

function selectedUnits(document, ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('outline selection must contain at least one node');
  const seen = new Set(), units = ids.map((id) => {
    if (typeof id !== 'string' || seen.has(id)) throw new Error('outline selection contains duplicate or invalid node ids');
    seen.add(id);
    return unit(document, id);
  });
  const parent = units[0].parent();
  if (!units.every((unit) => unit.parent().id === parent.id)) throw new Error('outline selection must be siblings');
  return units;
}

function remove(document, id) {
  document.transact(() => removeUnit(unit(document, id)));
}

// Multi-select is one user action: use one CRDT transaction so undo/redo restores the whole sibling range.
// ids are in visual order; removal runs last-first to keep all positions valid.
function removeMany(document, ids) {
  const units = selectedUnits(document, ids);
  document.transact(() => { for (const unit of [...units].reverse()) removeUnit(unit); });
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
    rehome(document, id, type === 'bullet' ? 'bulletList' : type === 'numbered' ? 'orderedList' : type === 'quote' ? 'blockquote' : null);
    setLeaf(must(document, id).block, type);
  });
}

// Move the node into the container its type needs: out of the list or quote it sits in, then into `wanted`.
function rehome(document, id, wanted) {
  const { block, item } = must(document, id);
  const holder = holderOf(block);
  if (holder && name(holder) === wanted) return;
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
  if (holder) {
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
    // A list holds listItems only, so a rule between two items splits the list instead of joining it.
    if (holder && isList(holder)) { const unit = item || block; out = divider(holder.parent(), splitHolder(holder, indexOf(unit.parent(), unit))); return; }
    const unit = item || block, l = unit.parent();
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

module.exports = { readOutline, setText, setBlockType, insertDivider, insertAfter, insertChild, remove, removeMany, indent, indentMany, outdent, outdentMany, move, moveMany, toggleCheckbox, BLOCK_TYPES };
