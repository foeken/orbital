'use strict';
// Chapter 2, ⌘K, the command palette: node manual/scenes/run.js manual/scenes/commands.js
const open = (id) => ({ js: "goTo('" + id + "')" });
const row = (text) => ({ click: '.node .text', text });
const card = { sel: '#palette .card', pad: 28 };
// a palette still shows the card on the scrim alone: the page behind it is hidden, so no half-cut words frame it
const bare = { js: "for (const e of document.querySelectorAll('.scroll, #pagehead, #pills, #navbtns, #filterRow')) e.style.visibility = 'hidden'" };
module.exports = [
  // type, run: Complete on the row under the caret
  { name: 'commands-run', video: true, setup: [open('mockdoc2'), { wait: 900 }], steps: [
    row('Agree a date'), { wait: 500 }, { key: '⌘K' }, { wait: 700 }, { type: 'comp', delay: 110 }, { wait: 700 }, { key: '↩' }, { wait: 900 },
  ], clip: [0, 0, 1280, 560] },
  // the rows follow the caret: Current node first
  { name: 'commands-context', setup: [open('mockdoc0'), { wait: 900 }, row('Walk through'), { key: '⌘K' }, { wait: 1500 }, bare], clip: card },
  // a selection: the Selection group, counting what each row acts on
  { name: 'commands-selection', setup: [open('mockdoc0'), { wait: 900 }, { click: '.node .text', at: [0.1, 0.5] }, { key: '⇧↓' }, { key: '⇧↓' }, { key: '⇧↓' }, { wait: 300 }, { key: '⌘K' }, { wait: 600 }, bare], clip: card },
  // nothing focused: the app's own groups
  { name: 'commands-groups', setup: [{ wait: 900 }, { key: '⌘K' }, { wait: 600 }, bare], clip: card },
  // matching: initials
  { name: 'commands-match', setup: [{ wait: 900 }, { key: '⌘K' }, { type: 'nfp' }, { wait: 400 }, bare], clip: card },
  // folded levels and pages
  { name: 'commands-fold', video: true, setup: [open('mockdoc2'), { wait: 900 }, row('Agree a date')], steps: [
    { key: '⌘K' }, { wait: 600 }, { type: 'inb', delay: 120 }, { wait: 1300 }, { key: '⌫' }, { key: '⌫' }, { key: '⌫' }, { type: 'create', delay: 100 }, { wait: 800 }, { key: '↩' }, { wait: 1600 }, { key: 'esc' }, { wait: 1400 }, { key: 'esc' }, { wait: 600 },
  ], clip: [0, 0, 1280, 640] },
  // recording a key of your own
  { name: 'commands-record', video: true, setup: [{ wait: 900 }], steps: [
    { key: '⌘K' }, { wait: 500 }, { type: 'sync', delay: 110 }, { wait: 1300 }, { key: '⇧⌘K' }, { wait: 1200 }, { key: '⌃⌘Y' }, { wait: 1300 }, { key: '↩' }, { wait: 1200 },
  ], clip: [0, 0, 1280, 620] },
  { name: 'commands-reserved', setup: [{ wait: 900 }, { key: '⌘K' }, { type: 'sync' }, { wait: 300 }, { key: '⇧⌘K' }, { wait: 300 }, { key: '⌘K' }, { wait: 400 }, bare], clip: { sel: '#recorder .card', pad: 28 } },
  // ⌘S
  { name: 'commands-search', video: true, setup: [{ wait: 900 }], steps: [
    { key: '⌘S' }, { wait: 600 }, { type: 'board', delay: 140 }, { wait: 1500 }, { key: '↓' }, { wait: 500 }, { key: '↩' }, { wait: 1200 },
  ], clip: [0, 0, 1280, 640] },
  { name: 'commands-filters', setup: [{ wait: 900 }, { key: '⌘S' }, { type: '#meeting' }, { wait: 800 }, bare], clip: card },
  { name: 'commands-recent', setup: [open('mockdoc0'), { wait: 500 }, open('mockmeeting2'), { wait: 500 }, open('mockdoc2'), { wait: 500 }, open('mocknl0'), { wait: 500 }, { key: '⌘S' }, { wait: 600 }, bare], clip: card },
  { name: 'commands-fallback', setup: [{ wait: 900 }, { key: '⌘K' }, { type: 'quarterly budget' }, { wait: 400 }, bare], clip: card },
];




