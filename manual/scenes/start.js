'use strict';
// Chapter 1, First steps: node manual/scenes/run.js manual/scenes/start.js
// The Help tour is a page main lays over the window (main.js openOverlay); the mock has no main, so it is laid over
// the shell here the same way: help.html in a transparent frame over everything, in the window's theme.
const help = { page: 'shell', js: "(() => { const f = document.createElement('iframe'); f.id = 'mc-help'; f.src = 'help.html?theme=' + window.shell.state().theme; f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:100;background:transparent'; f.allowTransparency = true; document.body.append(f); return new Promise((r) => f.onload = () => { f.contentWindow.focus(); setTimeout(r, 300); }); })()" };
// the tour as Cmd+K Install mobile app opens it: on its iPhone page (main.js openOverlay, at=mobile)
const helpMobile = { ...help, js: help.js.replace("'help.html?theme='", "'help.html?at=mobile&theme='") };
// an image file dragged over Create new, then dropped (shell.js create.ondragover / ondrop)
const drag = (type) => ({ page: 'shell', js: "(() => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([png], 'lunch-receipt.png', { type: 'image/png' })); document.getElementById('create').dispatchEvent(new DragEvent('" + type + "', { dataTransfer: dt, bubbles: true, cancelable: true })); })()" });
const library = { js: "setView('inbox')" };
const bare = { js: "for (const e of document.querySelectorAll('.scroll, #pagehead, #pills, #navbtns, #filterRow')) e.style.visibility = 'hidden'" };
module.exports = [
  // the window at a glance: the Work View's two panes, a document on the right
  { name: 'start-window', panes: 2, size: '1440x900', setup: [
    { js: "goTo('mockdoc2')", page: '2' }, { wait: 900 },
    { hover: '.node .text', page: '2' }, { wait: 400 },
  ] },
  // signed out: the welcome, ⌘K, ↩ on Log in to Tana, and the first page arrives
  { name: 'start-welcome', signedOut: true, video: true, setup: [{ wait: 1200 }], steps: [
    { wait: 1400 }, { key: '⌘K' }, { wait: 1300 }, { key: '↩' }, { wait: 1500 },
  ] },
  { name: 'start-signedout-palette', signedOut: true, setup: [{ wait: 800 }, { key: '⌘K' }, { wait: 600 }, bare], clip: { sel: '#palette .card', pad: 28 } },
  // the Help tour, page by page
  { name: 'start-help', video: true, clip: [300, 40, 680, 560], setup: [{ wait: 800 }, help, { wait: 300 }], steps: [
    { wait: 1800 }, { key: '→' }, { wait: 2600 }, { key: '→' }, { wait: 2200 }, { key: '→' }, { wait: 2000 }, { key: '→' }, { wait: 2400 },
  ] },
  // the tour's last page, where Install mobile app opens it: iPhone chosen, its TestFlight code and link
  { name: 'start-help-iphone', clip: [300, 40, 680, 560], setup: [{ wait: 800 }, helpMobile, { wait: 900 }] },
  // the same page with Android chosen in its selector, as a page whose latest release has the APK sees it (updater.js
  // androidRelease, which the mock has no main to ask): the code that adds Orbital to Obtainium and the download
  { name: 'start-help-android', clip: [300, 40, 680, 560], setup: [{ wait: 800 }, helpMobile, { wait: 900 },
    { page: 'shell', js: "(() => { const h = document.getElementById('mc-help'); h.contentWindow.eval(\"helpApk = 'yes'\"); h.contentDocument.querySelector('[role=radio][data-os=android]').click(); })()" }, { wait: 500 }] },
  // Cmd+K Install mobile app, under Help, once the latest release has the Android app
  { name: 'start-install-mobile', setup: [{ wait: 900 }, { js: "androidDownload = { version: '0.10.0' }" }, { key: '⌘K' }, { type: 'install' }, { wait: 400 }, bare], clip: { sel: '#palette .card', pad: 14 } },
  // the loader: the page building itself, then the rows rising in
  { name: 'start-loader', video: true, setup: [{ wait: 800 }, { js: "document.getElementById('skeleton').classList.remove('gone'); document.body.classList.add('building')" }], steps: [
    { wait: 3200 }, { js: "document.getElementById('skeleton').classList.add('gone'); document.body.classList.remove('building')" }, { wait: 600 },
  ], hold: 1200, clip: { page: '' } },
  // notices and errors
  { name: 'start-note', setup: [{ wait: 800 }, { js: "showNote('Link copied')" }, { wait: 500 }], clip: [360, 620, 560, 180] },
  { name: 'start-error', setup: [{ wait: 800 }, { js: "showError(new Error('This node is read-only'))" }, { wait: 500 }], clip: [360, 620, 560, 180] },
  { name: 'start-relogin', setup: [library, { wait: 800 }, { js: "showStatus({ authenticated: undefined, connected: false, error: 'Your Tana session has expired' })" }, { wait: 500 }], clip: [0, 0, 1280, 300] },
  // Create new: the corner button, and an image dropped on it
  { name: 'start-create', video: true, setup: [{ wait: 800 }], steps: [
    { move: [900, 500] }, { hover: '#create', page: 'shell' }, { wait: 1200 }, { click: '#create', page: 'shell' }, { wait: 1600 },
  ], clip: [300, 40, 980, 760] },
  // Create new → Meeting (#765): named, then the When page, now for half an hour offered before anything is made
  { name: 'start-create-meeting', setup: [{ wait: 900 }, { key: '⌘K' }, { type: 'create new' }, { wait: 400 }, { key: '↩' }, { wait: 700 }, { type: 'meeting' }, { wait: 300 }, { key: '↩' }, { wait: 400 }, { type: 'Retro' }, { wait: 300 }, { key: '↩' }, { wait: 600 }, bare], clip: { sel: '#palette .card', pad: 28 } },
  { name: 'start-drop', video: true, setup: [{ wait: 800 }], steps: [
    { move: [1000, 560] }, { hover: '#create', page: 'shell' }, drag('dragover'), { wait: 1400 }, drag('drop'), { wait: 2400 },
  ] },
  { name: 'start-logout', setup: [library, { wait: 800 }, { key: '⌘K' }, { type: 'log out' }, { key: '↩' }, { wait: 500 }, bare], clip: { sel: '#palette .card', pad: 28 } },
];





