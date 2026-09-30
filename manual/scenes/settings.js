'use strict';
// Chapter 15, Settings & housekeeping (manual/settings.html): node manual/scenes/run.js manual/scenes/settings.js
const open = (id) => ({ js: 'goTo(' + JSON.stringify(id) + ')' });
const pal = { sel: '#palette .card', pad: 14 };
const blank = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#palette) { visibility: hidden !important; }'; document.head.append(s); })()" };
const NOTE = 'tana:text:mockai0';
// what main answers and the mock has not: the zoom (Electron's webFrame, drawn here as CSS zoom), Export to PDF and the
// update check (both open native dialogs, so the rows only need to exist)
const stubs = { js: "tana.zoom = (f) => { document.documentElement.style.zoom = f / BASE_ZOOM; }; tana.exportPdf = async () => {}; tana.checkUpdates = async () => {}; 1" };

module.exports = [
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
  { name: 'settings-about', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'about orbital' }, { wait: 300 }, { key: '↩' }, { wait: 500 }, blank], clip: pal },
  { name: 'settings-logout', setup: [stubs, open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'log out' }, { wait: 300 }, { key: '↩' }, { wait: 500 }, blank], clip: pal },
  { name: 'settings-login', signedOut: true, size: '1000x640', setup: [{ wait: 1500 }], steps: [{ key: '⌘K' }, { wait: 500 }, blank], clip: pal },
  { name: 'settings-page', url: 'manual/settings.html', full: true, size: '1440x900' },
];
