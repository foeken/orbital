// An outliner window (main.js): a Trellis workspace of outliner pages, each an iframe of index.html?side=<id> that is the
// outliner as before, docked side by side, tabbed or floating, and zoomed with Trellis's navigation. Main keeps what is
// saved and which pages exist and says what to do (window.shell: state, onCommand, layout); a page talks to this frame
// itself for what needs no main: its tab's title, the Trellis commands its keys run, being laid over the whole window
// while its palette is open (renderer/palette.js coverWindow) and flushing before its iframe goes (renderer/app.js leavePage).
import { createWorkspace, createDocument, layout as L, DEFAULT_KEYMAP } from './node_modules/@danfessler/trellis/dist/index.js';
/* global demoMode: writable, demoText */ // renderer/segments.js, loaded before this (shell.html): demo mode's masks for the sidebar's titles

const bridge = window.shell || { state: () => ({ doc: null }), onCommand() {}, layout() {} }; // shell.html opened on its own
const start = bridge.state();
let theme = start.theme === 'dark' ? 'dark' : 'light', covering = null, last = '', many = null;
// The sidebar's own state, kept on this machine as the pages keep the width they were dragged to (renderer/prefs.js):
// whether it is open or its icons alone, its width, and the sections folded. Up here because tell() reads it from the load on.
// ponytail: one width and one open-or-icons for every window; per window when someone wants two different ones.
let sbOpen = localStorage.getItem('windowSidebar') !== '0', sbWidth = Number(localStorage.getItem('windowSidebarWidth')) || 236, sbTree = [], searchKey = '⌘S';
const renamable = new Set(); // the pages whose title can be typed in (renderer/render.js tellTitle): Rename on their tab
const linkable = new Set(); // the pages showing a node of Tana's: Copy link on their tab (#542)
const refreshable = new Set(); // the saved searches that can be asked again: Refresh on their tab (renderer/pills.js offerRefresh)
const saveable = new Set(); // the views whose pills can be kept as a saved search (the Library): Save as new search on their tab (#538)
const removable = new Set(); // the saved searches: Delete on their tab (renderer/render.js tellTitle, #615)
const tabIcons = new Map(); // page id -> the glyph its page told (renderer/render.js tellTitle), our own markup
// the header buttons drawn per page (drawNav below), and with one page the window header's slot for them; up here
// because sync() runs at load and clears the slot when the page count crosses one
const navDrawn = new Map(), headNav = document.getElementById('headNav'), HEAD = '\u0000head';
// Signed out every page is the same login, so page '' shows alone and the layout waits here for the login ('auth').
const single = () => createDocument(L.view('page', { id: 'page', params: { side: '' } }));
const usable = (doc) => !!doc && typeof doc === 'object' && Object.values(doc.views || {}).some((v) => v && v.type === 'page');
let aside = start.signedOut && usable(start.doc) ? start.doc : null;
document.body.classList.toggle('signed-out', !!start.signedOut); // the header's buttons wait for the login (shell.css)

// The page's own background around it, one 1px line between panes in the colour the split line had, and a bright blue
// as the accent: a hovered divider, a tab's drop slot. The focused tab is the page's own colour, one surface with it
const tokens = () => theme === 'dark'
  ? { '--trellis-bg': '#2b2f31', '--trellis-border': '#2b2f31', '--trellis-panel': '#1b1d1e', '--trellis-tab-active': '#1b1d1e', '--trellis-tabbar': '#232627', '--trellis-accent': '#5aa8ff', '--trellis-gap': '0px', '--trellis-radius': '0px', '--trellis-tabbar-height': '38px' }
  : { '--trellis-bg': '#ececec', '--trellis-border': '#ececec', '--trellis-panel': '#fff', '--trellis-tab-active': '#fff', '--trellis-tabbar': '#f6f6f6', '--trellis-accent': '#2f8cf6', '--trellis-gap': '0px', '--trellis-radius': '0px', '--trellis-tabbar-height': '38px' };
// One page alone is the window as it was: no tab bar and no navigation. With more, each has its tab, titled by the page;
// a right click on it opens the panel menu, led by Rename where the page's title can be typed in (issue #441).
// Content keeps its layout down to 280 x 200 and scales below that, which is what zooming out shows.
const types = (tabs) => ({ page: { title: 'Orbital', tabbar: tabs ? 'always' : 'never', minSize: { width: 280, height: 200 },
  menu: (view) => {
    const items = [...(refreshable.has(view.id) ? [{ id: 'refresh', label: 'Refresh', run: () => windowOf(frameOf(view.id))?.postMessage({ orbital: 'refresh' }, '*') }] : []),
      ...(renamable.has(view.id) ? [{ id: 'rename', label: 'Rename', run: () => rename(view.id) }] : []),
      ...(linkable.has(view.id) ? [{ id: 'copyLink', label: 'Copy link', run: () => { focusPage(view.id); windowOf(frameOf(view.id))?.postMessage({ orbital: 'copyLink' }, '*'); } }] : []), // focused first: the clipboard wants the page in front
      ...(saveable.has(view.id) ? [{ id: 'saveSearch', label: 'Save as new search', run: () => { focusPage(view.id); windowOf(frameOf(view.id))?.postMessage({ orbital: 'action', id: 'saveSearch' }, '*'); } }] : [])]; // Cmd+K's row, in that page
    if (removable.has(view.id)) items.push({ id: 'remove', label: 'Delete', run: () => { focusPage(view.id); windowOf(frameOf(view.id))?.postMessage({ orbital: 'remove' }, '*'); } }); // last: destructive; Tana decides, ⌘Z restores
    return items.length ? [...items, 'separator'] : [];
  },
  iframe: (view) => ({ src: 'index.html?side=' + encodeURIComponent(view.params.side) + (view.params.links ? '&links=1' : ''), title: 'Orbital' }) } });

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
const tell = (win) => win?.postMessage({ orbital: 'layout', pages: pages().length, links: !!linksView(), sidebar: sbOpen }, '*'); // sidebar: ⌘K's Hide or Show sidebar
// The Graph pane (issue #462, renderer/rail.js): one page per window opened with links=1, showing the links of the
// document the page it follows is on. It follows the page that last took the keys, never itself; each page says which
// document it is on (its row too, so the Graph pane opens it without asking main), and a row opened there opens in it.
const linksView = () => pages().find((v) => v.params.links)?.id;
const docs = new Map(); // page view id -> { docId, doc } it last told
// Where each page is, and every page told where the others are, so none opens a place another pane shows (renderer/edit.js
// inOtherPane, #533). A key is a document, a node in one, or a view; the Library is none, as any number may show it.
const places = new Map(); // page view id -> place key
const placesFor = (id) => Object.fromEntries([...places].filter(([p, key]) => p !== id && key && others().includes(p)).map(([p, key]) => [key, p]));
const tellPlaces = () => { for (const id of others()) windowOf(frameOf(id))?.postMessage({ orbital: 'panes', places: placesFor(id) }, '*'); };
let followed = null;
const others = () => pages().filter((v) => !v.params.links).map((v) => v.id); // the pages a Graph pane can follow
// The page followed: the last to take the keys, else the one in front, else the first. A restored window may open with
// the Graph pane in front and no page having taken the keys yet (#463 review).
function following() {
  if (!others().includes(followed)) { const front = ws.getSnapshot().focusedView; followed = others().includes(front) ? front : others()[0] || null; }
  return followed;
}
function follow() {
  const told = docs.get(following()) || { docId: null, doc: null };
  windowOf(frameOf(linksView()))?.postMessage({ orbital: 'follow', docId: told.docId, doc: told.doc }, '*');
}

// The tab bars along the top drag the window as the header does (-webkit-app-region does not work inside an iframe). A
// floating panel's bar moves the panel. The bars along the left edge keep their first tab off the window's edge.
function mark() {
  const { top, left } = ws.element.getBoundingClientRect();
  for (const bar of ws.element.querySelectorAll('[data-trellis-part="tabbar"]')) {
    const r = bar.getBoundingClientRect(), up = r.height > 0 && r.top - top < 4 && !bar.closest('[data-floating]');
    bar.toggleAttribute('data-top', up);
    bar.toggleAttribute('data-left', r.height > 0 && r.left - left < 4 && !bar.closest('[data-floating]'));
  }
}
// Trellis moves a panel by rewriting its style, and says so (change) before an animated move has landed: a pane dropped
// at the top, a drag, a zoom. So the bars are marked again on the frame after any panel moves, once per frame.
let marking = 0;
new MutationObserver(() => { marking ||= requestAnimationFrame(() => { marking = 0; if (!ws.getSnapshot().dragging) mark(); }); }) // a pane being dragged is no top bar
  .observe(ws.element, { subtree: true, attributes: true, attributeFilter: ['style'] });
// A tab pressed in a bar of several is first reordered in its row, and Trellis stops the pages taking the pointer only
// once it is pulled out of the row. A page is an iframe, which swallows the pointer as it goes over, so the tab never
// left: the pages ignore the pointer from the press on (shell.css body.pressing).
ws.element.addEventListener('pointerdown', (e) => { if (e.target.closest('[data-trellis-part="tab"]')) document.body.classList.add('pressing'); }, true);
// Until the button is let go. A release the shell never heard (a drag ended outside the window, or where Trellis held
// the pointer) left every page deaf to the mouse until a reload: the next move with no button down, or the window
// losing focus, ends it too. The pages pass the pointer through meanwhile, so the shell does hear that move. Trellis's
// own gestures keep the pages off (data-busy) until they hear a release as well: a tab or panel drag listens on the
// window, a divider being moved on itself (data-active), so that move cancels whichever is still going. A resize keeps
// where it got to.
const released = () => document.body.classList.remove('pressing');
for (const type of ['pointerup', 'pointercancel', 'blur']) addEventListener(type, released, true);
addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  released();
  const root = document.querySelector('.trellis');
  if (root?.hasAttribute('data-busy')) (root.querySelector('[data-trellis-part="divider"][data-active]') || root).dispatchEvent(new PointerEvent('pointercancel', { pointerId: e.pointerId, bubbles: true }));
}, true);
// A page closes only after it has sent what it was typing (flush), whether its tab's X, the panel menu, ⌘W or its
// window asked; the last page never closes from here (main closes the window then).
const guarded = new Set();
function guard() {
  for (const { id } of pages()) if (!guarded.has(id)) {
    guarded.add(id);
    // the last page never closes from here, nor the last one a Graph pane follows: main closes the window then (closeFront)
    ws.view(id).guardClose(async () => { if (pages().length < 2 || (id !== linksView() && others().length < 2)) return false; await flush(frameOf(id)); return true; });
  }
}
// The closed page's frame had the keys, and its going leaves them with the shell, where ⌘K and the rest do nothing
// until a click. The page in front takes them once the frame is gone: a close waits for its page to flush (guardClose)
// and ⌘W has no click after it, so the pointerup below comes too early or not at all.
// A tab's glyph in Trellis's icon slot, set again whenever Trellis makes its surfaces anew (a tab moved to another pane)
const drawTabIcons = () => { for (const s of ws.surfaces()) { const g = tabIcons.get(s.view.id) || ''; if (s.icon.dataset.glyph !== g) { s.icon.dataset.glyph = g; s.icon.innerHTML = g; } } };
ws.on('surfaces', drawTabIcons);
ws.on('close', (view) => {
  guarded.delete(view.id); renamable.delete(view.id); refreshable.delete(view.id); saveable.delete(view.id); removable.delete(view.id); linkable.delete(view.id); tabIcons.delete(view.id); docs.delete(view.id); places.delete(view.id);
  if (followed === view.id) { followed = null; follow(); }
  requestAnimationFrame(() => { if (document.activeElement?.tagName !== 'IFRAME') windowOf(frameOf(ws.getSnapshot().focusedView))?.focus(); });
});

// Every committed change goes to main once; while signed out the layout aside is the one kept.
function sync() {
  const tabs = pages().length > 1;
  if (tabs !== many) { many = tabs; ws.update({ types: types(tabs), navigation: tabs ? 'free' : false }); document.body.classList.toggle('many', tabs); headNav.replaceChildren(); navDrawn.delete(HEAD); } // the pages send their buttons again on the layout below, to the tab bars or the header
  guard(); mark(); place(); frames().forEach((f) => tell(windowOf(f))); tellPlaces(); // place: a divider or a move shifts a covering page's pane
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
  if (frame === frameOf(linksView())) follow();
  // Trellis selects a new window's first pane without focusing it, so the page in front takes the keys once it is in
  if (frame === frameOf(ws.getSnapshot().focusedView) && document.activeElement?.tagName !== 'IFRAME') frame.contentWindow.focus();
  // Trellis makes a pane the focused one (its tab bold) from a focusin or a press inside it, and neither leaves an
  // iframe: the page's own are passed on as a focusin on its frame, which Trellis takes without moving the keys, so the
  // caret stays in the node that was clicked or tabbed into.
  const focused = () => frame.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  frame.contentWindow.addEventListener('focus', focused);
  frame.contentWindow.document.addEventListener('pointerdown', focused, true);
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
// The header's switches (shell.html) act in the page in front, which takes the keys first (renderer/app.js), and the
// corner's Create new runs Cmd+K Create new … there. Home is the sidebar's now (below); the Graph switch is each page's
// own (renderer/rail.js drawLinksBtn).
for (const [id, icon, msg] of [['headSensitive', null, { orbital: 'sensitive' }], ['headPalette', 'command', { orbital: 'palette' }], ['headHelp', 'help', { orbital: 'help' }], ['create', 'textPlus', { orbital: 'action', id: 'create' }]]) {
  const button = document.getElementById(id);
  if (icon) button.insertAdjacentHTML('afterbegin', window.ICONS?.[icon] || ''); // icons.js: our own markup, before a label the button has
  button.onmousedown = (e) => e.preventDefault();
  button.onclick = () => { const win = windowOf(frameOf(ws.getSnapshot().focusedView)); win?.focus(); win?.postMessage(msg, '*'); };
}
// Process image (issue #507): a file dragged over Create new turns it into Process image, with the image-sparkle glyph.
// Dropped, the file goes to the page in front (renderer/upload.js processImage), and the button says it is busy until
// that page answers 'processed' (below).
const create = document.getElementById('create'), createWords = create.querySelector('span');
function createAs(state) { // '' | 'drop' | 'busy'
  if ((create.dataset.state || '') === state) return; // dragover fires many times a second
  if (state) create.dataset.state = state; else delete create.dataset.state;
  createWords.textContent = { '': 'Create new', drop: 'Process image', busy: 'Processing image …' }[state];
  create.querySelector('svg')?.remove();
  create.insertAdjacentHTML('afterbegin', window.ICONS?.[state ? 'imageSparkle' : 'textPlus'] || '');
}
create.ondragover = (e) => {
  if (create.dataset.state === 'busy' || !e.dataTransfer.types.includes('Files')) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; createAs('drop');
};
create.ondragleave = (e) => { if (create.dataset.state === 'drop' && !create.contains(e.relatedTarget)) createAs(''); };
create.ondrop = (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0], win = windowOf(frameOf(ws.getSnapshot().focusedView));
  if (!file || !win) return createAs('');
  createAs('busy');
  win.postMessage({ orbital: 'processImage', file }, '*');
};
// The sensitive switch is drawn from the pages' own storage (renderer/document.js): the glyph is the state, an open eye
// while sensitive items are shown and the crossed one while they are blurred, and it follows a switch from any page.
function drawSensitive() {
  const on = localStorage.getItem('sensitiveVisible') === '1', button = document.getElementById('headSensitive'), label = on ? 'Hide sensitive items' : 'Show sensitive items';
  button.innerHTML = window.ICONS?.[on ? 'visible' : 'hidden'] || '';
  button.title = label; button.setAttribute('aria-label', label); button.setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('show-sensitive', on); // the sidebar's sensitive pins
}
drawSensitive();
addEventListener('storage', (e) => {
  if (e.key === 'sensitiveVisible') drawSensitive();
  else if (e.key === 'demoMode' && (e.newValue === '1') !== demoMode) { demoMode = e.newValue === '1'; sbDraw(); } // demo mode's made-up titles (renderer/state.js, renderer/segments.js)
});
function rename(viewId) {
  const win = windowOf(frameOf(viewId));
  win?.focus();
  win?.postMessage({ orbital: 'rename' }, '*');
}
// A page is told to send what it is typing and leave its presence room before its iframe goes (what beforeunload did
// when each page was a view main closed); it answers once its writes have gone to main, or three seconds pass.
const flush = (frame) => new Promise((done) => {
  const win = windowOf(frame);
  if (!win) return done();
  const end = () => { clearTimeout(timer); removeEventListener('message', heard); done(); };
  const heard = (e) => { if (e.source === win && e.data?.orbital === 'flushed') end(); };
  const timer = setTimeout(end, 3000); // a page that never answers still closes
  addEventListener('message', heard);
  win.postMessage({ orbital: 'flush' }, '*');
});
// The window reloads (a saved view opened, Cmd+K Reload) once every page has sent what it was typing, as a close waits
let reloadingAll = false;
async function reloadAll() {
  if (reloadingAll) return;
  reloadingAll = true;
  await Promise.all(frames().map(flush));
  location.reload();
}
// A new page beside the one that asked: to its right, as a tab in its panel, or floating. It takes the keys once its
// document exists: focused while still loading, its window never hears it.
function open({ id, where, from, focus }) {
  if (typeof id !== 'string' || viewOf(id)) return focusPage(viewOf(id));
  const links = where === 'links';
  // one per window: a second one asked for is not opened, and main, which gave it an id, hears the pages as they are
  if (links && linksView()) { focusPage(linksView()); return bridge.layout({ doc: ws.getDocument(), pages: pages().map((v) => v.params.side) }); }
  if (links && viewOf(from)) followed = viewOf(from);
  const beside = ws.view(viewOf(from) || '')?.panelId || ws.getSnapshot().focusedPanel;
  // the Graph pane takes about 320px of the pane it opens beside: under Trellis's 280px minimum its content would be scaled down
  const share = links ? Math.min(0.5, 320 / (frameOf(viewOf(from))?.getBoundingClientRect().width || innerWidth)) : undefined;
  const placement = where === 'float' ? 'float' : !beside ? 'side' : where === 'tab' ? { into: beside } : { beside, edge: where === 'left' ? 'left' : 'right', ...(links ? { share } : {}) };
  const { id: viewId } = ws.open('page', { id: 'page' + id, params: links ? { side: id, links: true } : { side: id }, placement, focus: false });
  if (focus) frameOf(viewId)?.addEventListener('load', () => focusPage(viewId), { once: true });
}
// A Trellis command a page's key or palette row asked for (maximize, overview, back, forward, next pane or tab), run
// from that page's panel; the keys stay in the page that has the focus afterwards.
function run(command, from) {
  if (command === 'navigation.stepOut') return many && ws.navigation.stepOut(); // Escape nothing in the page took (renderer/events.js): one zoom level out
  if (!many || !Object.hasOwn(DEFAULT_KEYMAP, command)) return;
  if (from) ws.focus(from);
  ws.run(command);
  windowOf(frameOf(ws.getSnapshot().focusedView))?.focus();
}

bridge.onCommand((cmd, arg) => {
  if (cmd === 'open' && !aside) open(arg || {});
  else if (cmd === 'close') { const id = viewOf(arg); if (id) ws.close(id); }
  else if (cmd === 'focus') focusPage(viewOf(arg));
  else if (cmd === 'run') run(arg);
  else if (cmd === 'reload') reloadAll(); // a saved view opened (main.js window:setLayout)
  else if (cmd === 'auth') {
    document.body.classList.toggle('signed-out', !!arg?.signedOut);
    if (arg?.signedOut && !aside) { aside = ws.getDocument(); ws.setDocument(single(), { animate: false }); }
    else if (!arg?.signedOut && aside) { const doc = aside; aside = null; ws.setDocument(doc, { animate: false }); }
    if (!arg?.signedOut) sbLoad(); // the pins of whoever signed in
  } else if (cmd === 'action') { // the app menu's Settings… (main.js createMenu): its row, run in the page in front
    const win = windowOf(frameOf(ws.getSnapshot().focusedView));
    win?.focus(); win?.postMessage({ orbital: 'action', id: String(arg) }, '*');
  } else if (cmd === 'theme') {
    theme = arg === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    ws.update({ theme, tokens: tokens() });
  }
});

// ---- the window's sidebar: Search, Home and Today, your sidebar pins, then your Agent chats as Tana keeps them (docs/OUTLINER.md §19) ----
// Every row acts in the page the Graph pane would follow (the last to take the keys): a pin opens there, Search opens
// its ⌘S, Home and Today run its Cmd+K rows, and an agent chat opens there. The pins are Tana's own sidebar collection (docs/PINNING.md): pins at the
// top level under Pinned, then each section with its pins, read from main (main/pins.js pinTree) and read again
// whenever main says it moved (pins:changed). Its edge is the handle: dragged it resizes, and let go narrower than
// SB_SHUT it is its icons alone (SB_RAIL wide), never less; ⌘K Collapse/Expand sidebar and ⌃⌘S switch the two.
const sidebar = document.getElementById('sidebar'), edge = document.getElementById('sbEdge');
const SB_RAIL = 48, SB_MIN = 180, SB_MAX = 420, SB_SHUT = 120;
const sbFolded = new Set(JSON.parse(localStorage.getItem('windowSidebarFolded') || '[]')); // section ids, 'pinned' for the top level, 'agentChats'
let sbChats = []; // your chats with Codex, newest first (main/agentchats.js): the Agent chats section, its newest SB_CHATS
const SB_CHATS = 8;
demoMode = localStorage.getItem('demoMode') === '1'; // renderer/segments.js: titles made up while demo mode is on
// the row glyphs: one chosen with Set icon (a Nucleo "nc-…", its markup sent with the pin by main/pins.js pinTree), a
// node's own where icons.js has it, the ones it names differently, else its kind's (tana:search: → a search), else a document's.
const GLYPH = { meeting: 'calendar', event: 'calendar', chat: 'discuss', agent: 'robot', search: 'search', type: 'type' };
const glyph = (name, uri) => window.ICONS?.[name] || window.ICONS?.[GLYPH[name]] || window.ICONS?.[GLYPH[String(uri || '').split(':')[1]] || String(uri || '').split(':')[1]] || window.ICONS?.doc || '';
function toPage(msg) {
  const id = following(), win = windowOf(frameOf(id));
  if (!win) return;
  focusPage(id);
  win.postMessage(msg, '*');
}
function sbButton(cls, icon, words, run, uri, svg) {
  const b = document.createElement('button');
  b.className = cls; b.tabIndex = -1;
  b.insertAdjacentHTML('afterbegin', svg || glyph(icon, uri)); // icons.js or the app's built-in Nucleo set: our own markup
  const t = document.createElement('span'); t.className = 't'; t.textContent = words; b.append(t);
  b.title = words; // what an icon is, when the sidebar is its icons alone
  b.onmousedown = (e) => e.preventDefault(); // the caret stays in the page
  b.onclick = run;
  return b;
}
function sbDraw() {
  const rows = [];
  const search = sbButton('sbrow', 'search', 'Search', () => toPage({ orbital: 'palette', mode: 'search' }));
  if (searchKey) { const k = document.createElement('kbd'); k.textContent = searchKey; search.append(k); }
  rows.push(search, sbButton('sbrow', 'home', 'Home', () => toPage({ orbital: 'action', id: 'goHome' })), sbButton('sbrow', 'today', 'Today', () => toPage({ orbital: 'action', id: 'today' })));
  const pin = (n) => {
    const b = sbButton('sbrow', n.node.icon, demoText(n.node.title || 'Untitled', n.uri), () => toPage({ orbital: 'goto', id: n.uri }), n.uri, n.node.svg);
    b.dataset.uri = n.uri;
    b.oncontextmenu = (e) => { e.preventDefault(); bridge.pinMenu?.(n.uri); }; // Remove pin (main/pins.js)
    b.classList.toggle('sensitive', n.node.sensitive === true);
    if (n.node.sensitive === true) b.removeAttribute('title'); // a blurred title is not told on hover either
    return b;
  };
  const pinned = (list) => list.filter((n) => n.uri && n.node);
  // the pins outside any section under Pinned, then each section; a section with nothing in it is not drawn
  const sections = [{ id: 'pinned', label: 'Pinned', pins: pinned(sbTree) }, ...sbTree.filter((n) => !n.uri && n.label).map((n) => ({ id: n.id, label: n.label, pins: pinned(n.children || []) }))];
  // a section's heading folds it, and shows its count while folded
  const head = (id, label, count) => {
    const shut = sbFolded.has(id), head = document.createElement('button');
    head.className = 'sbsec' + (shut ? ' shut' : ''); head.tabIndex = -1; head.textContent = label;
    head.setAttribute('aria-expanded', String(!shut));
    if (shut) { const n = document.createElement('span'); n.className = 'n'; n.textContent = count; head.append(n); }
    else head.insertAdjacentHTML('beforeend', glyph('chevronRight'));
    head.onmousedown = (e) => e.preventDefault();
    head.onclick = () => { if (sbFolded.has(id)) sbFolded.delete(id); else sbFolded.add(id); localStorage.setItem('windowSidebarFolded', JSON.stringify([...sbFolded])); sbDraw(); };
    return head;
  };
  for (const s of sections.filter((x) => x.pins.length)) rows.push(head(s.id, s.label, s.pins.length), ...(sbFolded.has(s.id) ? [] : s.pins.map(pin)));
  // nothing pinned yet: what would fill it, and how
  if (!sections.some((s) => s.pins.length)) { const p = document.createElement('p'); p.className = 'sbempty'; p.textContent = 'Pin anything here with ⌘K, Pin to sidebar …'; rows.push(p); }
  // Agent chats: the newest, each opening its chat in the page; none yet offers a new one, more than fit the whole list
  if (bridge.agentChats) {
    const chat = (c) => { const b = sbButton('sbrow', 'chat', demoText(c.title || 'New chat', c.id), () => toPage({ orbital: 'goto', id: c.id }), c.id); b.dataset.uri = c.id; return b; };
    const more = sbChats.length > SB_CHATS ? [sbButton('sbrow', 'robot', 'All agent chats', () => toPage({ orbital: 'action', id: 'agentChats' }))] : [];
    rows.push(head('agentChats', 'Agent chats', sbChats.length), ...(sbFolded.has('agentChats') ? [] : sbChats.length ? [...sbChats.slice(0, SB_CHATS).map(chat), ...more] : [sbButton('sbrow', 'robot', 'New chat with Codex', () => toPage({ orbital: 'action', id: 'newAgentChat' }))]));
  }
  sidebar.replaceChildren(...rows);
  sbMark();
}
// the pin of the page the rows act in, marked as the one on screen
function sbMark() {
  const on = docs.get(following())?.docId || '';
  for (const b of sidebar.querySelectorAll('[data-uri]')) b.classList.toggle('on', b.dataset.uri === on);
}
let sbReading = 0;
function sbLoad() {
  if (!bridge.pins) return sbDraw(); // shell.html on its own, or an older main: the three rows alone
  const mine = ++sbReading;
  bridge.pins().then((tree) => { if (mine === sbReading) { sbTree = Array.isArray(tree) ? tree : []; sbDraw(); } }, () => {});
}
bridge.onPins?.(sbLoad);
function sbChatsLoad() { bridge.agentChats?.().then((list) => { sbChats = Array.isArray(list) ? list : []; sbDraw(); }, () => {}); }
bridge.onAgentChats?.(sbChatsLoad);
sbChatsLoad();
// The width it is drawn at: --sw for the sidebar, the panes beside it and the edge (shell.css); its icons alone below SB_SHUT.
function sbApply(width = sbOpen ? sbWidth : SB_RAIL) {
  document.body.style.setProperty('--sw', width + 'px');
  document.body.classList.toggle('sb-rail', width < SB_SHUT);
  requestAnimationFrame(() => { mark(); place(); });
}
function sbSet(open) {
  sbOpen = open;
  localStorage.setItem('windowSidebar', open ? '1' : '0'); localStorage.setItem('windowSidebarWidth', String(sbWidth));
  sbApply();
  frames().forEach((f) => tell(windowOf(f))); // ⌘K's row says Collapse or Expand
}
edge.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  edge.setPointerCapture(e.pointerId);
  edge.classList.add('dragging'); document.body.classList.add('pressing'); // the pages let the pointer pass meanwhile
  const x0 = e.clientX, w0 = sbOpen ? sbWidth : SB_RAIL;
  let width = w0;
  const move = (m) => { width = Math.max(SB_RAIL, Math.min(SB_MAX, w0 + m.clientX - x0)); sbApply(width); };
  const end = () => {
    edge.removeEventListener('pointermove', move); edge.removeEventListener('pointerup', end); edge.removeEventListener('pointercancel', end);
    edge.classList.remove('dragging'); document.body.classList.remove('pressing');
    if (width < SB_SHUT) sbSet(false); else { sbWidth = Math.max(SB_MIN, width); sbSet(true); }
  };
  edge.addEventListener('pointermove', move); edge.addEventListener('pointerup', end); edge.addEventListener('pointercancel', end);
});
sbApply();
sbLoad();

// ---- the palette over the whole window (issue #409) ----
// The page asks, and its iframe is laid over the whole window, above the header and every other pane, docked or floating; the page
// draws itself in its own pane and is see-through beside it (styles.css html.cover). Its surface keeps the pane's box,
// which is where the page reads its pane from. A zoomed or scaled pane scales its iframe too, so the box is divided by it.
function place() {
  if (!covering) return;
  const content = covering.parentElement, box = content.getBoundingClientRect(), all = { left: 0, top: 0, width: innerWidth, height: innerHeight }, k = box.width / content.offsetWidth || 1; // the whole window, the header too
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
  else if (what === 'title') {
    const id = sourceOf(e.source);
    if (!id) return;
    ws.setTitle(id, String(e.data.title || '').trim() || 'Orbital');
    if (e.data.renamable === true) renamable.add(id); else renamable.delete(id);
    if (e.data.saveSearch === true) saveable.add(id); else saveable.delete(id);
    if (e.data.link === true) linkable.add(id); else linkable.delete(id);
    if (e.data.refresh === true) refreshable.add(id); else refreshable.delete(id);
    if (e.data.remove === true) removable.add(id); else removable.delete(id);
    tabIcons.set(id, typeof e.data.icon === 'string' ? e.data.icon : ''); drawTabIcons();
  }
  else if (what === 'run') run(String(e.data.command), sourceOf(e.source));
  else if (what === 'reload') reloadAll(); // Cmd+K Reload: the window, every page in it
  else if (what === 'navbtns') drawNav(sourceOf(e.source), String(e.data.html || ''), e.data.on === true);
  else if (what === 'doc') { const id = sourceOf(e.source); if (!id) return; docs.set(id, { docId: typeof e.data.docId === 'string' ? e.data.docId : null, doc: e.data.doc || null }); if (id === following()) { follow(); sbMark(); } }
  else if (what === 'place') { const id = sourceOf(e.source); if (!id) return; places.set(id, typeof e.data.key === 'string' ? e.data.key : null); tellPlaces(); }
  else if (what === 'focusPane') { if (others().includes(e.data.id)) focusPage(e.data.id); } // that place is on screen there already (#533)
  else if (what === 'focus') { const id = sourceOf(e.source); if (id && id !== linksView() && id !== followed) { followed = id; follow(); sbMark(); } }
  else if (what === 'sidebar') sbSet(!sbOpen); // ⌘K Hide/Show sidebar and ⌃⌘S (renderer/palette.js)
  else if (what === 'keys') { const key = typeof e.data.search === 'string' ? e.data.search : ''; if (key !== searchKey) { searchKey = key; sbDraw(); } } // the page's ⌘S, recorded or not (renderer/app.js)
  else if (what === 'open') { const id = following(), win = windowOf(frameOf(id)); if (!win) return; focusPage(id); if (typeof e.data.id === 'string' || typeof e.data.view === 'string') win.postMessage({ orbital: 'goto', id: e.data.id, view: e.data.view }, '*'); } // from the Graph pane
  else if (what === 'links') { const id = linksView(); if (id) ws.close(id); } // Cmd+K Hide graph
  else if (what === 'palette') { const id = following(), win = windowOf(frameOf(id)); if (!win) return; focusPage(id); win.postMessage({ orbital: 'palette', mode: e.data.mode }, '*'); } // Cmd+K or Cmd+S pressed in the Graph pane
  else if (what === 'action') { const id = following(), win = windowOf(frameOf(id)); if (!win) return; focusPage(id); win.postMessage({ orbital: 'action', id: String(e.data.id) }, '*'); } // any other key pressed there
  else if (what === 'focusLinks') focusPage(linksView());
  else if (what === 'processing') createAs('busy'); // Process image from Cmd+K (renderer/upload.js processImage)
  else if (what === 'processed') createAs(''); // the image is a task or a note now, or it failed and the page said why
  // ⌘K Add to chat (renderer/chat.js): the pane that shows the chat is brought into view and gets the references; with
  // none, the page that asked opens the chat itself
  else if (what === 'addToChat') {
    const id = others().find((v) => docs.get(v)?.docId === e.data.docId) || sourceOf(e.source);
    focusPage(id);
    // a frame on: Trellis moves the focus into the pane on its next frame, which would take the caret out of the message
    requestAnimationFrame(() => windowOf(frameOf(id))?.postMessage({ orbital: 'compose', docId: e.data.docId, segs: e.data.segs, doc: e.data.doc }, '*'));
  }
});

// ---- a page's header buttons in its tab bar, or with one page in the window's header ----
// Each page sends its header buttons' markup (renderer/app.js tellNav) and they are drawn in its view's accessory, the
// slot Trellis shows beside the ⋯ while that page is the selected tab. Ids become data-for, so two pages' copies share
// none, and a press is sent back as a click on the page's own button; mousedown keeps the caret where it is, as the
// page's buttons do. Shown while the pointer is over the page (on) or its tab bar (shell.css).
// One page has no tab bar: its buttons go in the window's header instead, left of the app's own (shell.css .headnav).
function drawNav(viewId, html, on) {
  const slot = !many ? viewId && headNav : viewId && ws.element.querySelector('[data-trellis-part="accessory"][data-view="' + CSS.escape(viewId) + '"]');
  if (!slot) return;
  const key = many ? viewId : HEAD;
  if (!many) slot.dataset.view = viewId;
  slot.toggleAttribute('data-pointer', on);
  if (navDrawn.get(key) === html && slot.childElementCount) return; // a redraw would restart Refresh's turn
  navDrawn.set(key, html);
  slot.innerHTML = html;
  for (const el of slot.querySelectorAll('[id]')) { el.dataset.for = el.id; el.removeAttribute('id'); }
}
headNav.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
headNav.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-for]');
  if (button) windowOf(frameOf(headNav.dataset.view))?.postMessage({ orbital: 'navclick', id: button.dataset.for }, '*');
});
ws.element.addEventListener('mousedown', (e) => { if (e.target.closest('[data-trellis-part="accessory"] button')) e.preventDefault(); });
ws.element.addEventListener('click', (e) => {
  const button = e.target.closest('[data-trellis-part="accessory"] button[data-for]');
  if (button) windowOf(frameOf(button.closest('[data-view]').dataset.view))?.postMessage({ orbital: 'navclick', id: button.dataset.for }, '*');
});
ws.on('close', (view) => navDrawn.delete(view.id));
