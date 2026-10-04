'use strict';
// The rows and answers the engine hands both phones (ios/engine/index.js) are declared twice: as Swift Decodables in
// ios/Orbital and as Kotlin @Serializable classes in the Android app's shared module. A field added on one side only is
// read by one phone and dropped without a word by the other. This checks that both declare the same fields for each of
// those types, and that every key of the invented sample both phones draw with -sample (ios/Orbital/*-sample.json) is
// one both read, so the sample never shows something one phone would not.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/(^|[^:"])\/\/.*$/gm, '$1'); // comments out; a url's // stays
const SWIFT = ['ios/Orbital/Timeline.swift', 'ios/Orbital/Engine.swift', 'ios/Orbital/Translator.swift'];
const KOTLIN = ['android/shared/src/commonMain/kotlin/com/dreetje/orbital/Model.kt', 'android/shared/src/commonMain/kotlin/com/dreetje/orbital/Translator.kt'];
// the engine's answers, each named the same on both sides (Row.Segment and friends nested in Row on both)
const TYPES = ['Row', 'Segment', 'Marks', 'Ref', 'Chat', 'Person', 'Free', 'Info', 'Page', 'Setup', 'Member', 'Audience', 'Access', 'TaskType', 'Value', 'Preset', 'Field', 'Sent', 'Sample', 'Answer',
  'Agent', 'HandedTo', 'AgentList', 'LinkCode', 'LinkState', 'Linked']; // your Dot (ios/engine/agents.js)

// the text between the bracket at i and the one that closes it
function inside(text, i, open, close) {
  for (let j = i, depth = 0; j < text.length; j++) {
    if (text[j] === open) depth++;
    else if (text[j] === close && --depth === 0) return text.slice(i + 1, j);
  }
  throw new Error('no ' + close + ' for the ' + open + ' at ' + i);
}
// at the commas outside any brackets
function split(text) {
  const out = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    if ('([<{'.includes(text[i])) depth++;
    else if (')]>}'.includes(text[i]) && text[i - 1] !== '-') depth--; // Kotlin's -> is no bracket
    else if (text[i] === ',' && !depth) { out.push(text.slice(from, i)); from = i + 1; }
  }
  return [...out, text.slice(from)].map((s) => s.trim()).filter(Boolean);
}
const add = (types, name, fields, file) => {
  assert.ok(!types.has(name), name + ' is declared twice (' + file + ')');
  types.set(name, new Set(fields));
};

// Swift: a struct's stored properties, let or var, one or several to a line; computed ones (a body in braces) and
// static ones left out, and nested types read on their own
function swiftTypes() {
  const types = new Map();
  for (const file of SWIFT) {
    const text = read(file);
    for (const m of text.matchAll(/\bstruct (\w+)\b[^{\n]*\{/g)) {
      if (!TYPES.includes(m[1])) continue;
      let body = inside(text, m.index + m[0].length - 1, '{', '}'), flat;
      while ((flat = body.replace(/\{[^{}]*\}/g, '\u0000')) !== body) body = flat; // every inner body as one mark
      const fields = body.split(/[;\n]/).map((s) => s.trim().replace(/^((private|fileprivate|public|internal|nonisolated)(\(set\))?|@\w+)\s+/g, ''))
        .filter((s) => /^(let|var)\s/.test(s) && !s.includes('\u0000'))
        .flatMap((s) => split(s.replace(/^(let|var)\s+/, '')).map((d) => d.match(/^(\w+)/)[1]));
      add(types, m[1], fields, file);
    }
  }
  return types;
}

// Kotlin: a class's constructor properties (val or var); a plain constructor parameter is no field
function kotlinTypes() {
  const types = new Map();
  for (const file of KOTLIN) {
    const text = read(file);
    for (const m of text.matchAll(/\bclass (\w+)\s*\(/g)) {
      if (!TYPES.includes(m[1])) continue;
      const fields = split(inside(text, m.index + m[0].length - 1, '(', ')')).map((p) => p.match(/^(?:@\w+(?:\([^)]*\))?\s+)*(?:val|var)\s+(\w+)/)).filter(Boolean).map((p) => p[1]);
      add(types, m[1], fields, file);
    }
  }
  return types;
}

const swift = swiftTypes(), kotlin = kotlinTypes();
for (const name of TYPES) {
  assert.ok(swift.has(name), 'no ' + name + ' in ' + SWIFT.join(', '));
  assert.ok(kotlin.has(name), 'no ' + name + ' in ' + KOTLIN.join(', '));
  const s = swift.get(name), k = kotlin.get(name);
  const onlySwift = [...s].filter((f) => !k.has(f)), onlyKotlin = [...k].filter((f) => !s.has(f));
  assert.ok(!onlySwift.length && !onlyKotlin.length, name + ': ' + [onlySwift.length && 'only the iPhone reads ' + onlySwift.join(', '), onlyKotlin.length && 'only Android reads ' + onlyKotlin.join(', ')].filter(Boolean).join('; '));
}

// The sample's keys, each where a phone reads it. What neither phone draws is named here with why, or taken out of the sample.
const UNREAD = {
  Segment: ['person', 'content'], // the words demo mode masks in a Timeline row (main/timeline.js, renderer/segments.js): the engine masks them, the phones draw the text
  Page: ['id'], // the page's own id, which the phone opened it by
};
const known = (type) => new Set([...swift.get(type), ...(UNREAD[type] || [])]);
const check = (type, value, at) => {
  if (value == null) return;
  const unknown = Object.keys(value).filter((k) => !known(type).has(k));
  assert.ok(!unknown.length, at + ' (' + type + ') has ' + unknown.join(', ') + ', which neither phone reads');
};
function row(r, at) {
  check('Row', r, at);
  (r.segments || []).forEach((s, i) => { check('Segment', s, at + '.segments[' + i + ']'); check('Marks', s.marks, at + '.marks'); check('Ref', s.mention, at + '.mention'); });
  check('Ref', r.reference, at + '.reference');
  check('Chat', r.chat, at + '.chat');
  (r.people || []).forEach((p) => check('Person', p, at + '.people'));
  check('Info', r.timeline, at + '.timeline');
  if (r.timeline) check('Free', r.timeline.free, at + '.timeline.free');
  (r.children || []).forEach((c, i) => row(c, at + '.children[' + i + ']'));
}
const timeline = JSON.parse(fs.readFileSync(path.join(root, 'ios/Orbital/timeline-sample.json'), 'utf8'));
timeline.forEach((r, i) => row(r, 'timeline-sample[' + i + ']'));
const pages = JSON.parse(fs.readFileSync(path.join(root, 'ios/Orbital/pages-sample.json'), 'utf8'));
check('Sample', pages, 'pages-sample');
pages.searches.forEach((r, i) => row(r, 'pages-sample.searches[' + i + ']'));
for (const [id, page] of Object.entries(pages.pages)) { check('Page', page, id); page.rows.forEach((r, i) => row(r, id + '.rows[' + i + ']')); }

console.log('phone model check ok (' + TYPES.length + ' types agree)');
