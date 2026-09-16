'use strict';
// Sharing and location: visibility palette, selected people, and moving a document to a space.

function loadAccess(docId) {
  if (!tana.accessOptions || accessById.has(docId) || accessLoading.has(docId)) return;
  accessLoading.add(docId);
  tana.accessOptions(docId).then((access) => { accessLoading.delete(docId); accessById.set(docId, access); if (!palette.hidden && palDoc?.id === docId) renderPalette(); }, (e) => { accessLoading.delete(docId); showError(e); });
}
function applySharing(doc, selection) {
  run(async () => {
    try {
      await tana.setSharing(doc.id, selection);
      accessById.delete(doc.id); taskMetaById.delete(doc.id);
      if (typeof closePalette === 'function') closePalette(); await loadRoots(); render();
    } catch (e) {
      if (typeof showError === 'function') showError(e);
      if (/reload|access changed/i.test(String(e.message || e))) {
        accessById.delete(doc.id); taskMetaById.delete(doc.id); palMode = 'visibility'; loadAccess(doc.id); loadTaskMeta(doc.id); renderPalette();
      }
    }
  });
}
function banSvg() { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18"><g stroke-linecap="round" stroke-width="1" fill="none" stroke="currentColor" stroke-linejoin="round"><line x1="3.873" y1="14.127" x2="14.118" y2="3.882"></line><circle cx="9" cy="9" r="7.25"></circle></g></svg>'; }
function visibilityRows(q) {
  if (!palDoc) return [];
  const access = accessById.get(palDoc.id);
  if (!access?.sharing) return [{ group: 'Visibility', ...(access?.reason ? { svg: banSvg() } : {}), label: access?.reason || 'Checking permission…', disabled: true }];
  loadTaskMeta(palDoc.id);
  const hasParticipants = taskMetaById.has(palDoc.id);
  const rules = new Set(access.rules || []), inherit = audienceInfo(access.inheritAudience);
  return [
    rules.has('me') && { group: 'Visibility', icon: 'lock', label: 'Only me', keepOpen: true, run: () => applySharing(palDoc, { rule: 'me' }) },
    rules.has('people') && { group: 'Visibility', icon: 'userLock', label: 'Selected people…', disabled: !hasParticipants, keepOpen: true, run: () => openVisibilityPeople(palDoc) },
    rules.has('inherit') && { group: 'Visibility', icon: 'houseLock', label: inherit ? 'Inherit: ' + inherit.label : 'Inherit location audience', keepOpen: true, run: () => applySharing(palDoc, { rule: 'inherit', token: access.sharingToken }) },
  ].filter(Boolean).filter((row) => fuzzyMatch(row.label, q));
}
function openVisibilityPalette(doc) {
  palDoc = doc; palMode = 'visibility'; palRows = []; palIndex = 0; palette.hidden = false;
  palInput.placeholder = 'Choose visibility'; palInput.value = ''; loadAccess(doc.id); loadTaskMeta(doc.id); renderPalette(); palInput.focus();
}
// A document that is already shared with selected people opens at that list: the mode is settled, the people are what
// changes. Anything else (and a doc whose participants or sharing rules say the list cannot be edited) starts at the
// mode picker as before. The full picker stays one Cmd+K "Edit visibility" away.
function openVisibility(doc, scope) {
  const access = accessById.get(doc.id);
  if (scope !== 'people' || !taskMetaById.has(doc.id) || !(access?.rules || []).includes('people')) return openVisibilityPalette(doc);
  palDoc = doc; palette.hidden = false;
  loadAccess(doc.id); // Apply still goes through the same sharing rules
  openVisibilityPeople(doc);
}
function openVisibilityPeople(doc) {
  const meta = taskMetaById.get(doc.id);
  if (!meta) return;
  visibilityPeople = new Set(meta.participants.map((p) => p.uri).filter((id) => id && id !== me()?.id));
  visibilityRoles = new Map(meta.participants.map((p) => [p.uri, p.role]).filter(([id]) => id && id !== me()?.id));
  palMode = 'visibilityPeople'; palRows = []; palIndex = 0; palInput.placeholder = 'Select people'; palInput.value = '';
  loadMembers(); renderPalette(); palInput.focus();
}
function visibilityPeopleRows(q) {
  if (!palDoc) return [];
  loadMembers();
  const people = (members || []).filter((member) => !member.me && fuzzyMatch(memberName(member.id), q));
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
  return nodes.map((node) => ({ icon: node.icon, label: node.text, disabled: !node.selectable, keepOpen: true, run: () => { openMovePalette(doc); previewMoveToSpace(doc, node); } }));
}
function openMovePalette(doc) {
  clearTimeout(palTimer); palTimer = null; ++palSeq;
  palDoc = doc; palMode = 'spaces'; palRows = []; palIndex = 0; palBusy = false; palette.hidden = false;
  palInput.placeholder = 'Move to …'; palInput.value = ''; searchSpacesNow(); palInput.focus();
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
      { group: 'Move', icon: 'space', label: 'Move to ' + (preview.target?.title || space.text || 'space'), keepOpen: true, run: () => moveToSpace(doc, space, preview.token) },
      { group: 'Move', label: 'Cancel', keepOpen: true, run: () => openMovePalette(doc) },
    ];
    renderPalette();
  }, showError);
}
function moveToSpace(doc, space, token) {
  run(async () => {
    try {
      await tana.moveToSpace(doc.id, space.id, token);
      paths.delete(doc.id); extra.set(doc.id, asDoc(doc)); closePalette(); await loadRoots(); render();
    } catch (e) {
      showError(e);
      if (/preview.*again|explicitly confirm|access changed/i.test(String(e.message || e))) openMovePalette(doc);
    }
  });
}
