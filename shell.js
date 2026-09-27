// An outliner window (main.js): a Trellis workspace of outliner pages, each an iframe of index.html?side=<id> that is the
// outliner as before, docked side by side, tabbed or floating, and zoomed with Trellis's navigation. Main keeps what is
// saved and which pages exist and says what to do (window.shell: state, onCommand, layout); a page talks to this frame
// itself for what needs no main: its tab's title, the Trellis commands its keys run, being laid over the whole window
// while its palette is open (renderer/palette.js coverWindow) and flushing before its iframe goes (renderer/app.js leavePage).
import { createWorkspace, createDocument, layout as L, DEFAULT_KEYMAP } from './vendor/trellis/index.js';

const bridge = window.shell || { state: () => ({ doc: null }), onCommand() {}, layout() {} }; // shell.html opened on its own
const start = bridge.state();
let theme = start.theme === 'dark' ? 'dark' : 'light', covering = null, last = '', many = null;
// Signed out every page is the same login, so page '' shows alone and the layout waits here for the login ('auth').
const single = () => createDocument(L.view('page', { id: 'page', params: { side: '' } }));
const usable = (doc) => !!doc && typeof doc === 'object' && Object.values(doc.views || {}).some((v) => v && v.type === 'page');
let aside = start.signedOut && usable(start.doc) ? start.doc : null;

// The page's own background around it, and one 1px line between panes in the colour the split line had
const tokens = () => theme === 'dark'
  ? { '--trellis-bg': '#2b2f31', '--trellis-border': '#2b2f31', '--trellis-panel': '#1b1d1e', '--trellis-tabbar': '#232627', '--trellis-accent': '#4a5053', '--trellis-gap': '0px', '--trellis-radius': '0px', '--trellis-tabbar-height': '38px' }
  : { '--trellis-bg': '#ececec', '--trellis-border': '#ececec', '--trellis-panel': '#fff', '--trellis-tabbar': '#f6f6f6', '--trellis-accent': '#c8c8c8', '--trellis-gap': '0px', '--trellis-radius': '0px', '--trellis-tabbar-height': '38px' };
// One page alone is the window as it was: no tab bar and no navigation. With more, each has its tab, titled by the page.
// Content keeps its layout down to 280 x 200 and scales below that, which is what zooming out shows.
const types = (tabs) => ({ page: { title: 'Orbital', tabbar: tabs ? 'always' : 'never', minSize: { width: 280, height: 200 },
  iframe: (view) => ({ src: 'index.html?side=' + encodeURIComponent(view.params.side), title: 'Orbital' }) } });

const ws = createWorkspace(document.getElementById('workspace'), {
  types: types(false),
  document: aside || !usable(start.doc) ? single() : start.doc,
  theme, tokens: tokens(),
  navigation: false, label: 'Orbital', onMissingType: () => 'drop',
  panelMenu: (entries) => entries.filter((e) => e.id !== 'hide'), // a hidden page has nowhere to come back from
  keymap: Object.fromEntries(Object.keys(DEFAULT_KEYMAP).map((k) => [k, null])), // keys are pressed in the pages: each is a row there that asks here ('run')
});
document.documentElement.dataset.theme = theme;

const pages = () => ws.views({ type: 'page' });
const viewOf = (side) => pages().find((v) => v.params.side === side)?.id;
const frameOf = (viewId) => (viewId && ws.view(viewId)?.element.querySelector('iframe')) || null;
const frames = () => [...ws.element.querySelectorAll('iframe')];
// A page's window, once its document has loaded. Touching a new iframe's window before that (its first, empty
// document) kept Electron from running preload.js in the page that replaces it: no window.api, the mock, no page in main.
const loaded = new WeakSet();
const windowOf = (frame) => (frame && loaded.has(frame) ? frame.contentWindow : null);
const sourceOf = (win) => pages().find((v) => windowOf(frameOf(v.id)) === win)?.id;
// Swap is offered while two panes stand side by side and nothing else is docked
const pair = (root) => root?.kind === 'split' && root.axis === 'x' && root.children.length === 2 && root.children.every((c) => c.kind === 'panel');
const tell = (win) => win?.postMessage({ orbital: 'layout', pages: pages().length, swap: pair(ws.getDocument().root) }, '*');

// The tab bars along the top are the window's drag region (-webkit-app-region does not work inside an iframe), and the
// one under the traffic lights starts its tabs clear of them. A floating panel's bar moves the panel.
function mark() {
  const top = ws.element.getBoundingClientRect().top;
  for (const bar of ws.element.querySelectorAll('[data-trellis-part="tabbar"]')) {
    const r = bar.getBoundingClientRect(), up = r.height > 0 && r.top - top < 4 && !bar.closest('[data-floating]');
    bar.toggleAttribute('data-top', up);
    bar.toggleAttribute('data-lights', up && r.left < 80);
  }
}
// A page closes only after it has sent what it was typing (flush), whether its tab's X, the panel menu, ⌘W or its
// window asked; the last page never closes from here (main closes the window then).
const guarded = new Set();
function guard() {
  for (const { id } of pages()) if (!guarded.has(id)) {
    guarded.add(id);
    ws.view(id).guardClose(async () => { if (pages().length < 2) return false; await flush(frameOf(id)); return true; });
  }
}
ws.on('close', (view) => guarded.delete(view.id));

// Every committed change goes to main once; while signed out the layout aside is the one kept.
function sync() {
  const tabs = pages().length > 1;
  if (tabs !== many) { many = tabs; ws.update({ types: types(tabs), navigation: tabs ? 'free' : false }); document.body.classList.toggle('many', tabs); }
  guard(); mark(); place(); frames().forEach((f) => tell(windowOf(f))); // place: a divider or a swap moves a covering page's pane
}
ws.on('change', (doc) => {
  sync();
  if (aside) return;
  const next = JSON.stringify({ doc, pages: pages().map((v) => v.params.side) });
  if (next !== last) { last = next; bridge.layout(JSON.parse(next)); }
});
ws.on('camera', () => { mark(); place(); }); // a zoom moves the panes under a covering palette too, and no resize says so
// A tab chosen, or the one Trellis selects after a close, takes the keys: its window's focus is what tells main
// (preload.js page:focus) which page ⌘W and a notification click aim at.
ws.on('focus', (viewId) => { const win = windowOf(frameOf(viewId)); if (win && !win.document.hasFocus()) win.focus(); });
// Every key is the pages' (Trellis's keymap is off here), so after a click on the shell's own chrome that changes no
// focus — the tab already chosen, a divider, a panel menu's Float or Maximize — the page in front takes the keys back,
// once the click is done and unless a menu is still open.
document.addEventListener('pointerup', () => setTimeout(() => {
  if (document.activeElement?.tagName === 'IFRAME' || document.querySelector('[data-trellis-part="menu"]')) return;
  windowOf(frameOf(ws.getSnapshot().focusedView))?.focus();
}));
addEventListener('resize', () => requestAnimationFrame(() => { mark(); place(); })); // after Trellis has laid the panels out again
sync();

// Each page as it loads: told the layout, and its pinches (ctrl+wheel) zoom the workspace, which no event inside an
// iframe reaches (the recipe "Zoom gestures over iframes"). Plain wheel stays the page's scroll.
ws.element.addEventListener('load', (e) => {
  const frame = e.target;
  if (frame.tagName !== 'IFRAME') return;
  loaded.add(frame);
  tell(frame.contentWindow);
  frame.contentWindow.addEventListener('wheel', (w) => {
    if (!w.ctrlKey || !many) return;
    w.preventDefault();
    const box = frame.getBoundingClientRect(), k = box.width / frame.offsetWidth;
    ws.element.dispatchEvent(new WheelEvent('wheel', { deltaX: w.deltaX, deltaY: w.deltaY, deltaMode: w.deltaMode, ctrlKey: true,
      clientX: box.left + w.clientX * k, clientY: box.top + w.clientY * k, bubbles: true, cancelable: true }));
  }, { passive: false });
}, true);

function focusPage(viewId) {
  if (!viewId) return;
  ws.focus(viewId);
  windowOf(frameOf(viewId))?.focus();
}
// A page is told to send what it is typing and leave its presence room before its iframe goes (what beforeunload did
// when each page was a view main closed); it answers, or half a second passes.
const flush = (frame) => new Promise((done) => {
  const win = windowOf(frame);
  if (!win) return done();
  const end = () => { clearTimeout(timer); removeEventListener('message', heard); done(); };
  const heard = (e) => { if (e.source === win && e.data?.orbital === 'flushed') end(); };
  const timer = setTimeout(end, 500);
  addEventListener('message', heard);
  win.postMessage({ orbital: 'flush' }, '*');
});
// A new page beside the one that asked: to its right, as a tab in its panel, or floating. It takes the keys once its
// document exists: focused while still loading, its window never hears it.
function open({ id, where, from, focus }) {
  if (typeof id !== 'string' || viewOf(id)) return focusPage(viewOf(id));
  const beside = ws.view(viewOf(from) || '')?.panelId || ws.getSnapshot().focusedPanel;
  const placement = where === 'float' ? 'float' : !beside ? 'side' : where === 'tab' ? { into: beside } : { beside, edge: where === 'left' ? 'left' : 'right' };
  const { id: viewId } = ws.open('page', { id: 'page' + id, params: { side: id }, placement, focus: false });
  if (focus) frameOf(viewId)?.addEventListener('load', () => focusPage(viewId), { once: true });
}
// A Trellis command a page's key or palette row asked for (maximize, overview, back, forward, next pane or tab), run
// from that page's panel; the keys stay in the page that has the focus afterwards.
function run(command, from) {
  if (!many || !Object.hasOwn(DEFAULT_KEYMAP, command)) return;
  if (from) ws.focus(from);
  ws.run(command);
  windowOf(frameOf(ws.getSnapshot().focusedView))?.focus();
}

bridge.onCommand((cmd, arg) => {
  if (cmd === 'open' && !aside) open(arg || {});
  else if (cmd === 'close') { const id = viewOf(arg); if (id) ws.close(id); }
  else if (cmd === 'focus') focusPage(viewOf(arg));
  else if (cmd === 'swap') { const doc = ws.getDocument(); if (pair(doc.root)) ws.setDocument({ ...doc, root: { ...doc.root, children: [...doc.root.children].reverse() } }); } // the line stays where it is
  else if (cmd === 'run') run(arg);
  else if (cmd === 'auth') {
    if (arg?.signedOut && !aside) { aside = ws.getDocument(); ws.setDocument(single(), { animate: false }); }
    else if (!arg?.signedOut && aside) { const doc = aside; aside = null; ws.setDocument(doc, { animate: false }); }
  } else if (cmd === 'theme') {
    theme = arg === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    ws.update({ theme, tokens: tokens() });
  }
});

// ---- the palette over the whole window (issue #409) ----
// The page asks, and its iframe is laid over the whole workspace, above every other pane, docked or floating; the page
// draws itself in its own pane and is see-through beside it (styles.css html.cover). Its surface keeps the pane's box,
// which is where the page reads its pane from. A zoomed or scaled pane scales its iframe too, so the box is divided by it.
function place() {
  if (!covering) return;
  const content = covering.parentElement, box = content.getBoundingClientRect(), all = ws.element.getBoundingClientRect(), k = box.width / content.offsetWidth || 1;
  covering.style.left = (all.left - box.left) / k + 'px'; covering.style.top = (all.top - box.top) / k + 'px';
  covering.style.width = all.width / k + 'px'; covering.style.height = all.height / k + 'px';
}
// every element from the iframe up to the workspace is lifted above its siblings and lets the iframe reach past it
const lift = (frame, on) => { for (let el = frame.parentElement; el && el !== ws.element; el = el.parentElement) el.toggleAttribute('data-covering', on); };
function cover(frame, on) {
  if (covering && (on || covering === frame)) { lift(covering, false); covering.style.cssText = ''; covering = null; }
  if (on) { lift(frame, true); covering = frame; place(); }
  document.body.classList.toggle('covered', !!covering);
}
addEventListener('message', (e) => {
  const frame = frames().find((f) => windowOf(f) === e.source), what = e.data?.orbital;
  if (!frame) return;
  if (what === 'cover') cover(frame, e.data.on === true);
  else if (what === 'title') { const id = sourceOf(e.source); if (id) ws.setTitle(id, String(e.data.title || '').trim() || 'Orbital'); }
  else if (what === 'run') run(String(e.data.command), sourceOf(e.source));
});
