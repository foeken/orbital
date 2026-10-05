'use strict';
// Chapter 3, Writing in the outline: node manual/scenes/run.js manual/scenes/writing.js
// H: small helpers the steps share, run in the page. T(words): the row text holding them; K(words): its key; N(words): its node.
// DRAG(words) picks a row up by its bullet, OVER(words, fx, fy) drags over a point of another row's text (fractions of
// its box, as a click's at is), DROP(...) lets go there: real DragEvents, so renderer/drag.js draws its own drop line.
const H = { js: String.raw`
  window.T = (s) => [...document.querySelectorAll('.node .text')].find((e) => e.textContent.includes(s));
  window.K = (s) => keyOfEl(T(s)); window.N = (s) => items.get(K(s)).node;
  window.at = (s, fx, fy) => { const r = T(s).getBoundingClientRect(); return { clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }; };
  window.fire = (type, p, el) => (el || document.elementFromPoint(p.clientX, p.clientY) || document.body).dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: window.DT, ...p }));
  window.DRAG = (s) => { window.DT = new DataTransfer(); const b = T(s).closest('.node').querySelector('.bullet'); fire('dragstart', at(s, 0, .5), b); };
  window.OVER = (s, fx, fy) => fire('dragover', at(s, fx, fy));
  window.DROP = (s, fx, fy) => { fire('drop', at(s, fx, fy)); fire('dragend', at(s, fx, fy), document.body); };
  1` };
const doc0 = [H, { js: "goTo('mockdoc0')" }, { wait: 700 }];
// a fresh, empty document with the caret waiting in its draft row
const blank = (title) => [H, { js: "tana.createDocument(" + JSON.stringify(title) + ").then((n) => goTo(n.id))" }, { wait: 800 }];
// scroll so the row holding these words sits dy px under the top of the page
const scrollTo = (words, dy = 90) => ({ js: "T(" + JSON.stringify(words) + ").scrollIntoView({ block: 'start' }); document.querySelector('.scroll').scrollTop -= " + dy + "; 1" });
const row = (words, at = [0.99, 0.5]) => ({ click: '.node .text', text: words, at });

module.exports = [
  // the block types, one of each
  { name: 'writing-blocks', size: '1100x860', setup: [...doc0, scrollTo('Walk through both'), { hover: '.node .text', text: 'Walk through both' }], clip: { page: '' } },
  // typing: Enter, Tab, ⇧Tab
  { name: 'writing-type', video: true, size: '640x320', setup: blank('Offsite plan'), steps: [
    { type: 'Why we meet', delay: 60 }, { key: '↩' },
    { type: 'Agree both pilots', delay: 60 }, { key: '↩' }, { key: '⇥' },
    { type: 'Sam leads onboarding', delay: 60 }, { key: '↩' }, { key: '⇧⇥' },
    { type: 'Book a room', delay: 60 },
  ], clip: { page: '' } },
  // ↑ from a code block's last line: its first line, then the title (#764); ↓ walks back in
  { name: 'writing-up', video: true, size: '640x320', setup: [...blank('Offsite plan'), { type: '```' }, { wait: 300 }, { type: 'npm run lint' }, { key: '⇧↩' }, { type: 'npm run check' }, { wait: 500 }],
    steps: [{ wait: 300 }, { key: '↑' }, { wait: 700 }, { key: '↑' }, { wait: 1000 }, { key: '↓' }, { wait: 700 }, { key: '↓' }, { wait: 900 }], clip: { page: '' } },
  // markdown typed at the start of a row and inline
  { name: 'writing-markdown', video: true, size: '640x320', setup: blank('Offsite plan'), steps: [
    { type: '## Agenda', delay: 70 }, { key: '↩' },
    { type: 'Keep it **short** and ~~formal~~ friendly', delay: 55 }, { key: '↩' },
    { type: '[] Book the room', delay: 60 },
  ], clip: { page: '' } },
  // ⌘↩ cycles a checkbox: on one row, then on every selected row at once
  { name: 'writing-checkbox', video: true, size: '640x320', setup: blank('Offsite prep'), steps: [
    { type: 'Book the room', delay: 55 }, { key: '↩' }, { type: 'Order lunch', delay: 55 }, { key: '↩' }, { type: 'Send the agenda', delay: 55 }, { wait: 400 },
    row('Order lunch'), { key: '⌘↩' }, { wait: 700 }, { key: '⌘↩' }, { wait: 900 },
    { key: '⌘A' }, { key: '⌘A' }, { wait: 700 }, { key: '⌘↩' }, { wait: 900 }, { key: '⌘↩' }, { wait: 2000 },
  ], clip: { page: '' } },
  // the floating toolbar over a selection: B, then the style menu
  { name: 'writing-toolbar', video: true, size: '640x480', setup: [...doc0, scrollTo('Slots:')], steps: [
    { js: "T('Slots:').focus(); selectRange(K('Slots:'), 24, 38); 1" }, { wait: 700 },
    { click: '#toolbar .tbtn.b' }, { wait: 600 },
    { click: '#toolbar .tbtn.style' }, { wait: 900 },
  ], clip: { page: '' } },
  { name: 'writing-style', size: '1100x720', setup: [...doc0, scrollTo('Slots:')], steps: [{ js: "T('Slots:').focus(); selectRange(K('Slots:'), 7, 20); 1" }, { wait: 300 }, { js: 'toggleStyleMenu(); 1' }, { wait: 900 }], clip: [0, 38, 760, 480] },
  // "/" on an empty row
  { name: 'writing-slash', size: '640x560', setup: blank('Offsite plan'), steps: [{ type: '/' }, { wait: 400 }], clip: { page: '' } },
  // "/" Meeting: named, then its when page, offering now for half an hour before anything is made
  { name: 'writing-slash-meeting', size: '640x560', setup: blank('Offsite plan'), steps: [{ type: '/' }, { wait: 400 }, { type: 'meeting' }, { wait: 300 }, { key: '↩' }, { wait: 400 }, { type: 'Design review' }, { wait: 300 }, { key: '↩' }, { wait: 600 }], clip: { page: '' } },
  // @ over selected words
  { name: 'writing-link', video: true, size: '640x520', setup: [...doc0, scrollTo('Next steps', 120)], steps: [
    row('Send both slots'), { js: "selectRange(K('Send both slots'), 19, 22); 1" }, { wait: 700 },
    { type: '@' }, { wait: 1100 }, { hover: '#paletteList .row', text: 'Sam Okafor# member' }, { wait: 400 }, { click: '#paletteList .row', text: 'Sam Okafor# member' }, { wait: 600 },
  ], clip: { page: '' } },
  // references and mentions at the top of the page
  // (the Agenda folded and the picture set aside, so the four kinds of reference sit together)
  { name: 'writing-refs', size: '1100x720', setup: doc0, steps: [row('Walk through both'), { key: '⌘↑' }, { key: 'esc' },
    { js: "document.querySelectorAll('.node').forEach((n) => { if (n.querySelector(':scope > .line img')) n.style.display = 'none'; }); document.querySelector('.scroll').scrollTop = 0; 1" }, { move: [1000, 700] }], clip: [0, 38, 1100, 400] },
  // images: two files on their way up, then Space opens one
  { name: 'writing-image', video: true, size: '640x560', setup: [...doc0, scrollTo('Discuss with', 60),
    { js: "const slow = tana.insertImage; tana.insertImage = (...a) => new Promise((r) => setTimeout(r, 1600)).then(() => slow(...a)); 1" }], steps: [
    { js: "window.AFTER = N('Discuss').id; 1" }, row('Discuss', [0.05, 0.5]), { wait: 300 },
    { js: "const f = (n) => new File([new Uint8Array(64)], n, { type: 'image/png' }); uploadImages('mockdoc0', AFTER, [f('whiteboard.png'), f('sticky-notes.png')]); 1" },
    { wait: 3800 }, { key: 'Space' }, { wait: 1200 }, { key: 'esc' },
  ], clip: { page: '' } },
  // a draft in a list: Enter at the end of a row drafts a document under it, made once it has words
  { name: 'writing-draft', video: true, size: '640x600', setup: [H, { js: "setView('library')" }, { wait: 800 }], steps: [
    row('Check out the new editor'), { key: '↩' }, { wait: 500 }, { type: 'Book the offsite venue', delay: 55 }, { key: '↩' }, { wait: 600 },
  ], clip: { page: '' } },
  // ⇧⌘↑ moves a row, ⌘↑ / ⌘↓ fold its parent
  { name: 'writing-move', video: true, size: '640x420', setup: [...doc0, scrollTo('Agenda', 30)], steps: [
    row('Shared cost tracking'), { key: '⇧⌘↑' }, { wait: 500 }, row('Walk through both'), { key: '⌘↑' }, { wait: 800 }, { key: '⌘↓' },
  ], clip: { page: '' } },
  // ⇧⌘⌫ takes a branch away, ⌘Z brings it back
  { name: 'writing-undo', video: true, size: '640x420', setup: [...doc0, scrollTo('Agenda', 30)], steps: [
    row('Shared cost tracking'), { key: '⇧⌘⌫' }, { wait: 900 }, { key: '⌘Z' }, { wait: 600 }, { key: '⇧⌘Z' }, { wait: 600 }, { key: '⌘Z' },
  ], clip: { page: '' } },
  // ⇧↓ grows a selection, Tab and ⇧⌘↑ move it whole
  { name: 'writing-select', video: true, size: '640x420', setup: [...doc0, scrollTo('Agenda', 30)], steps: [
    row('Onboarding buddies'), { key: '⇧↓' }, { wait: 400 }, { key: '⇧↑' }, { key: '⇧↑' }, { wait: 700 }, { key: '⇧↓' }, { wait: 500 }, { key: 'esc' },
  ], clip: { page: '' } },
  { name: 'writing-select-cmdk', size: '1000x760', setup: [...doc0, scrollTo('Agenda', 30)], steps: [
    row('Onboarding buddies'), { key: '⇧↓' }, { key: '⌘K' }, { wait: 500 }], clip: { page: '' } },
  // a drag by the bullet: the line follows the pointer's x through the levels on offer
  { name: 'writing-drag', video: true, size: '640x420', setup: [...doc0, scrollTo('Agenda', 30)], steps: [
    { hover: '.node .text', text: 'Onboarding buddies', at: [-0.1, 0.5] }, { wait: 300 }, { js: "DRAG('Onboarding buddies'); 1" },
    ...[0.3, -0.45, 0.3, -0.45].flatMap((fx) => [{ hover: '.node .text', text: 'Finance joins', at: [fx, 1.1] }, { js: "OVER('Finance joins', " + fx + ", 1.1); 1" }, { wait: 800 }]),
    { js: "DROP('Finance joins', -0.45, 1.1); 1" }, { wait: 900 }, { move: [700, 400] },
  ], clip: { page: '' } },
  // a table: type in a cell, Tab to the next
  { name: 'writing-table', video: true, size: '640x560', setup: [...doc0, { js: "document.querySelector('.scroll').scrollTop = 1e5; 1" }], steps: [
    { click: 'tr:last-child td:last-child' }, { type: 'Waiting', delay: 70 }, { key: '⌘K' }, { wait: 400 }, { type: 'row', delay: 80 },
  ], clip: { page: '' } },
];





