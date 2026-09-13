'use strict';
// Typed fields ("attributes"): each value is a ProseMirror-style tree stored in the document's own data map under
// "<type uri>?attribute=<key>", exactly like 'content' but rooted per field. Field names live in the type
// document's template.attributes ([{ key, title, type?, cardinality?, to? }]). Verified on a real typed node.
const { LoroMap, LoroList, LoroText } = require('loro-crdt');

const newBlockId = () => { let s = ''; while (s.length < 8) s += Math.random().toString(36).slice(2); return s.slice(0, 8); };
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

// [{ key, typeUri, attribute, text }] for every field the document carries
function readFields(document) {
  const attrs = document.data.get('attributes');
  const json = attrs && typeof attrs.toJSON === 'function' ? attrs.toJSON() : attrs;
  if (!json || typeof json !== 'object') return [];
  return Object.entries(json).map(([key, value]) => ({ key, ...parseKey(key), text: valueText(value).trim() }));
}

// the titles a type gives its fields: { key: title }
function templateTitles(typeDocument) {
  const template = typeDocument.data.get('template');
  const defs = (template && typeof template.toJSON === 'function' ? template.toJSON() : template) || {};
  const out = {};
  for (const def of defs.attributes || []) if (def && def.key) out[def.key] = def.title || def.key;
  return out;
}

// Replace a field's text, creating the doc/paragraph shell when the field is empty. Mirrors the observed layout:
// { nodeName: 'doc', attributes: {}, children: [{ nodeName: 'paragraph', attributes: { blockId }, children: [text] }] }
function setFieldText(document, key, text) {
  if (!key || typeof key !== 'string') throw new Error('field key required');
  if (typeof text !== 'string') throw new Error('field text must be a string');
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
    let paragraph = children.length ? children.get(0) : null;
    if (!paragraph || typeof paragraph.setContainer !== 'function') {
      paragraph = children.insertContainer(0, new LoroMap());
      paragraph.set('nodeName', 'paragraph');
      paragraph.setContainer('attributes', new LoroMap()).set('blockId', newBlockId());
      paragraph.setContainer('children', new LoroList());
    }
    let runs = paragraph.get('children');
    if (!runs || typeof runs.insertContainer !== 'function') runs = paragraph.setContainer('children', new LoroList());
    while (runs.length > 1) runs.delete(1, runs.length - 1);
    const first = runs.length ? runs.get(0) : null;
    if (first && typeof first.kind === 'function' && first.kind() === 'Text') first.update(text);
    else { if (runs.length) runs.delete(0, 1); runs.insertContainer(0, new LoroText()).insert(0, text); }
  });
  return text;
}

module.exports = { readFields, templateTitles, setFieldText, valueText, parseKey };
