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
const isList = (m) => LISTS.includes(name(m));
const isItem = (m) => name(m) === 'listItem';
const blockId = (m) => { const a = m.get('attributes'); return a ? a.get('blockId') : undefined; };
const newId = () => { let s = ''; while (s.length < 8) s += Math.random().toString(36).slice(2); return s.slice(0, 8); };

function indexOf(list, m) {
  for (let i = 0; i < list.length; i++) if (list.get(i).id === m.id) return i;
  throw new Error('container not in list');
}

// ---- read

function readOutline(document) {
  return nodes(kids(document.content));
}

function nodes(list, from = 0) {
  const out = [];
  for (let i = from; i < list.length; i++) {
    const b = list.get(i);
    if (!isList(b)) { out.push(node(b, [])); continue; }
    const items = kids(b);
    for (let j = 0; j < items.length; j++) {
      const c = kids(items.get(j));
      if (c.length) out.push(node(c.get(0), nodes(c, 1)));
    }
  }
  return out;
}

function node(block, children) {
  const n = { id: blockId(block), text: contentText({ content: block }), kind: 'block', hasChildren: children.length > 0, children };
  if (name(block) === 'heading') n.heading = block.get('attributes').get('level');
  return n;
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

function item(list, index, text) {
  const li = create(list, index, 'listItem');
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

function setText(document, id, text) {
  document.transact(() => {
    const c = kids(must(document, id).block);
    const only = c.length === 1 && c.get(0).kind() === 'Text' ? c.get(0) : null;
    if (only && text) only.update(text); // ponytail: diffing update keeps concurrent edits mergeable; mentions in mixed content are replaced
    else { c.clear(); if (text) c.insertContainer(0, new LoroText()).insert(0, text); }
  });
}

function insertAfter(document, id, text) {
  let out = null;
  document.transact(() => {
    const list = kids(document.content);
    if (id == null) { out = blockId(paragraph(list, list.length, text)); return; }
    const { block, item: li } = must(document, id);
    const unit = li || block, l = unit.parent(), i = indexOf(l, unit) + 1;
    out = blockId(li ? kids(item(l, i, text)).get(0) : paragraph(l, i, text));
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
    out = blockId(kids(item(items, 0, text)).get(0));
  });
  return out;
}

function remove(document, id) {
  document.transact(() => {
    const { block, item: li } = must(document, id);
    const unit = li || block, l = unit.parent();
    l.delete(indexOf(l, unit), 1);
    prune(l);
  });
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

module.exports = { readOutline, setText, insertAfter, insertChild, remove, indent, outdent };
