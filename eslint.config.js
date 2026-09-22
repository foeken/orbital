'use strict';
// Basic hygiene only: ESLint's recommended set over plain CommonJS main/SDK code and the browser-side renderer.
// No formatter, no style rules - this repo is written by hand and a reflow would drown real findings.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'build/**', 'sdk/proto/descriptors.js', 'icons.js'] },
  js.configs.recommended,
  {
    // main.js, main/, sdk/, scripts/, db.js, userdata.js, updater.js, tana-session.js: plain CommonJS on node.
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }], // "try { x() } catch {}" is this codebase's way of saying already gone
      'no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }], // "const { a, ...rest } = x" drops a key on purpose
      'no-regex-spaces': 'off', // the check scripts match the renderer's own two-space indentation, literally
      'no-control-regex': 'off', // stripping control characters out of a title needs a control-character class
    },
  },
  {
    // preload runs in the renderer process but requires electron: both sides.
    files: ['preload.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // The renderer is classic scripts sharing one global scope in the order index.html lists them, so every
    // top-level name of every earlier file is a global of every later one - collected here from that same order.
    files: ['renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...rendererGlobals() } },
    // A name declared here and used two files later is not unused, and a name declared in an earlier file is not
    // a redeclaration; renderer-check.js is what enforces the load order and the absence of duplicates.
    rules: {
      'no-unused-vars': ['error', { vars: 'local', args: 'none' }],
      'no-redeclare': ['error', { builtinGlobals: false }], // those same names are declarations here, not redeclarations
    },
  },
  {
    // The quick-add panel is its own window and its own scope (index.html does not load it).
    files: ['quick-add.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
    rules: { 'no-unused-vars': ['error', { vars: 'local', args: 'none' }] },
  },
];

function rendererGlobals() {
  const { source } = require('./scripts/renderer-source');
  const body = require('espree').parse(source, { ecmaVersion: 2024 }).body; // espree comes with eslint
  const names = body.flatMap((n) =>
    n.type === 'VariableDeclaration' ? n.declarations.map((d) => d.id.name) : n.id ? [n.id.name] : []);
  return Object.fromEntries(names.filter(Boolean).map((name) => [name, 'writable']));
}
