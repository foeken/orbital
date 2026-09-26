'use strict';
// Status, live updates from main, and boot.

// ---- status ----
function authView(s) {
  const checking = s.authChecking === true, authenticated = s.authenticated === true;
  const signedOut = s.authChecking === false && s.authenticated === false;
  const unresolved = !checking && !authenticated && !signedOut;
  return { checking, authenticated, signedOut, showLogin: signedOut, showOutline: checking || authenticated || unresolved, error: checking ? null : s.error };
}
function showStatus(s) {
  const state = authView(s);
  const wasConnected = connected;
  authed = state.authenticated; authChecking = state.checking; signedOut = state.signedOut; connected = !!s.connected;
  // The first fetch of a view can run before the sync client exists and fail quietly, so the view refetches the
  // moment the connection comes up; otherwise the Library or Chats stay empty until a filter is touched.
  // restorePlace waits for this too: reopening the last page needs a connection to ask for its children, and boot
  // reaches here with the cached roots already drawn, before the sync client exists.
  // The page you are on before the page behind it: the restore asks for one document's children, the view for a
  // list of up to a thousand rows and the subscriptions that go with it, and on one connection the second used to
  // go first. Any later reconnect finds the place already spent, so this is boot order only.
  if (connected && !wasConnected) { taskMetaFailed.clear(); loadSearches(); loadWorkspaceTypes(); loadPinned(true); restorePlace().finally(() => { placed = true; loadView(); renderSoon(); }); } // the types too: a key recorded on a Cmd+K type row finds it before Cmd+K opens
  $('loginBox').hidden = !state.showLogin;
  $('errorLogin').hidden = !(state.error && !state.authenticated && !state.signedOut);
  outline.hidden = $('filtered').hidden = !state.showOutline;
  showError(state.error);
  render(); // auth/connection state drives the skeleton; a newly visible outline applies the view's opening scroll
}
$('login').onclick = () => tana.login().catch(showError);
$('errorLogin').onclick = () => tana.login().catch(showError);

// ---- live updates ----
// One document changed (info.meta says whether its assignees, audience or sharing moved — main compares them, so a
// text edit does not throw the row's metadata away); null is a global change: the refresh loop wrote the active
// view's fresh rows into the cache before saying so, so roots already carry them and no second query is needed.
// Clicking a notification opens the node it was about; main has already raised and focused the window.
if (tana.onNotifyOpen) tana.onNotifyOpen((docId) => { if (docId) goTo(docId); });
// This page is going away: a split half or its window closed (main.js closes it with waitForBeforeUnload), or a
// Reload. What is still on the 400 ms edit timer is sent now, and its presence room and heartbeat are let go.
window.addEventListener('beforeunload', () => {
  flushAll();
  if (!tana.presenceOpen) return;
  if (presenceDoc) { tana.presenceSet(presenceDoc, null); if (presenceOpen) tana.presenceClose(presenceDoc); }
  tana.presenceView(null);
});
// This page changed sides (swapped, or the right half left alone): it saves its view and place under its new side's
// keys from now on. A Reload asks main again (api.side), so it reads the same ones.
if (tana.onSide) tana.onSide((side) => { SIDE = side ? ':' + side : ''; splitGrip.hidden = closePaneBtn.hidden = SIDE !== ':2'; localStorage.setItem('view' + SIDE, view); rememberPlace(); });
// The Work View, asked for in the other half: it stored this half's place, and this half goes there (renderer/timeline.js)
if (tana.onToPlace) tana.onToPlace(() => {
  const place = readStoredPlace();
  if (!place || !isPlaceId(place.docId)) return;
  goTo(place.docId).then(() => { if (String(place.docId).startsWith(SEARCH_ID)) addSearch({ text: place.title, ...extra.get(place.docId), id: place.docId }); }); // listed in Cmd+K at once, as restorePlace does
});
// The line between the halves is dragged from a grip on the right half's left edge; main reads the cursor and moves
// the line (main.js window:splitDrag), and a double click evens the halves out again.
const splitGrip = $('splitGrip');
splitGrip.hidden = SIDE !== ':2';
splitGrip.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  splitGrip.classList.add('dragging'); splitGrip.setPointerCapture(e.pointerId); tana.splitDrag('start');
  const move = () => tana.splitDrag('move');
  const up = () => { splitGrip.classList.remove('dragging'); splitGrip.removeEventListener('pointermove', move); splitGrip.removeEventListener('pointerup', up); };
  splitGrip.addEventListener('pointermove', move); splitGrip.addEventListener('pointerup', up);
});
splitGrip.addEventListener('dblclick', () => tana.splitDrag('even'));
// Whether the pointer is over this page, for the top row (styles.css html.pointer-in). The header is a window drag
// region, and over it the page hears nothing of the mouse, so a pointer leaving the page may only have gone up into
// the header: main watches the cursor from there and says when it has really left this half.
const pointerIn = (on) => document.documentElement.classList.toggle('pointer-in', on);
document.addEventListener('pointerover', () => pointerIn(true));
document.documentElement.addEventListener('pointerleave', () => (tana.watchPointer ? tana.watchPointer() : pointerIn(false)));
if (tana.onPointerOut) tana.onPointerOut(() => pointerIn(false));
// The right half closes from an X at the far right of its header, after every other button (index.html).
const closePaneBtn = $('navClosePane');
closePaneBtn.hidden = SIDE !== ':2';
closePaneBtn.title = 'Close this pane ⌘W';
closePaneBtn.setAttribute('aria-label', 'Close this pane'); // icon only, so the name has to come from here
{ const svg = iconNode('closePane'); if (svg) closePaneBtn.append(svg); }
closePaneBtn.onmousedown = (e) => e.preventDefault(); // the caret stays where it is: beforeunload flushes what it was typing
closePaneBtn.onclick = () => tana.closePane();
tana.onChanged((docId, info) => {
  // The Timeline's meetings moved (main/timeline.js): the page is read again where it is on screen, and on arrival elsewhere
  if (docId === TIMELINE_PAGE) { if (zoom?.docId === TIMELINE_PAGE) reload(TIMELINE_PAGE).then(() => renderSoon(true), showError); return; }
  if (docId) {
    // A newer update would reorder this row under Updated; keep the layout the user is looking at until Clean up.
    if (typeof sortBy === 'function' && (sortBy() === 'updated' || (typeof groupBy === 'function' && groupBy() === 'updated'))) {
      const row = shownDocs().find((n) => n.id === docId);
      if (row) holdRow(row);
    }
    if (!info || info.meta !== false) { taskMetaById.delete(docId); if (typeof taskMetaFailed !== 'undefined') taskMetaFailed.delete(docId); }
    // The sidebar is read once per page and left alone while the page is edited: its sections are relations, and
    // typing in a document changes none of them (a task row in it is patched by patchCopies, not re-fetched).
    // Only a metadata change — assignees, audience, participants, which main is already comparing for this flag —
    // asks for it again, and that read keeps the old payload on screen until the new one lands. What this gives up
    // is the Changes section noticing your own latest edit: it says what it said when the page opened. Pins refresh
    // it themselves, because they do change a section.
    if (!info || info.meta !== false || isTypeId(docId)) refreshRelated(docId); // a type's own change can be its fields, which its page's pills and columns are
    const work = [patchDoc(docId)];
    for (const id of outlinesOf(docId)) work.push(reload(id)); // its page and its fields: both are its rows
    // A zoom parks the caret in its blank tail, so an ordinary render defers until focus leaves and remote children
    // stay invisible. The forced render already preserves the caret and pending local text. Coalesced, because these
    // arrive in bursts — every document a view subscribes announces its first bootstrap — and one forced redraw of a
    // several-hundred-row outline per announcement is what made a wide view crawl.
    Promise.all(work).then(() => renderSoon(true), showError);
  } else {
    loadPins();
    const work = [loadRoots()];
    if (zoom?.docId === TIMELINE_PAGE) work.push(reload(TIMELINE_PAGE));
    Promise.all(work).then(renderSoon, showError);
  }
});
// A task is also drawn from copies of its own: a reference to it inside an open note (reference.node) and a sidebar row
// (relatedBy). A change to the task brings their state and title along, or those rows keep the old box until their note
// or sidebar reloads.
function patchCopies(docId, state) {
  const changes = Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined));
  const walk = (rows) => { for (const n of rows || []) { if (n.reference && n.reference.uri === docId && n.reference.node) Object.assign(n.reference.node, changes); walk(n.children); } };
  for (const rows of kids.values()) walk(rows);
  for (const data of relatedBy.values()) for (const [, rows] of railGroups(data)) for (const n of rows || []) if (n.id === docId) Object.assign(n, changes);
}
// The changed document's row, wherever it is listed, from one doc:info call instead of a reload of every view.
// A document no view knows about may have just become listable, so that case still reloads.
async function patchDoc(docId) {
  if (!tana.node) return loadRoots();
  let fresh;
  try { fresh = asDoc(await tana.node(docId)); } catch (e) { noteGone(docId, e); return loadRoots(); } // deleted or unreadable: the lists decide
  deletedIds.delete(docId); // it answered, so it is not gone: an undo of a delete brings the rows and the chips back
  if (isTask(fresh)) patchCopies(docId, { text: fresh.text, title: fresh.title, done: fresh.done, stateType: fresh.stateType });
  let hit = extra.has(docId);
  if (hit) Object.assign(extra.get(docId), fresh);
  for (const s of views) for (const n of s.nodes) if (n.id === docId) { Object.assign(n, fresh); hit = true; }
  // A zoomed page that lists documents — a saved search, a space — holds its rows in kids, not in any view, so a
  // change to one of them reached nothing here and the row kept the title, box and assignee it was drawn with.
  for (const rows of kids.values()) for (const n of rows || []) if (n.id === docId) { Object.assign(n, fresh); hit = true; }
  if (!hit) return loadRoots();
}
function removeStale(id) {
  deletedIds.add(id); // it stays known: copies of it elsewhere (a mention, a reference row) are drawn as gone, and nothing opens it
  searches = searches.filter((s) => s.id !== id); // a deleted saved search must leave the Cmd+K Searches group too
  repairHome(); // and if it was Home, the Library takes over rather than an id nothing can open
  invalidateNode(id); loadPins();
  loadRoots().then(render, showError);
}
if (tana.onRemoved) tana.onRemoved(removeStale);
tana.onStatus(showStatus);
// Another machine changed a preference: take the new set and apply it where it is already on screen. Everything a
// preference feeds is visible from here, which is why the applying lives in this file and not beside the store.
if (tana.onSettings) tana.onSettings((next) => {
  const openType = onTypePage() ? zoom.docId : null, wasFields = openType && JSON.stringify((filters.get(openType) || {}).fields || null);
  mergePrefs(next);
  home = pref('home', 'workView');
  for (const key of Object.keys(hotkeys)) delete hotkeys[key];
  Object.assign(hotkeys, pref('hotkeys', {}));
  for (const [store, key] of [[groupPref, 'groupBy'], [sortPref, 'sortBy'], [displayPref, 'display']]) {
    for (const k of Object.keys(store)) if (!k.startsWith(SEARCH_ID)) delete store[k]; // a saved search keeps its own, which lives in the document
    Object.assign(store, pref(key, {}));
  }
  // a type page's field pills are a preference too: the cached filters go, and the open page asks again if its own moved
  for (const id of [...filters.keys()]) if (isTypeId(id)) filters.delete(id);
  if (openType && JSON.stringify(typeFilter(openType).fields || null) !== wasFields) reload(openType).then(() => renderSoon(true), showError);
  collapsedGroups.clear(); for (const key of pref('collapsedGroups', [])) collapsedGroups.add(key);
  const nextTheme = ['dark', 'system', 'light'].includes(pref('theme')) ? pref('theme') : 'light';
  if (nextTheme !== themePref) { if (nextTheme === 'system') followSystem(true); else setTheme(nextTheme); } // writes the same value back, which is a no-op in the store
  renderSoon();
});
if (tana.onSystemTheme) tana.onSystemTheme((t) => { if (themePref === 'system') applyTheme(t); }); // macOS appearance changes re-theme a running window
if (themePref === 'system') followSystem(true);
loadRoots().then(render, showError).then(restorePlace).then(loadFilters);
// Cmd+K only: never blocks the first paint. Boot almost always races the sync connect (main creates the window
// before S.client exists, so main/views.js:searchList answers []), so this alone would usually leave the group
// empty; showStatus's connect edge above re-runs it once a client actually exists. Called here too so a session
// that is already connected (e.g. a reload) does not wait for a transition that will not happen.
// searchesLoaded is the flag repairHome trusts, so only an answer that could have listed something sets it: the
// boot call above lands before the client exists and its empty list is empty for everyone, which repairHome read
// as "the saved search you chose is gone" and wrote the Library over the stored choice on every launch.
function loadSearches() { if (tana.searches) tana.searches().then((answer) => { const list = answer || [], ids = new Set(list.map((s) => s.id)); searches = [...searches.filter((s) => s.added && !ids.has(s.id)), ...list]; searchesLoaded = connected; repairHome(); renderSoon(); }, () => {}); }
loadSearches();
// What a Codex task is doing is Codex's, not Tana's, so no live query carries it: read every 30 s, as it was when the
// refresh loop still ran that often (main.js), and only while something is handed to the agent at all.
setInterval(() => { if (codexIds.size) loadAgentStates(); }, 30000);
if (tana.mcpHidden) tana.mcpHidden().then((on) => { mcpHidden = !!on; }, () => {}); // Cmd+K only: the rows themselves are filtered in main
tana.status().then(showStatus, showError);
