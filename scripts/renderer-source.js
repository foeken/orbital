'use strict';
// The renderer as one string, in the order index.html loads it: the checks slice it by anchors and function names,
// so they read exactly what the window runs.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(renderer\/[^"]+)"><\/script>/g)].map((m) => m[1]);
if (!files.length) throw new Error('index.html loads no renderer/*.js');
module.exports = { files, source: files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n') };
