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
  if (connected && !wasConnected) { taskMetaFailed.clear(); loadView(); }
  $('loginBox').hidden = !state.showLogin;
  outline.hidden = $('filtered').hidden = !state.showOutline;
  showError(state.error);
  render(); // auth/connection state drives the skeleton; a newly visible outline applies the view's opening scroll
}
$('login').onclick = () => tana.login().catch(showError);

// ---- live updates ----
tana.onChanged((docId) => {
  if (docId) { taskMetaById.delete(docId); if (typeof taskMetaFailed !== 'undefined') taskMetaFailed.delete(docId); }
  const work = [loadRoots()];
  if (docId && kids.has(docId)) work.push(reload(docId));
  if (!docId) loadPins();
  Promise.all(work).then(() => docId ? undefined : loadView()).then(render, showError); // cached roots first, then the active query wins
});
function removeStale(id) {
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
loadRoots().then(render, showError).then(loadFilters);
tana.status().then(showStatus, showError);
