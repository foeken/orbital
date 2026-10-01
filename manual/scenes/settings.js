'use strict';
const kit = require('./kit');
// Chapter 15, Settings & housekeeping (manual/settings.html): node manual/scenes/run.js manual/scenes/settings.js
const open = (id) => ({ js: 'goTo(' + JSON.stringify(id) + ')' });
const pal = { sel: '#palette .card', pad: 14 };
const blank = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#palette) { visibility: hidden !important; }'; document.head.append(s); })()" };
const NOTE = 'tana:text:mockai0';
// what main answers and the mock has not: the zoom (Electron's webFrame, drawn here as CSS zoom), Export to PDF and the
// update check (the PDF opens a native dialog and the check, here, nothing: the update card is drawn below)
const stubs = { js: "tana.zoom = (f) => { document.documentElement.style.zoom = f / BASE_ZOOM; }; tana.exportPdf = async () => {}; tana.checkUpdates = async () => {}; 1" };

// The update card (update.html) with what main would hand it: two releases newer than this one, their notes as
// updater.js notes() makes them; then the same card while the newest downloads
const B = (text, extra) => ({ block: 'bullet', segments: [{ text }], ...extra });
const UPDATE = { current: '0.9.1', releases: [
  { version: '0.10.0', date: '2026-10-06T09:00:00Z', notes: [{ block: 'heading2', segments: [{ text: 'Updates' }] },
    { block: 'bullet', segments: [{ text: 'Check for updates', marks: { bold: true } }, { text: ' shows what is new before you update, and a progress bar while it downloads.' }] },
    { block: 'heading2', segments: [{ text: 'Meetings' }] }, B('Drag a node onto a meeting to pin it there.'), B('The Timeline marks a call that is being recorded.', { depth: 1 }),
    { block: 'heading2', segments: [{ text: 'Fixes' }] }, B('Enter at the start of a row keeps your last keystrokes.'), B('A restart restores every tab in its place.')] },
  { version: '0.9.2', date: '2026-10-02T09:00:00Z', notes: [{ block: 'heading2', segments: [{ text: 'Editing' }] },
    { block: 'bullet', segments: [{ text: '/task', marks: { code: true } }, { text: ' and ' }, { text: '/checklist', marks: { code: true } }, { text: ' in the slash menu.' }] }, B('Markdown you paste becomes headings, lists and marks.')] }] };
const updateCard = (then = '') => kit.overlay('update.html', 'f.contentWindow.eval(' + JSON.stringify('draw(' + JSON.stringify(UPDATE) + ');' + then) + ');');
const updating = "go.hidden = later.hidden = true; $('updateProgress').hidden = false; progress({ got: 47.2e6, total: 122.9e6 });";
const hidePage = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > * { visibility: hidden !important; }'; document.head.append(s); })()" }; // the card alone over the scrim
const card = [310, 76, 660, 556];


module.exports = [
  // ---- the Settings page: ⌘, opens it in a pane to the right (live: real Trellis panes); its first new page is '4' ----
  { name: 'settings-panel', size: '1440x900', setup: [kit.live(), open('mockdoc0'), { wait: 800 }, { click: '#title' }], steps: [{ key: '⌘,' }, { wait: 2400 }] },
  { name: 'settings-open', video: true, size: '1440x900', setup: [kit.live(), open('mockdoc0'), { wait: 800 }, { click: '#title' }], steps: [
    { key: '⌘K' }, { type: 'settings', delay: 70 }, { wait: 400 }, { key: '↩' }, { wait: 2000 }, { click: '.settings .sact', text: 'Choose …', page: '4' }, { wait: 1400 }, { key: '⇥' }, { wait: 1600 }] },
  // ---- how it looks ----
  { name: 'settings-theme', video: true, size: '1000x640', setup: [stubs, open('mockdoc0'), { wait: 900 }, { click: '#title' }], steps: [
    { key: '⌘K' }, { type: 'toggle dark', delay: 60 }, { wait: 400 }, { key: '↩' }, { wait: 1300 }, { key: '⌘K' }, { type: 'toggle light', delay: 60 }, { wait: 400 }, { key: '↩' }, { wait: 1000 }], clip: { page: '' } },
  { name: 'settings-themerows', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'mode' }, { wait: 400 }, blank], clip: pal },
  { name: 'settings-textsize', video: true, size: '1000x640', setup: [stubs, open(NOTE), { wait: 900 }, { click: '#title' }], steps: [
    { key: '⇧⌘=' }, { wait: 700 }, { key: '⇧⌘=' }, { wait: 900 }, { key: '⇧⌘-' }, { wait: 700 }, { key: '⌘0' }, { wait: 1000 }], clip: [0, 0, 1000, 300] },
  { name: 'settings-textrows', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'text' }, { wait: 400 }, blank], clip: pal },
  // ---- what follows you ----
  { name: 'settings-record', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'sync' }, { wait: 400 }, { key: '⇧⌘K' }, { wait: 500 }, { key: '⌃⌘Y' }, { wait: 500 }, { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#recorder) { visibility: hidden !important; }'; document.head.append(s); })()" }], clip: { sel: '#recorder .card', pad: 14 } },
  // ---- housekeeping ----
  { name: 'settings-pdf', setup: [stubs, open(NOTE), { wait: 800 }, { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'export' }, { wait: 400 }, blank], clip: pal },
  { name: 'settings-reload', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'reload' }, { wait: 400 }, blank], clip: pal },
  { name: 'settings-help', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { wait: 400 }, { js: "[...document.querySelectorAll('#paletteList .row')].at(-1).scrollIntoView({ block: 'end' })" }, { wait: 300 }, blank], clip: pal },
  { name: 'settings-update', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [hidePage, updateCard(), { wait: 300 }], clip: card },
  { name: 'settings-updating', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [hidePage, updateCard(updating), { wait: 300 }], clip: card },
  { name: 'settings-about', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'about orbital' }, { wait: 300 }, { key: '↩' }, { wait: 500 }, blank], clip: pal },
  { name: 'settings-logout', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'log out' }, { wait: 300 }, { key: '↩' }, { wait: 500 }, blank], clip: pal },
  { name: 'settings-login', signedOut: true, size: '1000x640', setup: [{ wait: 1500 }], steps: [{ key: '⌘K' }, { wait: 500 }, blank], clip: pal },
  { name: 'settings-page', url: 'manual/settings.html', full: true, size: '1440x900' },
];
