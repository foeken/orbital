'use strict';
// Chapter 16, Keyboard reference: node manual/scenes/run.js manual/scenes/keys.js
const open = (id) => ({ js: "goTo('" + id + "')" });
const bare = { js: "for (const e of document.querySelectorAll('.scroll, #pagehead, #pills, #navbtns, #filterRow')) e.style.visibility = 'hidden'" };
module.exports = [
  // the chips: a row's key, at the end of the row
  { name: 'keys-chips', panes: 2, size: '1440x900', setup: [{ wait: 900 }, { key: '⌘K' }, { wait: 400 }, { type: 'pane' }, { wait: 500 }, bare, { ...bare, page: '2' }], clip: { sel: '#palette .card', pad: 28 } },
  // writing: ↩ a row, ⇥ in, ⇧⇥ out, ⌘↩ a checkbox
  { name: 'keys-write', video: true, setup: [open('mockdoc2'), { wait: 900 }], steps: [
    { click: '.node .text', text: 'Agree a date', at: [0.98, 0.5] }, { wait: 300 }, { key: '↩' }, { type: 'Book a room', delay: 70 }, { wait: 300 }, { key: '⇥' }, { wait: 700 }, { key: '⇧⇥' }, { wait: 700 }, { key: '⌘↩' }, { wait: 900 },
  ], clip: [0, 24, 760, 400] },
  // moving rows: ⇧⌘↓ and ⇧⌘↑
  { name: 'keys-move', video: true, setup: [open('mockdoc2'), { wait: 900 }], steps: [
    { click: '.node .text', text: 'Read both' }, { wait: 300 }, { key: '⇧⌘↓' }, { wait: 900 }, { key: '⇧⌘↑' }, { wait: 900 }, { key: '⇧↓' }, { wait: 900 },
  ], clip: [0, 24, 760, 400] },
  // back and forward
  { name: 'keys-back', video: true, setup: [open('mockdoc0'), { wait: 700 }, open('mockdoc2'), { wait: 900 }], steps: [
    { key: '⌘[' }, { wait: 1300 }, { key: '⌘]' }, { wait: 1300 },
  ], clip: [0, 24, 760, 400] },
  // panes: next, maximize, restore
  { name: 'keys-panes', video: true, panes: 2, size: '1440x900', setup: [{ js: "goTo('mockdoc2')", page: '2' }, { wait: 900 }], steps: [
    { key: '⌘/' }, { wait: 900 }, { key: '⌥⌘↓' }, { wait: 1500 }, { key: '⌥⌘↓' }, { wait: 1300 },
  ] },
];




