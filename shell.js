// An outliner window (main.js): a Trellis workspace with one or two pages side by side, each an iframe of index.html
// that is the outliner as before. Main keeps what is saved and says what to do (window.shell: state, onCommand,
// layout); a page talks to this frame itself only to be laid over the whole window while its palette is open
// (renderer/palette.js coverWindow) and to flush before its iframe goes (renderer/app.js leavePage).
import { createWorkspace, createDocument, layout as L, DEFAULT_KEYMAP } from './vendor/trellis/index.js';

const bridge = window.shell || { state: () => ({ split: false }), onCommand() {}, layout() {} }; // shell.html opened on its own
const start = bridge.state();
let theme = start.theme === 'dark' ? 'dark' : 'light', splitAt = start.splitAt, last = '', seq = 0, covering = null;
// The side main knows each page by, '' the left or only one and '2' the right: positional, relabelled after every
// change and reported in the old labels (layout order) so main can follow the pages it holds.
const sides = new Map();
const newPage = (side) => { const id = 'page' + ++seq; sides.set(id, side); return id; };

// The line: the panels' 1px ring, in the colours the split line had (styles.css .splitgrip before), on the page's own background
const tokens = () => theme === 'dark'
  ? { '--trellis-bg': '#2b2f31', '--trellis-border': '#2b2f31', '--trellis-panel': '#1b1d1e', '--trellis-accent': '#4a5053', '--trellis-gap': '0px', '--trellis-radius': '0px' }
  : { '--trellis-bg': '#ececec', '--trellis-border': '#ececec', '--trellis-panel': '#fff', '--trellis-accent': '#c8c8c8', '--trellis-gap': '0px', '--trellis-radius': '0px' };
// The page's side in its URL is the one it was made with and never changes, since a new src reloads it; a page that
// changes sides rewrites its own URL (renderer/app.js onSide), so a Reload asks main with the right one.
const spec = (id) => L.view('page', { id, params: { side: sides.get(id) } });
const docOf = (ids) => createDocument(ids.length > 1 ? L.row(ids.map(spec), [splitAt ?? 0.5, 1 - (splitAt ?? 0.5)]) : spec(ids[0]));
const first = [newPage('')];
if (start.split) first.push(newPage('2'));

const ws = createWorkspace(document.getElementById('workspace'), {
  types: { page: { title: 'Orbital', tabbar: 'never', iframe: (view) => ({ src: 'index.html?side=' + view.params.side, title: 'Orbital' }) } },
  document: docOf(first),
  theme, tokens: tokens(),
  floating: false, navigation: false, panelMenu: false, label: 'Orbital',
  keymap: Object.fromEntries(Object.keys(DEFAULT_KEYMAP).map((k) => [k, null])), // every key is the outliner's (⌘\, ⌘W, ⌥⌘N and the rest)
});
document.documentElement.dataset.theme = theme;

const ids = () => { const root = ws.getDocument().root; return !root ? [] : root.kind === 'split' ? root.children.map((p) => p.views[0]) : [root.views[0]]; };
const frameOf = (id) => ws.view(id)?.element.querySelector('iframe');
const idOf = (side) => ids().find((id) => sides.get(id) === side);
const show = (list) => ws.setDocument(docOf(list));

// Every committed change — the divider dropped or double-clicked, a page opened, closed or swapped — goes to main once.
ws.on('change', (doc) => {
  const list = ids();
  if (doc.root?.kind === 'split') splitAt = doc.root.weights[0] / (doc.root.weights[0] + doc.root.weights[1]);
  const order = list.map((id) => sides.get(id));
  list.forEach((id, i) => sides.set(id, i ? '2' : ''));
  for (const id of sides.keys()) if (!list.includes(id)) sides.delete(id);
  const next = { split: list.length > 1, splitAt, order };
  if (JSON.stringify(next) !== last) { last = JSON.stringify(next); bridge.layout(next); }
});

function focusSide(side) {
  const id = idOf(side);
  if (!id) return;
  ws.focus(id);
  frameOf(id)?.contentWindow.focus();
}
// A page is told to send what it is typing and leave its presence room before its iframe goes (what beforeunload did
// when each page was a view main closed); it answers, or half a second passes.
const flush = (frame) => new Promise((done) => {
  const win = frame?.contentWindow;
  if (!win) return done();
  const end = () => { clearTimeout(timer); removeEventListener('message', heard); done(); };
  const heard = (e) => { if (e.source === win && e.data?.orbital === 'flushed') end(); };
  const timer = setTimeout(end, 500);
  addEventListener('message', heard);
  win.postMessage({ orbital: 'flush' }, '*');
});
async function close(side) {
  const list = ids(), id = idOf(side);
  if (!id || list.length < 2) return; // a page alone is the window's: main closes that
  await flush(frameOf(id));
  show(list.filter((x) => x !== id));
}

bridge.onCommand(async (cmd, arg) => {
  if (cmd === 'split') {
    const on = arg?.on === true, list = ids();
    let opened = null;
    if (on && list.length < 2) { opened = newPage('2'); show([...list, opened]); }
    else if (!on) await close('2');
    // a new page takes the focus once its document exists: focused while still loading, its window never hears it
    const frame = opened && frameOf(opened);
    if (arg?.focus != null) { if (frame) frame.addEventListener('load', () => focusSide(sides.get(opened)), { once: true }); else focusSide(arg.focus); }
  } else if (cmd === 'close') await close(arg);
  else if (cmd === 'swap') { if (ids().length > 1) show(ids().reverse()); } // the line stays where it is: splitAt is the left share
  else if (cmd === 'focus') focusSide(arg);
  else if (cmd === 'theme') {
    theme = arg === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    ws.update({ theme, tokens: tokens() });
  }
});

// ---- the palette over the whole window (issue #409) ----
// The page asks, and its iframe is laid over the whole workspace, its surface above the other; the page draws itself
// in its own half and is see-through beside it (styles.css html.cover). Its surface keeps the half's box, which is
// where the page reads its half from.
function place() {
  if (!covering) return;
  const box = covering.parentElement.getBoundingClientRect(), all = ws.element.getBoundingClientRect();
  covering.style.left = all.left - box.left + 'px'; covering.style.top = all.top - box.top + 'px';
  covering.style.width = all.width + 'px'; covering.style.height = all.height + 'px';
}
function cover(frame, on) {
  if (covering && (on || covering === frame)) { covering.closest('[data-trellis-part="surface"]')?.removeAttribute('data-covering'); covering.style.cssText = ''; covering = null; }
  if (on) { frame.closest('[data-trellis-part="surface"]')?.setAttribute('data-covering', ''); covering = frame; place(); }
  document.body.classList.toggle('covered', !!covering);
}
addEventListener('resize', () => requestAnimationFrame(place)); // after Trellis has laid the surfaces out again
addEventListener('message', (e) => {
  const frame = [...ws.element.querySelectorAll('iframe')].find((f) => f.contentWindow === e.source);
  if (frame && e.data?.orbital === 'cover') cover(frame, e.data.on === true);
});
