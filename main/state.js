'use strict';

// Order is the Cmd+K Views order: what is waiting on you, then your work, then knowledge.
// Meetings, Chats and People were fixed views over one kind each — which is exactly what a saved search is, only
// without being editable or nameable. They are gone; the kinds remain, so the same lists are a search away.
const VIEWS = [{ id: 'inbox', title: 'Inbox', icon: 'inbox' }, { id: 'library', title: 'Library', icon: 'library' }, { id: 'types', title: 'Types', icon: 'type' }];
const TAG = { task: { label: 'task', color: 'grey' }, meeting: { label: 'meeting', color: 'gold' }, space: { label: 'space', color: 'grey' }, doc: { label: 'doc', color: 'grey' }, member: { label: 'member', color: 'grey' } };
const KINDS = { doc: 'tana:text:', task: 'tana:text:', meeting: 'tana:event:', chat: 'tana:chat:', search: 'tana:search:', type: 'tana:type:' };
const PLAIN_KINDS = new Set(['chat', 'canvas', 'agent', 'skill', 'type', 'search']); // tana:<kind>: ids listed read-only: kind icon + kind tag
const PIN_HUBS = new Set(['event', 'space']); // the only schemas with a pinnedItems container (docs/PINNING.md section 4)
const DOC_URI = /^tana:[a-z-]+:[0-9a-z]{26}$/; // a real document id; a renderer draft keeps a local id until it materialises (#112)
// How many rows of a list are kept live. A subscription is a bootstrap RPC and a LoroDoc of its own, and every
// bootstrap lands as a change the renderer redraws on, so subscribing a whole list (the Library lists hundreds)
// flooded the one sync connection and the outline with it: the page lagged and the read for whatever you opened
// next queued behind it. The head of the list is what you are looking at; the rest ride the next refresh, which
// re-queries the graph anyway. 100 also sits at the usual HTTP/2 stream limit, so the burst is one round.
const LIVE_ROWS = 100;
// Everything the modules share and reassign lives on S, so one require gives every file the same live values.
// The caches below are plain consts: sharing the Map is enough.
const S = {
  client: null, me: null, win: null, session: null, userData: null, // set by main.js at boot (or testRuntime)
  status: { authenticated: null, authChecking: true, connected: false, syncing: false, lastSync: null, error: null },
  activeView: 'inbox', activeFilter: undefined, refreshing: null, refreshTimer: null, historyBusy: false, typesLoaded: null, membersLoaded: null,
  refresh: null, // views.js sets this: the one place a refresh runs, reached from here so documents.js and pins.js need no cycle
  writer: null, // the page whose typed text is being written right now (main.js typed): its echo is its own (#265)
  badge: null, // main.js sets this: the app icon's badge belongs to electron, the counting to views.js (same split as refresh)
};
const subscribed = new Set(); // ids the view refresh subscribed, which its list sweep lets go of (reads: documents.js onDemand)
// Ids an on-demand read (doc:info, a zoom, a mutation) is waiting on a bootstrap for. The view refresh unsubscribes
// every row it no longer lists, and unsubscribing a subscription that is still bootstrapping rejects it as
// 'unsubscribed <id>' under whoever is awaiting it — which is what a doc:info for a row of the view you just left
// reported as a red error. A read holds its document for as long as it is waiting; the next refresh sweeps it.
const reading = new Map(); // docId -> how many reads are waiting on it
const deletedNodes = new Set();
const isDeleted = n => typeof n.deletedAt === 'number' && n.deletedAt > 0;
const visibleGraphNodes = nodes => nodes.filter(n => !deletedNodes.has(n.id) && !isDeleted(n));
const typeTitles = new Map(); // entityType uri -> title, resolved once per S.session
const typeHues = new Map(); // type uri -> appearance.hue (0-360), for coloured type tags
const nodeHues = new Map(); // document uri -> its own appearance.hue; separate from typeHues
const nodeCreators = new Map(); // document uri -> the user-profile uri that made it; a graph fact, and it never changes
const editability = new Map(); // observed graph/document capabilities, never guessed from ownership
// What the renderer sorts and groups rows by. A graph node carries createTime and state; a Loro data map carries
// createdAt (ms) and stateType; the SQLite view rows (db.js) have a column for neither, so both are cached per id
// and toNode reads them back for cached rows. Times are ISO strings everywhere, so they compare as strings.
const nodeMeta = new Map(); // document uri -> { createdAt?, stateType? }
// What a document itself last said its state was. Kept apart from nodeMeta, which a lagging search-index row
// overwrites: that is how "Set status to Inbox" used to come back as In Progress two seconds later. The refresh drops
// the entry when it stops following the document (views.js), so this never outlives what it describes.
const docStates = new Map(); // document uri -> stateType, from a Loro data map only, never from the index
const iso = (v) => (typeof v === 'number' ? new Date(v).toISOString() : typeof v === 'string' ? v : undefined);
const errText = (e) => String((e && e.message) || e);
// Before the S.session and sync stream are ready, every view/metadata call fails the same benign way. That is a
// startup state, not an error to show or log (#97), so it never reaches setStatus.
const NOT_CONNECTED = 'not connected to Tana';
const notReady = (e) => errText(e) === NOT_CONNECTED;
const report = (e) => { if (!notReady(e)) setStatus({ error: errText(e) }); };
const now = () => new Date().toISOString();
const isSpace = (id) => id.startsWith('tana:space:');
const isSearch = (id) => id.startsWith('tana:search:'); // a saved search: its "children" are the rows its stored query returns
const idKind = (id) => id.split(':')[1];
const memberTitle = (n) => n.title || (n.userProfile && n.userProfile.name) || '';
const isMcp = (n) => (n.invocationContext && n.invocationContext.intent === 'mcp') || /^MCP:/i.test(n.title || '');
// every outliner page (issues #137, #159): what is pushed is shared state; a command for one page is sent to it directly
function pages() {
  const wins = S.windows && S.windows.size ? S.windows : S.win ? [S.win] : [];
  return [...wins].filter((w) => !w.isDestroyed()).flatMap((w) => (w.panes || [w]).map((p) => p.webContents));
}
function send(channel, ...payload) { for (const wc of pages()) wc.send(channel, ...payload); }
// One document changed. The page that typed the change already shows it, so it hears it as its own and skips
// re-reading the page (renderer/app.js); every other page, the other half of a split included, hears it as before (#265).
function sendChanged(docId, info) { for (const wc of pages()) wc.send('outline:changed', docId, wc === S.writer ? { ...info, own: true } : info); }
// local YYYY-MM-DD, optionally N days from now (1 = tomorrow)
const today = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d.toLocaleDateString('sv-SE'); };
function setStatus(patch) {
  Object.assign(S.status, patch);
  send('sync:status', S.status);
}

const metaSigs = new Map(); // docId -> the metadata signature the renderer last read (documents.js onChange)
const truncatedViews = new Set(); // view ids whose last query hit the row cap, so roots can say so without a second query
const summaryCache = new Map(); // event uri -> write-up uri or null
const typeAttrTitles = new Map(); // type uri -> { key: title }
const hueLoaded = new Set();
const undoStack = [];
const redoStack = [];

function scheduleRefresh(ms) {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(() => S.refresh && S.refresh(), ms);
}

module.exports = { VIEWS, TAG, KINDS, PLAIN_KINDS, PIN_HUBS, DOC_URI, LIVE_ROWS, S, subscribed, reading, deletedNodes, isDeleted, visibleGraphNodes, typeTitles, typeHues, nodeHues, nodeCreators, editability, nodeMeta, docStates, iso, errText, NOT_CONNECTED, notReady, report, now, isSpace, isSearch, idKind, memberTitle, isMcp, send, sendChanged, today, setStatus, metaSigs, truncatedViews, summaryCache, typeAttrTitles, hueLoaded, undoStack, redoStack, scheduleRefresh };
