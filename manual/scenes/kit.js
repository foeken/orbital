'use strict';
// What scenes keep needing, written once: the steps and clips the chapters were first shot with, collected so a new or
// updated scene reuses them instead of finding the trick again. require('./kit') from a scene file. Older scene files
// still carry their own copies; switch one to these when you next change it.
const J = JSON.stringify;

// open a node or an app page in a pane ('' the first, '2' the second)
const open = (id, page = '') => ({ js: 'goTo(' + J(id) + ')', page });
// the page's scripts settle before the first step
const settle = { wait: 1500 };
// clip regions: the palette's card, as a still or a clip crops to it
const palette = { sel: '#palette .card', pad: 14 };
// only the palette on screen: for clips about a palette page, shot in a narrow window
const onlyPalette = { js: "(() => { const s = document.createElement('style'); s.textContent = 'body > :not(#palette) { visibility: hidden !important; }'; document.head.append(s); })()" };
const NARROW = '1000x640';

// Rows and buttons that only exist for a real Tana id (current-node Cmd+K rows, the header's meeting button, the Graph
// pane, task meta, fields) are missing for the mock's mockdocN and mockmeetingN. REAL wraps a page's api so they read
// as tana:text:mockdocN and tana:event:mockmeetingN, both ways; run it in every page before anything is opened.
// The mock also has real-looking nodes of its own: tana:text:mockai0, tana:text:mockpin0, tana:text:mockpin1.
const REAL = `(() => { if (tana.__real) return; tana.__real = true;
  const local = (v) => typeof v === 'string' ? v.replace(/tana:(?:event|text):(mock(?:meeting|doc)\\d+)/g, '$1') : v;
  const real = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v).replace(/"(mockmeeting\\d+)(?=["|])/g, '"tana:event:$1').replace(/"(mockdoc\\d+)(?=["|])/g, '"tana:text:$1'));
  for (const k of Object.keys(tana)) { const f = tana[k]; if (typeof f !== 'function') continue;
    tana[k] = /^on[A-Z]/.test(k) ? (cb) => f((...a) => cb(...a.map(real))) : (...a) => { const r = f(...a.map(local)); return r && r.then ? r.then(real) : r; }; } })()`;
const real = (...pages) => (pages.length ? pages : ['']).map((page) => ({ js: REAL, page }));

// Task meta (assignee, audience, bell) and a document's fields are read by main in the app; the mock is never asked for
// mock ids, so a list or a page is seeded from the mock's own answers.
const seedTaskMeta = { js: "Promise.all(shownDocs().map(async (d) => { try { taskMetaById.set(d.id, await tana.taskMeta(d.id)); } catch { /* not a task */ } })).then(() => render(true))" };
const seedFields = (id) => ({ js: "tana.related(" + J(id) + ").then((d) => { relatedBy.set(" + J(id) + ", d); render(true); })" });

// Panes opened while a clip plays need main (window:split), which the runner's shell has none of. live() loads the
// shell's module again under a bridge that keeps its commands and gives each page a splitWindow that asks it, as
// main.js does: ⌘N, ⌘-click and Show graph then open real Trellis panes. doc: a Trellis layout to start from.
// The window sidebar's pins (main/pins.js pinTree's shape), on the mock's own documents so a click opens them: what a
// window draws in its sidebar in every picture (run.js and live() give them to the shell, shell.js sbLoad)
const SIDEBAR_PINS = [{ id: 'p1', uri: 'mockdoc2', node: { title: 'Check out the new editor', icon: 'task' }, children: [] },
  { id: 'p2', uri: 'mockmeeting2', node: { title: 'Leadership sync', icon: 'meeting' }, children: [] },
  { id: 's1', label: 'Studio', children: [{ id: 'p3', uri: 'tana:space:mock', node: { title: 'Studio LT', icon: 'space' }, children: [] },
    { id: 'p4', uri: 'mockspacedoc0', node: { title: 'Studio LT charter', icon: 'doc' }, children: [] }] }];
// and its Agent chats section (main/agentchats.js list's shape), the mock's two chats with Codex (renderer/mock.js)
const SIDEBAR_CHATS = [{ id: 'orbital:agent-chat:0198c0de-0000-7000-8000-000000000001', title: 'Draft the release notes for 0.11' }, { id: 'orbital:agent-chat:0198c0de-0000-7000-8000-000000000002', title: 'Why is the iPhone build slow?' }];
const live = (doc = null, withReal = false) => ({ page: 'shell', js: '(' + (async (doc, REAL, PINS, CHATS) => {
  const theme = document.documentElement.dataset.theme || 'light';
  const prep = (f) => { const w = f.contentWindow; if (REAL) w.eval(REAL); w.document.getElementById('login')?.click(); if (theme === 'dark') w.applyTheme('dark');
    w.eval("tana.splitWindow = async (where, start) => parent.orbOpen(where, start || {}, new URLSearchParams(location.search).get('side') || '')"); };
  document.addEventListener('load', (e) => { if (e.target.tagName === 'IFRAME') prep(e.target); }, true);
  document.getElementById('workspace').replaceChildren();
  for (const b of document.querySelectorAll('.head button, #create')) b.querySelector('svg')?.remove();
  let seq = 3;
  window.shell = { state: () => ({ doc, theme }), onCommand: (cb) => { window.shellCmd = cb; }, layout() {}, onPins() {}, pins: async () => PINS, onAgentChats() {}, agentChats: async () => CHATS };
  window.orbOpen = (where, start, from) => { const id = String(++seq); localStorage.setItem('view', start.view || 'library'); localStorage.setItem('place', start.place || '{}'); window.shellCmd('open', { id, where, from, focus: true }); return id; };
  await import('/shell.js?live');
  await new Promise((r) => setTimeout(r, 1800));
}) + ')(' + J(doc) + ',' + J(withReal ? REAL : '') + ',' + J(SIDEBAR_PINS) + ',' + J(SIDEBAR_CHATS) + ')' });
// a Trellis layout of panels side by side: layout([0.6, 0.4], [panel('a', ['page']), panel('b', ['page2'])], { page: page(''), page2: page('2') })
const panel = (id, views, selected = views[0]) => ({ kind: 'panel', id: 'panel-' + id, views, selected });
const page = (side, links) => ({ type: 'page', params: links ? { side, links: true } : { side } });
const layout = (weights, panels, views) => ({ schema: 1, root: { kind: 'split', id: 'split-m', axis: 'x', weights, children: panels }, floating: [], hidden: [], views });

// The pages main lays over the whole window (main.js openOverlay) have no host in the runner: an iframe does the same.
const overlay = (file, then = '') => ({ page: 'shell', js: "(() => { const f = document.createElement('iframe'); f.src = " + J(file) + " + '?theme=' + window.shell.state().theme;"
  + " f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:9999;background:transparent'; document.body.append(f);"
  + " return new Promise((r) => { f.onload = () => setTimeout(() => { " + then + " f.contentWindow.focus(); r(); }, 300); }); })()" });
const helpTour = overlay('help.html');
// Quick Add Task with what main would hand it: the members, you first, and two workflow types beside Task (task.js)
const quickAdd = overlay('task.html', "f.contentWindow.eval(" + J("people = [['robin', 'Robin Vega', true], ['sam', 'Sam Okafor'], ['priya', 'Priya Raman'], ['tomas', 'Tomas Ilves']].map(([k, title, me]) => ({ id: 'tana:user-profile:' + k, title, me: !!me }));"
  + " taskTypes = [taskTypes[0], { uri: 'tana:type:bug', title: 'Bug', hue: 20 }, { uri: 'tana:type:hire', title: 'Hiring step', hue: 150 }]; draw();") + "); f.contentDocument.getElementById('taskTitle').focus();");

// An image file dragged over the Create new button and dropped (shell.js ondragover / ondrop): type is 'dragenter',
// 'dragover' or 'drop'. A native drag cannot be sent; the app's own handlers run on these.
const dropOnCreate = (type, name = 'receipt.png') => ({ page: 'shell', js: "(() => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));"
  + " const dt = new DataTransfer(); dt.items.add(new File([png], " + J(name) + ", { type: 'image/png' })); document.getElementById('create').dispatchEvent(new DragEvent(" + J(type) + ", { dataTransfer: dt, bubbles: true, cancelable: true })); })()" });

// Auto-translate on or off (renderer/translate.js): the Dutch note mocknl0 then reads in English
const translate = (on) => ({ js: on ? "setPref('translateTo', 'English'); render(true)" : "setPref('translateTo', undefined); render(true)" });

module.exports = { SIDEBAR_CHATS, open, settle, palette, onlyPalette, NARROW, REAL, real, seedTaskMeta, seedFields, live, panel, page, layout, overlay, helpTour, quickAdd, dropOnCreate, translate, SIDEBAR_PINS };
