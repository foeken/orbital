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
  if (connected && !wasConnected) { taskMetaFailed.clear(); loadView(); loadSearches(); restorePlace(); }
  $('loginBox').hidden = !state.showLogin;
  outline.hidden = $('filtered').hidden = !state.showOutline;
  showError(state.error);
  render(); // auth/connection state drives the skeleton; a newly visible outline applies the view's opening scroll
}
$('login').onclick = () => tana.login().catch(showError);

// ---- live updates ----
// One document changed (info.meta says whether its assignees, audience or sharing moved — main compares them, so a
// text edit does not throw the row's metadata away); null is a global change: the refresh loop wrote the active
// view's fresh rows into the cache before saying so, so roots already carry them and no second query is needed.
// Clicking a notification opens the node it was about; main has already raised and focused the window.
if (tana.onNotifyOpen) tana.onNotifyOpen((docId) => { if (docId) goTo(docId); });
tana.onChanged((docId, info) => {
  if (docId) {
    if (!info || info.meta !== false) { taskMetaById.delete(docId); if (typeof taskMetaFailed !== 'undefined') taskMetaFailed.delete(docId); }
    const work = [patchDoc(docId)];
    if (kids.has(docId)) work.push(reload(docId));
    Promise.all(work).then(renderSoon, showError);
  } else {
    loadPins();
    loadRoots().then(renderSoon, showError);
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
  try { fresh = asDoc(await tana.node(docId)); } catch { return loadRoots(); } // deleted or unreadable: the lists decide
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
  searches = searches.filter((s) => s.id !== id); // a deleted saved search must leave the Cmd+K Searches group too
  invalidateNode(id); loadPins();
  loadRoots().then(render, showError);
}
function unpinStale(id) {
  invalidatePinCaches(id, false); loadPins(); render();
}
if (tana.onRemoved) tana.onRemoved(removeStale);
if (tana.onUnpinned) tana.onUnpinned(unpinStale);
tana.onStatus(showStatus);
if (tana.onSystemTheme) tana.onSystemTheme((t) => { if (themePref === 'system') applyTheme(t); }); // macOS appearance changes re-theme a running window
if (themePref === 'system') followSystem(true);
loadRoots().then(render, showError).then(restorePlace).then(loadFilters);
// Cmd+K only: never blocks the first paint. Boot almost always races the sync connect (main creates the window
// before S.client exists, so main/views.js:searchList answers []), so this alone would usually leave the group
// empty; showStatus's connect edge above re-runs it once a client actually exists. Called here too so a session
// that is already connected (e.g. a reload) does not wait for a transition that will not happen.
function loadSearches() { if (tana.searches) tana.searches().then((list) => { searches = list || []; renderSoon(); }, () => {}); }
loadSearches();
tana.status().then(showStatus, showError);
