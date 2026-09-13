'use strict';
// Outline operations over the loro-prosemirror content layout (docs/OUTLINER.md): a block is a LoroMap
// { nodeName, attributes: LoroMap, children: LoroList }; inline content is LoroText runs and mention LoroMaps.
// Outline nodes are paragraphs/headings/blockquotes/codeBlocks; a listItem is the node of its first paragraph
// and its remaining blocks are that node's children; bulletList/orderedList are transparent.
const { LoroMap, LoroList, LoroText } = require('loro-crdt');
const { contentText } = require('./node');

const LISTS = ['bulletList', 'orderedList'];
const name = (m) => m.get('nodeName');
const kids = (m) => m.get('children');
// The root content map of a fresh document (events, new docs) is empty; create the doc skeleton on first write.
function rootKids(document) {
  const c = document.content;
  if (!c.get('children')) { c.set('nodeName', 'doc'); c.setContainer('attributes', new LoroMap()); c.setContainer('children', new LoroList()); }
  return c.get('children');
}
const isList = (m) => LISTS.includes(name(m));
const isItem = (m) => name(m) === 'listItem';
const isMention = (x) => x.kind() === 'Map' && name(x) === 'mention';
const blockId = (m) => { const a = m.get('attributes'); return a ? a.get('blockId') : undefined; };
const newId = () => { let s = ''; while (s.length < 8) s += Math.random().toString(36).slice(2); return s.slice(0, 8); };

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
  const n = { id: blockId(block), text: contentText({ content: block }), kind: 'block', hasChildren: children.length > 0, children };
  n.segments = inline(block) || (n.text ? [{ text: n.text }] : []);
  if (name(block) === 'embed') {
    const a = block.get('attributes');
    n.type = 'reference'; n.editable = false;
    n.reference = { uri: a.get('tanaUri'), ...(typeof a.get('label') === 'string' ? { label: a.get('label') } : {}) };
  }
  if (name(block) === 'heading') n.heading = block.get('attributes').get('level');
  if (name(block) === 'image') { // { nodeName 'image', attributes { blockId, tanaUri, displayWidth?, displayHeight? }, children [] }; no alt stored
    const a = block.get('attributes');
    n.type = 'image';
    n.image = { uri: a.get('tanaUri'), alt: null, width: a.get('displayWidth') ?? null, height: a.get('displayHeight') ?? null };
  }
  return n;
}

// Inline runs of a block as segments; null when the block holds child blocks instead (blockquote).
function inline(block) {
  const c = kids(block), out = [];
  for (let i = 0; i < c.length; i++) {
    const x = c.get(i);
    if (x.kind() === 'Text') out.push({ text: x.toString() });
    else if (isMention(x)) { const a = x.get('attributes'); out.push({ mention: { label: a.get('label'), uri: a.get('tanaUri') } }); }
    else return null;
  }
  return out;
}

// -> { block, item } where item is the listItem the node represents (null for a bare block).
function locate(list, id) {
  for (let i = 0; i < list.length; i++) {
    const b = list.get(i);
    if (isItem(b) && kids(b).length && blockId(kids(b).get(0)) === id) return { block: kids(b).get(0), item: b };
    if (blockId(b) === id) return { block: b, item: null };
    if (isList(b) || isItem(b)) { const r = locate(kids(b), id); if (r) return r; }
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

// Turn a bare paragraph into a listItem (joining the list right before it when there is one); returns the listItem.
function wrap(block) {
  const list = block.parent(), i = indexOf(list, block);
  const prev = i > 0 ? list.get(i - 1) : null;
  const items = prev && isList(prev) ? kids(prev) : kids(create(list, i, 'bulletList'));
  const li = create(items, items.length, 'listItem');
  copy(kids(li), 0, block);
  list.delete(indexOf(list, block), 1);
  return li;
}

// Remove a list that became empty, and whatever that empties in turn.
function prune(list) {
  const m = list.parent();
  if (list.length === 0 && m && isList(m)) { const l = m.parent(); l.delete(indexOf(l, m), 1); prune(l); }
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

// value: a string or segments [{ text } | { mention: { label, uri } }]. Runs are matched by position: a text run
// is updated in place (diffing update keeps marks and concurrent edits), a mention with the same uri is kept,
// anything else is replaced; trailing runs are dropped.
function setText(document, id, value) {
  if (name(must(document, id).block) === 'embed') throw new Error('Reference blocks cannot contain editable text');
  const segs = (typeof value === 'string' ? [{ text: value }] : value).filter((s) => s.mention || s.text);
  document.transact(() => {
    const c = kids(must(document, id).block);
    segs.forEach((s, i) => {
      const cur = i < c.length ? c.get(i) : null;
      if (cur && s.text != null && cur.kind() === 'Text') return cur.update(s.text);
      if (cur && s.mention && isMention(cur) && cur.get('attributes').get('tanaUri') === s.mention.uri) return;
      if (cur) c.delete(i, 1);
      if (s.text != null) return c.insertContainer(i, new LoroText()).insert(0, s.text);
      const m = c.insertContainer(i, new LoroMap());
      m.set('nodeName', 'mention');
      const a = m.setContainer('attributes', new LoroMap());
      a.set('label', s.mention.label);
      a.set('tanaUri', s.mention.uri);
    });
    if (c.length > segs.length) c.delete(segs.length, c.length - segs.length);
  });
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

function indent(document, id) {
  document.transact(() => {
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
  });
}

function outdent(document, id) {
  document.transact(() => {
    const { block, item: li } = must(document, id);
    if (!li && name(block) !== 'paragraph') return;
    const unit = li || block, l = unit.parent();
    const parent = li ? l.parent().parent().parent() : l.parent(); // listItem owning this node, or the doc map
    if (!isItem(parent)) return;
    const pl = parent.parent(), at = indexOf(pl, parent) + 1;
    if (li) copy(pl, at, li); else copy(kids(create(pl, at, 'listItem')), 0, block);
    l.delete(indexOf(l, unit), 1);
    prune(l);
  });
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

module.exports = { readOutline, setText, insertAfter, insertChild, remove, removeMany, indent, outdent, move, moveMany, toggleCheckbox };
