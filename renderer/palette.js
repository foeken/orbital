'use strict';
// Cmd+K commands and Cmd+S search, hidden items, creation, results, and the shortcut recorder.

// ---- palette: Cmd+K commands (Views, Actions, matching Documents while typing) or Cmd+S live search (api.search) ----
const palette = $('palette'), palInput = $('paletteInput'), palList = $('paletteList');
let palMode = 'cmd', palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer, creationChoices = [];
let palEnter = null; // an Enter pressed while a search was still running: 'pick' or 'create', applied when the rows land
// Enter chooses: the highlighted row, or for an @ selection ⌘↩ always creates. While the search is still out, the
// choice is kept and made the moment the rows arrive, so the first Enter after "@" is never lost.
function chooseRow(create) {
  if (palBusy && (palMode === 'spaces' || palMode === 'search')) { palEnter = create ? 'create' : 'pick'; return; }
  const r = create && linkCtx ? palRows.find((row) => row.create) : palRows[palIndex];
  if (r) runRow(r);
}
function settleEnter() { if (palEnter) { const create = palEnter === 'create'; palEnter = null; chooseRow(create); } }
// hint defaults to the node's own meta, so a meeting keeps its date and time in every palette list
const docRow = (n, hint, run) => ({ node: n, icon: n.icon, label: n.text ?? n.title, tags: visibleTags(n), hint: hint === undefined ? n.meta : hint, run });
// The order of the rows about the node you are on: where it goes (open it, unfold it), what it is (done, status,
// assignee), where it lives (pins, the date nodes, its space), what it looks like (image, visibility, sensitivity),
// its link, and last the one destructive row. Rows without an id carry a `rank` from this list instead.
const NODE_ROW_ORDER = ['zoomIn', 'expand', 'collapse', 'toggleDone', 'status', 'assign', 'assignTo', 'pinSidebar', 'pinToday', 'addToday', 'addWeek', 'move', 'moveLibrary', 'visibility', 'sensitive', 'copyLink', 'delete'];
const nodeRank = (r) => { const i = NODE_ROW_ORDER.indexOf(r.rank || r.id); return i < 0 ? NODE_ROW_ORDER.length : i; };
const VIEW_ORDER = ['inbox', 'today', 'week', 'tasks', 'meetings', 'people', 'chats', 'library'];
// Matching a row, tiered the way Raycast ranks a title (its manual: aliases first, then the title's fuzzy score, which
// favours the first letters of words). Best first:
//   0  the label starts with the query      "in"    → **In**box
//   1  the first words' initials, in a row   "mti"   → **M**ove **t**o **I**nbox ("mtinb" too)
//   2  the query starts a later word         "in"    → Zoom **in**
//   3  word-prefix chunks that skip words    "moinb" → **Mo**ve to **Inb**ox
//   4  a substring inside a word             "in"    → P**in** to sidebar
//   5  the letters in order, the first one starting a word ("inbx" → **Inb**o**x**), Raycast's "msg" → Messages;
//      a first letter in the middle of a word would let nearly every long title in
// The matched character positions come back so the label can show them in bold, with the tier as `rank` on that
// array. null when the row is out.
function fuzzyMatch(label, q) {
  const ranked = (at, rank) => Object.assign(at, { rank }), span = (from) => Array.from({ length: q.length }, (_, i) => from + i);
  if (!q) return ranked([], 0);
  const lower = label.toLowerCase();
  if (lower.startsWith(q)) return ranked(span(0), 0);
  const starts = []; for (let i = 0; i < lower.length; i++) if (/[\p{L}\p{N}]/u.test(lower[i]) && (i === 0 || !/[\p{L}\p{N}]/u.test(lower[i - 1]))) starts.push(i);
  const rec = (qi, wi) => {
    if (qi === q.length) return [];
    for (let w = wi; w < starts.length; w++) {
      const s = starts[w], end = w + 1 < starts.length ? starts[w + 1] : lower.length;
      for (let n = Math.min(q.length - qi, end - s); n >= 1; n--) {
        if (!lower.startsWith(q.slice(qi, qi + n), s)) continue;
        const rest = rec(qi + n, w + 1);
        if (rest) return [...Array.from({ length: n }, (_, i) => s + i), ...rest];
      }
    }
    return null;
  };
  const chunks = rec(0, 0);
  // the words the chunks start in: 0, 1, 2, … is the initials tier
  const words = chunks && chunks.filter((p, i) => i === 0 || p !== chunks[i - 1] + 1).map((p) => starts.indexOf(p));
  if (words && words.every((w, i) => w === i)) return ranked(chunks, 1);
  const wordAt = starts.find((s) => lower.startsWith(q, s));
  if (wordAt !== undefined) return ranked(span(wordAt), 2);
  if (chunks) return ranked(chunks, 3);
  const at = lower.indexOf(q);
  if (at >= 0) return ranked(span(at), 4);
  for (const s of starts) {
    if (lower[s] !== q[0]) continue;
    const letters = [s];
    for (let i = s + 1; i < lower.length && letters.length < q.length; i++) if (lower[i] === q[letters.length]) letters.push(i);
    if (letters.length === q.length) return ranked(letters, 5);
  }
  return null;
}
// Rows that open a second level carry `sub`, the rows of that level, and every choice is offered as one row of its
// own: "Move to …" + "Foundry" → "Move to Foundry", so "mtf" reaches it without going down a level (paletteRows
// decides when a level is loaded).
const subCache = new Map();
const subBase = (row) => row.subBase || row.label.replace(/\s*…$/, '');
function subRowsFor(row) {
  const key = row.id || row.rank || row.label;
  if (!subCache.has(key)) {
    subCache.set(key, null);
    Promise.resolve().then(row.sub).then((rows) => { subCache.set(key, rows); if (palMode === 'cmd' && !palette.hidden) renderPalette(); }, (e) => { subCache.delete(key); showError(e); });
  }
  const kids = subCache.get(key);
  if (!kids) return [];
  const base = subBase(row);
  return kids.filter((k) => k.label && !k.disabled).map((k) => ({ ...k, id: undefined, sub: undefined, group: row.group, icon: k.icon || row.icon, label: base + ' ' + k.label }));
}
// With a query the closest matches come first ("in": Inbox before Zoom in): rows sort by match tier, then by where the
// match starts, else keep their place. A group moves as a whole to where its best row lands, so every heading shows
// once, and groups that match equally well keep the fixed order.
function rankRows(rows) {
  const cmp = (a, b) => a.match.rank - b.match.rank || a.match[0] - b.match[0];
  const best = new Map(), first = new Map();
  rows.forEach((r, i) => { if (!first.has(r.group)) first.set(r.group, i); if (!best.has(r.group) || cmp(r, best.get(r.group)) < 0) best.set(r.group, r); });
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.group === b.r.group ? cmp(a.r, b.r) || a.i - b.i : cmp(best.get(a.r.group), best.get(b.r.group)) || first.get(a.r.group) - first.get(b.r.group)))
    .map(({ r }) => r);
}
function paletteRows(q) {
  const selection = selectionRows();
  const rows = [...selection];
  // What acts on the current document (pins, link, icon, visibility, location) sits with the rest of its rows under
  // "Current node"; while a multi-selection owns the top of the palette these fall back among the app actions.
  const docGroup = selection.length && selection[0].group === 'Selection' ? 'Actions' : 'Current node';
  if (pinInfo && palDoc && pinInfo.docId === palDoc.id) { // no ids: their labels depend on state, so no hotkeys
    const sb = pinInfo.sidebar, td = pinInfo.dates.includes(localDate());
    rows.push({ rank: 'pinSidebar', group: docGroup, icon: 'pin', label: sb ? 'Unpin from sidebar' : 'Pin to sidebar', run: () => pinAction(sb ? 'unpin' : 'pin', 'sidebar') });
    rows.push({ rank: 'pinToday', group: docGroup, icon: 'pinDate', label: td ? 'Unpin from today' : 'Pin to today', run: () => pinAction(td ? 'unpin' : 'pin', 'today') });
  }
  // the node's web link, for pasting into Slack or a doc
  if (palDoc && tana.nodeLink && isRealId(palDoc.id)) {
    rows.push({ id: 'copyLink', group: docGroup, icon: 'link', label: 'Copy link', run: () => run(async () => copyText(await tana.nodeLink(palDoc.id), 'Link copied')) });
  }
  if (palDoc && tana.accessOptions) {
    loadAccess(palDoc.id);
    const access = accessById.get(palDoc.id);
    if (access?.sharing) rows.push({ rank: 'visibility', group: docGroup, icon: 'lock', label: 'Edit visibility', run: () => openVisibilityPalette(palDoc), sub: () => visibilityRows('') });
    if (access?.move) { // Library is a row of its own and the spaces are the folded level of "Move to …"; the Inbox is Set status to Inbox
      const doc = palDoc;
      rows.push({ rank: 'move', group: docGroup, icon: 'space', label: 'Move to …', keepOpen: true, subAlways: true, run: () => openMovePalette(doc), sub: () => moveTargets(doc) });
      if (access.ownerUri) rows.push({ rank: 'moveLibrary', group: docGroup, icon: 'library', label: 'Move to Library', keepOpen: true, run: () => { openMovePalette(doc); previewMoveToSpace(doc, { id: 'library', text: 'Library' }); } });
    }
  }
  // only node rows so far: the selection's rows first, then (with a multi-selection) the document's own, each in NODE_ROW_ORDER
  rows.sort((a, b) => (a.group === 'Selection' ? 0 : 1) - (b.group === 'Selection' ? 0 : 1) || nodeRank(a) - nodeRank(b));
  // Views, in the order of a day: what came in, today, this week, then the kinds, and the whole library last. Today's
  // node (titled with the date, pinned to today) and the week's ("Week 38 (2026)") are documents created on demand,
  // but places to go all the same, so they sit here.
  const viewRows = views.map((s) => ({ id: 'view:' + s.id, group: 'Views', icon: s.icon, label: s.title, run: () => setView(s.id) }));
  if (tana.todayNode) viewRows.push({ id: 'today', group: 'Views', icon: 'today', label: 'Today', run: () => run(async () => goTo(await tana.todayNode())) });
  if (tana.weekNode) viewRows.push({ id: 'week', group: 'Views', icon: 'week', label: 'This week', run: () => run(async () => goTo(await tana.weekNode())) });
  const viewRank = (r) => { const i = VIEW_ORDER.indexOf(r.id.replace(/^view:/, '')); return i < 0 ? VIEW_ORDER.length : i; };
  rows.push(...viewRows.sort((a, b) => viewRank(a) - viewRank(b)));
  // Saved searches are places too: their own heading, under the views, each opening the search document
  rows.push(...searches.map((s) => ({ id: 'search:' + s.id, group: 'Searches', icon: 'search', label: s.text || s.title || 'Untitled search', run: () => goTo(s.id) })));
  rows.push(...pillCommandRows());
  if (!zoom) rows.push({ id: 'filter', group: 'View options', icon: 'filter', label: 'Filter rows by text', run: () => { filterShown = true; render(); filterEl.focus(); } });
  // Actions: getting in first, then making and finding things, moving around, undoing, and last the app's own settings
  if (signedOut) rows.push({ id: 'login', group: 'Actions', label: 'Log in to Tana', run: () => tana.login().catch(showError) });
  if (tana.creationOptions) rows.push({ id: 'create', group: 'Actions', icon: 'createNew', label: 'Create new…', keepOpen: true, run: openCreationPalette, sub: async () => { creationChoices = (await tana.creationOptions()).options || []; return creationRows(''); } });
  // the keys the outline answers to, as rows: each has a default combo in DEFAULT_HOTKEYS and can be re-recorded
  rows.push({ id: 'search', group: 'Actions', icon: 'search', label: 'Search Tana', keepOpen: true, run: () => togglePalette('search') });
  rows.push({ id: 'back', group: 'Actions', icon: 'back', label: 'Go back', disabled: !navBack.length, run: () => navigate(-1) });
  rows.push({ id: 'forward', group: 'Actions', icon: 'forward', label: 'Go forward', disabled: !navForward.length, run: () => navigate(1) });
  if (!railEl.hidden) rows.push({ id: 'rail', group: 'Actions', icon: 'rail', label: 'Focus the sidebar', run: () => focusRail() });
  // Always reachable, unlike "Focus the sidebar" above: once the sidebar is hidden there would otherwise be no way back to it.
  if (!railToggle.hidden) rows.push({ id: 'railToggle', group: 'Actions', icon: railHidden ? 'railShow' : 'railHide', label: railHidden ? 'Show sidebar' : 'Hide sidebar', run: () => toggleRail() });
  rows.push({ id: 'undo', group: 'Actions', icon: 'undo', label: 'Undo', run: () => history('undo') });
  rows.push({ id: 'redo', group: 'Actions', icon: 'redo', label: 'Redo', run: () => history('redo') });
  rows.push({ id: 'sync', group: 'Actions', icon: 'sync', label: 'Sync', run: () => run(() => tana.refresh()) });
  // the list of titles hidden from every view and from search, edited in the palette itself
  if (tana.filters) rows.push({ id: 'hidden', group: 'Actions', icon: 'hiddenItems', label: 'Edit hidden items', keepOpen: true, run: openHiddenPalette });
  if (tana.sensitiveIds) rows.push({ id: 'sensitiveVisibility', group: 'Actions', icon: 'hidden', label: 'Toggle sensitive visibility', hint: sensitiveVisible ? 'Shown' : 'Hidden', run: toggleSensitiveVisibility });
  // text size stays on the fixed keys (their characters depend on the keyboard layout), so the chips are literal
  rows.push({ id: 'textLarger', group: 'Actions', icon: 'textLarger', label: 'Larger text', kbd: '⇧⌘+', run: () => setZoom(zoomFactor * 1.1) });
  rows.push({ id: 'textSmaller', group: 'Actions', icon: 'textSmaller', label: 'Smaller text', kbd: '⇧⌘-', run: () => setZoom(zoomFactor / 1.1) });
  rows.push({ id: 'textReset', group: 'Actions', icon: 'textReset', label: 'Reset text size', kbd: '⌘0', run: () => setZoom(BASE_ZOOM) });
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  rows.push({ id: 'theme', group: 'Actions', icon: 'darkLight', label: 'Toggle ' + (dark ? 'light' : 'dark') + ' mode', run: () => setTheme(dark ? 'light' : 'dark') });
  if (tana.systemTheme) rows.push({ id: 'systemTheme', group: 'Actions', icon: 'darkLight', label: 'Toggle system dark/light mode', hint: themePref === 'system' ? 'Following macOS' : '', run: () => followSystem(themePref !== 'system') });
  if (q) for (const s of views) for (const n of s.nodes) rows.push({ ...docRow(n, n.meta || s.title, () => openDoc(n.id)), id: 'doc:' + n.id, group: 'Documents' });
  // A second level is folded in once the query's first two letters reach its row, as a prefix or as the first words'
  // initials ("mo" or "mt" for Move to …, "as" or "at" for Assign to), and loaded once per palette opening. The spaces
  // and the four statuses are short fixed lists, so "Move to …" and "Set status" (`subAlways`) load them as the palette
  // opens and fold them in for any query: "inb" reaches Set status to Inbox, "foun" Move to Foundry.
  for (const r of rows.filter((r) => r.sub && ((r.subAlways && !palette.hidden) || (q.length >= 2 && fuzzyMatch(subBase(r), q.slice(0, 2))?.rank <= 1)))) {
    const kids = subRowsFor(r);
    if (q) rows.splice(rows.indexOf(r) + 1, 0, ...kids);
  }
  const seen = new Set(), key = (r) => r.id || r.group + '\n' + r.label; // a document listed by several views, or a folded choice that reads like its parent, once
  let matched = rows.map((r) => ({ ...r, match: fuzzyMatch(r.label, q) })).filter((r) => r.match && !seen.has(key(r)) && seen.add(key(r)));
  if (q) matched = rankRows(matched);
  let docsLeft = 8; // the best eight documents, now that they are ranked
  return matched.filter((r) => r.group !== 'Documents' || docsLeft-- > 0).map((r) => { const k = r.id && hotkeyFor(r.id); return k ? { ...r, kbd: k } : r; });
}
// a hotkey, recorded or default, runs its palette row's action (views/sync/login by id; documents wherever they live);
// false when no such row exists right now, so the key can fall through to whatever else it means
function runAction(id) {
  if (palette.hidden) palDoc = currentDoc(); // a key fires with the palette closed, so the "current node" is whatever is focused now
  const row = paletteRows('').find((r) => r.id === id);
  if (row && !row.disabled) { row.run(); return true; }
  if (id.startsWith('doc:')) { goTo(id.slice(4)); return true; }
  return false;
}
// Cmd+K renders the exact same rows as the header pill. Multi-select rows stay here; a single choice returns to commands.
function pillRows(q) {
  const def = (pillsApply() ? pillDefs() : []).find((item) => item.id === pillCtx);
  return def ? pillRowsFor(def, q) : [];
}
function pillRowsFor(def, q) {
  if (!def?.rows) return [];
  let group = pillName(def);
  return def.rows().flatMap((row) => {
    if (row.head) { group = row.head; return []; }
    if (!row.label || !fuzzyMatch(row.label, q)) return [];
    return [{ group, icon: row.icon, label: row.label, hint: row.checked ? '✓' : '', keepOpen: true, run: () => {
      row.run();
      if (row.keepOpen) renderPalette(); else openCommandPalette();
    } }];
  });
}
function openPillPalette(id) {
  pillCtx = id; palMode = 'pill'; palRows = []; palIndex = 0;
  palInput.placeholder = 'Choose ' + id; palInput.value = ''; renderPalette(); palInput.focus();
}
function openCommandPalette() {
  pillCtx = null; palMode = 'cmd'; palRows = []; palIndex = 0;
  palInput.placeholder = 'Search or run a command'; palInput.value = ''; renderPalette(); palInput.focus();
}
function backPalette() {
  if (palMode === 'pill') openCommandPalette();
  else if (palMode === 'visibilityPeople') openVisibilityPalette(palDoc);
  else closePalette();
}
// ---- hidden items (api.filters): titles every view and search skips, edited from Cmd+K ----
// The rule lives in the group header because that is the one line in the palette that wraps.
const HIDDEN_GROUP = 'Hidden items · whole title, case-insensitive; end with * to match a prefix';
let hiddenList = null; // null while api.filters() is in flight
const hiddenApply = (call) => run(async () => { hiddenList = await call(); renderPalette(); }); // resolves once the views have refreshed
function hiddenRows(q) {
  const rows = (hiddenList || []).filter((pattern) => pattern.toLowerCase().includes(q.toLowerCase()))
    .map((pattern) => ({ group: HIDDEN_GROUP, icon: 'any', label: pattern, hint: (pattern.endsWith('*') ? 'Prefix' : 'Exact') + ' · ↩ unhides', keepOpen: true, run: () => hiddenApply(() => tana.removeFilter(pattern)) }));
  if (q) rows.unshift({ group: HIDDEN_GROUP, icon: 'createNew', label: 'Hide "' + q + '"', hint: q.endsWith('*') ? 'Prefix' : 'Exact', keepOpen: true, run: () => { palInput.value = ''; hiddenApply(() => tana.addFilter(q)); } });
  if (!rows.length) rows.push({ group: HIDDEN_GROUP, label: hiddenList ? 'Nothing is hidden yet' : 'Loading…', disabled: true });
  return rows;
}
function openHiddenPalette() {
  palMode = 'hidden'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Type a title to hide'; palInput.value = '';
  hiddenList = null; renderPalette(); palInput.focus();
  hiddenApply(() => tana.filters());
}
function creationRows(q) {
  if (palBusy) return [{ group: 'Create new', label: 'Loading choices…', disabled: true }];
  return creationChoices.filter((choice) => fuzzyMatch(choice.title, q)).map((choice) => ({ group: choice.kind === 'custom' ? 'Workspace types' : 'Create new', icon: choice.icon, hue: choice.hue, label: choice.title, hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable, keepOpen: true, run: () => startCreation(choice) }));
}
function openCreationPalette() {
  palMode = 'create'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Choose what to create'; palInput.value = ''; renderPalette(); palInput.focus();
  loadCreationChoices();
}
// the create choices feed both the Cmd+K "Create new…" list and the "/" menu
function loadCreationChoices() {
  if (!tana.creationOptions) return;
  const seq = ++palSeq, mode = palMode; palBusy = true;
  tana.creationOptions().then((result) => {
    if (seq !== palSeq || palMode !== mode) return;
    creationChoices = result.options || []; palBusy = false; renderPalette();
  }, (e) => { if (seq === palSeq && palMode === mode) { palBusy = false; showError(e); renderPalette(); } });
}
function creationSection(choice) {
  const id = choice.kind === 'task' ? 'tasks' : choice.kind === 'meeting' || choice.appliesTo === 'events' ? 'meetings' : choice.kind === 'chat' ? 'chats' : 'library';
  return views.find((section) => section.id === id) || viewOf();
}
function startCreation(choice) {
  const section = creationSection(choice), tags = choice.kind === 'custom' ? [{ label: choice.title, hue: choice.hue }] : undefined;
  const node = draftDocNode(choice.kind, { typeUri: choice.typeUri, icon: choice.icon, tags });
  section.nodes.unshift(node); view = section.id; localStorage.setItem('view', view);
  closePalette(); zoom = { docId: node.id, nodeId: null }; render(); setCaret(titleEl, 0);
  loadView(view); // the target view may not have fetched its rows yet
}
// search result / pin: zoom into it wherever it lives (api.node shape -> extra); from = breadcrumb root when not opened in its view
function openResult(n, from) {
  if (!allDocs().some((d) => d.id === n.id)) extra.set(n.id, asDoc(n));
  openDoc(n.id, from);
}
// result rows pick a document: open it, or link it when the palette was opened with "@" on a selection (Create row first)
function resultRows(nodes, group) {
  nodes = nodes.map(asDoc);
  const ctx = linkCtx, pin = pinCtx;
  const rows = nodes.map((n) => ({ ...docRow(n, n.meta, () => (ctx ? linkTo(ctx, { label: n.title ?? n.text, uri: n.id }) : pin ? pinResult(pin, n) : openResult(n, 'Search'))), group }));
  if (!ctx) return rows;
  const title = ctx.text || palInput.value.trim(); // "@" at a caret has no selection: what is typed becomes the new document's title
  if (!title) return rows;
  return [{ create: true, label: 'Create “' + title + '”', hint: '⌘↩', run: () => createAndLink(ctx, title) }, ...rows];
}
function pinResult(ctx, node) {
  return run(async () => {
    await tana.pinTo(ctx.pinHub, node.id);
    relatedBy.delete(ctx.pinHub); relatedBy.delete(ctx.docId); render();
  });
}
// The typed words a search result's title holds (#type filters left out): their positions, for the bold letters, with
// `hits` (words found) and `starts` (how many of those begin a word) on the array.
function titleHits(title, q) {
  const lower = title.toLowerCase(), at = [];
  let hits = 0, starts = 0;
  for (const term of q.toLowerCase().split(/\s+/)) {
    if (!term || term.startsWith('#')) continue;
    const first = lower.indexOf(term);
    if (first < 0) continue;
    let i = first;
    while (i > 0 && /[\p{L}\p{N}]/u.test(lower[i - 1])) i = lower.indexOf(term, i + 1); // the first place it begins a word, if any
    hits++; if (i >= 0) starts++;
    for (let k = 0; k < term.length; k++) at.push((i >= 0 ? i : first) + k);
  }
  return Object.assign(at, { hits, starts });
}
function searchNow() {
  const q = palInput.value.trim(), seq = ++palSeq;
  palTimer = null; palBusy = !!q;
  if (!q) { palRows = resultRows(recentRows(), 'RECENTLY VIEWED'); return renderPalette(); }
  tana.search(q).then((found) => {
    if (seq !== palSeq || palMode !== 'search') return; // stale response
    // Tana's order does not weigh the title: a document that only mentions the words in its body can lead one titled
    // with them. The titles holding the most typed words come first, then those where more of them begin a word, and
    // Tana's order among equals. Only those words are bold, not the looser Cmd+K letter match.
    const score = new Map(found.map((n) => [n, titleHits(n.title ?? n.text ?? '', q)]));
    const nodes = found.map((n, i) => ({ n, i })).sort((a, b) => score.get(b.n).hits - score.get(a.n).hits || score.get(b.n).starts - score.get(a.n).starts || a.i - b.i).map(({ n }) => n);
    palRows = resultRows(nodes).map((row) => (row.node ? { ...row, match: titleHits(row.label ?? '', q) } : row));
    // Linking: a result is only the obvious choice when its title starts with what was typed. A full-text hit
    // that merely mentions the words is not, so "Create" stays selected and Enter creates.
    const starts = nodes.findIndex((n) => (n.title ?? n.text ?? '').toLowerCase().startsWith(q.toLowerCase()));
    palIndex = linkCtx ? (starts < 0 ? 0 : starts + (palRows[0] && palRows[0].create ? 1 : 0)) : 0;
    palBusy = false;
    renderPalette();
    settleEnter();
  }, showError);
}
function renderPalette() {
  const q = palInput.value.trim();
  if (palMode === 'cmd') palRows = paletteRows(q.toLowerCase());
  else if (palMode === 'create') palRows = creationRows(q.toLowerCase());
  else if (palMode === 'slash') palRows = slashRows(q.toLowerCase());
  else if (palMode === 'assignees') palRows = assigneeRows(q.toLowerCase());
  else if (palMode === 'assigneesMany') palRows = manyAssigneeRows(q.toLowerCase());
  else if (palMode === 'status') palRows = statusRows(q.toLowerCase());
  else if (palMode === 'visibility') palRows = visibilityRows(q.toLowerCase());
  else if (palMode === 'visibilityPeople') palRows = visibilityPeopleRows(q.toLowerCase());
  else if (palMode === 'hidden') palRows = hiddenRows(q);
  else if (palMode === 'pill') palRows = pillRows(q.toLowerCase());
  palIndex = Math.max(0, Math.min(palIndex, palRows.length - 1));
  const els = [];
  palRows.forEach((r, i) => {
    if (r.group && (!i || palRows[i - 1].group !== r.group)) { const h = document.createElement('div'); h.className = 'group'; h.textContent = r.group; els.push(h); }
    const row = document.createElement('div'); row.className = 'row' + (i === palIndex ? ' active' : '') + (r.disabled ? ' disabled' : ''); row.dataset.index = i;
    const icon = document.createElement('span'); icon.className = 'ricon' + (r.node ? ' ' + (r.icon || 'dot') : ''); icon.innerHTML = r.icon ? iconSvg(r.icon) : '';
    const rowHue = r.node ? r.node.hue : r.hue; // documents and "Create new…" type choices both carry the type hue
    if (rowHue != null) { icon.classList.add('hue'); icon.style.setProperty('--hue', String(rowHue)); }
    const label = document.createElement('span'); label.className = 'label';
    const match = r.match || (q ? fuzzyMatch(r.label, q.toLowerCase()) : null); // every level: the letters the query matched, in bold
    if (match && match.length) {
      const hit = new Set(match); let run = '', bold = false;
      const flushRun = () => { if (!run) return; if (bold) { const b = document.createElement('b'); b.textContent = run; label.append(b); } else label.append(run); run = ''; };
      for (let i = 0; i < r.label.length; i++) { if (hit.has(i) !== bold) { flushRun(); bold = hit.has(i); } run += r.label[i]; }
      flushRun();
    } else label.textContent = r.label;
    for (const t of r.tags || []) label.append(chipEl(t, r.node && r.node.hue));
    blurSensitive(label, r.node && r.node.id);
    row.append(icon, label);
    if (r.right) { const s = document.createElement('span'); s.className = 'ricon right'; s.innerHTML = iconSvg(r.right); row.append(s); }
    if (r.kbd) { const k = document.createElement('kbd'); k.textContent = r.kbd; row.append(k); }
    if (r.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = r.hint; blurSensitive(h, r.node && r.node.id); row.append(h); }
    row.onmousedown = (e) => e.preventDefault();
    row.onclick = () => runRow(r);
    els.push(row);
  });
  if (!palRows.some((r) => palMode === 'cmd' || palMode === 'slash' || palMode === 'hidden' || r.node) && (palMode === 'cmd' || palMode === 'slash' || (q && !palBusy))) { const n = document.createElement('div'); n.className = 'group'; n.textContent = 'No results'; els.push(n); }
  palList.replaceChildren(...els);
  const active = palList.querySelector('.row.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
// opens the palette in mode, closes it when already open in that mode; opening one mode closes the other.
// link = @ linking context; pin = relationship pin context. Both reuse search results.
function togglePalette(mode, link, pin) {
  const show = palette.hidden || palMode !== mode || !!link || !!pin;
  cancelLink(); pinCtx = null; pillCtx = null;
  palette.hidden = !show;
  if (!show) { clearTimeout(palTimer); palTimer = null; return returnFocus(); }
  if (!palReturn) palReturn = focused(); // switching modes keeps the original return target
  linkCtx = link || null;
  anchorPalette(link && link.rect);
  pinCtx = pin || null;
  if (mode !== 'slash') slashCtx = null;
  palMode = mode; palRows = []; palIndex = 0; palBusy = false; palEnter = null; clearTimeout(palTimer); palTimer = null;
  if (mode === 'cmd') { palDoc = currentDoc(); palTaskCtx = null; loadPins(); subCache.clear(); }
  palInput.placeholder = mode === 'search' ? 'Search Tana' : mode === 'slash' ? 'Choose a block type or create' : 'Search or run a command';
  palInput.value = link ? link.text : '';
  if (mode === 'search') searchNow(); else renderPalette();
  palInput.focus();
}
// @ linking opens the search as a dropdown at the text it links, like Tana's own: no scrim, a smaller card under the
// caret (above it when the window has more room there). Every other mode keeps the centred card.
function anchorPalette(rect) {
  const card = palette.querySelector('.card');
  palette.classList.toggle('anchored', !!rect);
  card.style.cssText = '';
  if (!rect) return;
  const width = Math.min(440, innerWidth - 16), below = innerHeight - rect.bottom - 14, above = rect.top - 14;
  const up = below < 240 && above > below;
  card.style.width = width + 'px';
  card.style.left = Math.max(8, Math.min(innerWidth - width - 8, rect.left - 8)) + 'px';
  card.style.maxHeight = Math.min(360, up ? above : below) + 'px';
  if (up) card.style.bottom = (innerHeight - rect.top + 6) + 'px'; else card.style.top = (rect.bottom + 6) + 'px';
}
function closePalette() { palette.hidden = true; clearTimeout(palTimer); palTimer = null; cancelLink(); pinCtx = null; pillCtx = null; returnFocus(); }
// back to the node that had the caret when the palette opened (the @ link path places its own caret); with nothing to
// return to (a row selection, the sidebar) the hidden input must not keep the keys, so it lets go of the focus
function returnFocus() { const r = palReturn; palReturn = null; if (r && !focused()) placeCaret(r.key, r.offset); else if (document.activeElement === palInput) palInput.blur(); }
function runRow(r) { if (!r || r.disabled) return; if (!r.keepOpen) closePalette(); r.run(); }
// Up/Down step over rows that cannot run (info lines, unavailable choices) so the keyboard never lands on a dead row
function nextPalIndex(rows, index, step) {
  const n = rows.length;
  for (let i = 1; i <= n; i++) { const next = ((index + step * i) % n + n) % n; if (!rows[next].disabled) return next; }
  return index;
}
palInput.addEventListener('input', () => {
  palIndex = 0; palEnter = null; // typing on supersedes an Enter that was waiting for the previous query
  if (palMode === 'cmd' || palMode === 'create' || palMode === 'slash' || palMode === 'assignees' || palMode === 'assigneesMany' || palMode === 'status' || palMode === 'visibility' || palMode === 'visibilityPeople' || palMode === 'hidden' || palMode === 'pill') return renderPalette();
  if (palMode === 'spaces') { palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchSpacesNow, 150); return; }
  palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchNow, 150);
});
palInput.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backPalette(); }
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && palRows.length) { e.preventDefault(); e.stopPropagation(); palIndex = nextPalIndex(palRows, palIndex, e.key === 'ArrowDown' ? 1 : -1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); chooseRow(mod); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); const r = palRows[palIndex]; if (palMode === 'cmd' && r && r.id) openRecorder(r); }
});
palette.addEventListener('mousedown', (e) => { if (e.target === palette) closePalette(); });

// ---- hotkeys: Cmd+Shift+K on a Cmd+K row records a combo (localStorage "hotkeys"); the outline dispatches it ----
const KEYNAMES = { Enter: '↩', Backspace: '⌫', Tab: '⇥', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space' };
// "⌃⌥⇧⌘" + key ("M", "1", "↩"); modifiers alone while only they are pressed
function comboOf(e) {
  const mods = (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '');
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return mods;
  return mods + (/^(Key|Digit)/.test(e.code) ? e.code.slice(-1) : KEYNAMES[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key));
}
const validCombo = (c) => /[⌘⌃]/.test(c) && c.replace(/[⌃⌥⇧⌘]/g, '') !== ''; // ⌘ or ⌃ plus a key, so typing is never hijacked
// Combos the outline keydown handler answers to before it looks at hotkeys, so a shortcut on one of them would
// never fire. That handler treats ⌃ like ⌘ and ignores ⌥, which the normalisation in comboTaken mirrors.
// Only what is fixed in the handlers is listed here; everything else the outline answers to is a row with a default
// combo (DEFAULT_HOTKEYS), which comboTaken reports as taken by that row.
const RESERVED = { '⌘K': 'opens the command palette', '⇧⌘K': 'records a shortcut', '⌘0': 'resets the text size', '⇧⌘+': 'makes the text larger', '⇧⌘=': 'makes the text larger', '⇧⌘-': 'makes the text smaller', '⇧⌘_': 'makes the text smaller', '⇧⌘⌫': 'deletes the node', '⇧⌘↑': 'moves the node or selection', '⇧⌘↓': 'moves the node or selection' };
// Why a combo cannot be saved for this row, or '' when it can: the app owns it, or another row already has it.
function comboTaken(combo, rowId) {
  const built = RESERVED[combo.replace(/[⌃⌥⌘]/g, '').replace(/^(⇧?)/, '$1⌘')];
  if (built) return combo + ' already ' + built;
  const other = hotkeyIds().find((id) => hotkeyFor(id) === combo && id !== rowId);
  if (!other) return '';
  const row = paletteRows('').find((r) => r.id === other), node = other.startsWith('doc:') && views.flatMap((s) => s.nodes).find((n) => n.id === other.slice(4));
  return combo + ' is already the shortcut for "' + (row ? row.label : node ? node.text : other.replace(/([A-Z])/g, ' $1').toLowerCase()) + '"'; // a row absent right now (Complete without a task) by its id, spelled out
}
const recorder = $('recorder');
let rec = null; // { row, combo }
function openRecorder(row) { rec = { row, combo: '' }; $('recTitle').textContent = row.label; recorder.hidden = false; showCombo(); }
function showCombo() {
  $('recKeys').replaceChildren(...(rec.combo.match(/[⌃⌥⇧⌘]|[^⌃⌥⇧⌘]+/g) || []).map((s) => { const k = document.createElement('span'); k.textContent = s; return k; }));
  const warn = validCombo(rec.combo) ? comboTaken(rec.combo, rec.row.id) : '';
  $('recWarn').textContent = warn; $('recWarn').hidden = !warn;
  $('recSave').disabled = !validCombo(rec.combo) || !!warn;
}
function closeRecorder() { rec = null; recorder.hidden = true; renderPalette(); palInput.focus(); }
const saveHotkeys = () => localStorage.setItem('hotkeys', JSON.stringify(hotkeys));
$('recReset').onclick = () => { delete hotkeys[rec.row.id]; saveHotkeys(); closeRecorder(); };
$('recCancel').onclick = closeRecorder;
$('recSave').onclick = () => { if (validCombo(rec.combo) && !comboTaken(rec.combo, rec.row.id)) { hotkeys[rec.row.id] = rec.combo; saveHotkeys(); closeRecorder(); } };
for (const b of recorder.querySelectorAll('button')) b.onmousedown = (e) => e.preventDefault(); // keep the keyboard focus where it is
document.addEventListener('keydown', (e) => { // capture: the recorder sees every key before the palette input does
  if (!rec) return;
  e.preventDefault(); e.stopPropagation();
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey; // plain keys drive the buttons (a combo needs ⌘/⌃ anyway)
  if (plain && e.key === 'Escape') return closeRecorder();
  if (plain && e.key === 'Enter') return $('recSave').click();
  if (plain && e.key === 'Backspace') return $('recReset').click();
  rec.combo = comboOf(e); showCombo();
}, true);
