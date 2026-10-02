'use strict';
// Chapter 13, Windows, panes & the Graph (manual/windows.html): node manual/scenes/run.js manual/scenes/windows.js
// REAL (as in meetings.js) makes the mock's meetings and tasks read as Tana ids (tana:event:mockmeeting2, tana:text:mockdoc1),
// which the Graph pane needs: it only follows a real document.
const REAL = `(() => { if (tana.__real) return; tana.__real = true;
  const local = (v) => typeof v === 'string' ? v.replace(/tana:(?:event|text):(mock(?:meeting|doc)\\d+)/g, '$1') : v;
  const real = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v).replace(/"(mockmeeting\\d+)(?=["|])/g, '"tana:event:$1').replace(/"(mockdoc\\d+)(?=["|])/g, '"tana:text:$1'));
  for (const k of Object.keys(tana)) { const f = tana[k]; if (typeof f !== 'function') continue;
    tana[k] = /^on[A-Z]/.test(k) ? (cb) => f((...a) => cb(...a.map(real))) : (...a) => { const r = f(...a.map(local)); return r && r.then ? r.then(real) : r; }; } })()`;
const real = (...pages) => pages.map((page) => ({ js: REAL, page }));
// Panes the window opens while a clip plays need main (window:split), which the runner's shell has none of. live()
// loads the shell's module again under a bridge that keeps its commands, and gives each page a splitWindow that asks
// it, the way main.js does: the page's own rows and clicks (⌘N, ⌘-click, Show graph) then open real Trellis panes.
const live = (doc = null, withReal = false) => ({ page: 'shell', js: '(' + (async (doc, REAL) => {
  const theme = document.documentElement.dataset.theme || 'light';
  const prep = (f) => { const w = f.contentWindow; if (REAL) w.eval(REAL); w.document.getElementById('login')?.click(); if (theme === 'dark') w.applyTheme('dark');
    w.eval("tana.splitWindow = async (where, start) => parent.orbOpen(where, start || {}, new URLSearchParams(location.search).get('side') || '')"); };
  document.addEventListener('load', (e) => { if (e.target.tagName === 'IFRAME') prep(e.target); }, true);
  document.getElementById('workspace').replaceChildren();
  for (const b of document.querySelectorAll('.head button, #create')) b.querySelector('svg')?.remove();
  let seq = 3;
  window.shell = { state: () => ({ doc, theme }), onCommand: (cb) => { window.shellCmd = cb; }, layout() {} };
  window.orbOpen = (where, start, from) => { const id = String(++seq); localStorage.setItem('view', start.view || 'library'); localStorage.setItem('place', start.place || '{}'); window.shellCmd('open', { id, where, from, focus: true }); return id; };
  await import('/shell.js?live');
  await new Promise((r) => setTimeout(r, 1800));
}) + ')(' + JSON.stringify(doc) + ',' + JSON.stringify(withReal ? REAL : '') + ')' });

const panel = (id, views, selected = views[0]) => ({ kind: 'panel', id: 'panel-' + id, views, selected });
const page = (side, links) => ({ type: 'page', params: links ? { side, links: true } : { side } });
const layout = (weights, panels, views) => ({ schema: 1, root: { kind: 'split', id: 'split-m', axis: 'x', weights, children: panels }, floating: [], hidden: [], views });
// the anatomy: two tabs in the left pane, a document on the right
const anatomy = layout([0.58, 0.42], [panel('a', ['page', 'page3']), panel('b', ['page2'])], { page: page(''), page2: page('2'), page3: page('3') });
// two pages and the Graph pane, for following
const three = layout([0.37, 0.37, 0.26], [panel('a', ['page']), panel('b', ['page2']), panel('c', ['page3'])], { page: page(''), page2: page('2'), page3: page('3', true) });
const two = layout([0.55, 0.45], [panel('a', ['page']), panel('b', ['page2'])], { page: page(''), page2: page('2') });
const open = (id, p = '') => ({ js: 'goTo(' + JSON.stringify(id) + ')', page: p });
const pal = { sel: '#palette .card', pad: 14 };
// a palette still shows the card alone: whatever the page has behind it would be cut off by the crop (as ai.js does)
const blank = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#palette) { visibility: hidden !important; }'; document.head.append(s); })()" };
const peers = "(() => { const row = (s) => [...items.values()].find((i) => i.node.text && i.node.text.startsWith(s)).node.id; presencePeers = [{ peer: 'p1', userHash: '390', name: 'Sam Okafor', blockId: row('Open'), offset: 5 }, { peer: 'p2', userHash: '150', name: 'Priya Raman', blockId: row('Agree'), offset: 16 }]; paintPresence(); })()";
const views = "setPref('savedViews', [WORK_VIEW, { id: 'view:planning', name: 'Planning', doc: null, keys: {} }, { id: 'view:review', name: 'Monday review', doc: null, keys: {} }])";
// a ctrl+wheel over a page is a pinch: the shell zooms the workspace (shell.js)
const pinch = (x, y, dy) => ({ cdp: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy, modifiers: 2 } });

module.exports = [
  // ---- the window ----
  { name: 'windows-window', size: '1440x900', layout: anatomy, setup: [open('mockdoc0'), { js: "setView('library')", page: '3' }, open('tana:text:mockai0', '2'), { wait: 900 }, { js: "document.querySelector('[data-trellis-part=\"tab\"][data-view=\"page\"], [data-view=\"page\"][data-trellis-part=\"tab\"]')?.click()", page: 'shell' }], steps: [{ hover: '#title' }, { wait: 500 }] },
  { name: 'windows-newpane', video: true, setup: [live(), open('mockdoc0'), { wait: 800 }, { click: '#title' }], steps: [{ wait: 300 }, { key: '⇧⌘N' }, { wait: 1800 }] },
  { name: 'windows-float', video: true, setup: [live(), open('mockdoc0'), { wait: 800 }, { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'floating', delay: 70 }, { wait: 300 }, { key: '↩' }, { wait: 1800 }] },
  { name: 'windows-elsewhere', video: true, setup: [live(), open('mockdoc0'), { wait: 800 }, { click: '#title' }], steps: [
    { key: '⌘S' }, { type: 'offsite agenda', delay: 60 }, { wait: 700 }, { caption: '⌘↩ opens it in a new tab' }, { key: '⌘↩' }, { wait: 1700 },
    { key: '⌘S' }, { type: 'book a room', delay: 60 }, { wait: 700 }, { caption: '⇧↩ opens it in a pane beside' }, { key: '⇧↩' }, { wait: 1800 }, { caption: '' }] },
  { name: 'windows-cmdk', size: '1000x700', setup: [open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'new' }, { wait: 400 }, blank], clip: pal },
  { name: 'windows-menu', size: '1280x800', layout: two, setup: [open('mockdoc0'), { js: "setView('library')", page: '2' }, { wait: 900 }], steps: [{ click: '[data-trellis-part="panel-menu"]', page: 'shell' }, { wait: 500 }], clip: [300, 20, 640, 300] },
  { name: 'windows-maximize', video: true, layout: two, setup: [open('mockdoc0'), { js: "setView('library')", page: '2' }, { wait: 900 }, { click: '#title' }], steps: [{ wait: 300 }, { key: '⌥⌘↓' }, { wait: 1400 }, { key: '⌥⌘↓' }, { wait: 1400 }] },
  { name: 'windows-zoom', video: true, size: '960x600', layout: three, setup: [...real('', '2', '3'), open('tana:event:mockmeeting2'), open('tana:text:mockdoc1', '2'), { wait: 1200 }, { click: '#title' }], steps: [
    { move: [450, 250] }, { caption: 'Pinch to zoom in' }, pinch(450, 250, -220), { wait: 900 },
    { caption: '⌥⌘↑ shows all panes' }, { key: '⌥⌘↑' }, { wait: 1000 }, { caption: '' }], hold: 600 },
  // ---- saved views ----
  { name: 'windows-views', size: '1000x700', setup: [open('mockdoc0'), { js: views }, { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'view' }, { wait: 400 }, blank], clip: pal },
  { name: 'windows-saveview', size: '1000x700', setup: [open('mockdoc0'), { js: views }, { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'save view' }, { wait: 300 }, { key: '↩' }, { wait: 300 }, blank], clip: pal },
  // ---- the Graph pane ----
  { name: 'windows-graph', size: '1440x900', graph: true, setup: [...real('', '2'), open('tana:event:mockmeeting2'), { wait: 2500 }] },
  { name: 'windows-follow', video: true, size: '1440x900', layout: three, setup: [...real('', '2', '3'), open('tana:event:mockmeeting2'), open('tana:text:mockdoc1', '2'), { wait: 1500 }, { click: '#title' }, { wait: 800 }], steps: [
    { wait: 400 }, { caption: 'The Graph follows the pane you are in' }, { click: '#title', page: '2' }, { wait: 1800 }, { caption: '' }] },
  { name: 'windows-showgraph', video: true, setup: [live(null, true), open('tana:event:mockmeeting2'), { wait: 1200 }, { click: '#title' }], steps: [{ key: '⌘K' }, { type: 'show graph', delay: 60 }, { wait: 300 }, { key: '↩' }, { wait: 2200 }] },
  // ---- presence, canvases ----
  { name: 'windows-presence', size: '1000x640', setup: [open('tana:text:mockai0'), { wait: 900 }, { js: peers }, { wait: 800 }], clip: [0, 40, 760, 260] },
  { name: 'windows-canvas', size: '1000x700', setup: [open('mockdoc0'), { wait: 600 }], steps: [{ key: '⌘K' }, { type: 'canvas' }, { wait: 400 }, blank], clip: pal },
  { name: 'windows-page', url: 'manual/windows.html', full: true, size: '1440x900' },
];
