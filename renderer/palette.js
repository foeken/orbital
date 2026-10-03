'use strict';
// Cmd+K commands and Cmd+S search, hidden items, creation, results, and the shortcut recorder.

// ---- palette: Cmd+K commands (Views, Actions; documents are Cmd+S live search, api.search) ----
const palette = $('palette'), palInput = $('paletteInput'), palText = $('paletteText'), palList = $('paletteList'), palKeyHint = $('paletteKeyHint');
let palMode = 'cmd', palPage = {}, palRows = [], palIndex = 0, palBusy = false, palSeq = 0, palTimer, creationChoices = [];
let palEnter = null; // an Enter pressed while a search was still running: { create, where }, applied when the rows land
let meetingNow; // the active meeting as last read: undefined = not asked this open, { meeting } or { error } after
let meetingList = null, pinMeetingDoc = null; // the meeting picker: loadList's answer, and the node being pinned
let todayPickerNode = null, todayPickerResults = null;
// Enter chooses: the highlighted row, or for an @ selection ⌘↩ always creates. While the search is still out, the
// choice is kept and made the moment the rows arrive, so the first Enter after "@" is never lost.
// where: ⌘↩ / ⇧↩ / ⌥↩ (or the same click, openRow) open a row that opens a place in a tab, a pane beside or a floating
// pane (`opens` an id, or a function finding one).
function chooseRow(create, where) {
  // the four pages whose rows main finds (the input listener below): an Enter there waits for the answer to what was typed
  if (palBusy && (palMode === 'spaces' || palMode === 'search' || palMode === 'pinToday' || palMode === 'setIcon')) { palEnter = { create, where }; return; }
  const r = create && linkCtx ? palRows.find((row) => row.create) : palRows[palIndex];
  openRow(r, where);
}
function openRow(r, where) {
  if (r && where && !linkCtx && r.opens && !r.disabled) { closePalette(); run(async () => openElsewhere(where, typeof r.opens === 'function' ? await r.opens() : r.opens)); }
  else if (r) runRow(r);
}
function settleEnter() { if (palEnter) { const { create, where } = palEnter; palEnter = null; chooseRow(create, where); } }
// hint defaults to the node's own meta, so a meeting keeps its date and time in every palette list
const docRow = (n, hint, run) => ({ node: n, icon: n.icon, label: n.text ?? n.title, tags: visibleTags(n), hint: hint === undefined ? n.meta : hint, run });
// The order of the rows about the node you are on: where it goes (open it, unfold it), its task state, who has it,
// a meeting's own details, when and where it lives (pins, the date nodes, its space), what it is (type, fields), how
// it looks, the agent, who sees it, its link and export, and last the destructive rows. Rows without an id carry a
// `rank` from this list instead.
// The rows about a field the caret is on (renderer/fields.js) come before the node's own: they are about what is focused.
const NODE_ROW_ORDER = ['fieldValue', 'fieldKind', 'fieldCount', 'fieldChoices', 'fieldTargets', 'setFieldIcon',
  'zoomIn', 'expand', 'collapse',
  'toggleDone', 'markRead', 'markUnread', 'approveProposal', 'rejectProposal', 'status',
  'assign', 'assignTo', 'discussWith', 'addToChat',
  'meetingTime', 'meetingLocation', 'meetingAttendee',
  'pinToday', 'pinTomorrow', 'pinToDate', 'pinToMeeting', 'pinToSelectedMeeting', 'editPins', 'addToday', 'addTomorrow', 'addWeek', 'move', 'moveLibrary',
  'setType', 'classifyType', 'removeType', 'addField', 'editFields',
  'setIcon', 'setHue', 'sensitive', 'translateNodes', 'replaceTranslation',
  'codex', 'codexOpen', 'codexLink', 'sendToAgent',
  'visibility', 'addParticipants', 'notify', 'copyLink', 'exportPdf',
  'archive', 'delete'];
const DOC_KIND = /^tana:text:/; // the Discussion Task type applies to documents, so a meeting is not offered that row
const nodeRank = (r) => { const i = NODE_ROW_ORDER.indexOf(r.rank || r.id); return i < 0 ? NODE_ROW_ORDER.length : i; };
const VIEW_ORDER = ['timeline', 'today', 'week', 'inbox', 'notifications', 'proposals', 'library', 'types'];
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
// A folded row's id is its parent's plus its own label ("status>Later"), so ⇧⌘K records a key against it; with the
// palette closed nothing is folded, so runAction asks the parent for its choices when that key is pressed. A choice
// is found by label: a renamed space or type drops its key.
const subCache = new Map();
const subBase = (row) => row.subBase || row.label.replace(/\s*…$/, '');
const foldId = (row, label) => (row.id || row.rank) && (row.id || row.rank) + '>' + label;
function subRowsFor(row) {
  const key = row.id || row.rank || row.label;
  if (!subCache.has(key)) {
    subCache.set(key, null);
    Promise.resolve().then(row.sub).then((rows) => { subCache.set(key, rows); if (palMode === 'cmd' && !palette.hidden) renderPalette(); }, (e) => { subCache.delete(key); showError(e); });
  }
  const kids = subCache.get(key);
  if (!kids) return [];
  const base = subBase(row);
  return kids.filter((k) => k.label && !k.disabled).map((k) => ({ ...k, id: foldId(row, k.label), folded: true, sub: undefined, group: row.group, icon: k.icon || row.icon, label: base + ' ' + k.label }));
}
// With a query the closest matches come first ("in": Inbox before Zoom in): rows sort by match tier, then the shorter
// label ("tasks": My tasks before Set type to discussion tasks), then by where the match starts, else keep their
// place. A group moves as a whole to where its best row lands, so every heading shows once, and groups whose best rows
// tie on tier and length keep the fixed order — where the match starts decides only within a group, so "sensitive"
// puts the current node's Mark as sensitive above Toggle sensitive visibility instead of losing to it by one character.
function rankRows(rows) {
  const tier = (a, b) => a.match.rank - b.match.rank || a.label.length - b.label.length;
  const cmp = (a, b) => tier(a, b) || a.match[0] - b.match[0];
  const best = new Map(), first = new Map();
  rows.forEach((r, i) => { if (!first.has(r.group)) first.set(r.group, i); if (!best.has(r.group) || cmp(r, best.get(r.group)) < 0) best.set(r.group, r); });
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.group === b.r.group ? cmp(a.r, b.r) || a.i - b.i : tier(best.get(a.r.group), best.get(b.r.group)) || first.get(a.r.group) - first.get(b.r.group)))
    .map(({ r }) => r);
}
// typed is the query as it was typed; q is the lowercased one every row is matched against.
// A meeting's call link (api.related().call) as Cmd+K Join call, the readable link its hint (masked in demo mode)
function callRow(data) {
  const call = data && data.call;
  if (!call || !call.url || !tana.openExternal) return null; // no call, no row
  return { id: 'joinCall', icon: 'video', label: 'Join call', hint: demoText(call.label || call.url, 'call'), run: () => run(() => tana.openExternal(call.url)) };
}
// palDoc is null while a chat message is selected (renderer/chat.js): Cmd+K and the keys act on the message then,
// never on the chat document around it, so none of the Current node rows is offered.
function paletteRows(q, typed = q) {
  const selection = selectionRows();
  // a selected chat message's own rows lead, under "Message"; the chat's latest-answer rows stay with the Actions
  const chatRows = (tana.askAgent || tana.deleteChatMessage) && zoom && isChatPage(zoom) ? chatMessageRows(zoom.docId) : [];
  // Signed out, logging in is the first row, so the splash's lesson is ⌘K then ↩ (index.html #loginBox)
  const rows = [...selection];
  rows.unshift(...chatRows.filter((r) => r.group === 'Message')); // the chat's selection: a message, never beside a row selection
  if (signedOut) rows.unshift({ id: 'login', group: 'Get started', icon: 'tana', label: 'Log in to Tana', run: () => tana.login().catch(showError) });
  if (tana.tableOp) rows.push(...tableRows()); // with the caret in a table cell: its rows and columns (renderer/table.js)
  if (tana.inboxSetRead) rows.push(...notificationRows()); // a notification row's own two (renderer/inbox.js)
  if (tana.proposalAnswer) rows.push(...proposalRows()); // a proposal row's approve and reject (renderer/proposals.js)
  // What acts on the current document (pins, link, icon, visibility, location) sits with the rest of its rows under
  // "Current node"; while a multi-selection owns the top of the palette they are "Current page", right under it.
  const docGroup = selection.length && selection[0].group === 'Selection' ? 'Current page' : 'Current node';
  // Rename, as on the page's tab: the zoomed page's title, where it can be typed in (renderer/document.js renameTitle)
  if (palDoc && zoom && palDoc.id === zoom.docId && !zoom.nodeId && (titleEl.dataset || {}).key) rows.push({ id: 'rename', group: docGroup, icon: 'rename', label: 'Rename', run: renameTitle });
  // the selection, or the row or page you are on, written in the auto-translate language (renderer/translate.js)
  if (tana.translate && tana.setText && tana.setTitle && !demoMode) { const list = translateTargets(), to = translateTo() || 'English'; if (list.length) rows.push({ id: 'translateNodes', group: selKeys().length ? 'Selection' : docGroup, icon: 'language', label: 'Translate' + (list.length > 1 ? ' ' + list.length + ' nodes' : '') + ' into ' + to, hint: 'Writes the translation', run: () => translateNodes(list, to) }); }
  // its title shown translated (renderer/translate.js), written as the title for good, where it may be edited
  if (palDoc && tana.setTitle && !demoMode && canEditNode(palDoc)) { const doc = palDoc, found = titleTranslation(doc); if (found) rows.push({ id: 'replaceTranslation', group: docGroup, icon: 'language', label: 'Replace with translation', hint: 'From ' + found.lang, run: () => replaceWithTranslation(doc, found) }); }
  if (palDoc && tana.exportPdf && DOC_KIND.test(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'exportPdf', group: docGroup, icon: 'doc', label: 'Export to PDF', run: () => { flushAll(); run(() => tana.exportPdf(doc.id)); } });
  }
  // Pin to today and to tomorrow, on every real node so a recorded key works wherever it is pressed (#273). The label
  // follows pinInfo when ⌘K has read it for this node; the press reads the pins again (toggleDatePin, renderer/
  // document.js), because a key fires with the palette closed, where pinInfo is the node ⌘K was last opened on.
  if (palDoc && tana.pinState && tana.pin && isRealId(palDoc.id)) {
    const doc = palDoc, dates = pinInfo && pinInfo.docId === doc.id ? pinInfo.dates : [];
    for (const [id, day, name] of [['pinToday', 0, 'today'], ['pinTomorrow', 1, 'tomorrow']]) {
      const date = localDate(day);
      rows.push({ id, rank: id, group: docGroup, icon: 'pinDate', label: (dates.includes(date) ? 'Unpin from ' : 'Pin to ') + name, run: () => toggleDatePin(doc, date) });
    }
  }
  // Any other day, typed in words on a page of its own (renderer/document.js parseDay). Listed whenever a real node
  // is on screen, so ⇧⌘K can record a key against it.
  if (palDoc && tana.pin && isRealId(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'pinToDate', group: docGroup, icon: 'pinDate', label: 'Pin to date \u2026', hint: 'sunday, in 3 days, 12 oct', keepOpen: true, run: () => openPinDatePalette(doc) });
  }
  rows.push(...meetingRows(palDoc, docGroup)); // Change time / location, Add attendee: on a meeting this user may change (renderer/meeting.js)
  // Pin this node onto the meeting I am in, through the event pin the sidebar reads back under Pinned (docs/PINNING.md).
  // The row is listed whenever a real node is on screen, so ⇧⌘K can record
  // a key against it, and says why instead of disappearing when there is no meeting to pin to. Its id is unchanged
  // from when it was called "Pin to meeting": a recorded key belongs to the id, and the label is only what it reads.
  // The lookup and the greying are the open palette's: a key pressed with it closed runs pinToMeeting, which looks
  // the meeting up itself and says when there is none (#273, #274).
  if (palDoc && tana.currentMeeting && tana.pinTo && isRealId(palDoc.id)) {
    if (!palette.hidden) loadMeeting();
    const doc = palDoc, live = palette.hidden ? null : meetingNow;
    rows.push({ id: 'pinToMeeting', group: docGroup, icon: 'meetingPin', label: 'Pin to current meeting',
      hint: !live ? '' : live.pending ? 'Checking…' : live.meeting ? demoText(live.meeting.title || 'Current meeting', live.meeting.id) : live.error || 'No active meeting',
      disabled: !!live && !live.meeting, run: () => pinToMeeting(doc) });
  }
  // And any other meeting, chosen from a page of its own: the same pin, a target picked rather than detected. It
  // needs no live meeting, so it is never disabled — a workspace with no meetings at all says so on that page.
  if (palDoc && tana.searchPreview && tana.pinTo && isRealId(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'pinToSelectedMeeting', group: docGroup, icon: 'meetingPin', label: 'Pin to meeting …', hint: 'Choose a meeting',
      keepOpen: true, run: () => openMeetingPicker(doc) });
  }
  // Everywhere this node is pinned, on one page, with each of them one press from being taken off. Offered whether
  // or not it is pinned: "Edit pins" is also where you find out that it is not. The hint is the state pinInfo
  // already carries for the rows above, so the page costs nothing to announce.
  if (palDoc && tana.pinState && isRealId(palDoc.id)) {
    const doc = palDoc, info = pinInfo && pinInfo.docId === doc.id ? pinInfo : null;
    const hubs = (info && info.hubs) || [];
    const meetings = hubs.filter((hub) => hub.kind !== 'space').length, spaces = hubs.length - meetings; // a space pin is the same edge, and must not be counted as a meeting
    const where = info ? [info.sidebar ? 'Sidebar' : '', info.dates.length ? info.dates.length + (info.dates.length === 1 ? ' date' : ' dates') : '',
      meetings ? meetings + (meetings === 1 ? ' meeting' : ' meetings') : '', spaces ? spaces + (spaces === 1 ? ' space' : ' spaces') : ''].filter(Boolean) : [];
    rows.push({ id: 'editPins', group: docGroup, icon: 'pinned', label: 'Edit pins',
      hint: info ? where.join(' · ') || 'Not pinned' : '', keepOpen: true, run: () => openPinsPalette(doc) });
  }
  // the node's web link, for pasting into Slack or a doc; on a Timeline row, the link of the node it is about
  const tlUri = timelineUriAt(), linkId = tlUri || (palDoc && isRealId(palDoc.id) ? palDoc.id : null);
  if (linkId && tana.nodeLink) {
    rows.push({ id: 'copyLink', group: tlUri && selKeys().length ? 'Selection' : docGroup, icon: 'link', label: 'Copy link', run: () => run(async () => copyText(await tana.nodeLink(linkId), 'Link copied')) });
  }
  // the node in Tana's own web app (what Show in Tana in the Graph pane's Details did)
  if (palDoc && tana.nodeLink && tana.openExternal && isRealId(palDoc.id)) { const doc = palDoc; rows.push({ id: 'openInTana', group: docGroup, icon: 'tana', label: 'Open in Tana', run: () => run(async () => tana.openExternal(await tana.nodeLink(doc.id))) }); }
  // a meeting's call, on the meeting and on its write-up: its related read carries the link (callRow)
  if (palDoc && isRealId(palDoc.id)) { const call = callRow(relatedBy.get(palDoc.id)); if (call) rows.push({ ...call, group: docGroup }); }
  // Open in <agent>: a new task in that agent's app with the node's link, nothing tracked (Assign to Agent is the
  // tracked one), one row for each agent that is on and can take a link. Codex's id keeps its old name so a recorded
  // key still finds the row.
  if (palDoc && tana.nodeLink && tana.openInAgent && isRealId(palDoc.id)) {
    const doc = palDoc;
    for (const a of agentsOn().filter((x) => x.openNew)) rows.push({ id: a.id === 'codex' ? 'sendToAgent' : 'openIn' + a.label, rank: 'sendToAgent', group: docGroup, icon: a.icon, label: 'Open in ' + a.label, hint: 'New task with this link',
      run: () => run(async () => tana.openInAgent(a.id, await tana.nodeLink(doc.id))) });
  }
  // What this document is: its Tana type, or none. Only a document or a meeting carries one, so a block, a space or a
  // member is not offered the row at all. The list is main's (the rules for which types fit live there); the hint is
  // the type it has now, read from the chip the row already carries.
  if (palDoc && tana.docTypes && tana.setType && isRealId(palDoc.id) && TYPED_KIND.test(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'setType', group: docGroup, icon: 'type', label: 'Set type', subBase: 'Set type to', hint: typeNameOf(doc) || 'No type',
      keepOpen: true, subAlways: true, run: () => openTypePalette(doc), sub: async () => { await typesLoaded(doc); return typeRows(''); } });
  }
  // Or have the model choose from the same list, reading each type's description and AI instructions (main/ai.js).
  if (palDoc && tana.classifyType && tana.setType && isRealId(palDoc.id) && TYPED_KIND.test(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'classifyType', group: docGroup, icon: 'sparkle', label: 'Auto-pick type', hint: 'AI picks the type', keepOpen: true, run: () => openClassifyPalette(doc) });
  }
  // And straight out of one: a typed document or meeting only, named after the type it takes off. The same one write
  // as "No type" on Set type, one key instead of a page.
  if (palDoc && tana.setType && isRealId(palDoc.id) && TYPED_KIND.test(palDoc.id) && typeNameOf(palDoc)) {
    const doc = palDoc;
    rows.push({ id: 'removeType', group: docGroup, icon: 'none', label: 'Remove type', hint: typeNameOf(doc), keepOpen: true, run: () => applyType(doc, null) });
  }
  rows.push(...fieldRows(docGroup)); // the focused field's value or definition, and Add field … on a type's page
  // One type a document is given by answering a question instead of picking it from a list: who it is to be
  // discussed with. A meeting is not offered it — the type applies to documents.
  if (palDoc && tana.discussWith && isRealId(palDoc.id) && DOC_KIND.test(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'discussWith', group: docGroup, icon: 'discuss', label: 'Discuss with …', hint: 'Discussion Task',
      keepOpen: true, run: () => openDiscussPalette(doc) });
  }
  // And what a type looks like. The glyph belongs to the type, so every document of that type is drawn with it: its
  // bullet, its row in the sidebar, a breadcrumb, and the chip an inline mention of it draws. A saved search takes one
  // the same way, for itself: its row, its page and its line under Searches (#521).
  // On a saved search's page it is the search's, wherever the caret is: its rows are other documents (a goal, a task),
  // which have no icon of their own to set, and the search is what the page is (#551).
  // A document takes one for itself, worn instead of its type's; a task keeps its box.
  const iconDoc = !tana.searchIcons || !tana.setTypeIcon ? null : palDoc && (TYPE_NODE.test(palDoc.id) || isSearchDoc(palDoc) || (DOC_KIND.test(palDoc.id) && isRealId(palDoc.id) && !isTask(palDoc))) ? palDoc : onSearchPage() ? docOf(zoom.docId) || extra.get(zoom.docId) || { id: zoom.docId, text: titleEl.textContent } : null;
  if (iconDoc) {
    const doc = iconDoc;
    rows.push({ id: 'setIcon', group: doc === palDoc ? docGroup : 'Current page', icon: iconOf(doc), label: 'Set icon',
      hint: typeGlyphs.has(doc.id) ? 'Chosen' : 'The generic glyph', keepOpen: true, run: () => openIconPalette(doc) });
  }
  // And what colour it is here: our own hue or grey for the type, kept with the glyph in the settings document, so
  // Tana's colour on the type is left alone (docs/SETTINGS.md).
  if (palDoc && tana.setTypeHue && TYPE_NODE.test(palDoc.id)) {
    const doc = palDoc;
    rows.push({ id: 'setHue', group: docGroup, icon: typeGlyph(doc.id), label: 'Set colour',
      hint: doc.hue == null ? 'Grey' : 'Hue ' + doc.hue, keepOpen: true, run: () => openHuePalette(doc) });
  }
  // Watching this node: the label says what pressing it does, so it carries no id — a hotkey whose meaning flips
  // between "start" and "stop" would be a key you cannot learn. No key can reach it, so it is asked only for the
  // open palette (#274), like the sharing rows below.
  if (palDoc && tana.notifyState && isRealId(palDoc.id)) {
    if (!palette.hidden) loadNotify(palDoc.id);
    const watch = notifyById.get(palDoc.id);
    if (watch) rows.push({ rank: 'notify', group: docGroup, icon: 'notify', label: watch.on ? 'Stop notifying' : 'Notify on changes',
      run: () => run(() => setNodeNotify(palDoc.id, !watch.on)) });
  }
  // Handing this node to an agent. App-local: Tana's assignees are user profiles, so nothing is
  // written into the node's own assignees. The label says what pressing it does, so it carries no id — same reason
  // as the watch row above. Assigning asks what the agent should do first (the prompt page keeps the palette open);
  // taking it back needs nothing typed, so it happens on the press.
  if (palDoc && tana.setAgent && isRealId(palDoc.id)) {
    const assigned = agentIds.has(palDoc.id), doc = palDoc;
    const holder = agentNamed((agentTasks.get(doc.id) || {}).agent), fallback = agentsOn().find((a) => a.isDefault) || agentNamed('tana');
    rows.push({ rank: 'codex', group: docGroup, icon: 'robot', label: assigned ? 'Unassign from Agent' : 'Assign to Agent',
      hint: assigned ? (holder ? holder.label : '') : 'To ' + ((fallback && fallback.label) || 'Tana'),
      keepOpen: !assigned,
      run: () => {
        if (!assigned) return openAgentPrompt(doc);
        run(async () => {
          holdRow(doc); // taking it back moves the row out of Agent: it stays put, and Clean up offers the redraw
          await tana.setAgent(doc.id, false); // the prompt goes with the assignment
          agentIds.delete(doc.id);
          agentStates.delete(doc.id); // main lets go of the task id; the snapshot has to let go with it, not next refresh
          renderPalette(); patchAgent(doc.id);
          renderPills(true); // Clean up is decided while the pills render, and nothing else here redraws them
        });
      } });
  }
  // A task that already exists in an agent's app, linked by pasting its link (#143): renderer/agent.js.
  if (palDoc && tana.linkAgentTask && isRealId(palDoc.id)) { const doc = palDoc; for (const a of agentsOn().filter((x) => x.link)) rows.push({ rank: 'codexLink', group: docGroup, icon: a.icon, label: 'Link ' + a.label + ' task …', keepOpen: true, run: () => openAgentLink(doc, a) }); }
  // The way into the task the agent is handling, from the keyboard. Both halves have to hold: the node is assigned
  // now, and a task id is known for it. The status map alone was not enough — it is a snapshot, and an unassigned
  // node kept its entry until the next read, which is how this row turned up on nodes with no agent on them.
  if (palDoc && tana.openAgentTask && agentIds.has(palDoc.id) && agentStates.has(palDoc.id) && agentTasks.has(palDoc.id)) {
    const doc = palDoc, a = agentNamed(agentTasks.get(doc.id).agent);
    // a task on another Mac stays offered, greyed with where it is (the badge is not a button there either)
    const away = agentStateOf(doc.id) === 'elsewhere';
    if (a) rows.push({ rank: 'codexOpen', group: docGroup, icon: a.icon, label: 'Go to ' + a.label + ' task', ...(away ? { disabled: true, hint: 'On another Mac: open it there' } : {}), run: () => openAgentTask(doc.id) });
  }
  if (palDoc && tana.accessOptions) {
    if (!palette.hidden) loadAccess(palDoc.id); // for the open palette only (#274): a key on a choice folded under these asks in runAction
    const access = accessById.get(palDoc.id);
    // Selected people … is greyed until the participants are in, so the folded level waits for them (as Edit
    // assignees' does): a key recorded on it then works on its first press
    const doc = palDoc;
    if (access?.sharing) rows.push({ rank: 'visibility', group: docGroup, icon: 'lock', label: 'Edit visibility', run: () => openVisibilityPalette(doc),
      sub: async () => { if (tana.taskMeta && !taskMetaById.has(doc.id)) taskMetaById.set(doc.id, await tana.taskMeta(doc.id)); return visibilityRows('', doc); } }); // doc, not palDoc: focus may move while the participants are asked
    if (access?.sharing) rows.push({ rank: 'addParticipants', group: docGroup, icon: 'users', label: 'Add participants …', hint: 'Who can see it', keepOpen: true, run: () => addParticipants(doc) }); // Edit visibility, at its people (renderer/access.js)
    if (access?.move) { // Library is a row of its own and the spaces are the folded level of "Move to …"; the Inbox is Set status to Inbox
      rows.push({ rank: 'move', group: docGroup, icon: 'space', label: 'Move to …', keepOpen: true, subAlways: true, run: () => openMovePalette(doc), sub: () => moveTargets(doc) });
      if (access.ownerUri) rows.push({ rank: 'moveLibrary', group: docGroup, icon: 'library', label: 'Move to Library', keepOpen: true, run: () => { openMovePalette(doc); previewMoveToSpace(doc, { id: 'library', text: 'Library' }); } });
    }
  }
  // only node rows so far: the selection's rows first, then (with a multi-selection) the document's own, each in NODE_ROW_ORDER
  rows.sort((a, b) => (a.group === 'Selection' ? 0 : 1) - (b.group === 'Selection' ? 0 : 1) || nodeRank(a) - nodeRank(b));
  if (tana.processImage) rows.push(...processImageRows());
  // Views, most used first: the Timeline (today's tasks and what happened), Today and This week, then what came in
  // (Inbox, Notifications, Proposals), and the Library and Types last. Today's node (titled with the date, pinned to
  // today) and the week's ("Week 38 (2026)") are documents created on demand, but places to go all the same.
  const viewRows = views.map((s) => ({ id: 'view:' + s.id, group: 'Views', icon: s.icon, label: s.title, run: () => setView(s.id) }));
  if (tana.todayNode) viewRows.push({ id: 'today', group: 'Views', icon: 'today', label: 'Today', opens: () => tana.todayNode(), run: () => run(async () => goTo(await tana.todayNode())) });
  if (tana.weekNode) viewRows.push({ id: 'week', group: 'Views', icon: 'week', label: 'This week', opens: () => tana.weekNode(), run: () => run(async () => goTo(await tana.weekNode())) });
  if (tana.inboxUnread) viewRows.push(notificationsViewRow()); // Tana's notifications, what came in from other people
  if (tana.proposalAnswer) viewRows.push(proposalsViewRow()); // what Tana's AI proposed and is waiting on you to accept
  if (tana.children) viewRows.push(timelineViewRow()); // what happened to what you watch, and what landed in your Inbox
  const viewRank = (r) => { const i = VIEW_ORDER.indexOf(r.id.replace(/^view:/, '')); return i < 0 ? VIEW_ORDER.length : i; };
  rows.push(...viewRows.sort((a, b) => viewRank(a) - viewRank(b)));
  // Saved searches are places too: their own heading, under the views, each opening the search document
  rows.push(...searches.map((s) => ({ id: 'search:' + s.id, group: 'Searches', icon: typeGlyph(s.id), label: s.text || s.title || 'Untitled search', opens: s.id, run: () => goTo(s.id) })));
  // So is every workspace type: its page lists its documents. Drawn in its own glyph, without its hue.
  rows.push(...(typeListCache || []).map((t) => ({ id: 'type:' + t.uri, group: 'Types', icon: typeGlyph(t.uri), label: t.title || 'Untitled type', opens: t.uri, run: () => goTo(t.uri) })));
  rows.push(...pillCommandRows());
  // ⌘F arrives as runAction('filter'), which only fires if this row exists right now — so a saved search page has to
  // offer it, or the key falls through to the browser exactly as it did before.
  // The field is shown here rather than left to the render: a render is deferred while the caret is in a row or a
  // selection is frozen, and focusing a still-hidden input does nothing — which is why ⌘F used to need a click first.
  if (!zoom || onSearchPage() || onTypePage()) rows.push({ id: 'filter', group: 'View options', icon: 'filter', label: 'Filter rows by text', run: () => { filterShown = true; showHide(filterRow, true); render(); filterEl.focus(); } });
  // The app's own rows, in four groups: Actions (making and finding things, undoing, syncing), Navigate
  // (moving between places), Window (windows, panes, the sidebar) and Settings (how it looks, what it hides, accounts).
  // the corner button's glyph (shell.html #create); with an image on the clipboard its page offers that first (openCreationPalette)
  if (tana.creationOptions) rows.push({ id: 'create', group: 'Actions', icon: 'textPlus', label: 'Create new …', keepOpen: true, run: openCreationPalette, sub: async () => { creationChoices = (await tana.creationOptions()).options || []; return creationRows(''); } });
  if (tana.createDocument) rows.push({ id: 'createTask', group: 'Actions', icon: 'task', label: 'Quick Add Task', run: () => openTask() }); // ⇧⌘Space: task.html over the window (renderer/overlays.js)
  if (tana.inviteToChat && zoom && isChatPage(zoom)) { const chatId = zoom.docId; rows.push({ id: 'inviteChat', group: 'Actions', icon: 'member', label: 'Invite to chat…', hint: 'Someone from the workspace', keepOpen: true, run: () => openInvitePicker(chatId) }); } // renderer/chat.js
  rows.push(...chatRows.filter((r) => r.group !== 'Message')); // the selected message's, or the latest answer's (renderer/chat.js)
  if (tana.newChat) rows.push({ id: 'newChat', group: 'Actions', icon: 'chat', label: 'New chat', hint: 'Talk to Tana', run: () => startNewChat() }); // renderer/chat.js
  // ⌘K New canvas (#620): named as Tana names one ("Canvas Sep 30, 2026, 2:05 PM") and opened in its window (#611)
  if (tana.createDocument && tana.openCanvas) rows.push({ id: 'newCanvas', group: 'Actions', icon: 'canvas', label: 'New canvas', hint: 'A board, drawn by Tana', run: () => run(async () => { const now = new Date(); opensCanvas((await tana.createDocument('Canvas ' + now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }), { kind: 'canvas' })).id); }) });
  if (tana.newChat && tana.inviteToChat) rows.push({ id: 'newChatWith', group: 'Actions', icon: 'chat', label: 'New chat with …', hint: 'Someone from the workspace', keepOpen: true, run: () => openNewChatWith() }); // renderer/chat.js
  // the keys the outline answers to, as rows: each has a default combo in DEFAULT_HOTKEYS and can be re-recorded
  rows.push({ id: 'search', group: 'Actions', icon: 'search', label: 'Search Tana', keepOpen: true, run: () => togglePalette('search') });
  rows.push({ id: 'undo', group: 'Actions', icon: 'undo', label: 'Undo', run: () => history('undo') });
  rows.push({ id: 'redo', group: 'Actions', icon: 'redo', label: 'Redo', run: () => history('redo') });
  if (tana.inboxMarkAll) rows.push(markAllRow());
  rows.push({ id: 'sync', group: 'Actions', icon: 'sync', label: 'Sync', run: () => run(() => tana.refresh()) });
  // Go back with an empty stack is still a move while you are away from Home, which is where it lands (edit.js)
  rows.push({ id: 'back', group: 'Navigate', icon: 'back', label: 'Go back', disabled: !navBack.length, run: () => navigate(-1) });
  rows.push({ id: 'forward', group: 'Navigate', icon: 'forward', label: 'Go forward', disabled: !navForward.length, run: () => navigate(1) });
  // Where Back lands with no history and what the anchor crumb points at, as a row: the same goHome (renderer/nodes.js),
  // so there is one route Home and it reads the choice live. On Home it stays, disabled, saying so — discoverable, and
  // still something ⇧⌘K can record a key against.
  rows.push({ id: 'goHome', group: 'Navigate', icon: 'home', label: 'Go to Home', hint: atHome() ? 'Current' : homeName() || '', disabled: atHome(), run: () => goHome() });
  // Home is the window as it is now, its panes and what each shows: kept as the saved view "Home" (renderer/nodes.js)
  if (tana.windowLayout) rows.push({ id: 'setHome', group: 'Navigate', icon: 'home', label: 'Set as Home', hint: homeId() === HOME_VIEW ? 'Updates Home to this window' : 'This window as it is', run: () => run(async () => { await saveView('Home', HOME_VIEW); setHome(HOME_VIEW); }) });
  if (windowPanes.links) rows.push({ id: 'rail', group: 'Navigate', icon: 'graph', label: 'Focus graph', run: () => (LINKS ? focusRail() : toShell({ orbital: 'focusLinks' })) });
  if (tana.deletedList) rows.push({ id: 'recentlyDeleted', group: 'Navigate', icon: 'trash', label: 'Recently deleted', keepOpen: true, run: openTrashPalette });
  if (tana.archivedTypes) rows.push({ id: 'archivedTypes', group: 'Navigate', icon: 'type', label: 'Archived types', keepOpen: true, run: openArchivedPalette });
  // A new page starts where you are: main hands it this view and place with its id, before it reads them (main.js starts)
  rows.push({ id: 'newWindow', group: 'Window', icon: 'createNew', label: 'New window', run: () => run(() => tana.newWindow({ view, place: placeJSON() })) });
  // a new page opens on the Library, the one place more than one pane may show (#533): a copy of this one would be a second pane on it
  const openPage = (where) => run(() => tana.splitWindow(where, { view: 'library', place: '{}' }));
  rows.push({ id: 'splitView', group: 'Window', icon: 'splitPanes', label: 'New pane', hint: 'Library, to the right', run: () => openPage('right') });
  rows.push({ id: 'newTab', group: 'Window', icon: 'createNew', label: 'New tab', hint: 'Beside this page', run: () => openPage('tab') });
  rows.push({ id: 'floatPane', group: 'Window', icon: 'splitPanes', label: 'New floating pane', run: () => openPage('float') }); // "Float" in a pane's menu floats that pane
  // With more than one page, the workspace's own moves (shell.js run): Trellis does them, this page only asks
  if (windowPanes.pages > 1) for (const [id, label, command, icon] of PANE_ROWS) rows.push({ id, group: 'Window', icon, label, ...(id === 'closePane' ? { kbd: '⌘W' } : {}), run: () => shellRun(command) }); // ⌘W: the File menu's Close
  // The window's Graph pane (issue #462, renderer/rail.js): opened beside this page on this place, or closed by the shell
  rows.push({ id: 'railToggle', group: 'Window', icon: 'graph', label: windowPanes.links ? 'Hide graph' : 'Show graph', run: () => (windowPanes.links ? toShell({ orbital: 'links' }) : run(() => tana.splitWindow('links', { view, place: placeJSON() }))) });
  rows.push({ id: 'reload', group: 'Window', icon: 'reload', label: 'Reload', hint: 'Every pane', run: () => (window.frameElement ? window.parent.postMessage({ orbital: 'reload' }, '*') : location.reload()) }); // the shell reloads, and every page with it (shell.js)
  if (tana.windowLayout) {
    rows.push({ id: 'saveView', group: 'Window', icon: 'splitPanes', label: 'Save view\u2026', keepOpen: true, run: openSaveViewPalette });
    if (savedViews().some((v) => v.id !== WORK_VIEW.id)) rows.push({ id: 'removeSavedView', group: 'Window', icon: 'trash', label: 'Remove saved view', keepOpen: true, run: openRemoveViewPalette, sub: async () => removeViewRows('') });
    for (const v of savedViews()) rows.push({ id: v.id || 'savedView:' + v.name, group: 'Saved views', icon: 'splitPanes', label: v.name, run: () => run(() => openSavedView(v)) });
  }
  // text size stays on the fixed keys (their characters depend on the keyboard layout), so the chips are literal
  rows.push({ id: 'openSettings', group: 'Settings', icon: 'options', label: 'Open settings', run: () => openSettings() }); // the Settings page (renderer/settings.js), first in its group
  rows.push({ id: 'textLarger', group: 'Settings', icon: 'textLarger', label: 'Larger text', kbd: '⇧⌘+', run: () => setZoom(zoomFactor * 1.1) });
  rows.push({ id: 'textSmaller', group: 'Settings', icon: 'textSmaller', label: 'Smaller text', kbd: '⇧⌘-', run: () => setZoom(zoomFactor / 1.1) });
  rows.push({ id: 'textReset', group: 'Settings', icon: 'textReset', label: 'Reset text size', kbd: '⌘0', run: () => setZoom(BASE_ZOOM) });
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  rows.push({ id: 'theme', group: 'Settings', icon: 'darkLight', label: 'Toggle ' + (dark ? 'light' : 'dark') + ' mode', run: () => setTheme(dark ? 'light' : 'dark') });
  if (tana.systemTheme) rows.push({ id: 'systemTheme', group: 'Settings', icon: 'darkLight', label: 'Toggle system dark/light mode', hint: themePref === 'system' ? 'Following macOS' : '', run: () => followSystem(themePref !== 'system') });
  // the list of titles hidden from every view and from search, edited in the palette itself
  if (tana.filters) rows.push({ id: 'hidden', group: 'Settings', icon: 'hiddenItems', label: 'Edit hidden items', keepOpen: true, run: openHiddenPalette });
  if (tana.sensitiveIds) rows.push({ id: 'sensitiveVisibility', group: 'Settings', icon: 'hidden', label: 'Toggle sensitive visibility', hint: sensitiveVisible ? 'Shown' : 'Hidden', run: toggleSensitiveVisibility });
  // Every list and every search, not this page: the switch lives in main (main/views.js listFilter), so the Library
  // and Cmd+S stop offering MCP chats too. Stable label + hint, like the row above, so a recorded key keeps meaning.
  if (tana.setMcpHidden) rows.push({ id: 'mcpChats', group: 'Settings', icon: 'hiddenItems', label: 'Toggle MCP chats', hint: mcpHidden ? 'Hidden' : 'Shown',
    run: () => run(async () => { mcpHidden = await tana.setMcpHidden(!mcpHidden); }) });
  // names and Tana's words swapped for made-up ones on screen, for showing the app to someone (renderer/segments.js)
  if (tana.translate) rows.push({ id: 'autoTranslate', group: 'Settings', icon: 'sparkle', label: 'Auto-translate …', hint: translateTo() ? 'Into ' + translateTo() : 'Off', run: openTranslatePage }); // renderer/translate.js
  rows.push({ id: 'demoMode', group: 'Settings', icon: 'demo', label: 'Toggle demo mode', hint: demoMode ? 'On' : 'Off', run: () => toggleDemoMode() });
  if (tana.aiOptions) rows.push({ id: 'models', group: 'Settings', icon: 'brain', label: 'Choose models …', hint: 'Quick and Regular AI', keepOpen: true, run: openModelsPalette }); // renderer/settings.js
  if (tana.agentList) rows.push({ id: 'agents', group: 'Settings', icon: 'robot', label: 'Choose agents …', hint: agentsOn().map((a) => a.label).join(', '), keepOpen: true, run: openAgentsPalette });
  if (tana.relayLink) rows.push({ id: 'linkAgent', group: 'Settings', icon: 'link', label: 'Connect to new agent …', hint: 'Any agent that takes an MCP server', keepOpen: true, run: () => openLinkPalette() }); // renderer/agent.js
  if (tana.chatgptStatus) rows.push({ id: 'chatgpt', group: 'Settings', icon: 'chatgpt', label: chatgptAuth?.signedIn ? 'Sign out of ChatGPT' : 'Sign in with ChatGPT',
    hint: chatgptAuth?.signedIn ? (chatgptAuth.email || 'Signed in') : chatgptAuth?.available === false ? 'Status unavailable' : chatgptAuth ? 'Turns on translation, Discuss with and more' : 'Checking sign-in',
    keepOpen: true, run: chatgptCommand });
  // Sign in with ChatGPT is the way in (issue #669): the key is offered only to whoever already stored one, until it is cleared
  if (tana.setOpenAIKey && chatgptAuth?.apiKey) rows.push({ id: 'openaiKey', group: 'Settings', icon: 'openaiKey', label: 'Set OpenAI API key', hint: 'Stored locally', keepOpen: true, run: openOpenAIKeyPalette });
  if (authed && tana.logout) rows.push({ id: 'logout', group: 'Settings', icon: 'tana', label: 'Log out of Tana', keepOpen: true, run: confirmLogout });
  rows.push({ id: 'help', group: 'Help', icon: 'help', label: 'Help', hint: 'The basics and the keys', run: () => openHelp() }); // renderer/overlays.js
  if (tana.openExternal) rows.push({ id: 'manual', group: 'Help', icon: 'help', label: 'Open Manual', hint: 'Every feature, with pictures', run: () => run(() => tana.openExternal('https://orbital.md/manual/?theme=' + theme)) }); // manual/, published there at each release
  if (tana.openExternal) rows.push({ id: 'about', group: 'Help', icon: 'info', label: 'About Orbital', keepOpen: true, run: openAboutPalette });
  if (tana.checkUpdates) rows.push({ id: 'checkUpdates', group: 'Help', icon: 'reload', label: 'Check for updates', run: () => tana.checkUpdates() }); // a newer release opens the update card (update.html), a dialog says up to date
  // A second level is folded in once the query's first two letters reach its row, as a prefix or as the first words'
  // initials ("mo" or "mt" for Move to …, "as" or "at" for Assign to), and loaded once per palette opening. The spaces
  // and the four statuses are short fixed lists, so "Move to …" and "Set status" (`subAlways`) load them as the palette
  // opens and fold them in for any query: "inb" reaches Set status to Inbox, "foun" Move to Foundry.
  for (const r of rows.filter((r) => r.sub && ((r.subAlways && !palette.hidden) || (q.length >= 2 && fuzzyMatch(subBase(r), q.slice(0, 2))?.rank <= 1)))) {
    const kids = subRowsFor(r);
    if (q) rows.splice(rows.indexOf(r) + 1, 0, ...kids);
  }
  const seen = new Set(), key = (r) => (!r.folded && r.id) || r.group + '\n' + r.label; // a folded choice that reads like its parent, once
  let matched = rows.map((r) => ({ ...r, match: fuzzyMatch(r.label, q) })).filter((r) => r.match && !seen.has(key(r)) && seen.add(key(r)));
  if (q) matched = rankRows(matched);
  // Nothing here matches what was typed, so the words are probably a document's: offer the one thing that can still
  // find it, carrying the query into Cmd+S instead of making it be typed a second time. Its heading is the "No
  // results" line, which renderPalette leaves out once there is a row.
  if (q && !matched.length) return [{ group: 'No results', icon: 'search', label: 'Search Tana for “' + typed + '”', keepOpen: true, disabled: signedOut,
    run: () => { togglePalette('search'); palInput.value = typed; searchNow(); } }];
  // Signed out, logging in is the only thing that works: every other row is greyed out, and runRow refuses it
  return matched.map((r) => { const k = r.id && hotkeyFor(r.id); return { ...r, ...(k && { kbd: k }), ...(signedOut && r.id !== 'login' && { disabled: true }) }; });
}
// a hotkey, recorded or default, runs its palette row's action (views/sync/login by id; documents wherever they live);
// false when no such row exists right now, so the key can fall through to whatever else it means. A row that is here
// but off (Clean up with nothing held, Go back with no history) answers the key by doing nothing: it is the same
// command either way, so it must not mean one thing while it is live and something else while it is not.
function runAction(id) {
  // A key pressed in the Graph pane acts in the page it follows, where its rows are meant (#463 review), except the
  // pane's own rows and the workspace's moves, which ask the shell from wherever they are pressed.
  if (LINKS && !['railToggle', 'rail', 'reload'].includes(id) && !PANE_ROWS.some(([rowId]) => rowId === id)) { toShell({ orbital: 'action', id }); return true; }
  if (palette.hidden) { palDoc = document.activeElement && document.activeElement.matches && document.activeElement.matches('.chat-msg[data-key]') ? null : currentDoc(); palField = fieldAt(document.activeElement); } // a key fires with the palette closed, so the "current node" is whatever is focused now
  const rows = paletteRows(''), row = rows.find((r) => r.id === id);
  if (row) { if (!row.disabled) row.run(); return true; }
  // A key pressed with the palette closed may wait on main below (access, participants, spaces). A palette opened in
  // the meantime, still open or already closed again, has moved palSeq on (showPage), and the key lets its answer go
  // rather than taking that palette over or reopening one Esc just closed.
  const closed = palette.hidden, seq = palSeq, current = () => !closed || palSeq === seq;
  const fold = id.indexOf('>'), parent = fold > 0 && rows.find((r) => r.sub && (r.id || r.rank) === id.slice(0, fold));
  if (parent) {
    if (!parent.disabled) run(async () => { const kids = await parent.sub(); if (!current()) return; const kid = kids.find((k) => k.label === id.slice(fold + 1) && !k.disabled); if (kid) kid.run(); });
    return true;
  }
  // A key on a choice folded under Move to … or Edit visibility ("move>Foundry"): those two rows exist once main has
  // said what this node allows, which the closed palette does not ask on its own (#274). Asked here, for this key only,
  // and the key runs again with the answer.
  if (palette.hidden && /^(move|visibility)>/.test(id) && palDoc && tana.accessOptions && isRealId(palDoc.id) && !accessById.has(palDoc.id)) {
    const doc = palDoc;
    run(async () => { accessById.set(doc.id, await tana.accessOptions(doc.id)); if (current() && currentDoc()?.id === doc.id) runAction(id); });
    return true;
  }
  // The same for Change time, Change location and Add attendee: they are offered once main has said this meeting may be
  // changed, which the closed palette does not ask. Asked for this key only, and the key runs again with the answer (#391).
  const meeting = palette.hidden && /^meeting(Time|Location|Attendee)$/.test(id) && tana.meetingInfo ? meetingOf(palDoc) : null;
  if (meeting && !(meetingCtx && meetingCtx.docId === meeting.id && meetingCtx.info)) {
    const doc = palDoc;
    run(async () => { await loadMeetingCtx(meeting); if (current() && currentDoc()?.id === doc.id) runAction(id); });
    return true;
  }
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
// Every page of the palette starts here (#275): what the last page left behind — its rows, a search still debounced or
// in flight, an Enter waiting on it, busy, the prompt editor — is let go of, and the page is up with its field.
// A page is what the palette asks of it: { rows(q, typed) } draws it on every keystroke (q lowercased, typed as
// typed), back is where Escape goes (closing the palette when there is none), keys(e) answers a key before the
// palette does, and typed: true marks a page whose rows are what you type, which has no "No results" to show.
function showPage(mode, placeholder, page, value = '') {
  clearTimeout(palTimer); palTimer = null; ++palSeq; palEnter = null; promptEditor(false);
  if (palette.hidden && !palReturn) palReturn = returnTarget(); // opened with the palette closed (a recorded key, a row's meta): closing comes back here (#376)
  palMode = mode; palPage = page || {}; palRows = []; palIndex = 0; palBusy = false; palette.hidden = false;
  palInput.placeholder = placeholder; palInput.value = value;
  coverWindow(mode);
}
// showPage, drawn, with the field focused: the whole of opening most pages, once their context is set. A page that
// starts something the first draw depends on (Set icon's busy search) calls showPage and draws itself.
function openPage(mode, placeholder, page, value) { showPage(mode, placeholder, page, value); renderPalette(); palInput.focus(); }
const BACK_TO_COMMANDS = () => openCommandPalette(); // a page opened from the command page steps back to it
// Logging out ends the session for every window on this Mac, so the row asks once more; Escape or Cancel steps back.
function confirmLogout() {
  const rows = [
    { group: 'Log out of Tana?', icon: 'tana', label: 'Log out', hint: 'Every window, until you log in again', run: () => tana.logout().catch(showError) },
    { group: 'Log out of Tana?', label: 'Cancel', keepOpen: true, run: BACK_TO_COMMANDS },
  ];
  openPage('logout', 'Log out of Tana?', { back: BACK_TO_COMMANDS, rows: (q) => (q ? rows.filter((r) => fuzzyMatch(r.label.toLowerCase(), q)) : rows) });
}
// About Orbital: what it is (the field's placeholder), its links first so the first row is one you can run, the big
// dependencies with their licences, then Orbital's own licence in three lines (the README's License section and
// LICENSE, public in the releases repo).
function openAboutPalette() {
  const link = (group, icon, label, hint, url) => ({ group, icon, label, hint, run: () => run(() => tana.openExternal(url)) });
  const notes = ['Free to use, change, fork and share; charging for your help is fine',
    'Keep the credit: copies and forks say it was made by Andre Foeken',
    'Don\'t sell Orbital itself, changed or repackaged, as your own product',
    'Tana and its trademarks are Tana\'s own; Orbital is not affiliated with Tana'].map((label) => ({ group: 'Good to know', label, disabled: true, note: true }));
  const links = [link('', 'globe', 'Website', 'orbital.md', 'https://orbital.md'), // no heading: the two rows say what they are, and the page fits
    link('', 'license', 'License', 'The full terms on GitHub', 'https://github.com/foeken/orbital/blob/main/LICENSE'),
    link('Built with', 'code', 'Trellis', 'Panes · free for non-commercial use', 'https://github.com/DanFessler/trellis/blob/main/LICENSE.md'),
    link('Built with', 'code', 'Electron', 'The app · MIT', 'https://github.com/electron/electron/blob/main/LICENSE'),
    link('Built with', 'code', 'Loro', 'Live sync · MIT', 'https://github.com/loro-dev/loro/blob/main/LICENSE')];
  openPage('about', 'Orbital: a keyboard-first outliner over your Tana', { back: BACK_TO_COMMANDS, rows: (q) => [...(q ? links.filter((r) => fuzzyMatch(r.label.toLowerCase(), q)) : links), ...notes] });
}
function openPillPalette(id) {
  pillCtx = id; openPage('pill', 'Choose ' + id, { rows: pillRows, back: BACK_TO_COMMANDS });
}
function openCommandPalette() {
  pillCtx = null; refreshChatGPTStatus(); openPage('cmd', 'Run a command', { rows: paletteRows });
}
// Escape: the page says where it came from; a page that says nothing (the command page, search) closes.
function backPalette() { (palPage.back || closePalette)(); }
// ---- a page that lists one read from main: Recently deleted, Archived types, Hidden items, the meeting picker ----
// The list is null while the read is out, then what main answered, or the Error it failed with. The page draws its rows
// once it is in, and otherwise one line saying why there are none: Loading…, the failure, or its empty line for a list
// with nothing in it. A query that matches nothing leaves the rows empty, and the palette's own "No results" says so.
// Only the latest read of a page is kept: a page left and opened again before its first answer came would otherwise let
// that older answer land last. A write that answers with the list (hiddenApply, hostsApply) retires the read too.
// The read waits for the actions already queued (run): a delete or restore still in flight is in the list it reads.
const listReads = new Map(); // mode -> the read in flight
function loadList(mode, read, keep) {
  const mine = {}; listReads.set(mode, mine);
  keep(null);
  queue.then(read).then((list) => (Array.isArray(list) ? list : []), (e) => (e instanceof Error ? e : new Error(String(e))))
    .then((list) => { if (listReads.get(mode) !== mine) return; listReads.delete(mode); keep(list); if (palMode === mode && !palette.hidden) renderPalette(); });
}
function listRows(group, list, q, empty, toRows) {
  const note = (label) => [{ group, label, disabled: true, note: true }]; // says why there are no rows, so no "No results" under it
  if (!list) return note('Loading…');
  if (list instanceof Error) return note(list.message);
  const rows = toRows(list);
  return rows.length || q || !empty ? rows : note(empty);
}
// ---- recently deleted: undo without the undo stack ----
// A delete here is Tana's soft delete: the document keeps everything it had and only its deletedAt is set, so
// restoring it is one call with its id. What nothing can answer is which ids those are — a deleted document leaves
// the graph, so no list, search or query names it again — and the undo stack only reaches back through this
// session, in order. So main writes down every deletion it sees (db.js) and this page reads that list back.
const TRASH_GROUP = 'Recently deleted · ↩ restores it';
let trashList = null; // loadList's answer
const trashRows = (q) => listRows(TRASH_GROUP, trashList, q, 'Nothing deleted recently', (list) => list.filter((d) => fuzzyMatch(d.title, q)).map((d) => ({ group: TRASH_GROUP, icon: 'trash', label: demoText(d.title, d.id),
  hint: agoText(d.deletedAt), keepOpen: true, run: () => run(async () => { await tana.restoreDocument(d.id); closePalette(); goTo(d.id); }) })));
function openTrashPalette() {
  loadList('trash', () => tana.deletedList(), (list) => { trashList = list; });
  openPage('trash', 'Restore something deleted', { rows: trashRows, back: BACK_TO_COMMANDS });
}
// ---- archived types: Tana archives a type instead of deleting it (it leaves every list and picker; its documents keep
// it). An archived type is still in the graph behind includeArchived, so main answers from there, not from a local list.
const ARCHIVED_GROUP = 'Archived types · ↩ unarchives it';
let archivedList = null; // loadList's answer
const archivedRows = (q) => listRows(ARCHIVED_GROUP, archivedList, q, 'No archived types', (list) => list.filter((d) => fuzzyMatch(d.title, q)).map((d) => ({ group: ARCHIVED_GROUP, icon: typeGlyph(d.id), label: d.title,
  hint: agoText(d.archivedAt), keepOpen: true, run: () => run(async () => { await tana.unarchiveDocument(d.id); closePalette(); goTo(d.id); }) })));
function openArchivedPalette() {
  loadList('archived', () => tana.archivedTypes(), (list) => { archivedList = list; });
  openPage('archived', 'Unarchive a type', { rows: archivedRows, back: BACK_TO_COMMANDS });
}
// ---- hidden items (api.filters): titles every view and search skips, edited from Cmd+K ----
// The rule lives in the group header because that is the one line in the palette that wraps.
const HIDDEN_GROUP = 'Hidden items · whole title, case-insensitive; end with * to match a prefix';
let hiddenList = null; // loadList's answer, then each write's
const hiddenApply = (call) => run(async () => { hiddenList = await call(); listReads.delete('hidden'); renderPalette(); }); // resolves once the views have refreshed
// What is typed is offered as a title to hide, first, whether or not the list is in yet; the list below is narrowed by it.
const hiddenRows = (q, typed) => [
  ...(typed ? [{ group: HIDDEN_GROUP, icon: 'createNew', label: 'Hide "' + typed + '"', hint: typed.endsWith('*') ? 'Prefix' : 'Exact', keepOpen: true, run: () => { palInput.value = ''; hiddenApply(() => tana.addFilter(typed)); } }] : []),
  ...listRows(HIDDEN_GROUP, hiddenList, typed, 'Nothing is hidden yet', (list) => list.filter((pattern) => pattern.toLowerCase().includes(q))
    .map((pattern) => ({ group: HIDDEN_GROUP, icon: 'any', label: pattern, hint: (pattern.endsWith('*') ? 'Prefix' : 'Exact') + ' · ↩ unhides', keepOpen: true, run: () => hiddenApply(() => tana.removeFilter(pattern)) })))];
function openHiddenPalette() {
  loadList('hidden', () => tana.filters(), (list) => { hiddenList = list; });
  openPage('hidden', 'Type a title to hide', { rows: hiddenRows, back: BACK_TO_COMMANDS });
}
function creationRows(q) {
  if (palBusy) return [{ group: 'Create new', label: 'Loading choices…', disabled: true }];
  return creationChoices.filter((choice) => fuzzyMatch(choice.title, q)).map((choice) => ({ group: choice.kind === 'custom' ? 'Workspace types' : 'Create new', icon: choice.icon, label: choice.title, hint: choice.selectable ? '' : choice.reason || 'Unavailable', disabled: !choice.selectable, keepOpen: true, run: () => openNamePage(choice) }));
}
function openCreationPalette() {
  // The clipboard's image leads the page, and only the page: a folded row under Create new … could get a key.
  // The corner button opens this page with ⌘K closed, so the clipboard is asked here too.
  if (palette.hidden) loadClipImage();
  const clip = (q) => (clipImage && fuzzyMatch('process image from clipboard', q) ? [clipImageRow()] : []);
  openPage('create', 'Choose what to create', { rows: (q) => [...clip(q), ...creationRows(q)], back: BACK_TO_COMMANDS });
  loadCreationChoices();
}
// the create choices feed both the Cmd+K "Create new …" list and the "/" menu
function loadCreationChoices() {
  if (!tana.creationOptions) return;
  const seq = ++palSeq, mode = palMode; palBusy = true;
  tana.creationOptions().then((result) => {
    if (seq !== palSeq || palMode !== mode) return;
    creationChoices = result.options || []; palBusy = false; renderPalette();
  }, (e) => { if (seq === palSeq && palMode === mode) { palBusy = false; showError(e); renderPalette(); } });
}
function creationSection() {
  // Everything — tasks, meetings, chats, saved searches, docs — is drafted in the Library, which is the one view
  // that lists any kind. The kind pages those used to have are gone, Tasks with them.
  return views.find((section) => section.id === 'library') || viewOf();
}
function startCreation(choice) {
  const section = creationSection(), tags = choice.kind === 'custom' ? [{ label: choice.title, hue: choice.hue, uri: choice.typeUri }] : undefined; // uri: a task draft finds its type's glyph as the row it becomes does (iconOf)
  const node = draftDocNode(choice.kind, { typeUri: choice.typeUri, icon: choice.icon, tags });
  section.nodes.unshift(node); view = section.id; localStorage.setItem('view' + SIDE, view);
  // render(true), like every other action that changes the page: closePalette puts the caret back in the row ⌘K was
  // opened from, and an ordinary render defers while a row holds the caret. The draft page was then never drawn, the
  // caret never reached its title, and the empty draft sat in the view as a node nobody created.
  closePalette(); zoom = { docId: node.id, nodeId: null }; render(true); setCaret(titleEl, 0);
  loadView(view); // the target view may not have fetched its rows yet
}
// Create new … (Cmd+K and the corner button) asks the name on a page of its own, in the palette's field (#535): Enter makes
// the node and opens it, Escape goes back to the choices. The "/" menu, typed in a row, keeps its draft on the page
// (startCreation), where the words go on being typed.
let creatingNamed = false; // one create per Enter: a second press while main answers makes no second node
function openNamePage(choice) {
  const group = 'New ' + choice.title;
  openPage('createName', 'Name the new ' + choice.title + '…', { back: openCreationPalette, typed: true, rows: (q, typed) => {
    const title = String(typed || '').trim();
    return [title ? { group, icon: choice.icon, label: 'Create “' + title + '”', run: () => createNamed(choice, title) } : { group, icon: choice.icon, label: 'Type a name', disabled: true, note: true }];
  } });
}
function createNamed(choice, title) {
  if (creatingNamed) return;
  creatingNamed = true;
  const opts = { kind: choice.kind, ...(choice.typeUri ? { typeUri: choice.typeUri } : {}), ...(choice.kind === 'search' ? { query: {} } : {}) }; // what a draft would have been created with (draftDocNode)
  return run(async () => {
    const n = await tana.createDocument(title, opts), made = { ...n, text: n.title ?? n.text ?? '', hasChildren: true };
    addSearch(made); // a saved search is in Cmd+K at once (#141)
    extra.set(made.id, made); closePalette(); openDoc(made.id);
  }).finally(() => { creatingNamed = false; });
}
// search result / pin: zoom into it wherever it lives (api.node shape -> extra); from = breadcrumb root when not opened in its view
function openResult(n, from) {
  if (!allDocs().some((d) => d.id === n.id)) extra.set(n.id, asDoc(n));
  openDoc(n.id, from);
}
// result rows pick a document: open it, or link it when the palette was opened with "@" on a selection (Create row first)
function resultRows(nodes, group) {
  nodes = nodes.map(asDoc);
  const ctx = linkCtx, pin = pinCtx, field = fieldLinkCtx; // field: a link field picking its value (renderer/fields.js)
  const rows = nodes.map((n) => ({ ...docRow(n, n.meta, () => (field ? pickLink(field, n) : ctx ? linkTo(ctx, { label: n.title ?? n.text, uri: n.id, ...(n.icon ? { icon: n.icon } : {}), ...(n.hue != null ? { hue: n.hue } : {}) }) : pin ? pinResult(pin, n) : openResult(n, 'Search'))), ...(field || ctx || pin ? {} : { opens: n.id }), group }));
  // a link field that holds something can be emptied here too, as an options field can; last, so Enter never clears
  if (field && group === undefined && choiceValues(field).length && fuzzyMatch('Clear value', palInput.value.trim())) rows.push({ group: field.field.label || 'Value', icon: 'none', label: 'Clear value', run: () => writeChoice(field, []) });
  if (!ctx) return rows;
  if (ctx.composer) rows.unshift(...tanaMentionRows(palInput.value.trim(), ctx), ...agentMentionRows(palInput.value.trim(), ctx)); // a chat's "@" can ask Tana itself, or an agent on this device (renderer/chat.js)
  const title = ctx.text || palInput.value.trim(); // "@" at a caret has no selection: what is typed becomes the new document's title
  if (!title) return rows;
  // words that read as a day ("friday", "12 oct", "tomorrow": parseDay) also offer that date, first, as Tana's "@" does
  const day = parseDay(title);
  const date = day ? [{ date: true, icon: 'today', label: dayLabel(day), hint: day === localDate() ? 'Today' : day === localDate(1) ? 'Tomorrow' : new Date(day + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' }),
    run: () => linkTo(ctx, { label: dayLabel(day), uri: dayUri(day) }) }] : [];
  return [...date, { create: true, label: 'Create “' + title + '”', hint: '⌘↩', run: () => createAndLink(ctx, title) }, ...rows];
}
// The active meeting behind the Pin to meeting row. Asked once per palette open (togglePalette clears it), because a
// lookup is a round trip and the row is rebuilt on every keystroke; a failure is kept as the reason the row shows.
// Process image (issue #507) from Cmd+K only, so neither row has an id a key could be recorded on: the image row the
// selection or the caret is on, and the clipboard's image when it holds one (clipImage, asked each time ⌘K or the
// Create new … page opens).
let clipImage = false;
const clipImageRow = () => ({ group: 'Image', icon: 'imageSparkle', label: 'Process image from clipboard', hint: 'Make it a task or a note', run: () => processImage({ clipboard: true }) });
function processImageRows() {
  const node = [...selKeys(), palReturn && palReturn.key].map((k) => k && items.get(k)?.node).find((n) => n && isImage(n)), rows = [];
  if (node) { const uri = node.image.uri; rows.push({ group: 'Image', icon: 'imageSparkle', label: 'Process image', hint: 'Make it a task or a note', run: () => processImage({ uri }) }); }
  if (clipImage) rows.push(clipImageRow());
  return rows;
}
function loadClipImage() {
  clipImage = false;
  tana.clipboardHasImage?.().then((has) => { clipImage = has === true; if (clipImage && (palMode === 'cmd' || palMode === 'create') && !palette.hidden) renderPalette(); }, () => {});
}
function loadMeeting() {
  if (!tana.currentMeeting || meetingNow !== undefined) return;
  meetingNow = { meeting: null, pending: true }; // asked: the row says Checking… until this is replaced
  tana.currentMeeting().then((meeting) => { meetingNow = { meeting }; }, (e) => { meetingNow = { meeting: null, error: (e && e.message) || String(e) }; })
    .then(() => { if (palMode === 'cmd' && !palette.hidden) renderPalette(); });
}
// Pin the node onto the meeting, looking the meeting up again first: the palette may have been open for minutes and
// "the meeting I am in" outlives that by not much. A lookup that fails is reported like any other failed action
// rather than read as "no meeting". The pin itself is idempotent — sdk/pins.js dedups on uri — so a second press on
// an already pinned node writes nothing new.
function pinToMeeting(doc) {
  return run(async () => {
    const live = await tana.currentMeeting();
    meetingNow = { meeting: live || null };
    if (!live) throw new Error('No active meeting to pin to');
    await pinDocToMeeting(live.id, doc.id);
  });
}
// ---- the meeting picker: a page of meetings to pin the current node on ----
// The list is the old Meetings view's query — the meetings I take part in from a week back to a week ahead (the
// 'recent' window in sdk/query.js) — read through searchPreview, which runs a filter without storing it. One call
// per open, matched here with the palette’s own matcher, so typing costs no round trip; the rows are ordinary
// document rows, so each carries the meeting’s own date and time as its hint and same-named meetings are told apart.
const MEETING_GROUP = 'Meetings';
const MEETING_FILTER = { types: ['meetings'], participant: 'me', window: 'week' };
// Next meeting first, against the clock at the moment the page opens: what is on now or still to come, soonest
// first, then what is over, most recent first. It reads the event window the row carries (`start`/`end`, ISO from
// the graph), never the `meta` label, which says "Fri 08:20" for six days either side of today and cannot be
// ordered. Array.prototype.sort is stable, so meetings sharing a start keep the order the server gave them.
const eventStart = (m) => Date.parse(m.start) || 0;
const byNextFirst = (now) => (a, b) => {
  const ahead = (m) => (m.end ? Date.parse(m.end) : eventStart(m)) >= now; // in progress counts as ahead, not past
  return (ahead(b) - ahead(a)) || (ahead(a) ? eventStart(a) - eventStart(b) : eventStart(b) - eventStart(a));
};
// sorted once, here: the page is ordered by time and a query only filters it, so matches never reorder — and every
// open loads again, so the order is always against the current time rather than the one it was drawn with.
const loadMeetingList = () => loadList('pinMeeting', () => tana.searchPreview(MEETING_FILTER), (list) => { meetingList = Array.isArray(list) ? list.sort(byNextFirst(Date.now())) : list; });
const meetingPickRows = (q) => listRows(MEETING_GROUP, meetingList, q, 'No meetings in the last week or the week ahead', (list) => list.filter((m) => fuzzyMatch(String(m.text ?? m.title ?? ''), q))
  .map((m) => ({ ...docRow(m, undefined, () => run(() => pinDocToMeeting(m.id, pinMeetingDoc.id))), group: MEETING_GROUP })));
function openMeetingPicker(doc, back) {
  // opened from the command page and from Edit pins, so Escape steps back to whichever asked (the command page by default)
  pinMeetingDoc = doc; loadMeetingList();
  openPage('pinMeeting', 'Pin to which meeting?', { rows: meetingPickRows, back: back || BACK_TO_COMMANDS });
}
// ---- Set type: the types this document can be given, and "No type", which takes the one it has off ----
// Which types those are is main's answer (main/documents.js typeChoices): a type applies to documents or to meetings,
// and a type that lives in a space can only go on a document in that space, while a Library type goes on anything.
// A type that does not fit is listed and disabled with the space it belongs to, so the list answers "why not this
// one?" instead of leaving it out.
const TYPE_GROUP = 'Type';
const TYPED_KIND = /^tana:(text|event):/; // only a document or a meeting carries a type
const typeNameOf = (n) => (((n.tags || []).find((t) => t && t.uri) || {}).label || ''); // the chip the row already shows
let typeCtx = null, typeList = null, typeListError = null; // the document the page is about, and main's answer for it
function loadTypeList(doc) {
  typeList = null; typeListError = null;
  return tana.docTypes(doc.id).then(
    (list) => { typeList = list && Array.isArray(list.options) ? list : { current: null, options: [] }; },
    (e) => { typeListError = (e && e.message) || String(e); },
  ).then(() => { if (palMode === 'setType') renderPalette(); });
}
// the list as a promise, so the folded level under "Set type" can show it before the page is opened
async function typesLoaded(doc) { typeCtx = doc; await loadTypeList(doc); }
function typeRows(q) {
  const doc = typeCtx;
  if (!doc) return [];
  if (typeListError) return [{ group: TYPE_GROUP, label: typeListError, disabled: true }];
  if (!typeList) return [{ group: TYPE_GROUP, label: 'Loading…', disabled: true }];
  const rows = [];
  // Only when there is one to remove: an untyped document offered "No type" would be a row that does nothing.
  if (typeList.current && fuzzyMatch('No type', q)) rows.push({ group: TYPE_GROUP, icon: 'none', label: 'No type', hint: 'Removes the type', keepOpen: true, run: () => applyType(doc, null) });
  for (const t of typeList.options) {
    if (!fuzzyMatch(t.title || '', q)) continue;
    const current = t.uri === typeList.current;
    rows.push({ group: TYPE_GROUP, icon: typeGlyph(t.uri), label: t.title || 'Untitled type',
      hint: current ? '✓' : t.selectable ? '' : t.reason || 'Lives in another space',
      disabled: !t.selectable || current, keepOpen: true, run: () => applyType(doc, t.uri) });
  }
  if (!rows.length && !q) rows.push({ group: TYPE_GROUP, label: 'No types for this kind of document', disabled: true });
  return rows;
}
function openTypePalette(doc) {
  typeCtx = doc; loadTypeList(doc);
  openPage('setType', 'Set type to…', { rows: typeRows, back: BACK_TO_COMMANDS });
}
// ---- Auto-pick type: the model weighs the types Set type would offer, "No type" among them ----
// One call per open (main/ai.js classifyType). A type it is sure of is applied at once, as choosing it on Set type
// would; anything less sure is the list, most likely first, with the odds beside each, and the choice is yours.
// "No type" is only ever applied by choosing it: a model sure that nothing fits takes no type off on its own.
const CLASSIFY_GROUP = 'Auto-pick type';
const CLASSIFY_SURE = 0.8; // ponytail: the model's own odds, uncalibrated; raise it if it applies types you would not
let classifyCtx = null, classifyAI = null; // the document, and { state: 'thinking'|'ready'|'failed', current, choices, error }
function openClassifyPalette(doc) {
  classifyCtx = doc;
  const mine = classifyAI = { state: 'thinking' };
  tana.classifyType(doc.id).then(
    (answer) => { mine.state = 'ready'; mine.current = (answer && answer.current) || null; mine.choices = (answer && answer.choices) || []; },
    (e) => { mine.state = 'failed'; mine.error = (e && e.message) || String(e); },
  ).then(() => {
    if (classifyAI !== mine || palMode !== 'classify') return; // a page left in the meantime is neither redrawn nor written
    const best = mine.state === 'ready' && mine.choices[0];
    if (!best || !best.uri || best.p < CLASSIFY_SURE) return renderPalette();
    const sure = best.title + ' (' + Math.round(best.p * 100) + '%)';
    if (best.uri === mine.current) { closePalette(); showNote('Already ' + sure); return; }
    renderPalette(); // the list is up while the type is written, so a refused write leaves it there to choose from
    run(async () => { await tana.setType(doc.id, best.uri); closePalette(); showNote('Type set to ' + sure); });
  });
  openPage('classify', 'Auto-pick type…', { rows: classifyRows, back: BACK_TO_COMMANDS });
}
function classifyRows(q) {
  const doc = classifyCtx, ai = classifyAI;
  if (!doc || !ai) return [];
  if (ai.state === 'thinking') return [{ group: CLASSIFY_GROUP, icon: 'sparkle', spin: true, label: 'Reading the document\u2026', disabled: true }];
  if (ai.state === 'failed') return [{ group: CLASSIFY_GROUP, icon: 'sparkle', label: ai.error, disabled: true }];
  const rows = [];
  for (const c of ai.choices) {
    if (!fuzzyMatch(c.title || '', q)) continue;
    const odds = Math.round(c.p * 100) + '%', current = (c.uri || null) === ai.current;
    rows.push({ group: CLASSIFY_GROUP, icon: c.uri ? typeGlyph(c.uri) : 'none', label: c.title, hint: current ? odds + ' \u2713' : odds,
      disabled: current, keepOpen: true, run: () => applyType(doc, c.uri) });
  }
  if (!rows.length && !q) rows.push({ group: CLASSIFY_GROUP, label: 'No type matches', disabled: true }); // with a query, the palette's "No results"
  return rows;
}

// ---- Discuss with …: the Discussion Task type and the one field it exists for, in a single answer ----
// Main owns both writes (main/documents.js discussWith): it finds the type by title, creates it in the Library with
// its "Discuss with" field when the workspace has none, types the document and writes the words. The field holds
// text, not a member reference — a real value as often names a team ("Heads of Technology") or two people at once
// as it does one colleague — so the page is the palette's own field and whatever is typed is the answer.
const DISCUSS_GROUP = 'Discuss with';
let discussCtx = null; // the document the page is about
// and what the model made of its title, while this page is open: { title, state: 'thinking'|'ready'|'failed', value, error }
let discussAI = null;
// One read per open, not per keystroke: the title does not change while the page is up. A page opened again asks
// again, which is how a key added in the meantime starts working without a restart.
function loadDiscussSuggestion(doc) {
  const title = (doc.text || '').trim();
  discussAI = tana.suggestDiscussWith && title ? { title, state: 'thinking' } : null;
  if (!discussAI) return;
  const mine = discussAI;
  tana.suggestDiscussWith(title).then(
    (value) => { mine.state = 'ready'; mine.value = typeof value === 'string' ? value.trim() : ''; mine.arriving = true; },
    (e) => { mine.state = 'failed'; mine.error = (e && e.message) || String(e); mine.arriving = true; },
  ).then(() => { if (discussAI === mine && palMode === 'discuss') renderPalette(); }); // a page left in the meantime is not redrawn
}
function discussRows(q, typed) {
  const doc = discussCtx, words = (typed || '').trim();
  if (!doc) return [];
  // Same glyph on the placeholder as on the row it becomes, so the line does not step sideways once there is
  // something to run.
  const rows = words
    ? [{ group: DISCUSS_GROUP, icon: 'member', label: '\u201C' + words + '\u201D', hint: '\u21A9', run: () => applyDiscussWith(doc, words) }]
    : [{ group: DISCUSS_GROUP, icon: 'member', label: 'Type who this is for', disabled: true }];
  // What the title suggests goes *under* what you typed, never above it: Enter is always your own answer, and the
  // suggestion is one arrow key away. It says it is thinking rather than appearing out of nowhere, and says why
  // when the call failed rather than looking like a title that named nobody.
  const guess = discussAI;
  // The turning glyph would otherwise stop dead the moment the answer lands. `arrive` marks the one build that
  // follows the answer — it is spent here, so the letters typed after it rebuild the row without replaying the
  // landing — and the row that carries it settles out of the spin instead of being swapped for a still one.
  const arrive = !!(guess && guess.arriving);
  if (guess) guess.arriving = false;
  if (guess && guess.state === 'thinking') rows.push({ group: DISCUSS_GROUP, icon: 'sparkle', spin: true, label: 'Reading the title\u2026', disabled: true });
  else if (guess && guess.state === 'failed') rows.push({ group: DISCUSS_GROUP, icon: 'sparkle', arrive, label: guess.error, disabled: true });
  else if (guess && guess.value && guess.value !== words) rows.push({ group: DISCUSS_GROUP, icon: 'sparkle', arrive, label: '\u201C' + (demoMode ? demoPersonName(guess.value, demoWordCount(guess.value)) : guess.value) + '\u201D', hint: 'From the title', run: () => applyDiscussWith(doc, guess.value) });
  return rows;
}
function applyDiscussWith(doc, who) {
  // Like a retype (applyType): the row, the chip and the page's fields all follow main's change event for this
  // document, so nothing is patched here.
  run(async () => { await tana.discussWith(doc.id, who); closePalette(); });
}
function openDiscussPalette(doc) {
  discussCtx = doc; loadDiscussSuggestion(doc);
  openPage('discuss', 'Discuss with…', { rows: discussRows, back: BACK_TO_COMMANDS, typed: true });
}
// ---- Set icon: the Nucleo UI set built into the app, searched in main, a page of results at a time ----
// The set is not in the renderer: main holds it (3.5k glyphs, half a megabyte gzipped) and answers with the page
// being shown, which is registered as it arrives so the rows can draw it. Choosing writes the choice against the
// type and main rebuilds the rows — every document of that type carries the icon's name, so they all follow.
const ICON_GROUP = 'Icon';
const TYPE_NODE = /^tana:type:[0-9a-z]{26}$/;
let iconCtx = null, iconList = [];
function searchIconsNow() {
  const seq = ++palSeq, q = palInput.value.trim();
  tana.searchIcons(q).then((list) => {
    if (seq !== palSeq || palMode !== 'setIcon') return;
    iconList = Array.isArray(list) ? list : [];
    registerIcons(iconList); // the rows about to be drawn name these glyphs
    palBusy = false; renderPalette(); settleEnter();
  }, (e) => { if (seq === palSeq) { palBusy = false; iconList = []; showError(e); renderPalette(); } });
}
function iconPickRows(q) {
  const doc = iconCtx;
  if (!doc) return [];
  const rows = [];
  // narrowed with the rest, as Unassigned is (memberRows): leading whatever was typed, Enter after "calendar" took the icon off
  if (typeGlyphs.has(doc.id) && fuzzyMatch('No icon', q)) rows.push({ group: ICON_GROUP, icon: 'none', label: 'No icon', hint: 'Back to the generic glyph', keepOpen: true, run: () => applyIcon(doc, null) });
  for (const icon of iconList) rows.push({ group: ICON_GROUP, icon: icon.name, label: icon.label,
    hint: typeGlyphs.get(doc.id) === icon.name ? '✓' : '', keepOpen: true, run: () => applyIcon(doc, icon.name) });
  if (!rows.length && (palBusy || !q)) rows.push({ group: ICON_GROUP, label: palBusy ? 'Loading…' : 'No icon matches', disabled: true }); // a query that finds none: "No results"
  return rows;
}
function openIconPalette(doc) {
  iconCtx = doc; showPage('setIcon', 'Search icons…', { rows: iconPickRows, back: BACK_TO_COMMANDS }); palBusy = true; iconList = [];
  searchIconsNow(); renderPalette(); palInput.focus();
}
// The rows redraw themselves: main rebuilds the cached rows with the new name and announces it, which reloads the
// roots — and that load is where the glyphs are registered, so a name a row carries always has markup behind it.
function applyIcon(doc, name) {
  run(async () => {
    const chosen = await tana.setTypeIcon(doc.id, name);
    if (chosen) { registerIcons([chosen]); typeGlyphs.set(doc.id, chosen.name); } else typeGlyphs.delete(doc.id);
    patchFieldGlyphs(doc.id); // a field's glyph shows now, even with the caret in its value
    closePalette();
  });
}
// ---- Set colour: the hue Tana keeps on a type (appearance.hue, 0-360) ----
// The picker is the palette itself: one row per colour, each drawn with the glyph the type already wears, in the
// colour it would become — the same tint its documents, chips and bullets get. Typing narrows by name, and typing
// a number picks that hue exactly, since the wheel has 360 of them and a list of twelve does not.
const HUE_GROUP = 'Colour';
const HUES = [['Red', 0], ['Orange', 30], ['Yellow', 60], ['Lime', 90], ['Green', 120], ['Sea', 150], ['Cyan', 180],
  ['Sky', 210], ['Blue', 240], ['Violet', 270], ['Magenta', 300], ['Pink', 330]];
let hueCtx = null;
function huePickRows(q) {
  const doc = hueCtx;
  if (!doc) return [];
  const glyph = typeGlyph(doc.id);
  const rows = [];
  const typed = Number(q);
  if (q && Number.isInteger(typed) && typed >= 0 && typed <= 360 && !HUES.some(([, h]) => h === typed)) {
    rows.push({ group: HUE_GROUP, icon: glyph, hue: typed, label: 'Hue ' + typed, hint: doc.hue === typed ? '✓' : 'Exact', keepOpen: true, run: () => applyHue(doc, typed) });
  }
  for (const [name, hue] of HUES) {
    if (!fuzzyMatch(name, q) && String(hue) !== q) continue;
    rows.push({ group: HUE_GROUP, icon: glyph, hue, label: name, hint: doc.hue === hue ? '✓' : String(hue), keepOpen: true, run: () => applyHue(doc, hue) });
  }
  if (fuzzyMatch('Grey', q)) rows.push({ group: HUE_GROUP, icon: glyph, label: 'Grey', hint: doc.hue == null ? '✓' : 'No tint, whatever Tana says', keepOpen: true, run: () => applyHue(doc, 'grey') });
  if (fuzzyMatch("Tana's colour", q)) rows.push({ group: HUE_GROUP, icon: 'none', label: "Tana's colour", hint: 'Forget the override', keepOpen: true, run: () => applyHue(doc, null) });
  return rows;
}
function openHuePalette(doc) {
  hueCtx = doc; openPage('setHue', 'Choose a colour or type a hue…', { rows: huePickRows, back: BACK_TO_COMMANDS });
}
// Written into this app's settings, so everything wearing the type follows here and Tana keeps its own colour. Main
// rebuilds the rows and announces them, the same way the icon does; the node in hand is patched so the page it
// came from agrees — a forgotten override shows Tana's hue again, which only the rebuilt rows know.
function applyHue(doc, hue) {
  run(async () => {
    await tana.setTypeHue(doc.id, hue);
    if (hue !== null) doc.hue = hue === 'grey' ? undefined : hue;
    closePalette();
  });
}
// The row redraws itself: main's change event carries the document, and doc:info rebuilds a row whose type has moved
// on rather than handing back the cached one (main/documents.js info).
function applyType(doc, uri) {
  run(async () => { await tana.setType(doc.id, uri); closePalette(); });
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
  const scope = fieldLinkCtx ? linkScope(fieldLinkCtx.field) : undefined; // a link field lists what it may link to, typed or not
  if (!q && !scope) { palRows = resultRows(recentRows(), 'RECENTLY VIEWED'); return renderPalette(); }
  tana.search(q, scope).then((all) => {
    if (seq !== palSeq || palMode !== 'search') return; // stale response
    // What only Tana's semantic search found (`related`, main/views.js) keeps its own order under its own heading.
    const found = all.filter((n) => !n.related), related = all.filter((n) => n.related);
    // Tana's order does not weigh the title: a document that only mentions the words in its body can lead one titled
    // with them. The titles holding the most typed words come first, then those where more of them begin a word, and
    // Tana's order among equals. Only those words are bold, not the looser Cmd+K letter match.
    const score = new Map(found.map((n) => [n, titleHits(n.title ?? n.text ?? '', q)]));
    const nodes = found.map((n, i) => ({ n, i })).sort((a, b) => score.get(b.n).hits - score.get(a.n).hits || score.get(b.n).starts - score.get(a.n).starts || a.i - b.i).map(({ n }) => n);
    palRows = [...resultRows(nodes), ...resultRows(related, 'RELATED').filter((row) => row.node)] // its documents only: the date and Create rows lead once
      .map((row) => (row.node ? { ...row, match: titleHits(row.label ?? '', q) } : row));
    // Linking: a result is only the obvious choice when its title starts with what was typed. A full-text hit
    // that merely mentions the words is not, so "Create" stays selected and Enter creates. Words that read as a
    // day are that date before anything else.
    const starts = nodes.findIndex((n) => (n.title ?? n.text ?? '').toLowerCase().startsWith(q.toLowerCase()));
    palIndex = linkCtx && starts >= 0 && !(palRows[0] && palRows[0].date) ? starts + palRows.filter((r) => r.create).length : 0;
    palBusy = false;
    renderPalette();
    settleEnter();
  }, showError);
}
function todayPickerRows(q) {
  const group = 'Open tasks assigned to you';
  if (palBusy || todayPickerResults === null) return [{ group, label: 'Searching…', disabled: true }];
  const pinned = new Set((todayPickerNode?.children || []).map((n) => n.id));
  const rows = todayPickerResults.filter((n) => !pinned.has(n.id)).map(asDoc)
    .map((n) => ({ ...docRow(n, n.meta, () => pinTodayResult(n)), group }));
  return rows.length ? rows : q ? [] : [{ group, label: 'No open tasks to add', disabled: true }];
}
function todayPickerSearchNow() {
  const q = palInput.value.trim(), seq = ++palSeq;
  palTimer = null; palBusy = true; renderPalette();
  tana.searchPreview({ types: ['tasks'], states: ['open'], assignee: 'me', text: q }).then((nodes) => {
    if (seq !== palSeq || palMode !== 'pinToday') return;
    todayPickerResults = nodes || []; palBusy = false; renderPalette(); settleEnter();
  }, (e) => {
    if (seq !== palSeq || palMode !== 'pinToday') return;
    todayPickerResults = []; palBusy = false; showError(e); renderPalette();
  });
}
function pinTodayResult(node) {
  run(async () => {
    await tana.pin(node.id, 'today');
    loadPinned(true);
    await reload(TIMELINE_PAGE);
    render(true);
  });
}
function openTodayTaskSearch(node) {
  todayPickerNode = node; todayPickerResults = null;
  togglePalette('pinToday');
  todayPickerSearchNow();
}
// "⇧⌘K Set key" at the end of the field, while the highlighted command is one ⇧⌘K can record a key for (the keydown
// handler's own test) and nowhere else: it never offers what the key would not do.
function keyHint() { const r = palRows[palIndex]; palKeyHint.hidden = !(palMode === 'cmd' && r && r.id); }
function renderPalette() {
  const q = palInput.value.trim();
  swapPanel(palList, palMode); // a mode changed while open slides its list across
  if (palPage.rows) palRows = palPage.rows(q.toLowerCase(), q); // search and Move to … set theirs when main answers
  palIndex = Math.max(0, Math.min(palIndex, palRows.length - 1));
  const els = [];
  palRows.forEach((r, i) => {
    if (r.group && (!i || palRows[i - 1].group !== r.group)) { const h = document.createElement('div'); h.className = 'group'; h.textContent = r.group; els.push(h); }
    const row = document.createElement('div'); row.className = 'row' + (i === palIndex ? ' active' : '') + (r.disabled ? ' disabled' : '') + (r.note ? ' note' : '') + (r.wrap ? ' wrap' : '') + (r.arrive ? ' arrive' : '') + (r.bare ? ' bare' : ''); row.dataset.index = i;
    // a row names its glyph, or hands over the markup itself (the "/" menu's block glyphs, the refusal ban)
    const icon = document.createElement('span'); icon.className = 'ricon' + (r.node ? ' ' + (r.icon || 'dot') : ''); if (r.icon) addIcon(icon, r.icon); else icon.innerHTML = r.svg || ''; // r.svg: our own markup (glyphSvg, banSvg)
    if (r.spin) icon.classList.add('thinking'); // a row waiting on an answer: its glyph breathes while it waits
    const rowHue = r.hue; // only the Set colour page carries one: every other glyph is monochrome
    if (rowHue != null) { icon.classList.add('hue'); icon.style.setProperty('--hue', String(rowHue)); }
    const label = document.createElement('span'); label.className = 'label';
    if (r.sweep) label.classList.add('sweep'); // a row waiting on someone else: a light passes over its words, as over "Thinking…" in a chat
    const match = r.match || (q ? fuzzyMatch(r.label, q.toLowerCase()) : null); // every level: the letters the query matched, in bold
    if (demoMode && r.node) label.textContent = demoText(r.label, r.node.id); // a document's title is content: masked, and no highlight to give its words away
    else if (match && match.length) {
      const hit = new Set(match); let run = '', bold = false;
      const flushRun = () => { if (!run) return; if (bold) { const b = document.createElement('b'); b.textContent = run; label.append(b); } else label.append(run); run = ''; };
      for (let i = 0; i < r.label.length; i++) { if (hit.has(i) !== bold) { flushRun(); bold = hit.has(i); } run += r.label[i]; }
      flushRun();
    } else label.textContent = r.label;
    for (const t of r.tags || []) label.append(chipEl(t, r.node && r.node.hue));
    blurSensitive(label, r.node && r.node.id);
    row.append(icon, label);
    if (r.right) { const s = document.createElement('span'); s.className = 'ricon right'; row.append(addIcon(s, r.right)); }
    if (r.kbd) { const k = document.createElement('kbd'); k.textContent = r.kbd; row.append(k); }
    if (r.hint) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = demoMeta(r.node, r.hint); blurSensitive(h, r.node && r.node.id); row.append(h); }
    row.onmousedown = (e) => e.preventDefault();
    row.onclick = (e) => openRow(r, elsewhere(e)); // ⌘/⇧/⌥-click opens it where ⌘↩/⇧↩/⌥↩ would
    // the pointer moves the one highlight, as ↑/↓ do (and past the same rows): a pointer that only rests there does not
    row.onmousemove = () => {
      if (palIndex === i || (r.disabled && !r.id)) return;
      if (palRows[i] !== r) return renderPalette(); // the rows changed under the drawn list (invalidateNode): draw them again first
      palList.querySelector('.row.active')?.classList.remove('active');
      row.classList.add('active'); palIndex = i;
      keyHint();
    };
    els.push(row);
  });
  // "No results" belongs under a list that was searched and found nothing. A typed page is not a list: the agent
  // prompt, "Discuss with …", a meeting's time or place and a field turn what is typed into their row. Any row is a
  // result, except on Cmd+S, whose Create, date, Clear value and @ mention rows are offered whatever it found (#656).
  if (!palRows.some((r) => palMode !== 'search' || r.node || r.note) && !palPage.typed && (palMode === 'cmd' || palMode === 'slash' || (q && !palBusy))) { const n = document.createElement('div'); n.className = 'group'; n.textContent = 'No results'; els.push(n); }
  palList.replaceChildren(...els);
  keyHint();
  const active = palList.querySelector('.row.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}
// opens the palette in mode, closes it when already open in that mode; opening one mode closes the other.
// link = @ linking context; pin = relationship pin context. Both reuse search results.
function togglePalette(mode, link, pin) {
  // The Graph pane has no outline for Cmd+K or Cmd+S to act on: they open in the page it follows (shell.js), whose rows
  // (views, Create new …, results) are meant for it (#463 review). A picker one of its own rows opens stays here.
  if (LINKS && palette.hidden && !link && !pin && (mode === 'cmd' || mode === 'search')) return toShell({ orbital: 'palette', mode });
  const show = palette.hidden || palMode !== mode || !!link || !!pin;
  cancelLink(); pinCtx = null; pillCtx = null;
  palette.hidden = !show;
  if (!show) return closePalette(); // closing the way every other close does, so a field that opened it gets its focus back
  if (!palReturn) palReturn = returnTarget(); // switching modes keeps the original return target
  linkCtx = link || null;
  anchorPalette(link && link.rect);
  pinCtx = pin || null;
  if (mode !== 'slash') slashCtx = null;
  // ⌘K over the prompt page leaves it, without assigning
  showPage(mode, mode === 'search' ? 'Search Tana' : mode === 'pinToday' ? 'Search open tasks assigned to you' : mode === 'slash' ? 'Choose a block type or create' : 'Run a command',
    { cmd: { rows: paletteRows }, slash: { rows: slashRows }, pinToday: { rows: todayPickerRows } }[mode] || {}, link ? link.text : '');
  // meetingNow is cleared, not kept: every open re-reads the meeting, because "the meeting I am in" lasts minutes.
  fieldLinkCtx = null;
  if (mode === 'cmd') { palDoc = document.activeElement && document.activeElement.matches && document.activeElement.matches('.chat-msg[data-key]') ? null : currentDoc(); palField = fieldAt(document.activeElement); fieldReturn = palField && palField.key; palTaskCtx = null; meetingNow = undefined; meetingCtx = null; loadPins(); loadWorkspaceTypes(true); subCache.clear(); refreshChatGPTStatus(); loadClipImage(); }
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
function closePalette() {
  swapPanel(null, null);
  palette.hidden = true; clearTimeout(palTimer); palTimer = null; cancelLink(); pinCtx = null; pillCtx = null; fieldLinkCtx = null; promptEditor(false); returnFocus();
  anchorPalette(null); // an "@" dropdown's place and size go with it: a page opened next without togglePalette (Create new from the corner button, a recorded key) is the centred card
  coverWindow(null);
  const field = fieldReturn; fieldReturn = null;
  if (field && !focused()) focusField(field); // a field that holds choices is no row: returnFocus cannot find it
}
// ---- over every pane of the window (issue #409) ----
// The palette's scrim and card cover the whole window, not only this pane: while it is open the shell lays this
// page's iframe over the window, above every other pane, docked or floating (shell.js cover). The page goes on drawing
// itself in its pane (styles.css html.cover) and is see-through around it, so the others show under the scrim, live.
// The rows, the node acted on, the keys and the focus stay this page's: nothing of the palette moves. The pane is the
// box Trellis gives the iframe, which stays put while the iframe reaches past it, read in the shell's pixels and
// scaled to the page's (k: the two zoom apart, or Trellis scales the pane). The class follows the page's own size — on
// once the page is larger than its pane, off once it is back — so no frame is drawn out of place while the shell
// resizes it; any resize places it again. It lets go once the scrim has faded. A page alone is covered too, which
// changes nothing but the shell's drag strip, gone so the scrim takes its clicks. Outside the shell (the mock) there
// is no frame and no cover.
let covering = false, coverTimer = null;
const tellCover = (on) => { if (window.frameElement) window.parent.postMessage({ orbital: 'cover', on }, '*'); };
// The workspace's moves, asked of the shell the same way (shell.js run): [row id, label, Trellis command, icon]. Keys
// pressed in a page never reach the shell, so each is a row here with its key in DEFAULT_HOTKEYS.
const PANE_ROWS = [['otherPane', 'Next pane', 'panel.next', 'otherPane'], ['previousPane', 'Previous pane', 'panel.previous', 'otherPane'],
  ['nextTab', 'Next tab', 'tab.next', 'forward'], ['previousTab', 'Previous tab', 'tab.previous', 'back'],
  ['maximizePane', 'Maximize or restore pane', 'frame.toggle', 'zoomIn'], ['overview', 'Show all panes', 'navigation.overview', 'splitPanes'],
  ['zoomBack', 'Zoom back', 'navigation.back', 'back'], ['zoomForward', 'Zoom forward', 'navigation.forward', 'forward'],
  ['closePane', 'Close pane', 'view.close', 'closePane']];
const shellRun = (command) => { if (window.frameElement) window.parent.postMessage({ orbital: 'run', command }, '*'); };
// Opening a place somewhere other than this page (issues #443, #608), as is common elsewhere: ⌘ a tab in this pane (a
// browser's, Obsidian's), ⇧ a pane beside this one (Roam's and Logseq's sidebar), ⌥ a floating pane (no convention; the
// key left). Main gives the new page its id, and it opens on the place stored under that id (shell.js open, edit.js).
// A ⌘- or ⇧-click on a row's line still selects: only its bullet, a chat's links and cards reach here with those.
const elsewhere = (e) => (e.metaKey || e.ctrlKey ? 'tab' : e.shiftKey ? 'right' : e.altKey ? 'float' : null);
async function openElsewhere(where, docId, nodeId = null) {
  if (opensCanvas(docId)) return; // ⌘/⇧/⌥ on a canvas: its own window, as a plain click (renderer/edit.js, #611)
  if (inOtherPane(placeKey(docId, nodeId))) return; // already on screen in another pane: that pane takes the keys (#533)
  const d = docOf(docId) || {};
  await tana.splitWindow(where, { view, place: JSON.stringify({ docId, nodeId, title: d.text ?? d.title, icon: d.icon }) });
}
// ---- Saved views: the window's panes, and what each shows, under a name (issue #442) ----
// A view is the layout main keeps for the window (Trellis's document) and each page's view and place, under the keys
// the pages read at load: 'view' and 'place' for page '', 'view:2' and 'place:2' for page '2'. Opening one writes those
// back and hands main the layout, which reloads the window, so every page comes back where it was when saved. The list
// follows you (pref savedViews): a view names places, like a saved search does. It starts with the Work View
// (renderer/timeline.js), which is replaced like any other and never removed; replaced by name, a view keeps its id, so Home
// and a key recorded for it still find it.
// The Work View cannot be removed: a list without it (an older one, another machine's) still starts with it.
function savedViews() {
  const list = pref('savedViews', [WORK_VIEW]).filter((v) => v && typeof v.name === 'string' && v.keys && typeof v.keys === 'object');
  return list.some((v) => v.id === WORK_VIEW.id) ? list : [WORK_VIEW, ...list];
}
const PAGE_KEY = /^(view|place)(:[1-9]\d*)?$/;
async function saveView(name, id) { // id: kept under that id (Set as Home), else found by name
  const doc = await tana.windowLayout(), keys = {};
  if (doc) delete doc.navigation; // Trellis's zoom is how you were looking, not the view: a view opens with every pane shown
  const ids = doc ? Object.values(doc.views || {}).filter((v) => v && v.type === 'page').map((v) => String((v.params && v.params.side) || '')) : [''];
  for (const id of ids) for (const key of ['view', 'place']) keys[key + (id ? ':' + id : '')] = localStorage.getItem(key + (id ? ':' + id : ''));
  // A page on your day or week node is Today or This week (#639): the view reopens on the day and week it is opened in.
  // By id, found now and never made: they are your own documents (main/pins.js ownNode), not a colleague's of that title.
  // The places are read above, before this lookup, so a page moved meanwhile is saved where it was when asked.
  const find = (p) => Promise.resolve(p).catch(() => null);
  const [today, week] = await Promise.all([find(tana.todayNode && tana.todayNode(0, true)), find(tana.weekNode && tana.weekNode(true))]);
  for (const name of Object.keys(keys)) {
    let p = null;
    if (name.startsWith('place')) try { p = JSON.parse(keys[name]); } catch { /* not a place */ }
    const date = p && p.docId && !p.nodeId ? (p.docId === today ? 'today' : p.docId === week ? 'week' : null) : null;
    if (date) keys[name] = JSON.stringify({ [date]: true });
  }
  const old = savedViews().find((v) => (id ? v.id === id : v.name === name)), keep = id || (old && old.id);
  setPref('savedViews', [...savedViews().filter((v) => v !== old), { ...(keep ? { id: keep } : {}), name, doc, keys }]);
  showNote((old ? 'Updated' : 'Saved') + ' view \u201c' + name + '\u201d');
}
// plain async, for run() to queue: a queued step that queues another waits on itself. Main hands each page its keys as
// it loads (main.js starts), under the id it ends up with when another window has that id open.
async function openSavedView(v) {
  const keys = Object.fromEntries(Object.entries(v.keys).filter(([key]) => PAGE_KEY.test(key)).map(([key, value]) => [key, typeof value === 'string' ? value : null]));
  if (!(await tana.setWindowLayout(v.doc || null, keys))) showNote('This view could not be opened', true);
}
// A new name saves a new view; each saved view below, narrowed by what is typed, is updated to this window (its name
// and id kept, so Home, the Work View and a key recorded for it still find it).
function saveViewRows(q, typed) {
  const name = typed.trim(), views = savedViews(), group = 'Save view \u00b7 the panes in this window and what each shows';
  const rows = views.filter((v) => v.name.toLowerCase().includes(q)).map((v) => ({ group: 'Update a saved view', icon: 'splitPanes', label: v.name, hint: 'To this window', run: () => run(() => saveView(v.name, v.id)) }));
  if (name && !views.some((v) => v.name === name)) rows.unshift({ group, icon: 'createNew', label: 'Save view \u201c' + name + '\u201d', run: () => run(() => saveView(name)) });
  else if (!name && !rows.length) rows.push({ group, icon: 'splitPanes', label: 'Type a name for this view', disabled: true });
  return rows;
}
function openSaveViewPalette() { openPage('saveView', 'Name a new view, or pick one to update\u2026', { rows: saveViewRows, back: BACK_TO_COMMANDS, typed: true }); }
function removeViewRows(q) {
  return savedViews().filter((v) => v.id !== WORK_VIEW.id && v.name.toLowerCase().includes(q)).map((v) => ({ group: 'Remove saved view', icon: 'trash', label: v.name,
    run: () => { setPref('savedViews', savedViews().filter((w) => w.name !== v.name || (w.id || null) !== (v.id || null))); showNote('Removed view \u201c' + v.name + '\u201d'); } }));
}
function openRemoveViewPalette() { openPage('removeView', 'Remove saved view\u2026', { rows: removeViewRows, back: BACK_TO_COMMANDS }); }
function placeCover() {
  const root = document.documentElement, frame = window.frameElement;
  const half = covering && frame ? frame.parentElement.getBoundingClientRect() : null, box = half && frame.getBoundingClientRect(), k = box ? innerWidth / box.width : 1;
  const on = !!half && (innerWidth > half.width * k + 1 || innerHeight > half.height * k + 1);
  root.classList.toggle('cover', on);
  if (on) for (const [name, value] of [['x', half.left - box.left], ['y', half.top - box.top], ['w', half.width], ['h', half.height]]) root.style.setProperty('--pane-' + name, value * k + 'px');
}
function coverWindow(mode) { // the page shown, or null once the palette has closed
  const on = !!mode && mode !== 'slash' && !palette.classList.contains('anchored'); // the @ and / menus belong to their spot in this half
  clearTimeout(coverTimer); coverTimer = null;
  if (!window.frameElement || on === covering) return;
  if (on) { covering = true; tellCover(true); placeCover(); }
  else coverTimer = setTimeout(() => { covering = false; tellCover(false); }, MOTION.quick);
}
addEventListener('resize', placeCover);
// back to the node that had the caret when the palette opened (the @ link path places its own caret); with nothing to
// return to (a row selection, the sidebar) the hidden input must not keep the keys, so it lets go of the focus
// Where the focus goes back to when the palette closes: the caret's row, or the sidebar row the palette was opened from
// (a sidebar row is no caret: it is found again by its id, since the sidebar may have been drawn again meanwhile).
const returnTarget = () => focused() || (railEl.contains(document.activeElement) && document.activeElement.dataset.id ? { rail: document.activeElement.dataset.id } : null)
  || (outline.contains(document.activeElement) && document.activeElement.matches('.chat-msg[data-key]') ? { chatMsg: document.activeElement.dataset.key } : null); // a chat's selected message (renderer/chat.js)
function returnFocus() {
  const r = palReturn; palReturn = null;
  const railRow = r && r.rail && railEl.querySelector('.rrow[data-id="' + CSS.escape(r.rail) + '"]');
  if (railRow) railRow.focus();
  else if (r && r.key && !focused()) (r.cell ? placeCell(r.key, r.cell, r.offset) : placeCaret(r.key, r.offset));
  else if (r && r.composer && !composer.hidden) composerText.focus(); // a chat's composer opened it (renderer/chat.js)
  else if (r && r.chatMsg && chatFocus(r.chatMsg)) { /* back on the message it was opened over, unless a row deleted it */ }
  else if (document.activeElement === palInput) palInput.blur();
}
function runRow(r) { if (!r || r.disabled) return; if (!r.keepOpen) closePalette(); r.run(); }
// Up/Down step over rows that cannot run (info lines, unavailable choices) so the keyboard never lands on a dead row.
// A disabled row with a stable id is not dead: Cmd+Shift+K records a shortcut against it, which is how Clean up gets
// a key before there is anything to clean up. Enter on it still does nothing, since runRow refuses it.
function nextPalIndex(rows, index, step) {
  const n = rows.length;
  for (let i = 1; i <= n; i++) { const next = ((index + step * i) % n + n) % n; if (!rows[next].disabled || rows[next].id) return next; }
  return index;
}
// ↑/↓ only move the highlight: the rows are the ones already drawn, so the class moves between two of them and nothing
// is rebuilt (#272). Rows that changed without a redraw (a document removed while the list was up) are drawn again.
function movePalIndex(step) {
  const drawn = palList.querySelectorAll('.row');
  palIndex = nextPalIndex(palRows, palIndex, step);
  if (drawn.length !== palRows.length) return renderPalette();
  drawn.forEach((row, i) => row.classList.toggle('active', i === palIndex));
  keyHint();
  drawn[palIndex].scrollIntoView({ block: 'nearest' });
}
// pages whose rows are built from what is typed, with nothing to fetch
// Typing redraws the page from what is typed, except on the four pages whose rows main finds: those ask it, debounced
// like the document search, and say they are busy meanwhile. There is no list of the other pages to keep in step: one
// missing from it (Pin to date) ignored every key and sent a search nobody read (#297).
palInput.addEventListener('input', () => {
  palIndex = 0; palEnter = null; // typing on supersedes an Enter that was waiting for the previous query
  // palSeq++ on each: an answer to the words before, landing during the debounce, would draw its rows and settle the
  // Enter waiting for these words with them (#397 review)
  if (palMode === 'setIcon') { palSeq++; palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchIconsNow, 150); return renderPalette(); }
  if (palMode === 'spaces') { palSeq++; palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchSpacesNow, 150); return; }
  if (palMode === 'pinToday') { palSeq++; palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(todayPickerSearchNow, 150); return; }
  if (palMode === 'search') { palSeq++; palBusy = true; clearTimeout(palTimer); palTimer = setTimeout(searchNow, 150); return; }
  renderPalette();
  // what was typed narrowed the page to something to do: a note leading it ("No pin matches" in Edit pins) is not
  // where Enter lands, so the highlight starts on the first row that does something. Only on typing: a page drawn
  // again after its own Enter (the last pin taken off) keeps the note, so a quick second Enter adds nothing.
  if (palRows[palIndex]?.disabled && !palRows[palIndex].id && nextPalIndex(palRows, palIndex, 1) !== palIndex) movePalIndex(1);
});
palInput.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (palPage.keys && palPage.keys(e)) { e.preventDefault(); e.stopPropagation(); } // a page's own keys (Edit choices: ⌘⌫, ⇧⌘↑/↓)
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (linkCtx) linkCtx.typed = palInput.value; backPalette(); } // what was typed into an "@" search goes on after the "@" (toolbar.js cancelLink)
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && palRows.length) { e.preventDefault(); e.stopPropagation(); movePalIndex(e.key === 'ArrowDown' ? 1 : -1); }
  else if (e.key === 'Enter') { // ⌘↩ / ⇧↩ / ⌥↩ on a row that opens a place: a tab in this pane, a pane beside, or floating (while linking, ⌘↩ creates)
    e.preventDefault(); e.stopPropagation();
    chooseRow(mod, !linkCtx && elsewhere(e));
  }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); const r = palRows[palIndex]; if (palMode === 'cmd' && r && r.id) openRecorder(r); }
});
palette.addEventListener('mousedown', (e) => { if (e.target === palette) closePalette(); });

// ---- hotkeys: Cmd+Shift+K on a Cmd+K row records a combo (the synced "hotkeys" preference); the outline dispatches it ----
const KEYNAMES = { Enter: '↩', Backspace: '⌫', Tab: '⇥', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space' };
// by the key pressed rather than what it types, which ⌥ and ⇧ change (⌥⌘[ types “, ⇧⌘/ types ?)
const KEYCODES = { BracketLeft: '[', BracketRight: ']', Backslash: '\\', Slash: '/' };
// "⌃⌥⇧⌘" + key ("M", "1", "↩"); modifiers alone while only they are pressed
function comboOf(e) {
  const mods = (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '');
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return mods;
  return mods + (/^(Key|Digit)/.test(e.code) ? e.code.slice(-1) : KEYCODES[e.code] || KEYNAMES[e.key] || (e.key.length === 1 ? e.key.toUpperCase() : e.key));
}
const validCombo = (c) => (/[⌘⌃]/.test(c) || /^[⌥⇧]*F\d{1,2}$/.test(c)) && c.replace(/[⌃⌥⇧⌘]/g, '') !== ''; // ⌘ or ⌃ plus a key, or a function key (F6), so typing is never hijacked
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
  const fold = row || node ? -1 : other.indexOf('>'), parent = fold > 0 && paletteRows('').find((r) => r.sub && (r.id || r.rank) === other.slice(0, fold));
  const folded = fold > 0 && (parent ? subBase(parent) + ' ' : '') + other.slice(fold + 1); // "status>Later" while it is folded away: "Set status to Later"
  return combo + ' is already the shortcut for "' + (row ? row.label : node ? node.text : folded || other.replace(/([A-Z])/g, ' $1').toLowerCase()) + '"'; // a row absent right now (Complete without a task) by its id, spelled out
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
const saveHotkeys = () => { setPref('hotkeys', hotkeys); renderSoon(); }; // the page may name a key: an empty My Tasks names Quick Add Task's (emptyText)
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
// The pane keys go to the shell before a row sees them (capture), whatever they are recorded as: a row reads ⌥ away
// (⌥⌘↓ as ⌘↓) and a function key has no ⌘ for it to see. Only while there are panes to move between,
// with the palette closed and no key being recorded; alone, a page leaves those keys to the row.
document.addEventListener('keydown', (e) => {
  if (windowPanes.pages < 2 || !palette.hidden || rec) return;
  const row = PANE_ROWS.find(([id]) => hotkeyFor(id) === comboOf(e));
  if (!row) return;
  e.preventDefault(); e.stopPropagation(); shellRun(row[2]);
}, true);
