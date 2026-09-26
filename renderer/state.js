'use strict';
// The api handle and all renderer state, page zoom, and the root elements.

const tana = window.api ? readOnlyInDemo(window.api) : readOnlyInDemo(mockApi());
// Demo mode draws made-up words, and nothing on screen may then reach Tana: every call that writes is refused here,
// whatever asked for it (a key, Cmd+K, a checkbox, a drop). Reads, navigation and the app's own settings still work.
const DEMO_WRITES = new Set(['editMeeting', 'setNotify', 'inboxSetRead', 'inboxMarkAll', 'proposalAnswer', 'linkCodexTask', 'discussWith',
  'deleteDocument', 'restoreDocument', 'archiveDocument', 'unarchiveDocument', 'setType', 'setField', 'defineField', 'addField', 'setTypeIcon',
  'setTypeHue', 'createDocument', 'createSearch', 'setSearchFilter', 'setTitle', 'setDone', 'setState', 'setStateMany', 'toggleCheckbox',
  'setSharing', 'moveToSpace', 'setAssignees', 'setAssigneesMany', 'setText', 'setCell', 'tableOp', 'setBlockType', 'insertDivider',
  'insertImage', 'insertTable', 'insertAfter', 'insertBefore', 'split', 'join', 'insertChild', 'removeMany', 'moveMany', 'indentMany',
  'outdentMany', 'remove', 'indent', 'outdent', 'move', 'moveTo', 'insertMention', 'pin', 'unpin', 'pinTo', 'unpinFrom', 'setSensitive',
  'setCodex', 'undo', 'redo']);
function readOnlyInDemo(api) {
  return new Proxy({ ...api }, { // a copy: contextBridge freezes window.api, and a proxy of a frozen object must hand back its own values
    get: (own, key) => {
      if (!demoMode || typeof own[key] !== 'function') return own[key];
      if (DEMO_WRITES.has(key)) return () => Promise.reject(new Error('Demo mode is on: nothing is saved to Tana'));
      // the day and week nodes are made (and pinned) the first time they are asked for: in demo mode only found
      if (key === 'todayNode') return (offset) => own.todayNode(offset, true);
      if (key === 'weekNode') return () => own.weekNode(true);
      if (key === 'myTasks') return () => own.myTasks(true); // the Work View's My Tasks, found and never made
      return own[key];
    },
  });
}

// ---- state ----
let views = [];              // [{ id, title, icon, nodes: document Node[] }]
let searches = [];           // [{ id, title, icon, … }] saved search documents, for the Cmd+K Searches group
// Searches made here are listed at once and kept until the graph lists them too: its index lags a creation, so the
// reload made right after Save as search came back without the new one and Cmd+K never showed it (#141).
// Marked `added`, loadSearches keeps such an entry until the graph's answer has it; deleting it drops it like any other.
function addSearch(n) { if (!n || typeof n.id !== 'string' || !n.id.startsWith(SEARCH_ID)) return; searches = [{ ...n, added: true }, ...searches.filter((s) => s.id !== n.id)]; }
let searchesLoaded = false;  // whether that list has answered once: until it has, a Home search is trusted, not repaired away
// Home: the page this app comes back to — the Work View, the Library, or a saved search, kept as the target's own id
// ("workView", "library" or a tana:search: document id) rather than its name, so renaming the search in Tana keeps the
// choice and only changes what it reads. It is the Home button on every page and where Back lands with nothing to go
// back to. The Work View is the default, the Library the fallback for a search that is gone (nodes.js).
let home = pref('home', 'workView');
// The right half of a split (main.js addPane, api.side) keeps its own view and place, so a restart reopens both halves
// where they were; main says so when a page changes sides (onSide in renderer/app.js).
let SIDE = typeof window !== 'undefined' && window.api && window.api.side ? ':' + window.api.side : '';
let view = localStorage.getItem('view' + SIDE) || 'library'; // active view id; the outline shows one view at a time
// Views that no longer exist. A stored one would leave the app on a page with no filter, no rows and no way back,
// so it lands in the Library, which lists every kind those pages used to list one of.
// Tasks lands in the Library rather than the Inbox: the two listed almost the same thing (your tasks, proposed and
// open), so it is the nearest page to the one that went away.
if (['members', 'people', 'meetings', 'chats', 'tasks'].includes(view)) view = 'library';
let authed = false, authChecking = true, signedOut = false;
const extra = new Map();     // docId -> document Node reached through a mention (not in roots)
const deletedIds = new Set(); // nodes main has said are gone (outline:removed, a resolved reference, a refused read): drawn struck through, never opened
const justDone = new Map();  // docId -> when it was completed by a click here: renders in the next moment play its tick (render.js playTicks)
const kids = new Map();      // docId -> Node[] | null (loading)
const open = new Map();      // key -> bool; default: blocks open, documents closed
let zoom = null;             // { docId, nodeId | null, from?: string } from = breadcrumb root label when not the view (e.g. 'Search')
const items = new Map();     // key -> { key, node, docId, parent }, rebuilt on render
const pending = new Map();   // key -> { item, segs, timer } debounced edits
let lastEnter = null;        // { from, created, at } the last Enter: the row it acted on, the row it made, and the caret offset it ran at — so undoing it hands the caret back
let filterShown = false;
let queue = Promise.resolve();
let scrolledView = null;     // view already scrolled to today's first meeting when it opened
let animView = null;         // view whose rows are already on screen: only then is an arrival/departure worth animating
let linkCtx = null;          // @ linking in progress: { item, segs, start, end, text }
let pinCtx = null;           // relationship pin picker: { pinHub, docId }
let pillCtx = null;          // Cmd+K sublevel for one current view pill
const hotkeys = { ...pref('hotkeys', {}) }; // palette row id -> combo ("⇧⌘M"), one of the preferences that follow you
// The built-in keys are palette rows with a default combo, in the same map the recorder edits: a recorded combo
// overrides the default, and Reset in the recorder restores it. What is not here is fixed on purpose (⌘K, ⇧⌘K,
// the text-size keys, ⇧⌘⌫ and the ⇧⌘↑/↓ moves, which act on blocks the palette does not address).
const DEFAULT_HOTKEYS = { createTask: '⇧⌘Space', search: '⌘S', filter: '⌘F', copyLink: '⌘C', back: '⌘[', forward: '⌘]', undo: '⌘Z', redo: '⇧⌘Z', expand: '⌘↓', collapse: '⌘↑', toggleDone: '⌘↩', today: '⌃⇧D', reload: '⌘R', newWindow: '⌘N', splitView: '⌥⌘N', otherPane: '⌘\\' }; // "Focus the sidebar" is a palette row with no default key
const hotkeyFor = (id) => (Object.hasOwn(hotkeys, id) ? hotkeys[id] : DEFAULT_HOTKEYS[id]);
// A header button's tooltip: what it does and, when it has one, the key that does the same. The label and row id stay
// on the button so hovering can read the key again (renderer/edit.js), since a key recorded later changes it.
function keyTitle(el, label, id) {
  el.dataset.label = label; el.dataset.hotkey = id;
  const key = hotkeyFor(id);
  el.title = key ? label + ' ' + key : label;
}
const hotkeyIds = () => [...new Set([...Object.keys(DEFAULT_HOTKEYS), ...Object.keys(hotkeys)])];
let pinInfo = null;          // { docId, sidebar, dates } of the palette's document (api.pinState)
let pinFailed = null;        // { docId, message } when that read failed: Edit pins says so rather than Loading… (#394)
let pinRead = 0;             // the latest pinState read: only its answer updates pinInfo and pinFailed
let pinnedIds = null, pinnedLoading = null; // every pinned document (api.pinIds), for the pin mark on a row; null until the first answer
let datePinsById = new Map(); // docId -> ['YYYY-MM-DD'] it is pinned to (api.pinDates), read with pinnedIds
let palDoc = null;           // document the Cmd+K context actions apply to (zoomed, else the one whose node is focused)
let palTaskCtx = null;
let palReturn = null; // { key, offset } of the node focused when a palette opened; focus goes back there on close
const fresh = new Map();     // docId -> { section, after, node }: documents created here that roots does not list yet, kept in place until it does
let draftSeq = 0;
let sel = null;              // multi-select: { keys: Set, anchor: key, focus: key }; the caret leaves the text
let selectionFrozen = false;
const filters = new Map();   // view id -> the persisted query filter
const viewSeq = new Map();   // stale viewList responses never replace a newer filter result
const truncated = new Set();
let members = null;
// The marks live in Tana; whether they are shown is this machine's business, like the page you had open and the
// sidebar width — revealing them on your own laptop should not unblur them on a shared one.
let sensitiveIds = null, sensitiveVisible = localStorage.getItem('sensitiveVisible') === '1', sensitiveLoading = null;
let mcpHidden = false; // the Cmd+K switch: MCP chats out of every list and search; main owns it, read once at boot
const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map(); // docId -> { until, wait }: a failed metadata read backs off, it is never given up on
const META_RETRY_MS = 500, META_RETRY_MAX = 30000;
const accessById = new Map(), accessLoading = new Set();
const notifyById = new Map(), notifyLoading = new Set(); // docId -> { on, default, explicit }: whether changes to it are announced
let codexIds = new Set(), codexLoading = null; // documents handed to the local Codex agent (app-local mark, not a Tana assignee)
// docId -> 'pending' | 'working' | 'waiting' | 'done' | 'broken': what the linked Codex task is doing, read on the
// refresh (main/agent.js). A node with no entry is pending: assigned, but no task has registered itself yet, which
// is the one thing the badge must never draw as finished.
const agentStates = new Map();
const AGENT_BADGE = {
  pending: { label: 'Agent pending', title: 'Assignment requested; no Codex task yet' },
  working: { label: 'Agent working', title: 'The Codex task is running' },
  waiting: { label: 'Agent waiting for you', title: 'The Codex task is waiting for approval or input' },
  done: { label: 'Agent completed', title: 'The Codex task finished its last turn' },
  broken: { label: 'Agent needs attention', title: 'The Codex task failed or cannot be reached — assign again to retry' },
  unavailable: { label: 'Agent host unavailable', title: 'The machine running this task cannot be reached; the task itself is fine' },
};
const agentStateOf = (id) => (AGENT_BADGE[agentStates.get(id)] ? agentStates.get(id) : 'pending');
// The model for the assignment being written, chosen on the Assign to Agent page. '' is Codex's own default, which
// is also what an unknown stored value falls back to: a model Codex no longer offers must not be sent.
let agentModel = '', agentModels = [];
// Which machine the task runs on, chosen per assignment. Laptop unless asked otherwise; the list is main's, so the
// renderer only ever holds names.
let agentHost = 'local', agentHosts = [];
const agentTaskHosts = new Map(); // docId -> the machine its task runs on; only a local one can be opened from here
let visibilityPeople = new Set();
let visibilityRoles = new Map();
let menu = null;             // open pill menu: { id, index }
// Page key -> arrangement. A view's key is its id and lives here, in the browser; a saved search's key is its
// document id and lives in the document, so only the view keys are written back to localStorage (persistPref).
const groupPref = { ...pref('groupBy', {}) }; // page key -> 'none' | 'status' | 'assignee' | 'updated' | 'type'
const sortPref = { ...pref('sortBy', {}) };   // page key -> 'default' | 'updated' | 'created' | 'title'
const displayPref = { ...pref('display', {}) }; // page key -> which of a row's facts it shows
// Sections folded away (renderer/views.js), as "page key\ngrouping\nsection key" — folded ones only, so unfolding a
// section drops its entry. Read here, at load, so the first render already draws them folded. A saved search's key is
// its document id, which is why these are kept whole rather than filtered like the arrangement above.
const collapsedGroups = new Set(pref('collapsedGroups', []));
let rootsLoaded = false, connected = false; // for the loading skeleton: shown while the view has no rows and roots/library/connection are still pending
let booted = false; // the first page has landed: the loading page is built on a launch or a Reload only, never again after
let placed = false; // the launch's one connected restorePlace has settled (renderer/app.js), so the page on screen is the one it lands on
// font size: native page zoom (⇧⌘+ / ⇧⌘− / ⌘0), persisted. Default is one step below native.
const BASE_ZOOM = 0.91;
let zoomFactor = Number(localStorage.getItem('zoom')) || BASE_ZOOM;
function setZoom(f) {
  zoomFactor = Math.min(3, Math.max(0.5, Math.round(f * 100) / 100));
  localStorage.setItem('zoom', String(zoomFactor));
  if (tana.zoom) tana.zoom(zoomFactor);
}
if (zoomFactor !== 1 && tana.zoom) tana.zoom(zoomFactor);

const $ = (id) => document.getElementById(id);
// Demo mode is remembered on this machine, like sensitive visibility: a reload opens the way you left it. Every
// outliner window follows a switch made in another (the storage event), and main is told so it posts no banners.
function applyDemoMode(on) {
  if (on && typeof flushAll === 'function') flushAll(); // finish any real edit before masking the text on screen
  if (on && document.activeElement?.isContentEditable) document.activeElement.blur();
  demoMode = on;
  if (tana.setDemoMode) tana.setDemoMode(on);
}
applyDemoMode(localStorage.getItem('demoMode') === '1');
function toggleDemoMode() {
  applyDemoMode(!demoMode);
  localStorage.setItem('demoMode', demoMode ? '1' : '0');
  render(true);
}
window.addEventListener('storage', (e) => {
  if (e.key === 'demoMode' && (e.newValue === '1') !== demoMode) { applyDemoMode(e.newValue === '1'); render(true); }
  if (e.key === 'zoom' && tana.zoom) { zoomFactor = Number(e.newValue) || BASE_ZOOM; tana.zoom(zoomFactor); } // the text size, set in another page
});
const outline = $('outline'), filterEl = $('filter'), filterRow = $('filterRow');
