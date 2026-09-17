'use strict';
// The api handle and all renderer state, page zoom, and the root elements.

const tana = window.api || mockApi();

// ---- state ----
let views = [];              // [{ id, title, icon, nodes: document Node[] }]
let searches = [];           // [{ id, title, icon, … }] saved search documents, for the Cmd+K Searches group
let view = localStorage.getItem('view') || 'tasks'; // active view id; the outline shows one view at a time
// Views that no longer exist. A stored one would leave the app on a page with no filter, no rows and no way back,
// so it lands in the Library, which lists every kind those pages used to list one of.
if (['members', 'people', 'meetings', 'chats'].includes(view)) view = 'library';
let authed = false, authChecking = true, signedOut = false;
const extra = new Map();     // docId -> document Node reached through a mention (not in roots)
const paths = new Map();     // docId -> [{ id, title }] location in Tana for the breadcrumb (api.path)
const kids = new Map();      // docId -> Node[] | null (loading)
const open = new Map();      // key -> bool; default: blocks open, documents closed
let zoom = null;             // { docId, nodeId | null, from?: string } from = breadcrumb root label when not the view (e.g. 'Search')
const items = new Map();     // key -> { key, node, docId, parent }, rebuilt on render
const pending = new Map();   // key -> { item, segs, timer } debounced edits
let filterShown = false;
let queue = Promise.resolve();
let scrolledView = null;     // view already scrolled to today's first meeting when it opened
let animView = null;         // view whose rows are already on screen: only then is an arrival/departure worth animating
let linkCtx = null;          // @ linking in progress: { item, segs, start, end, text }
let pinCtx = null;           // relationship pin picker: { pinHub, docId }
let pillCtx = null;          // Cmd+K sublevel for one current view pill
const hotkeys = JSON.parse(localStorage.getItem('hotkeys') || '{}'); // palette row id -> combo ("⇧⌘M")
if (hotkeys.sync) { delete hotkeys.sync; localStorage.setItem('hotkeys', JSON.stringify(hotkeys)); }
// The built-in keys are palette rows with a default combo, in the same map the recorder edits: a recorded combo
// overrides the default, and Reset in the recorder restores it. What is not here is fixed on purpose (⌘K, ⇧⌘K,
// the text-size keys, ⇧⌘⌫ and the ⇧⌘↑/↓ moves, which act on blocks the palette does not address).
const DEFAULT_HOTKEYS = { search: '⌘S', filter: '⌘F', copyLink: '⌘C', back: '⌘[', forward: '⌘]', undo: '⌘Z', redo: '⇧⌘Z', rail: '⌘→', expand: '⌘↓', collapse: '⌘↑', toggleDone: '⌘↩', today: '⌃⇧D' };
const hotkeyFor = (id) => (Object.hasOwn(hotkeys, id) ? hotkeys[id] : DEFAULT_HOTKEYS[id]);
const hotkeyIds = () => [...new Set([...Object.keys(DEFAULT_HOTKEYS), ...Object.keys(hotkeys)])];
let pinInfo = null;          // { docId, sidebar, dates } of the palette's document (api.pinState)
let palDoc = null;           // document the Cmd+K context actions apply to (zoomed, else the one whose node is focused)
let palTaskCtx = null;
let palReturn = null; // { key, offset } of the node focused when a palette opened; focus goes back there on close
const fresh = new Map();     // docId -> { section, after, node }: documents created here that roots does not list yet, kept in place until it does
let draftSeq = 0;
const DRAFT_KIND = { tasks: 'task' }; // what Enter drafts in a view (any other view: a plain doc)
let sel = null;              // multi-select: { keys: Set, anchor: key, focus: key }; the caret leaves the text
let selectionFrozen = false;
const filters = new Map();   // view id -> the persisted query filter
const viewSeq = new Map();   // stale viewList responses never replace a newer filter result
const truncated = new Set();
let members = null;
let sensitiveIds = null, sensitiveVisible = false, sensitiveLoading = null; // marks persist; every launch starts blurred
const sensitiveEls = new Map(); // rendered surface -> document ids; lets a toggle update live DOM without rebuilding it
const taskMetaById = new Map(), taskMetaLoading = new Set(), taskMetaFailed = new Map(); // docId -> { until, wait }: a failed metadata read backs off, it is never given up on
const META_RETRY_MS = 500, META_RETRY_MAX = 30000;
const accessById = new Map(), accessLoading = new Set();
let visibilityPeople = new Set();
let visibilityRoles = new Map();
let menu = null;             // open pill menu: { id, index }
// Page key -> arrangement. A view's key is its id and lives here, in the browser; a saved search's key is its
// document id and lives in the document, so only the view keys are written back to localStorage (persistPref).
const groupPref = JSON.parse(localStorage.getItem('groupBy') || '{}'); // page key -> 'none' | 'status' | 'assignee' | 'updated' | 'type'
const sortPref = JSON.parse(localStorage.getItem('sortBy') || '{}');   // page key -> 'default' | 'updated' | 'created' | 'title'
const displayPref = JSON.parse(localStorage.getItem('display') || '{}'); // page key -> which of a row's facts it shows
let rootsLoaded = false, connected = false; // for the loading skeleton: shown while the view has no rows and roots/library/connection are still pending
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
const outline = $('outline'), filterEl = $('filter'), filterRow = $('filterRow');
