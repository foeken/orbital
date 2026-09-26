'use strict';
// The renderer as one string, in the order index.html loads it: the checks slice it by anchors and function names,
// so they read exactly what the window runs. `tops` is each file's top level, parsed: the names it declares for
// every later file (eslint.config.js globals, renderer-check.js duplicates) and the statements that run at load.
const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree'); // comes with eslint
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(renderer\/[^"]+)"><\/script>/g)].map((m) => m[1]);
if (!files.length) throw new Error('index.html loads no renderer/*.js');
const texts = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
const tops = files.map((file, i) => {
  const body = espree.parse(texts[i], { ecmaVersion: 2024, loc: true }).body;
  const names = body.flatMap((n) => (n.type === 'VariableDeclaration' ? n.declarations.map((d) => d.id.name) : n.id ? [n.id.name] : [])).filter(Boolean);
  return { file, body, names };
});
module.exports = { files, source: texts.join('\n'), tops };
