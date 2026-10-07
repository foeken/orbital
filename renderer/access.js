'use strict';
// Sharing and location: visibility palette, selected people, and moving a document to a space.

function loadAccess(docId) {
  // The readiness rule loadTaskMeta already uses: a local draft id and a client that is not up yet both come back as
  // "not connected to Tana" (main/documents.js: document()), which is a startup state rather than something to put in
  // front of the user. Every render asks again, so neither case needs a retry of its own, and a real refusal still shows.
  if (!connected || !tana.accessOptions || !isRealId(docId) || accessById.has(docId) || accessLoading.has(docId)) return;
  accessLoading.add(docId);
  tana.accessOptions(docId).then((access) => { accessLoading.delete(docId); accessById.set(docId, access); if (!palette.hidden) renderPalette(); else if (zoom && zoom.docId === docId) renderSoon(); }, (e) => { accessLoading.delete(docId); showError(e); }); // any open palette: a selection's Delete row reads it too
}
function applySharing(doc, selection) {
  run(async () => {
    try {
      await tana.setSharing(doc.id, selection);
      // the watch default is read off participants and assignment, so a sharing change can flip it: drop it too
      accessById.delete(doc.id); taskMetaById.delete(doc.id); notifyById.delete(doc.id);
      if (typeof closePalette === 'function') closePalette(); await loadRoots(); render();
    } catch (e) {
      if (typeof showError === 'function') showError(e);
      if (/reload|access changed/i.test(String(e.message || e))) {
        accessById.delete(doc.id); taskMetaById.delete(doc.id); notifyById.delete(doc.id); openVisibilityPalette(doc);
      }
    }
  });
}
// "Fix this" beside "Not visible to …" (renderer/fields.js, #622): the assignees the page shuts out join its own
// participants as editors, everyone already there kept, by the write Selected people … makes. Only where the page's
// own list is its audience and you may change it: an audience taken from a space is that space's to widen.
function hiddenFromFix(node) {
  const meta = taskMetaById.get(node.id), mine = (loadMembers(), me()?.id);
  if (!meta || !meta.hiddenFrom?.length || !tana.setSharing || !mine) return null;
  loadAccess(node.id);
  const access = accessById.get(node.id);
  if (!access?.rules?.includes('people')) return null;
  // Its own people keep their roles. Named people it takes from where it lives (a task in a meeting: its attendees)
  // become its own list, the same people, so nobody loses it; only a later change to the meeting's people no longer
  // reaches it. An audience of everyone or of a space is not narrowed to fix it.
  const now = meta.restricted === true ? meta.participants.map((p) => ({ uri: p.uri, role: p.role }))
    : access.audience?.scope === 'people' ? (access.audience.participants || []).map((uri) => ({ uri, role: 'editor' })) : null;
  if (!now) return null;
  const kept = now.filter((p) => p.uri !== mine);
  // the people named (a pill on the page, the assign prompt) or everyone the page shuts out
  return (uris = meta.hiddenFrom) => applySharing(node, { rule: 'people', participants: [...kept, ...uris.map((uri) => ({ uri, role: 'editor' }))] });
}
// Assigning someone who cannot see the task (#622): Tana asks there and then, and so does Orbital, on the palette card
// the assignment was made from. Grant access shares it with them (hiddenFromFix, the pill's write), Keep private leaves
// it as it is (Escape too), Cancel takes the assignment back. The pill in Visible to stays either way.
const namesOf = (uris) => { const n = uris.map(memberName); return n.length > 1 ? n.slice(0, -1).join(', ') + ' and ' + n.at(-1) : n[0]; };
function openShareAsk(doc, uris, before) {
  loadAccess(doc.id);
  // Tana's title is the field's placeholder, the answers come first so Enter runs one, and its sentence follows as a
  // note (the Log out and About pages' shape)
  const who = namesOf(uris), question = who + ' can\u2019t see this', title = String(doc.text || doc.title || 'This task').trim();
  openPage('shareAsk', question, { back: closePalette, rows: () => {
    const fix = hiddenFromFix(doc); // asked on every draw: the page's access arrives after the card opens
    return [
      { group: question, icon: 'userLock', label: 'Grant access', hint: fix ? 'Share it with ' + who : accessById.has(doc.id) ? 'Shared through where it lives' : 'Checking permission\u2026', disabled: !fix, run: () => fix(uris) },
      { group: question, icon: 'lock', label: 'Keep private', run: closePalette },
      { group: question, icon: 'undo', label: 'Cancel', hint: 'Unassign ' + who, run: () => { closePalette(); setTaskAssignees(doc, before); } },
      { group: question, label: '\u201c' + demoText(title, doc.id) + '\u201d is assigned to ' + who + ', but they won\u2019t be able to open it unless you grant access or move it somewhere they can see.', disabled: true, note: true, wrap: true },
    ];
  } });
}
function banSvg() { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1" fill="none" stroke="currentColor" stroke-linejoin="round"><line x1="3.873" y1="14.127" x2="14.118" y2="3.882"></line><circle cx="9" cy="9" r="7.25"></circle></g></svg>'; }
// doc: the document the rows are for; the page's own, unless a folded level built for another asks (renderer/palette.js)
function visibilityRows(q, doc = palDoc) {
  if (!doc) return [];
  const access = accessById.get(doc.id);
  if (!access?.sharing) return [{ group: 'Visibility', ...(access?.reason ? { svg: banSvg() } : {}), label: access?.reason || 'Checking permission…', disabled: true }];
  loadTaskMeta(doc.id);
  const hasParticipants = taskMetaById.has(doc.id);
  const rules = new Set(access.rules || []), inherit = audienceInfo(access.inheritAudience);
  return [
    rules.has('me') && { group: 'Visibility', icon: 'lock', label: 'Only me', keepOpen: true, run: () => applySharing(doc, { rule: 'me' }) },
    rules.has('people') && { group: 'Visibility', icon: 'userLock', label: 'Selected people …', disabled: !hasParticipants, keepOpen: true, run: () => openVisibilityPeople(doc) },
    rules.has('inherit') && { group: 'Visibility', icon: 'houseLock', label: inherit ? 'Inherit: ' + inherit.label : 'Inherit location audience', keepOpen: true, run: () => applySharing(doc, { rule: 'inherit', token: access.sharingToken }) },
  ].filter(Boolean).filter((row) => fuzzyMatch(row.label, q));
}
// ⌘K Add participants … and the link beside who can see a chat (renderer/chat.js chatContextEl): Edit visibility, at
// its Select people step when the document may be shared with people and its participants are in, else at the picker
// (which says why a step cannot be taken)
function addParticipants(doc) {
  palDoc = doc; loadAccess(doc.id); loadTaskMeta(doc.id);
  if (taskMetaById.has(doc.id) && (accessById.get(doc.id)?.rules || []).includes('people')) return openVisibilityPeople(doc);
  openVisibilityPalette(doc);
}
function openVisibilityPalette(doc) {
  palDoc = doc; loadAccess(doc.id); loadTaskMeta(doc.id); openPage('visibility', 'Choose visibility', { rows: (q) => visibilityRows(q) });
}
// A document that is already shared with selected people opens at that list: the mode is settled, the people are what
// changes. Anything else (and a doc whose participants or sharing rules say the list cannot be edited) starts at the
// mode picker as before. The full picker stays one Cmd+K "Edit visibility" away.
function openVisibility(doc, scope) {
  const access = accessById.get(doc.id);
  if (scope !== 'people' || !taskMetaById.has(doc.id) || !(access?.rules || []).includes('people')) return openVisibilityPalette(doc);
  palDoc = doc; // the palette opens in showPage, which notes where the focus was while it is still closed (#376)
  loadAccess(doc.id); // Apply still goes through the same sharing rules
  openVisibilityPeople(doc);
}
function openVisibilityPeople(doc) {
  const meta = taskMetaById.get(doc.id);
  if (!meta) return;
  visibilityPeople = new Set(meta.participants.map((p) => p.uri).filter((id) => id && id !== me()?.id));
  visibilityRoles = new Map(meta.participants.map((p) => [p.uri, p.role]).filter(([id]) => id && id !== me()?.id));
  palDoc = doc; // the page's rows and Apply read it (visibilityPeopleRows)
  loadMembers(); // the page shows the palette: a key recorded on Selected people … arrives with it closed
  openPage('visibilityPeople', 'Select people', { rows: visibilityPeopleRows, back: () => openVisibilityPalette(palDoc) });
}
function visibilityPeopleRows(q) {
  if (!palDoc) return [];
  loadMembers();
  const people = (members || []).filter((member) => !member.me && fuzzyMatch(memberName(member.id), q));
  // who can see it now leads the list, the rest after in member order; ticking one does not move it (the node's own
  // participants, not the choices being made)
  const seeing = new Set(((taskMetaById.get(palDoc.id) || {}).participants || []).map((p) => p.uri));
  people.sort((a, b) => seeing.has(b.id) - seeing.has(a.id));
  const back = { group: 'Visibility', label: 'Back to visibility', keepOpen: true, run: backPalette };
  const apply = { group: 'Visibility', label: 'Apply selected people', disabled: !visibilityPeople.size, keepOpen: true, run: () => applySharing(palDoc, { rule: 'people', participants: [...visibilityPeople].map((uri) => ({ uri, role: visibilityRoles.get(uri) || 'editor' })) }) };
  return [back, apply, ...people.map((member) => ({ group: 'People', icon: 'member', label: memberName(member.id), hint: visibilityPeople.has(member.id) ? '✓' : '', keepOpen: true, run: () => { if (visibilityPeople.has(member.id)) visibilityPeople.delete(member.id); else { visibilityPeople.add(member.id); visibilityRoles.set(member.id, 'editor'); } renderPalette(); } }))];
}
function searchSpacesNow() {
  if (!palDoc || !tana.searchSpaces) return;
  const query = palInput.value.trim(), seq = ++palSeq; palBusy = true;
  tana.searchSpaces(query).then((nodes) => {
    if (seq !== palSeq || palMode !== 'spaces') return;
    palRows = nodes.map(asDoc).map((node) => ({ group: 'Spaces', ...docRow(node, node.selectable ? '' : 'No permission', () => previewMoveToSpace(palDoc, node)), disabled: !node.selectable, keepOpen: true }));
    palIndex = 0; palBusy = false; renderPalette(); settleEnter();
  }, showError);
}
// The second level of "Move to …", for the command palette to offer as single rows ("Move to Foundry"). The Inbox is a
// state rather than a place, so it is not offered here: Set status to Inbox puts a task there.
async function moveTargets(doc) {
  const nodes = tana.searchSpaces ? (await tana.searchSpaces('')).map(asDoc) : [];
  return nodes.map((node) => ({ icon: node.icon, label: demoText(node.text, node.id), disabled: !node.selectable, keepOpen: true, run: () => { openMovePalette(doc); previewMoveToSpace(doc, node); } }));
}
function openMovePalette(doc) {
  palDoc = doc; showPage('spaces', 'Move to …'); searchSpacesNow(); palInput.focus();
}
function audienceLabel(audience) { return audienceInfo(audience)?.label || 'Audience cannot be verified'; }
function previewMoveToSpace(doc, space) {
  if (!tana.previewMove) return;
  const seq = ++palSeq; palBusy = true;
  tana.previewMove(doc.id, space.id).then((preview) => {
    if (seq !== palSeq || palMode !== 'spaces') return;
    palBusy = false;
    if (!preview.allowed) { showError(new Error(preview.reason || 'This space cannot be selected')); return renderPalette(); }
    palMode = 'moveConfirm'; palIndex = 2;
    palRows = [
      { group: 'Move', label: 'Before: ' + audienceLabel(preview.before), disabled: true },
      { group: 'Move', label: 'After: ' + audienceLabel(preview.after), disabled: true },
      { group: 'Move', icon: 'space', label: 'Move to ' + demoText(preview.target?.title || space.text || 'space', space.id), keepOpen: true, run: () => moveToSpace(doc, space, preview.token) },
      { group: 'Move', label: 'Cancel', keepOpen: true, run: () => openMovePalette(doc) },
    ];
    renderPalette();
  }, showError);
}
function moveToSpace(doc, space, token) {
  run(async () => {
    try {
      await tana.moveToSpace(doc.id, space.id, token);
      extra.set(doc.id, asDoc(doc)); closePalette(); await loadRoots(); render();
    } catch (e) {
      showError(e);
      if (/preview.*again|explicitly confirm|access changed/i.test(String(e.message || e))) openMovePalette(doc);
    }
  });
}
