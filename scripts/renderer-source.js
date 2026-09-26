'use strict';
// The renderer as one string, in the order index.html loads it: the checks slice it by anchors and function names,
// so they read exactly what the window runs. `tops` is each file parsed: the names its top level declares for every
// later file (eslint.config.js globals, renderer-check.js duplicates) and the tree renderer-check.js reads for what
// runs at load.
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree'); // comes with eslint, as does eslint-scope
const { analyze } = require('eslint-scope');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(renderer\/[^"]+)"><\/script>/g)].map((m) => m[1]);
if (!files.length) throw new Error('index.html loads no renderer/*.js');
const texts = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
const tops = files.map((file, i) => {
  const ast = espree.parse(texts[i], { ecmaVersion: 2024, loc: true, range: true });
  const scope = analyze(ast, { ecmaVersion: 2024, sourceType: 'script' }).globalScope;
  // every top-level binding, destructured ones included; through: the references the file leaves to other files
  return { file, ast, scope, names: scope.variables.map((v) => v.name) };
});
module.exports = { files, source: texts.join('\n'), tops };
