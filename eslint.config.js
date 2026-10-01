'use strict';
// Basic hygiene only: ESLint's recommended set over plain CommonJS main/SDK code and the browser-side renderer.
// No formatter, no style rules - this repo is written by hand and a reflow would drown real findings.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'build/**', '.tana-log/**', 'sdk/proto/descriptors.js', 'icons.js'] },
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
    // The Help tour, Quick Add Task and the update card are pages of their own, each its own scope (index.html does not load them).
    files: ['help.js', 'task.js', 'update.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
    rules: { 'no-unused-vars': ['error', { vars: 'local', args: 'none' }] },
  },
  {
    // The window's shell (shell.html): an ES module importing Trellis, its own scope like the pages above.
    files: ['shell.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
  {
    // The manual's pages (manual/*.html): classic scripts, their own scope; search-index.js only sets a global.
    files: ['manual/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
    rules: { 'no-unused-vars': ['error', { vars: 'local', args: 'none' }] },
  },
  {
    // The scenes that draw the manual's pictures: node scripts whose injected helpers run in the page.
    files: ['manual/scenes/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // The iPhone app's engine (ios/engine): index.js is an ES module that runs in a web view, build.js a Bun script
    // (top-level await); stand-ins.js stays CommonJS like the main/ files it stands in for.
    files: ['ios/engine/index.js', 'ios/engine/build.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser, ...globals.node, Bun: 'readonly' } },
  },
  {
    files: ['ios/engine/stand-ins.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];

function rendererGlobals() {
  const { tops } = require('./scripts/renderer-source');
  return Object.fromEntries(tops.flatMap((t) => t.names).map((name) => [name, 'writable']));
}
