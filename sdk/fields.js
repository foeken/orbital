'use strict';
// Typed fields ("attributes"): each value is a ProseMirror-style tree stored in the document's own data map under
// "<type uri>?attribute=<key>", exactly like 'content' but rooted per field. Field names live in the type
// document's template.attributes ([{ key, title, type?, cardinality?, to?, options? }]). Verified on a real typed node.
const { LoroMap, LoroList, LoroMovableList } = require('loro-crdt');
const content = require('./content');
const { isDateUri } = require('./dates');

const parseKey = (key) => { const [typeUri, attribute] = String(key).split('?attribute='); return { typeUri, attribute }; };

// plain text of a value tree, from its JSON form (children are strings, text runs or inline maps)
function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(valueText).join('');
  if (value && value.nodeName === 'mention') return (value.attributes && value.attributes.label) || '';
  if (typeof value === 'object') return valueText(value.children);
  return '';
}

// The inline runs of one block as segments ([{ text } | { mention: { label, uri } }]), the shape the outline's rows
// use, so a field value renders and edits the same way a line does. Marks are not read: a field is words and
// references.
const isInlineJson = (run) => typeof run === 'string' || (run && run.nodeName === 'mention');
function runSegments(runs) {
  const out = [];
  for (const run of runs || []) {
    if (typeof run === 'string') { if (run) out.push({ text: run }); }
    else if (run && run.nodeName === 'mention') out.push({ mention: { label: (run.attributes && run.attributes.label) || '', uri: run.attributes && run.attributes.tanaUri } });
    else if (run && typeof run === 'object') { const t = valueText(run); if (t) out.push({ text: t }); }
  }
  return out;
}
// A field holds what a node holds: several blocks, and the block types a line can have. Every block that carries
// words is one line here — `{ segments, block }` — in the order they are stored, whatever it is nested in, so a
// bulleted value reads as its bullets, one line each. `block` is 'bullet' for a line inside a list and otherwise
// the block's own name ('paragraph', 'heading1', …), which is what lets a write put it back as it was.
function valueLines(value) {
  const blockLines = (block, inList) => {
    const name = (block && block.nodeName) || 'paragraph';
    const list = inList || name === 'listItem' || name === 'bulletList' || name === 'orderedList';
    const kids = (block && block.children) || [];
    if (!kids.length) return [{ segments: [], block: list ? 'bullet' : name }];
    if (kids.every(isInlineJson)) return [{ segments: runSegments(kids), block: list ? 'bullet' : name }];
    return kids.flatMap((kid) => (isInlineJson(kid) ? [{ segments: runSegments([kid]), block: list ? 'bullet' : name }] : blockLines(kid, list)));
  };
  const blocks = value && typeof value === 'object' && !Array.isArray(value) ? value.children : null;
  if (!Array.isArray(blocks)) return valueText(value) ? [{ segments: [{ text: valueText(value) }], block: 'paragraph' }] : [];
  return blocks.flatMap((block) => blockLines(block, false));
}
// [{ key, typeUri, attribute, text, segments, lines }] for every field the document carries. text joins the lines
// with newlines, so a value that is a list still reads as one string wherever only the words matter.
function readFields(document) {
  const attrs = document.data.get('attributes');
  const json = attrs && typeof attrs.toJSON === 'function' ? attrs.toJSON() : attrs;
  if (!json || typeof json !== 'object') return [];
  return Object.entries(json).map(([key, value]) => {
    const lines = valueLines(value);
    const words = (line) => line.segments.map((s) => ('text' in s ? s.text : s.mention.label)).join('');
    return { key, ...parseKey(key), text: lines.map(words).join('\n').trim(), segments: lines.length ? lines[0].segments : [], lines };
  });
}

// the titles a type gives its fields: { key: title }
function templateTitles(typeDocument) {
  const template = typeDocument.data.get('template');
  const defs = (template && typeof template.toJSON === 'function' ? template.toJSON() : template) || {};
  const out = {};
  for (const def of defs.attributes || []) if (def && def.key) out[def.key] = def.title || def.key;
  return out;
}
// One field's definition as the type holds it — { key, title, type?, cardinality?, to?: [{ uri, title? }],
// options?: [{ label }] } — or null. `attribute` is the template key (the part after "?attribute=").
function fieldDefinition(typeDocument, attribute) {
  const template = typeDocument.data.get('template');
  const defs = (template && typeof template.toJSON === 'function' ? template.toJSON() : template) || {};
  return (defs.attributes || []).find((def) => def && def.key === attribute) || null;
}

// ---- option labels and link targets, by Tana's rules (shared-*.js of 2026-09-22: ol/sl/cl/due, Ep/Ube) ----
// A label is trimmed, and must then be non-empty, one line and at most 60 characters; labels that differ only in
// case are one option, the first spelling kept. `labels` are strings or { label }.
const labelKey = (label) => label.trim().toLowerCase();
function optionLabels(labels) {
  if (!Array.isArray(labels)) throw new Error('options must be a list of labels');
  const seen = new Set();
  return labels.map((o) => (o && typeof o === 'object' ? o.label : o)).filter((label) => {
    if (typeof label !== 'string') throw new Error('option label must be a string');
    const t = label.trim();
    const problem = !t ? 'empty' : /[\n\r]/.test(t) ? 'contains-separator' : t.length > 60 ? 'too-long' : null;
    if (problem) throw new Error(`Invalid option label (${problem}): ${JSON.stringify(label)}`);
    if (seen.has(labelKey(t))) return false;
    seen.add(labelKey(t));
    return true;
  }).map((label) => label.trim());
}
// Link targets are types: uri strings or { uri, title? }, one entry per type (Tana's addLinkTarget skips a repeat).
const TYPE_URI = /^tana:type:[0-9a-z]{26}$/;
function linkTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('link targets must be a list of type uris');
  const out = [];
  for (const t of targets) {
    const target = typeof t === 'string' ? { uri: t } : t && typeof t === 'object' ? { uri: t.uri, ...(t.title ? { title: String(t.title) } : {}) } : {};
    if (!TYPE_URI.test(target.uri || '')) throw new Error('link target must be a type uri: ' + JSON.stringify(t));
    if (!out.some((o) => o.uri === target.uri)) out.push(target);
  }
  return out;
}
// A list of maps written again from the items — how `options` and `to` are held (Tana's schema: Fc.list, a LoroList).
function writeList(def, name, items) {
  let list = def.get(name);
  if (!list || typeof list.insertContainer !== 'function') list = def.setContainer(name, new LoroList());
  if (JSON.stringify(list.toJSON()) === JSON.stringify(items)) return; // unchanged: no ops
  if (list.length) list.delete(0, list.length);
  for (const item of items) { const map = list.insertContainer(list.length, new LoroMap()); for (const [k, v] of Object.entries(item)) map.set(k, v); }
}
// The map of one field definition in a type document, for the edits below.
function definitionMap(loro, attribute) {
  const template = loro.getMap('data').get('template');
  const attrs = template && typeof template.get === 'function' ? template.get('attributes') : null;
  for (let i = 0; attrs && i < attrs.length; i++) { const def = attrs.get(i); if (def && typeof def.get === 'function' && def.get('key') === attribute) return def; }
  throw new Error('no field ' + attribute + ' on this type');
}
// Replace an options field's choices (Tana's configureAsOptions, which every add, rename, remove and reorder of an
// option comes down to). Values already written keep their words: a renamed or removed label is simply no longer
// offered, as in Tana. Returns the labels written.
function setFieldOptions(typeDocument, attribute, labels) {
  const clean = optionLabels(labels);
  typeDocument.transact((loro) => {
    const def = definitionMap(loro, attribute);
    if (def.get('type') !== 'options') throw new Error('field ' + attribute + ' is not an options field');
    writeList(def, 'options', clean.map((label) => ({ label })));
  });
  return clean;
}
// Replace a link field's target types (Tana's configureAsLink with targets); [] lets it link to anything again.
function setFieldTargets(typeDocument, attribute, targets) {
  const clean = linkTargets(targets);
  typeDocument.transact((loro) => {
    const def = definitionMap(loro, attribute);
    if (def.get('type') !== 'link') throw new Error('field ' + attribute + ' is not a link field');
    writeList(def, 'to', clean);
  });
  return clean;
}
// Change what a field is (type; null makes it plain text) and how many values it holds. A kind keeps only the
// settings it uses, as Tana's configureAs… calls leave it: choices go when it stops being an options field (and an
// options field always has its list), targets when it stops being a link. Returns the definition written.
function setFieldKind(typeDocument, attribute, { type, cardinality } = {}) {
  if (type != null && !FIELD_TYPES.includes(type)) throw new Error('field type must be one of ' + FIELD_TYPES.join(', '));
  if (cardinality !== undefined && cardinality !== 'single' && cardinality !== 'multiple') throw new Error('cardinality must be single or multiple');
  typeDocument.transact((loro) => {
    const def = definitionMap(loro, attribute);
    const drop = (name) => { if (def.get(name) !== undefined) def.delete(name); };
    if (type !== undefined && (type || undefined) !== def.get('type')) {
      if (type) def.set('type', type); else drop('type');
      if (type === 'options') writeList(def, 'options', []); else drop('options');
      drop('to');
    }
    if (cardinality && cardinality !== def.get('cardinality')) def.set('cardinality', cardinality);
  });
  return fieldDefinition(typeDocument, attribute);
}

// The checks Tana makes of a value against its field's definition, before it is written. Takes and returns the
// lines setFieldText writes ({ words, block }); throws with Tana's own wording.
// - options (XL/dl/fl): every non-empty line is a label, case-insensitive repeats dropped; each must be one the
//   field declares, and is written as declared, one bullet each (Nye's layout); more than one needs cardinality
//   multiple. A field with no options declared takes nothing.
// - link and member (Ove.getValidationErrors): a line holds one reference and nothing else, and more than one
//   reference needs cardinality multiple (Tana's rule is "not single"; unset allows several).
// - link with `to` (validateTargetTypes): a reference whose type `typeOf(uri)` knows and the field does not list is
//   refused; one whose type is unknown passes, as in Tana. typeOf is the caller's, since it takes a lookup.
const wordsText = (words) => (typeof words === 'string' ? words : (words || []).map((s) => ('text' in s ? s.text : (s.mention && s.mention.label) || '')).join(''));
function checkValue(field, lines, typeOf) {
  if (field.type === 'options') {
    const declared = [];
    for (const o of field.options || []) if (o && typeof o.label === 'string' && !declared.some((d) => labelKey(d) === labelKey(o.label))) declared.push(o.label);
    const given = [];
    for (const line of lines) for (const l of wordsText(line.words).split('\n')) if (l.trim() && !given.some((g) => labelKey(g) === labelKey(l))) given.push(l.trim());
    if (!given.length) return [{ words: '', block: 'paragraph' }]; // an empty value is one empty paragraph, as Nye writes it
    const title = field.title || field.key;
    if (!declared.length) throw new Error(`Field "${title}" is an options field with no values defined yet.`);
    const undeclared = given.filter((g) => !declared.some((d) => labelKey(d) === labelKey(g)));
    if (undeclared.length) throw new Error(`Field "${title}" only accepts its declared values. Rejected: ${undeclared.map((e) => `"${e}"`).join(', ')}. Available: ${declared.map((e) => `"${e}"`).join(' | ')}.`);
    if (field.cardinality !== 'multiple' && given.length > 1) throw new Error(`Field "${title}" holds a single value, but ${given.length} were given: ${given.map((e) => `"${e}"`).join(', ')}.`);
    return given.map((g) => ({ words: declared.find((d) => labelKey(d) === labelKey(g)), block: 'bullet' }));
  }
  // A date field is held the way a link field is (Tana edits it with the same link ops): one mention per line, of a date.
  if (field.type === 'link' || field.type === 'member' || field.type === 'date') {
    const links = [];
    for (const line of lines) {
      const segs = (typeof line.words === 'string' ? [{ text: line.words }] : line.words || []).filter((s) => !('text' in s) || s.text !== '');
      if (!segs.length) continue;
      if (segs.length > 1 || !segs[0].mention || !segs[0].mention.uri) throw new Error('Contains non-link content');
      links.push(segs[0].mention);
    }
    if (field.cardinality === 'single' && links.length > 1) throw new Error(`Multiple values not allowed (found ${links.length})`);
    const notDate = field.type === 'date' && links.find((link) => !isDateUri(link.uri));
    if (notDate) throw new Error(`"${notDate.label}" is not a date`);
    const targets = field.type === 'link' ? (field.to || []).map((t) => t.uri).filter(Boolean) : [];
    if (targets.length && typeOf) {
      for (const link of links) {
        const type = typeOf(link.uri);
        if (type && !targets.includes(type)) throw new Error(`"${link.label}" has wrong type (expected one of: ${targets.join(', ')})`);
      }
    }
  }
  return lines;
}

// The blocks of a value that carry words, in reading order, as Loro containers — the write side of valueLines.
// `kind` is the line kind valueLines reports for it: 'bullet' inside a list, else the block's own name.
const nameOf = (block) => (block && typeof block.get === 'function' ? block.get('nodeName') : null);
const isInlineRun = (run) => !run || typeof run.get !== 'function' || nameOf(run) === 'mention';
function leafBlocks(list, out = [], inList = false) {
  for (let i = 0; i < list.length; i++) {
    const block = list.get(i);
    if (!block || typeof block.get !== 'function') continue;
    const name = nameOf(block) || 'paragraph';
    const nested = inList || name === 'listItem' || name === 'bulletList' || name === 'orderedList';
    const kids = block.get('children');
    if (kids && typeof kids.get === 'function' && kids.length && !isInlineRun(kids.get(0))) leafBlocks(kids, out, nested);
    else out.push({ node: block, parent: list, index: i, kind: nested ? 'bullet' : name });
  }
  return out;
}
// A container left with nothing in it is not an empty line, it is a bullet with nothing under it, so it goes with
// the line that was removed. An empty paragraph stays: that *is* an empty line.
function pruneEmpty(list) {
  for (let i = list.length - 1; i >= 0; i--) {
    const block = list.get(i), kids = block && typeof block.get === 'function' ? block.get('children') : null;
    if (!kids || typeof kids.get !== 'function') continue;
    if (kids.length && !isInlineRun(kids.get(0))) pruneEmpty(kids);
    if (!kids.length && nameOf(block) !== 'paragraph') list.delete(i, 1);
  }
}
function addBlock(list, name = 'paragraph') {
  const block = list.insertContainer(list.length, new LoroMap());
  block.set('nodeName', name);
  block.setContainer('attributes', new LoroMap()).set('blockId', content.newId());
  return { block, runs: block.setContainer('children', new LoroList()) };
}
// The whole value written again, which is what a line changing its kind needs: consecutive bullets share one list,
// each as a listItem holding a paragraph — the layout a value Tana bulleted already has — and every other line is
// a block of its own name.
function rebuild(children, lines) {
  while (children.length) children.delete(children.length - 1, 1);
  let list = null;
  return lines.map((line) => {
    if (line.block !== 'bullet') { list = null; return addBlock(children, line.block || 'paragraph').runs; }
    if (!list) { const holder = addBlock(children, 'bulletList'); list = holder.runs; }
    const item = addBlock(list, 'listItem');
    return addBlock(item.runs, 'paragraph').runs;
  });
}
// Replace a field's value — plain text, segments with references, or an array of those, which is a line each.
// A line is written into the block that held it, whatever that block is, so editing a value that is a bulleted
// list leaves it bulleted; lines beyond what the value had are added as paragraphs, and lines taken away take
// their blocks with them.
// ponytail: a line added to a bulleted value arrives as a paragraph at the end rather than as one more bullet;
// give a line its block type if that ever matters.
// Creates the doc/paragraph shell when the field is empty. Mirrors the observed layout:
// { nodeName: 'doc', attributes: {}, children: [{ nodeName: 'paragraph', attributes: { blockId }, children: [text | mention] }] }
// The runs are written by the same code a line's are (sdk/content.js), so a mention is the map Tana expects.
// With { field } — the definition, as fieldDefinition gives it — the value is checked the way Tana checks it first
// (checkValue above), and nothing is written when it fails; `typeOf(uri)` answers a linked document's type.
function setFieldText(document, key, text, { field, typeOf } = {}) {
  if (!key || typeof key !== 'string') throw new Error('field key required');
  if (typeof text !== 'string' && !Array.isArray(text)) throw new Error('field text must be a string or segments');
  // One value: a string, one line's segments, or an array of lines — each a string, segments, or { segments, block }.
  const isLine = (line) => typeof line === 'string' || Array.isArray(line) || (line && typeof line === 'object' && !('text' in line) && !('mention' in line));
  const isLines = Array.isArray(text) && text.length > 0 && text.every(isLine);
  let given = (isLines ? text : [text]).map((line) => {
    const words = line && !Array.isArray(line) && typeof line === 'object' && 'segments' in line ? line.segments : line;
    const block = line && !Array.isArray(line) && typeof line === 'object' && line.block ? line.block : 'paragraph';
    return { words: words === undefined || words === null ? '' : words, block };
  });
  if (field) given = checkValue(field, given, typeOf);
  const lines = given.map(({ words, block }) => ({ ...content.inlineGroups(words), block }));
  content.styleDoc(document);
  document.transact((loro) => {
    const data = loro.getMap('data');
    let attrs = data.get('attributes');
    if (!attrs || typeof attrs.setContainer !== 'function') attrs = data.setContainer('attributes', new LoroMap());
    let value = attrs.get(key);
    if (!value || typeof value.setContainer !== 'function') {
      value = attrs.setContainer(key, new LoroMap());
      value.set('nodeName', 'doc');
      value.setContainer('attributes', new LoroMap());
      value.setContainer('children', new LoroList());
    }
    let children = value.get('children');
    if (!children || typeof children.insertContainer !== 'function') children = value.setContainer('children', new LoroList());
    // Words changing is the common case and is written into the blocks that are already there, so a value keeps
    // whatever it was — bullets, a heading — and its block ids with it. A line becoming a bullet (or stopping)
    // changes the shape of the value, and that is written again from the top.
    const leaves = leafBlocks(children);
    const shared = Math.min(leaves.length, lines.length);
    const prefix = lines.slice(0, shared).every((line, i) => leaves[i].kind === line.block);
    // Extra lines can be appended in place only where every line is a plain paragraph; a bullet arriving (or
    // leaving) changes the shape of the value, and that is written again from the top.
    const patchable = prefix && (lines.length <= leaves.length || (leaves.every((leaf) => leaf.kind === 'paragraph') && lines.every((line) => line.block === 'paragraph')));
    let runsFor;
    if (patchable) {
      for (let i = leaves.length - 1; i >= lines.length; i--) leaves[i].parent.delete(leaves[i].index, 1); // from the end, so the indexes above still hold
      pruneEmpty(children);
      runsFor = lines.map((line, i) => {
        if (i >= leaves.length) return addBlock(children, 'paragraph').runs;
        const runs = leaves[i].node.get('children');
        return runs && typeof runs.insertContainer === 'function' ? runs : leaves[i].node.setContainer('children', new LoroList());
      });
    } else {
      runsFor = rebuild(children, lines);
    }
    lines.forEach((line, i) => content.writeInline(runsFor[i], line.groups, line.marked));
  });
  return text;
}

// ---- a field value as a document, so the outline editor can drive it ----
// A field's value is a content tree of exactly the shape a document's `content` is — `{ nodeName: 'doc', children }`
// with paragraphs, lists, quotes and block ids inside it — kept in the document's own data map instead of at its
// root. Wrapping one as a document is therefore enough to let every operation in sdk/content.js work on it: read,
// split, indent, block types, checkboxes, references. That is what keeps the page and the field editor the same
// code rather than two editors drifting apart.
//
// `create` decides what an absent value does: a write needs the shell to exist, a read must not write one, or
// opening a typed page would fill in every empty field it has.
const EMPTY = { get: () => undefined, set: () => {}, setContainer: () => { throw new Error('field value is not open for writing'); } };
// The id a field view answers to, built below: "<document uri>|<type uri>?attribute=<key>". It is parsed in
// main/documents.js, which took the outline operations there, so the format is written once, here.
const FIELD_ID = /^(tana:[a-z-]+:[0-9a-z]{26})\|(tana:type:[0-9a-z]{26}\?attribute=[0-9a-z]{8})$/;
function fieldView(document, key, { create = false } = {}) {
  if (!key || typeof key !== 'string') throw new Error('field key required');
  const found = () => { const attrs = document.data.get('attributes'); const value = attrs && typeof attrs.get === 'function' ? attrs.get(key) : null; return value && typeof value.get === 'function' ? value : null; };
  const ensure = () => {
    const value = found();
    if (value) return value;
    let made = null;
    document.transact((loro) => {
      const data = loro.getMap('data');
      let attrs = data.get('attributes');
      if (!attrs || typeof attrs.setContainer !== 'function') attrs = data.setContainer('attributes', new LoroMap());
      made = attrs.get(key);
      if (!made || typeof made.setContainer !== 'function') {
        made = attrs.setContainer(key, new LoroMap());
        made.set('nodeName', 'doc');
        made.setContainer('attributes', new LoroMap());
        made.setContainer('children', new LoroList());
      }
    });
    return made;
  };
  return {
    id: document.id + '|' + key,
    key,
    document,
    data: document.data,
    loro: document.loro,
    transact: (fn) => document.transact(fn),
    get content() { return (create ? ensure() : found()) || EMPTY; },
  };
}

// Define a field on a type: one more entry in the type document's template.attributes, in the layout a real type
// carries (a MovableList of maps: { key, title, type?, cardinality?, to?, options? }). Tana's schema allows the types
// link, date, member and options; a plain text field has no type at all. Keys are Tana's own 8-character ids
// (content.newId). `options` (labels, by optionLabels' rules) belong to an options field, which always gets the list,
// empty or not, as Tana's setAttributeType writes it; `to` (type uris or { uri, title }) to a link field. Returns the key.
const FIELD_TYPES = ['link', 'date', 'member', 'options'];
function addField(typeDocument, { title, type, cardinality, options, to } = {}) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('field title required');
  if (type !== undefined && !FIELD_TYPES.includes(type)) throw new Error('field type must be one of ' + FIELD_TYPES.join(', '));
  if (cardinality !== undefined && cardinality !== 'single' && cardinality !== 'multiple') throw new Error('cardinality must be single or multiple');
  if (options !== undefined && type !== 'options') throw new Error(`field "${title.trim()}" has type "${type}", which takes no options`);
  if (to !== undefined && type !== 'link') throw new Error(`field "${title.trim()}" has type "${type}", which takes no link targets`);
  const labels = type === 'options' ? optionLabels(options || []) : null;
  const targets = to !== undefined ? linkTargets(to) : null;
  const key = content.newId();
  typeDocument.transact((loro) => {
    const data = loro.getMap('data');
    let template = data.get('template');
    if (!template || typeof template.setContainer !== 'function') template = data.setContainer('template', new LoroMap());
    let attrs = template.get('attributes');
    if (!attrs || typeof attrs.pushContainer !== 'function') attrs = template.setContainer('attributes', new LoroMovableList());
    const def = attrs.pushContainer(new LoroMap());
    def.set('key', key); def.set('title', title.trim());
    if (type) def.set('type', type);
    if (cardinality) def.set('cardinality', cardinality);
    if (labels) writeList(def, 'options', labels.map((label) => ({ label })));
    if (targets) writeList(def, 'to', targets);
  });
  return key;
}

module.exports = { readFields, templateTitles, fieldDefinition, setFieldText, parseKey, fieldView, addField, setFieldOptions, setFieldTargets, setFieldKind, FIELD_ID };
