'use strict';
// Status, live updates from main, and boot.

// ---- status ----
let statusError = null; // the status repeats its error on every update; the toast shows it once
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
  if (((wasConnected && !connected) || !state.authenticated) && typeof forgetNotes === 'function') forgetNotes(!state.authenticated); // a meeting's notes are asked again by whoever is signed in next (renderer/meetingnotes.js)
  // The first fetch of a view can run before the sync client exists and fail quietly, so the view refetches the
  // moment the connection comes up; otherwise the Library or Chats stay empty until a filter is touched.
  // restorePlace waits for this too: reopening the last page needs a connection to ask for its children, and boot
  // reaches here with the cached roots already drawn, before the sync client exists.
  // The page you are on before the page behind it: the restore asks for one document's children, the view for a
  // list of up to a thousand rows and the subscriptions that go with it, and on one connection the second used to
  // go first. Any later reconnect finds the place already spent, so this is boot order only.
  if (connected && !wasConnected) { taskMetaFailed.clear(); loadSearches(); loadWorkspaceTypes(); loadPinned(true); restorePlace().finally(() => { placed = true; loadView(); renderSoon(); helpOnce(); }); } // the types too: a key recorded on a Cmd+K type row finds it before Cmd+K opens; the tour opens over the page it came back to
  $('loginBox').hidden = !state.showLogin;
  $('pagehead').hidden = state.showLogin; // signed out, the login is the page: no view title above it
  $('navbtns').hidden = state.showLogin; // nor back, forward or the page's buttons
  const relogin = !!(state.error && !state.authenticated && !state.signedOut);
  $('errorText').textContent = relogin ? state.error : ''; $('error').hidden = $('errorLogin').hidden = !relogin;
  outline.hidden = $('filtered').hidden = !state.showOutline;
  if (!relogin && !state.showLogin && state.error && state.error !== statusError) showError(state.error); // the login screen says nothing of a login that did not work: try again
  statusError = state.error;
  render(); // auth/connection state drives the skeleton; a newly visible outline applies the view's opening scroll
}
$('login').onclick = () => tana.login().catch(showError);
$('errorLogin').onclick = () => tana.login().catch(showError);
// Signed out, the splash's big ⌘ and K keycaps go down under the keys you hold, so pressing them feels like the lesson.
// Capture phase: the palette's own handler must not keep ⌘K from reaching it. A keyup of K rarely arrives while ⌘ is
// held on macOS, so K comes up with ⌘ (or when the window loses focus).
function loginKeys(e) {
  if ($('loginBox').hidden) return;
  $('loginCmd').classList.toggle('down', !!e.metaKey);
  $('loginK').classList.toggle('down', !!e.metaKey && e.type === 'keydown' && e.key.toLowerCase() === 'k');
}
document.addEventListener('keydown', loginKeys, true);
document.addEventListener('keyup', loginKeys, true);
window.addEventListener('blur', loginKeys);

// ---- live updates ----
// One document changed (info.meta says whether its assignees, audience or sharing moved — main compares them, so a
// text edit does not throw the row's metadata away; info.fields whether a field's value moved, which re-reads the page's fields only); null is a global change: the refresh wrote every open view's
// fresh rows into the cache before saying so, so roots already carry them and no second query is needed.
// Clicking a notification opens the node it was about; main has already raised and focused the window.
if (tana.onNotifyOpen) tana.onNotifyOpen((docId) => { if (docId) openLink(docId); }); // in the Graph pane: in the page it follows (renderer/rail.js)
// This page is going away: the shell is about to remove its half (it says so first, shell.js flush), its window
// closed, or a Reload. What is still on the 400 ms edit timer is sent now, its presence room and heartbeat are let
// go, and a window it covered is given back. Once: the shell's word, beforeunload and pagehide can all arrive.
let leftPage = false;
function leavePage() {
  if (leftPage) return;
  leftPage = true;
  if (covering) { covering = false; tellCover(false); }
  flushAll();
  if (!tana.presenceOpen) return;
  if (presenceDoc) { tana.presenceSet(presenceDoc, null); if (presenceOpen) tana.presenceClose(presenceDoc); }
  tana.presenceView(null);
}
window.addEventListener('beforeunload', leavePage);
window.addEventListener('pagehide', leavePage);
// The shell (shell.js), the only frame this page listens to: flush before the iframe goes, and what the window holds
// after every change (windowPanes, for the pane rows in Cmd+K). Under a tab bar the page drops the band it kept for the
// traffic lights (styles.css html.tabbed).
window.addEventListener('message', (e) => {
  if (e.source !== window.parent || e.source === window) return;
  // flushed once every write this page queued has gone to main: an earlier one still out holds back the last characters
  if (e.data?.orbital === 'flush') { leavePage(); const shell = e.source; queue.then(() => shell.postMessage({ orbital: 'flushed' }, '*')); }
  else if (e.data?.orbital === 'palette') togglePalette(e.data.mode === 'search' ? 'search' : 'cmd'); // the window header's ⌘K and ? (shell.js), for the page in front, or the Graph pane's
  else if (e.data?.orbital === 'help') openHelp();
  else if (e.data?.orbital === 'sensitive') toggleSensitiveVisibility();
  else if (e.data?.orbital === 'layout') { windowPanes = { pages: e.data.pages, links: e.data.links === true, sidebar: e.data.sidebar !== false }; toShell({ orbital: 'keys', search: hotkeyFor('search') || '' }); drawLinksBtn(); document.documentElement.classList.toggle('tabbed', e.data.pages > 1); document.documentElement.classList.add('framed'); navSent = ''; tellNav(); retell(); } // framed: the shell draws the header buttons, in a tab bar or its header; retell: the title and document again (renderer/rail.js)
  else if (e.data?.orbital === 'navclick') navRow.querySelector('#' + CSS.escape(String(e.data.id)))?.click(); // a press on its copy in the tab bar
  else if (e.data?.orbital === 'follow' && LINKS) follow(e.data.docId, e.data.doc); // the Graph pane: the focused pane's document (renderer/rail.js)
  else if (e.data?.orbital === 'goto') { if (typeof e.data.view === 'string') setView(e.data.view); else if (typeof e.data.id === 'string') goTo(e.data.id); } // what the Graph pane opened, opened here
  else if (e.data?.orbital === 'panes') otherPanes = e.data.places && typeof e.data.places === 'object' ? e.data.places : {}; // where the other panes are (shell.js tellPlaces, #533)
  else if (e.data?.orbital === 'action' && typeof e.data.id === 'string') runAction(e.data.id); // a key pressed in the Graph pane
  else if (e.data?.orbital === 'rename') renameTitle(); // Rename on the tab (shell.js)
  else if (e.data?.orbital === 'refresh') refreshSearch(); // Refresh in the pane's menu (shell.js)
  else if (e.data?.orbital === 'remove' && onSearchPage()) removeZoomedBlock(); // Delete on a saved search's tab (shell.js, #615)
  else if (e.data?.orbital === 'copyLink' && zoom) copyNodeLink(meetingShown(zoom.docId) || zoom.docId); // Copy link on the tab: the page's node, whatever row has the caret (#542); on a meeting, the summary or notes it shows, as ⌘C
  else if (e.data?.orbital === 'processImage') processImage(e.data.file); // an image dropped on Create new (shell.js)
  else if (e.data?.orbital === 'compose' && typeof e.data.docId === 'string' && Array.isArray(e.data.segs) && e.data.doc) composeInto(e.data.docId, e.data.segs, e.data.doc); // ⌘K Add to chat, from this pane or another (renderer/chat.js)
});
titleEl.addEventListener('blur', () => document.documentElement.classList.remove('renaming'));
// Under a tab bar (html.tabbed) the header buttons are drawn in this page's tab bar, beside its ⋯ (shell.js navbtns),
// and the line they sat on above the title goes. The page keeps its own row, laid out but unseen (styles.css), so its
// animations still end — Clean up hides once its exit has played — and sends its markup on every change, with whether
// the pointer is here; a press on the copy is a click on the button here (navclick above).
const navRow = $('navbtns');
let navSent = '';
function tellNav() {
  const on = document.documentElement.classList.contains('pointer-in'), html = navRow.hidden ? '' : navRow.innerHTML; // hidden: the login screen
  if (LINKS || window.parent === window || navSent === on + html) return; // the Graph pane has no outline: its tab gets none of its buttons
  navSent = on + html;
  window.parent.postMessage({ orbital: 'navbtns', html, on }, '*');
}
new MutationObserver(tellNav).observe(navRow, { subtree: true, childList: true, attributes: true });
// Whether the pointer is over this page, for the top row (styles.css html.pointer-in). The page is an iframe now, so
// it hears the pointer leave for anything laid over it too — another page, the line, the shell's drag strip above
// the crumbs — and the row fades there.
const pointerIn = (on) => { document.documentElement.classList.toggle('pointer-in', on); tellNav(); };
document.addEventListener('pointerover', () => pointerIn(true));
document.documentElement.addEventListener('pointerleave', () => pointerIn(false));
tana.onChanged((docId, info) => {
  // The Timeline's meetings moved (main/timeline.js): the page is read again where it is on screen, and on arrival elsewhere
  if (docId === TIMELINE_PAGE) { if (zoom?.docId === TIMELINE_PAGE) reload(TIMELINE_PAGE).then(() => renderSoon(true), showError); return; }
  // and so is a change to today's node, whose tasks are among Today's Tasks: one added there shows at once
  if (docId && zoom?.docId === TIMELINE_PAGE && (kids.get(TIMELINE_PAGE) || []).some((n) => n.timeline?.day === docId)) reload(TIMELINE_PAGE).then(() => renderSoon(true), showError);
  if (docId) {
    // A newer update would reorder this row under Updated; keep the layout the user is looking at until Clean up.
    if (typeof sortBy === 'function' && (sortBy() === 'updated' || (typeof groupBy === 'function' && groupBy() === 'updated'))) {
      const row = shownDocs().find((n) => n.id === docId);
      if (row) holdRow(row);
    }
    // the watch state goes with it: its default follows the assignees, and another page's watch choice arrives this way
    // and the metadata is read again with the old answer kept on screen until the new one lands (loadTaskMeta again)
    // a read still out may predate the change, so it is read once more when it lands (#477)
    if (!info || info.meta !== false) { notifyById.delete(docId); if (typeof taskMetaFailed !== 'undefined') taskMetaFailed.delete(docId); if (taskMetaById.has(docId) || taskMetaLoading.has(docId)) loadTaskMeta(docId, true); }
    if (meetingInfos.has(docId)) meetingInfoOf(docId, true); // a meeting's attendees, read again for its page's field
    if (info && info.notes && typeof noteNotesChanged === 'function') noteNotesChanged(docId); // its private notes were made in another pane, or are no longer private
    if (typeof noteSummaryChanged === 'function') noteSummaryChanged(docId, info); // a meeting's write-up on screen: who sees it and whether you may edit it, asked again
    // and a node linked to an agent task asks what its task is doing: another page may have relinked it to another task
    if (info && info.meta && (agentStates.has(docId) || agentTasks.has(docId))) loadAgentStates();
    // The sidebar is read once per page and left alone while the page is edited: its sections are relations, and
    // typing in a document changes none of them (a task row in it is patched by patchCopies, not re-fetched).
    // Only a metadata change — assignees, audience, participants, which main is already comparing for this flag —
    // asks for it again, and that read keeps the old payload on screen until the new one lands. What this gives up
    // is the Changes section noticing your own latest edit: it says what it said when the page opened. Pins refresh
    // it themselves, because they do change a section.
    if (!info || info.meta !== false || info.fields || isTypeId(docId)) refreshRelated(docId); // fields: a field's value moved (main keeps that apart from meta); a type's own change can be its fields, which its page's pills and columns are
    // What this page just typed (main.js typed): the words are already on screen, so the page is not read again and not
    // rebuilt under the caret on every save. The document's copies elsewhere — a list row, a search result — still take
    // the new title and time, drawn when the caret leaves. Another page, another pane of this window included, never
    // hears a change as its own and reads it as before (#265).
    if (info && info.own && info.meta === false) { patchDoc(docId).then(() => renderSoon(), showError); return; }
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
    // A zoomed page that lists documents holds its own rows (kids), which loadRoots does not reach: the Timeline, a saved
    // search, a type's page. A hidden title, the MCP switch or a type's icon changes them as much as the views (#153 did
    // the Timeline; a search or type page kept the rows just hidden until it was opened again).
    const id = zoom?.docId;
    if (id === TIMELINE_PAGE || (zoom && listPage())) {
      if (searchRows.delete(id)) previewRows(id); // unsaved pill edits: their preview is asked again, as on a return (edit.js)
      else work.push(reload(id));
    }
    Promise.all(work).then(renderSoon, showError);
  }
});
// A document is also drawn from copies of its own: a reference to it inside an open note (reference.node) and a sidebar
// row (relatedBy). A change to it brings their title (and a task's state) along, or those rows keep the old ones until
// their note or sidebar reloads (#413).
function patchCopies(docId, state) {
  const changes = Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined));
  // and the document's own rows nested in a list (a task under Today's Tasks and the same task again further down)
  const walk = (rows) => { for (const n of rows || []) { if (n.reference && n.reference.uri === docId && n.reference.node) Object.assign(n.reference.node, changes); else if (n.id === docId) Object.assign(n, changes); walk(n.children); } };
  for (const rows of kids.values()) walk(rows);
  for (const data of relatedBy.values()) for (const [, rows] of railGroups(data)) for (const n of rows || []) if (n.id === docId) Object.assign(n, changes);
}
// The changed document's row, wherever it is listed, from one doc:info call instead of a reload of every view.
// A document no list shows is left alone. One that becomes listable (created, restored, moved or reassigned) moves a
// view's live query, and main answers that with the global refresh (main/views.js watchViews), which reloads the lists;
// reloading them here too cost every page ~40 roots reads at boot, one per document bootstrapping.
async function patchDoc(docId) {
  if (!tana.node) return loadRoots();
  let fresh;
  try { fresh = asDoc(await tana.node(docId, true)); } catch (e) { noteGone(docId, e); return loadRoots(); } // deleted or unreadable: the lists decide
  deletedIds.delete(docId); // it answered, so it is not gone: an undo of a delete brings the rows and the chips back
  patchCopies(docId, { text: fresh.text, title: fresh.title, done: fresh.done, stateType: fresh.stateType });
  // A task under Today's Tasks set to Waiting leaves it (main/timeline.js), which only a fresh build of the page says:
  // the Timeline in front of you is read again, wherever the change came from (⌘K here, another pane, the phone).
  const timeline = zoom?.docId === TIMELINE_PAGE ? kids.get(TIMELINE_PAGE) || [] : [];
  if (fresh.stateType === 'waiting' && timeline.some((n) => n.timeline?.today && (n.children || []).some((c) => c.id === docId))) await reload(TIMELINE_PAGE);
  if (extra.has(docId)) Object.assign(extra.get(docId), fresh);
  for (const s of views) for (const n of s.nodes) if (n.id === docId) Object.assign(n, fresh);
  // A zoomed page that lists documents — a saved search, a space — holds its rows in kids, not in any view, so a
  // change to one of them reached nothing here and the row kept the title, box and assignee it was drawn with.
  for (const rows of kids.values()) for (const n of rows || []) if (n.id === docId) Object.assign(n, fresh);
}
function removeStale(id) {
  deletedIds.add(id); // it stays known: copies of it elsewhere (a mention, a reference row) are drawn as gone, and nothing opens it
  searches = searches.filter((s) => s.id !== id); // a deleted saved search must leave the Cmd+K Searches group too
  repairHome(); // and if it was Home, the Library takes over rather than an id nothing can open
  invalidateNode(id); loadPins();
  loadRoots().then(render, showError);
}
if (tana.onRemoved) tana.onRemoved(removeStale);
// Main let go of these documents (the oldest reads past LIVE_ROWS, rows that left a list), so no change to them reaches
// this page any more, and an outline kept for one would stay as it was: reopened by ⌘[, a crumb or a pin, or expanded
// again, it showed the old text for good (#389). It is forgotten and read again the next time it is drawn, which
// subscribes it again; one on screen now is read again at once.
function forgetReleased(ids) {
  const list = Array.isArray(ids) ? ids : [];
  // On screen: the page itself, an outline drawn open (an expanded row or full reference, empty or not: render.js marks
  // its children with the outline's id), and one some row of which is drawn (a field's rows carry its id). A collapsed
  // row draws no outline, and reading it again would only subscribe what main has just let go of (#406 review).
  const drawn = new Set([...items.values()].filter((item) => item.node && item.node.id !== item.docId).map((item) => item.docId));
  for (const wrap of outline.querySelectorAll('.children[data-outline]')) drawn.add(wrap.dataset.outline);
  if (zoom) drawn.add(zoom.docId);
  const gone = new Set(list);
  releases++;
  for (const id of list) releasedDocs.set(id, releases); // a read begun before now that names one is not cached (nodes.js reload)
  // What goes stale: every outline of a released document, and every outline holding a copy of one, as a row it lists
  // (a space's documents) or as a reference (reference.node): its title and checkbox came with the read. Decided per
  // document: one drawn outline (its page, its body, a field's rows) means its fields are on screen with it, and a
  // choice field draws chips rather than rows, so all its outlines are read again (#406 review).
  const base = (key) => key.split('|')[0];
  const cites = (rows) => Array.isArray(rows) && rows.some((row) => row && (gone.has(row.id) || (row.reference && gone.has(row.reference.uri)) || cites(row.children)));
  const shownDocs = new Set([...drawn].map(base));
  for (const key of [...kids.keys()].filter((key) => gone.has(base(key)) || cites(kids.get(key)))) {
    // unforced: a row of it may be under the caret, and that render waits for the edit (#406 review); failed, the loading path asks again
    // A saved search with unsaved pill edits shows their preview, which a plain reload (its stored query) would replace.
    if (shownDocs.has(base(key))) { if (searchRows.delete(key)) previewRows(key); else reload(key).then(() => renderSoon(), () => { kids.delete(key); renderSoon(); }); }
    else if (!isSearchDoc({ id: key }) && !isTypeDoc({ id: key })) kids.delete(key); // those run their query again on every arrival (edit.js noteNavigation)
  }
  // The sidebar read of such a page, of a page whose meeting or space it was (pinHub), or of one that lists it in a
  // section (a pin, an outcome, a reference, a backlink) is read again on the next visit, keeping the old one on screen
  // until then (renderer/rail.js relatedStale): what changed meanwhile would otherwise never show (#396, #406 review). A
  // read still out checks its own answer (rail.js loadRelated).
  const lists = (payload) => railGroups(payload).some(([, rows]) => (rows || []).some((row) => row && gone.has(row.id)));
  for (const [page, payload] of relatedBy) if (gone.has(page) || (payload && (gone.has(payload.pinHub) || lists(payload)))) relatedStale.add(page);
}
if (tana.onReleased) tana.onReleased(forgetReleased);
tana.onStatus(showStatus);
// Another page, window or machine changed a setting: take the new set and apply it where it is already on screen.
// Everything a preference feeds is visible from here, which is why the applying lives in this file and not beside
// the store. Nothing here writes back: the change is already stored, and a write would bounce between the pages.
function applySettings(next) {
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
  railClosed.clear(); for (const key of pref('railClosed', [])) railClosed.add(key); // the Graph pane's, copied at load (renderer/rail.js)
  const nextTheme = themeChoice(pref('theme'));
  if (nextTheme !== themePref) showTheme(nextTheme);
  sensitiveLoading = null; loadSensitive().then(refreshSensitive); // the sensitive marks and the MCP switch are settings too, kept outside the preferences
  if (tana.mcpHidden) tana.mcpHidden().then((on) => { mcpHidden = !!on; }, () => {});
  loadFilters(); // and so are the views' filters, the agent marks and the watch choices (main/settings.js tellOthers)
  // a mark or a task that moved asks for the task's state too, or its badge waits pending for the 30 s poll;
  // only then, since that read starts a Codex app-server child. Both: another machine writes the mark before the task.
  const before = JSON.stringify([[...agentIds].sort(), [...agentTasks].sort()]);
  agentLoading = null;
  Promise.all([loadAgentIds(), tana.agentTasks ? tana.agentTasks() : {}]).then(([, links]) => {
    const next = JSON.stringify([[...agentIds].sort(), Object.entries(links || {}).sort()]);
    if (next !== before) loadAgentStates();
  }, () => {});
  loadAgentList(); // which agents are on, and the default, are settings too (Choose agents …)
  notifyById.clear();
  renderSoon();
}
// settings:changed is not kept for a page that is not listening yet, and the first connect's read of the settings
// document can land while this one is still loading: whatever changed since preload's snapshot is asked for once more.
// A key changed here while the answer was on its way is newer than it and keeps the page's value; the rest applies.
function catchUpSettings() {
  const asked = JSON.parse(JSON.stringify(prefs));
  return tana.prefsNow().then((now) => {
    const next = { ...now };
    for (const key of new Set([...Object.keys(asked), ...Object.keys(prefs)])) {
      if (JSON.stringify(prefs[key]) === JSON.stringify(asked[key])) continue;
      if (key in prefs) next[key] = prefs[key]; else delete next[key];
    }
    if (JSON.stringify(next) !== JSON.stringify(prefs)) applySettings(next);
  }, () => {});
}
if (tana.onSettings) tana.onSettings(applySettings);
if (tana.prefsNow) catchUpSettings();
if (tana.onSystemTheme) tana.onSystemTheme((t) => { if (themePref === 'system') applyTheme(t); }); // macOS appearance changes re-theme a running window
if (themePref === 'system') showTheme('system');
loadAgentStates(); // what each linked agent task is doing: at boot, then on the 30 s timer below and when a link moves
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
// What an agent's task is doing is the agent's, so no live query carries it: read every 30 s, as it was when the
// refresh loop still ran that often (main.js), and only while something is handed to the agent at all.
setInterval(() => { if (agentIds.size) loadAgentStates(); }, 30000);
if (tana.mcpHidden) tana.mcpHidden().then((on) => { mcpHidden = !!on; }, () => {}); // Cmd+K only: the rows themselves are filtered in main
tana.status().then(showStatus, showError);
