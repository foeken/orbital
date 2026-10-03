#!/usr/bin/env node
'use strict';
// The GPUI spike's mock engine: answers window.api calls for the native window over stdio (serve.js). The method names
// are window.api's (preload.js), so the window does not care which engine answers. This one serves renderer/mock.js,
// the same in-file mock the web renderer falls back to, run in a vm context with the one browser
// global it reads (matchMedia). The mock calls helpers other renderer files declare (views.js completedWindow, …), so
// those declarations are found by name in the renderer's own parse (scripts/renderer-source.js) and run before it,
// with whatever they in turn use. engine-tana.js answers the same names from your real Tana, read-only.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { analyze } = require('eslint-scope');
const { files, tops } = require('../scripts/renderer-source');
const { serve } = require('./serve');

const root = path.join(__dirname, '..');
const store = new Map(); // the renderer's localStorage, for this run only
const ctx = { console: { log: (...a) => console.error(...a), warn: console.error, error: console.error }, structuredClone, setTimeout, clearTimeout, Date, URL, TextEncoder,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) } };
ctx.window = ctx;
vm.createContext(ctx);

// Every top-level statement of the renderer, by the names it declares, with the global names it uses.
const WHOLE = ['renderer/segments.js', 'renderer/mock.js'];
const decl = new Map();
const uses = (top, text) => {
  const refs = analyze(top.ast, { ecmaVersion: 2024, sourceType: 'script' }).scopes.flatMap((s) => s.references)
    .filter((r) => !r.resolved || r.resolved.scope.type === 'global');
  return (stmt) => new Set(refs.filter((r) => r.identifier.range[0] >= stmt.range[0] && r.identifier.range[1] <= stmt.range[1]).map((r) => r.identifier.name));
};
tops.forEach((top, i) => {
  const text = fs.readFileSync(path.join(root, files[i]), 'utf8');
  const used = uses(top, text);
  top.ast.body.forEach((stmt, at) => {
    const names = stmt.type === 'FunctionDeclaration' ? [stmt.id.name] : stmt.type === 'VariableDeclaration' ? stmt.declarations.filter((d) => d.id.type === 'Identifier').map((d) => d.id.name) : [];
    for (const name of names) decl.set(name, { file: i, at, source: text.slice(...stmt.range), used: () => used(stmt) });
  });
});
const whole = new Set(WHOLE.map((f) => files.indexOf(f)));
const wanted = new Map();
const want = (names) => {
  for (const name of names) {
    const d = decl.get(name);
    if (!d || whole.has(d.file) || wanted.has(d.file + ':' + d.at)) continue;
    wanted.set(d.file + ':' + d.at, d);
    want(d.used());
  }
};
for (const f of WHOLE) want(tops[files.indexOf(f)].scope.through.map((r) => r.identifier.name));
const helpers = [...wanted.values()].sort((a, b) => a.file - b.file || a.at - b.at).map((d) => d.source).join('\n');
vm.runInContext(fs.readFileSync(path.join(root, WHOLE[0]), 'utf8'), ctx, { filename: WHOLE[0] });
vm.runInContext(helpers, ctx, { filename: 'renderer helpers' });
vm.runInContext(fs.readFileSync(path.join(root, WHOLE[1]), 'utf8'), ctx, { filename: WHOLE[1] });
const api = vm.runInContext('mockApi()', ctx);

// A long document for timing the window (ORBITAL_OPEN=gpui:stress): rows of words with a mark, each with four children.
const STRESS = Number(process.env.ORBITAL_STRESS_ROWS || 5000);
let stressRows = null;
const stress = () => (stressRows ||= Array.from({ length: STRESS / 5 }, (_, i) => ({
  id: 's' + i, kind: 'block', text: 'Row ' + i + ' has a bold part and a longer sentence after it, the way notes are written', hasChildren: true,
  segments: [{ text: 'Row ' + i + ' has ' }, { text: 'a bold part', marks: { bold: true } }, { text: ' and a longer sentence after it, the way notes are written' }],
  children: Array.from({ length: 4 }, (__, j) => ({ id: 's' + i + '.' + j, kind: 'block', text: 'Child ' + j + ' of row ' + i,
    segments: [{ text: 'Child ' + j + ' of row ' + i }], hasChildren: false, children: [], ...(j === 0 ? { done: 0 } : {}) })),
})));
const { children, node } = api;
api.children = async (id) => (id === 'gpui:stress' ? stress() : children(id));
api.node = async (id) => (id === 'gpui:stress' ? { id, title: STRESS + ' rows', kind: 'document' } : node(id));

serve(api);
