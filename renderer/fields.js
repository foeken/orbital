'use strict';
// Fields that hold choices or links (issue #33). A text or date field is an outline under the title; an options, link
// or member field is a closed list, so its value is a row of chips with no editor in it: Enter or typing opens a
// palette page to pick from, Backspace takes the last value off. Every write goes through api.setField, which checks
// the value the way Tana does, so what Tana would refuse never reaches the document. On a type's own page the fields
// it defines are listed under the title, and ⌘K on one of them edits the definition.

const FIELD_KINDS = [['', 'Text'], ['options', 'Options'], ['link', 'Link'], ['member', 'Member'], ['date', 'Date']];
const kindName = (type) => (FIELD_KINDS.find(([t]) => t === (type || '')) || [type, type])[1];
const sameLabel = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const offered = (field, label) => (field.options || []).some((o) => sameLabel(o.label, label));
// Tana's rule: an options field holds one value unless it says multiple, a link or member field several unless it says single.
const holdsMany = (field) => (field.type === 'options' ? field.cardinality === 'multiple' : field.cardinality !== 'single');
// what a link field may link to, as api.search takes it: members, or the target types (none: anything)
const linkScope = (field) => (field.type === 'member' ? { members: true } : { types: (field.to || []).map((t) => t.uri) });
const fieldCtxs = new Map(); // a drawn field's key -> { docId, hostId, key, field, editable } or, on a type's page, { typeUri, key, def }
const fieldAt = (el) => (el && el.classList && el.classList.contains('fchoice') ? fieldCtxs.get(el.dataset.key) || null : null);
let palField = null;     // the field ⌘K was opened on
let fieldReturn = null;  // the field to give the focus back to when the palette closes (it is no row: returnFocus cannot)
let fieldLinkCtx = null; // the link field the search palette is picking for
let fieldCtx = null; // what the open field page is about
let editingType = null; // the type page whose field definitions are drawn under its title (renderer/render.js renderFields)
function focusField(key) { const el = queryRow('.fchoice[data-key="' + CSS.escape(key) + '"]'); if (el) el.focus(); }

// ---- the value: chips ----
// The value's lines, each a segments array: the field's rows once they are loaded (a write reloads them), else what
// the page was read with.
let chipsNew = null; // { key, seen, until }: the field just written here, whose new chips pop the first time they are drawn
function choiceValues(ctx) {
  const rows = kids.get(ctx.hostId);
  const lines = Array.isArray(rows) ? rows.map((n) => n.segments || [{ text: n.text || '' }]) : (ctx.field.lines || []).map((l) => l.segments || []);
  return lines.filter((segs) => plainOf(segs).trim());
}
function choiceEl(parent, field, host) {
  const ctx = { docId: parent.docId, hostId: host.docId, key: host.key, field, editable: canEditItem(parent) && !!tana.setField };
  fieldCtxs.set(host.key, ctx);
  const el = document.createElement('div'); el.className = 'fvalue fchoice'; el.tabIndex = 0; el.dataset.key = host.key;
  const values = choiceValues(ctx), targets = (field.to || []).map((t) => t.uri);
  for (const segs of values) {
    const chip = document.createElement('span'); chip.className = 'fchip';
    if (chipsNew && chipsNew.key === host.key && Date.now() < chipsNew.until && !chipsNew.seen.has(plainOf(segs))) { chipsNew.seen.add(plainOf(segs)); chip.classList.add('pop'); } // just chosen: it pops, once
    if (field.type === 'options') {
      chip.textContent = plainOf(segs).trim();
      if (!offered(field, chip.textContent)) { chip.classList.add('gone'); chip.title = 'No longer offered'; }
    } else {
      renderSegs(chip, segs);
      // a link written elsewhere may point at a type this field does not link to: Tana would refuse it, so it says so
      if (targets.length && segs.some((s) => s.mention && s.mention.type && !targets.includes(s.mention.type))) {
        chip.classList.add('wrong'); chip.title = 'Not a ' + field.to.map((t) => t.name || t.title || 'type').join(' or ');
      }
    }
    el.append(chip);
  }
  if (!values.length && ctx.editable) { const hint = document.createElement('span'); hint.className = 'fhint'; hint.textContent = field.type === 'options' ? 'Select value' : 'Link to …'; el.append(hint); }
  el.onkeydown = choiceKey;
  el.onclick = (e) => { if (ctx.editable && !e.target.closest('.mention')) openChooser(ctx); }; // a chip is a link out, like anywhere else
  return el;
}
function choiceKey(e) {
  const el = e.currentTarget, ctx = fieldCtxs.get(el.dataset.key);
  if (!ctx || e.metaKey || e.ctrlKey || e.altKey) return; // ⌘K and the rest are the document's
  const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
  if (back || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveTo(el, back ? -1 : 1, 0); }
  else if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
  else if (!ctx.editable || ctx.def) return; // a definition row only answers to ⌘K
  else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); const values = choiceValues(ctx); if (values.length) writeChoice(ctx, holdsMany(ctx.field) ? values.slice(0, -1) : []); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChooser(ctx); }
  else if (e.key.length === 1) { e.preventDefault(); openChooser(ctx, undefined, e.key); } // typing is the start of what to look for
}
// A task's assignees, drawn as its first field under the title (renderer/render.js renderFields), in the same row and
// people a person field shows: a mention per person, "Unassigned" when there is nobody. Not a Tana field, Tana keeps them as
// the task's assignedToUris, so it opens the assignee picker the row's facts and Cmd+K use (openAssigneePalette).
function assigneeFieldEl(parent) {
  const node = parent.node, meta = taskMetaById.get(node.id);
  if (!meta) { loadTaskMeta(node.id); return null; } // the answer redraws the page (patchMeta)
  if (meta.assignees.length) loadMembers(); // the chips' names; the list redraws the page when it lands
  const row = document.createElement('div'); row.className = 'field';
  const icon = document.createElement('span'); icon.className = 'ricon'; addIcon(icon, 'member');
  const label = document.createElement('span'); label.className = 'flabel'; label.textContent = 'Assigned to';
  const values = document.createElement('div'); values.className = 'fvalues';
  const el = document.createElement('div'); el.className = 'fvalue fchoice'; el.tabIndex = 0;
  // the people as mentions, drawn as a person in any other field is: a link, no chip behind it
  if (meta.assignees.length) { const who = document.createElement('span'); renderSegs(who, meta.assignees.flatMap((uri, i) => [...(i ? [{ text: ', ' }] : []), { mention: { uri, label: memberName(uri), icon: 'member' } }])); el.append(who); }
  if (!meta.assignees.length) { const hint = document.createElement('span'); hint.className = 'fhint'; hint.textContent = 'Unassigned'; el.append(hint); }
  const open = canEditNode(node) && tana.setAssignees ? () => openAssigneePalette(node) : null;
  el.onclick = (e) => { if (open && !e.target.closest('.mention')) open(); }; // a chip is a link to the person, as anywhere else
  el.onkeydown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘K and the rest are the document's
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (back || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveTo(el, back ? -1 : 1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
    else if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  };
  values.append(el); row.append(icon, label, values);
  return row;
}
// Who can see the page, drawn under its title as a field after Assigned to (renderer/render.js renderFields): the
// audience's glyph, a bubble per person as a list row's subtext has them (facesEls), or the audience's words where it
// names nobody, whether anyone with the link can read it, and who is assigned but shut out. It opens the visibility
// picker, on a meeting's write-up the event's.
function visibilityFieldEl(parent) {
  const node = parent.node, summary = taskSummary(node) || documentSummary(node); // either asks for the metadata
  if (!summary || !summary.audience || sensitiveHidden(node.id)) return null; // a sensitive page says nothing about who
  const data = relatedBy.get(parent.docId), access = data && typeof data.pinHub === 'string' && data.pinHub.startsWith('tana:event:') ? { id: data.pinHub } : node;
  const row = document.createElement('div'); row.className = 'field';
  const icon = document.createElement('span'); icon.className = 'ricon' + (summary.hiddenFrom ? ' hiddenfrom' : ''); addIcon(icon, summary.audience.icon);
  const label = document.createElement('span'); label.className = 'flabel'; label.textContent = 'Visible to';
  const values = document.createElement('div'); values.className = 'fvalues';
  const el = document.createElement('div'); el.className = 'fvalue fchoice'; el.tabIndex = 0; el.title = summary.audience.label;
  const count = summary.peopleCount || summary.people.length;
  if (count === 1 && summary.people.length === 1) { loadMembers(); const name = document.createElement('span'); name.textContent = memberName(summary.people[0]); el.append(name); } // one person: their name, not a lone bubble
  else if (summary.people.length) el.append(...facesEls(summary.people, count));
  else { const words = document.createElement('span'); words.className = 'fhint'; words.textContent = summary.audience.label; el.append(words); }
  if (summary.linkShared) { const link = document.createElement('span'); link.className = 'fhint'; link.textContent = 'Anyone with the link'; el.append(link); } // Tana's own switch, read-only here
  if (summary.hiddenFrom) { const warn = document.createElement('span'); warn.className = 'fhint fwarn'; warn.textContent = 'Not visible to ' + summary.hiddenFrom; el.append(warn); }
  const open = tana.accessOptions ? () => openVisibility(access, summary.scope) : null;
  el.onclick = () => { if (open) open(); };
  el.onkeydown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘K and the rest are the document's
    const back = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    if (back || e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); moveTo(el, back ? -1 : 1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); el.blur(); }
    else if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); }
  };
  values.append(el); row.append(icon, label, values);
  return row;
}
// Written the way the field holds it: an options value as its labels (only those still offered, since Tana refuses
// the rest), a link value as one reference per line.
function writeChoice(ctx, values) {
  chipsNew = { key: ctx.key, seen: new Set(choiceValues(ctx).map(plainOf)), until: Date.now() + 3000 }; // what was there already does not pop
  const lines = ctx.field.type === 'options'
    ? values.map((segs) => plainOf(segs).trim()).filter((label) => offered(ctx.field, label))
    : values.map((segs) => segs.find((s) => s.mention)).filter(Boolean).map((s) => [{ mention: { label: s.mention.label, uri: s.mention.uri } }]);
  return run(async () => {
    await tana.setField(ctx.docId, ctx.field.key, lines);
    if (ctx.row) { ctx.row.fields = { ...ctx.row.fields, [ctx.field.key]: lines }; ctx.field.lines = lines.map((text) => ({ segments: [{ text }] })); } // a table cell: its row shows it now, the type page's live query reads it again
    else await reload(ctx.hostId);
    render(true);
    if (palette.hidden) focusField(ctx.key); else if (palMode === 'field') renderPalette(); // a multiple pick stays open: its ticks move
  });
}
function openChooser(ctx, back, text = '') {
  fieldReturn = ctx.key;
  if (ctx.field.type !== 'options') return openFieldLink(ctx, text);
  openFieldPage(ctx, optionRows, 'Select ' + (ctx.field.label || 'value') + '…', back, text);
}
// A table cell on a type's page (renderer/views.js tableCells): that row's value of one choice field. An options value
// comes from the row the page was read with; a link or member value is read as the field's outline first, so a
// multiple pick keeps the links it has.
function openCellChooser(node, key, def, back) {
  if (def.type !== 'options') {
    const hostId = node.id + '|' + key;
    return run(async () => { await reload(hostId); openChooser({ docId: node.id, hostId, key: hostId, editable: true, field: { ...def, key, label: def.title } }, back); });
  }
  const lines = ((node.fields || {})[key] || []).map((text) => ({ segments: [{ text }] }));
  openChooser({ docId: node.id, key: 'cell|' + node.id + '|' + key, row: node, editable: true, field: { key, label: def.title, type: def.type, cardinality: def.cardinality, options: def.options, lines } }, back);
}
// ---- a field page in the palette: one mode, the rows and the way back given by whoever opens it ----
function openFieldPage(ctx, rows, placeholder, back, text = '', keys = null) {
  fieldCtx = ctx; anchorPalette(null);
  openPage('field', placeholder, { rows, back, keys, typed: true }, text);
}
function optionRows(q) {
  const ctx = fieldCtx, f = ctx.field, group = f.label || 'Value', many = holdsMany(f);
  const current = choiceValues(ctx).map((segs) => plainOf(segs).trim());
  const has = (label) => current.some((c) => sameLabel(c, label));
  const rows = [];
  if (current.length && fuzzyMatch('Clear value', q)) rows.push({ group, icon: 'none', label: 'Clear value', run: () => writeChoice(ctx, []) });
  for (const { label } of f.options || []) {
    if (!fuzzyMatch(label, q)) continue;
    const next = !many ? [label] : has(label) ? current.filter((c) => !sameLabel(c, label)) : [...current, label];
    rows.push({ group, icon: 'options', label, hint: has(label) ? '✓' : '', keepOpen: many, run: () => writeChoice(ctx, next.map((l) => [{ text: l }])) });
  }
  // a stored label the type no longer declares: shown, and taken off with Enter, but never offered again
  for (const label of current) if (!offered(f, label) && fuzzyMatch(label, q)) rows.push({ group, icon: 'options', label, hint: 'No longer offered · ↩ removes it', keepOpen: many, run: () => writeChoice(ctx, current.filter((c) => c !== label).map((l) => [{ text: l }])) });
  if (!(f.options || []).length) rows.push({ group, label: 'No values defined yet', disabled: true });
  return rows;
}
// ---- link and member fields: the search palette, narrowed to what the field may link to ----
function openFieldLink(ctx, text = '') {
  togglePalette('search');
  fieldLinkCtx = ctx;
  palInput.placeholder = 'Link ' + (ctx.field.label || 'field') + ' to…';
  palInput.value = text;
  searchNow();
}
// A single link is replaced, anything else gets one more line; linking what is already there changes nothing.
function pickLink(ctx, n) {
  const mention = { label: n.title ?? n.text ?? '', uri: n.id };
  const current = choiceValues(ctx).filter((segs) => !segs.some((s) => s.mention && s.mention.uri === n.id));
  return writeChoice(ctx, holdsMany(ctx.field) ? [...current, [{ mention }]] : [[{ mention }]]);
}

// ---- a type's page: the fields it defines, and ⌘K on one to change it ----
function definitionEl(parent, def) {
  const key = parent.docId + '|def|' + def.key, ctx = { typeUri: parent.docId, key, def };
  fieldCtxs.set(key, ctx);
  const row = document.createElement('div'); row.className = 'field';
  const icon = document.createElement('span'); icon.className = 'ricon'; addIcon(icon, 'field');
  const label = document.createElement('span'); label.className = 'flabel fdef-title'; label.textContent = def.title || def.key;
  const values = document.createElement('div'); values.className = 'fvalues';
  const el = document.createElement('div'); el.className = 'fvalue fchoice fdef'; el.tabIndex = 0; el.dataset.key = key;
  const detail = def.type === 'options' ? (def.options || []).map((o) => o.label).join(', ') || 'No choices yet'
    : def.type === 'link' ? (def.to || []).map((t) => t.name || t.title).filter(Boolean).join(', ') || 'Any type' : '';
  const chip = document.createElement('span'); chip.className = 'fkind';
  chip.textContent = [kindName(def.type), def.cardinality === 'multiple' ? 'Multiple' : def.cardinality === 'single' ? 'Single' : '', detail].filter(Boolean).join(' · ');
  el.append(chip);
  el.onkeydown = (e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); togglePalette('cmd'); } else choiceKey(e); }; // Enter: its ⌘K rows
  el.onclick = () => togglePalette('cmd');
  values.append(el);
  row.append(icon, label, values);
  return row;
}
const plainDef = (to) => (to || []).map(({ uri, title }) => (title ? { uri, title } : { uri }));
// A definition changed: the type's page reads it again, and so does every page read before, since a document of
// this type may be one of them (loadRelated keeps the old answer on screen until the new one lands).
function saveDefinition(ctx, change) {
  return run(async () => {
    const def = await tana.defineField(ctx.typeUri, ctx.def.key, change);
    if (def) ctx.def = { ...def, to: def.to && def.to.map((t) => ({ ...t, name: (typeListCache || []).find((x) => x.uri === t.uri)?.title })) };
    for (const id of relatedBy.keys()) relatedStale.add(id);
    refreshRelated(ctx.typeUri);
    if (!palette.hidden && palMode === 'field') renderPalette();
  });
}
function fieldRows(group) {
  const ctx = palField, rows = [];
  if (ctx && ctx.field && ctx.editable) {
    rows.push({ id: 'fieldValue', group, icon: ctx.field.type === 'options' ? 'options' : 'link', label: ctx.field.type === 'options' ? 'Select value …' : 'Link to …',
      hint: ctx.field.label || '', keepOpen: true, run: () => openChooser(ctx, openCommandPalette) });
  }
  // a table row on a page of one type (fieldType): its choice columns, the keyboard's way to what a click on the cell does
  const row = palDoc && tableView() && fieldType() && shownDocs().find((n) => n.id === palDoc.id);
  if (row) for (const k of tableKeys()) {
    const def = pickableDef(row, k);
    const options = def && def.type === 'options';
    if (def) rows.push({ id: 'cellValue:' + def.key, group, icon: options ? 'options' : 'link', label: (options ? 'Set ' : 'Link ') + (def.title || 'value') + ' …', hint: ((row.fields || {})[k] || []).join(', '), keepOpen: true, run: () => openCellChooser(row, k, def, openCommandPalette) });
  }
  if (ctx && ctx.def && tana.defineField) {
    const def = ctx.def, type = def.type || '';
    rows.push({ id: 'fieldKind', group, icon: 'field', label: 'Set field type …', hint: kindName(type), keepOpen: true, run: () => openFieldPage(ctx, kindRows, 'Set field type to…', openCommandPalette) });
    rows.push({ id: 'fieldCount', group, icon: 'field', label: 'Number of values …', hint: def.cardinality === 'multiple' ? 'Multiple' : def.cardinality === 'single' ? 'Single' : 'Not set', keepOpen: true, run: () => openFieldPage(ctx, countRows, 'Number of values', openCommandPalette) });
    rows.push({ id: 'fieldChoices', group, icon: 'options', label: 'Edit choices …', hint: type === 'options' ? (def.options || []).length + ' choices' : 'Options fields only', disabled: type !== 'options', keepOpen: true, run: () => openChoicesPage(ctx) });
    rows.push({ id: 'fieldTargets', group, icon: 'type', label: 'Link to types …', hint: type === 'link' ? (def.to || []).map((t) => t.name || t.title).filter(Boolean).join(', ') || 'Any type' : 'Link fields only', disabled: type !== 'link', keepOpen: true, run: () => openTargetsPage(ctx) });
  }
  // on a type (its row, or one of the fields it defines): one more field
  const typeUri = ctx && ctx.def ? ctx.typeUri : palDoc && /^tana:type:/.test(palDoc.id) ? palDoc.id : null;
  if (typeUri && tana.addField) rows.push({ id: 'addField', group, icon: 'createNew', label: 'Add field …', keepOpen: true, run: () => openFieldPage({ typeUri }, addFieldRows, 'Name the field', openCommandPalette) });
  if (onTypePage() && typeUri === zoom.docId) rows.push({ id: 'editFields', group, icon: 'field', label: editingType === typeUri ? 'Done editing fields' : 'Edit fields', run: () => { editingType = editingType === typeUri ? null : typeUri; render(true); } });
  return rows;
}
function kindRows(q) {
  const ctx = fieldCtx, def = ctx.def, now = def.type || '';
  // what a change of kind takes with it, said before Enter rather than after
  const loses = (type) => (now === 'options' && type !== 'options' && (def.options || []).length ? 'Drops its choices' : now === 'link' && type !== 'link' && (def.to || []).length ? 'Drops its link types' : '');
  return FIELD_KINDS.filter(([, name]) => fuzzyMatch(name, q)).map(([type, name]) => ({ group: def.title || 'Field type', icon: 'field', label: name,
    hint: type === now ? '✓' : loses(type), disabled: type === now, run: () => saveDefinition(ctx, { type: type || null }) }));
}
function countRows(q) {
  const ctx = fieldCtx;
  return [['single', 'Single'], ['multiple', 'Multiple']].filter(([, name]) => fuzzyMatch(name, q)).map(([cardinality, name]) => ({ group: ctx.def.title || 'Number of values', icon: 'field', label: name,
    hint: ctx.def.cardinality === cardinality ? '✓' : '', disabled: ctx.def.cardinality === cardinality, run: () => saveDefinition(ctx, { cardinality }) }));
}
// Edit choices: a row per label. What is typed adds a label (Enter), or renames the one Enter was pressed on; ⌘⌫
// removes the highlighted label and ⇧⌘↑/↓ move it, the keys that do the same to rows in the outline. Tana's label
// rules show on the row before anything is written: at most 60 characters, no two the same.
let renaming = null; // the label being renamed, while the input holds its new words
function openChoicesPage(ctx) { renaming = null; openFieldPage(ctx, choiceRows, 'New choice', openCommandPalette, '', choiceKeys); }
const choiceLabels = () => (fieldCtx.def.options || []).map((o) => o.label);
function choiceRows(q, typed) {
  const labels = choiceLabels(), group = (fieldCtx.def.title || 'Field') + ' · choices', words = (typed || '').trim();
  const problem = words.length > 60 ? 'At most 60 characters' : labels.some((l) => sameLabel(l, words) && l !== renaming) ? 'Already a choice' : '';
  const rows = [];
  if (renaming !== null) rows.push({ group, icon: 'options', label: words ? 'Rename “' + renaming + '” to “' + words + '”' : 'Type the new name', hint: problem || (words ? '↩' : 'Esc keeps it'), disabled: !words || !!problem || words === renaming,
    keepOpen: true, run: () => { const from = renaming; renaming = null; palInput.value = ''; palInput.placeholder = 'New choice'; saveDefinition(fieldCtx, { options: labels.map((l) => (l === from ? words : l)) }); } });
  else if (words) rows.push({ group, icon: 'createNew', label: 'Add “' + words + '”', hint: problem || '↩', disabled: !!problem, keepOpen: true, run: () => { palInput.value = ''; saveDefinition(fieldCtx, { options: [...labels, words] }); } });
  for (const label of labels) rows.push({ group, icon: 'options', label, choice: label, hint: '↩ renames · ⌘⌫ removes · ⇧⌘↑↓ moves', keepOpen: true,
    run: () => { renaming = label; palInput.value = label; palInput.placeholder = 'Rename “' + label + '”'; palIndex = 0; renderPalette(); } });
  if (!labels.length && !words) rows.push({ group, label: 'No choices yet: type one', disabled: true });
  return rows;
}
function choiceKeys(e) {
  if (e.key === 'Escape' && renaming !== null) { renaming = null; palInput.value = ''; palInput.placeholder = 'New choice'; renderPalette(); return true; }
  const row = palRows[palIndex], mod = e.metaKey || e.ctrlKey;
  if (!mod || !row || row.choice === undefined) return false;
  const labels = choiceLabels(), i = labels.indexOf(row.choice);
  if (e.key === 'Backspace') { labels.splice(i, 1); saveDefinition(fieldCtx, { options: labels }); return true; }
  if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return false;
  const j = i + (e.key === 'ArrowUp' ? -1 : 1);
  if (j < 0 || j >= labels.length) return true; // at the end already: the key is still this page's
  [labels[i], labels[j]] = [labels[j], labels[i]];
  palIndex += j - i;
  saveDefinition(fieldCtx, { options: labels });
  return true;
}
// Link to types: every type in the workspace, the current targets ticked; each Enter adds or removes one.
// (typeListCache is declared in renderer/pills.js, whose Type pill lists the same types)
// The page reads the types afresh (loadList: Loading…, the failure or the list), and shows the ones the Type pill
// already read while it does; a failed read says so instead of Loading… for as long as the page is open (#394).
let targetTypes = null;
function openTargetsPage(ctx) {
  // the read starts before the page is drawn, so its first render shows the pill's copy or Loading…, never the last failure
  loadList('field', () => tana.typeList(), (list) => { targetTypes = list || typeListCache; if (Array.isArray(list)) typeListCache = list; });
  openFieldPage(ctx, targetRows, 'Link to types…', openCommandPalette);
}
function targetRows(q) {
  const ctx = fieldCtx, to = plainDef(ctx.def.to), group = (ctx.def.title || 'Field') + ' links to';
  const rows = listRows(group, targetTypes, q, 'No types in this workspace', (list) => list.filter((t) => fuzzyMatch(t.title || '', q)).map((t) => {
    const on = to.some((x) => x.uri === t.uri);
    return { group, icon: typeGlyph(t.uri), label: t.title || 'Untitled type', hint: on ? '✓' : '', keepOpen: true,
      run: () => saveDefinition(ctx, { to: on ? to.filter((x) => x.uri !== t.uri) : [...to, { uri: t.uri }] }) };
  }));
  // a typed page draws no "No results" of its own (renderPalette), so a query that matches no type says so here
  return rows.length || !q ? rows : [{ group, label: 'No types match', disabled: true, note: true }];
}
// Add field …: its name first, then what kind of field it is, then one write.
function addFieldRows(q, typed) {
  const words = (typed || '').trim();
  if (!words) return [{ group: 'Add field', icon: 'createNew', label: 'Type the field’s name', disabled: true }];
  return [{ group: 'Add field', icon: 'createNew', label: 'Add field “' + words + '”', hint: 'then its type', keepOpen: true,
    run: () => openFieldPage({ ...fieldCtx, title: words }, addKindRows, 'Field type of “' + words + '”', () => openFieldPage({ typeUri: fieldCtx.typeUri }, addFieldRows, 'Name the field', openCommandPalette, words)) }];
}
function addKindRows(q) {
  const { typeUri, title } = fieldCtx;
  return FIELD_KINDS.filter(([, name]) => fuzzyMatch(name, q)).map(([type, name]) => ({ group: 'Add field “' + title + '”', icon: 'field', label: name,
    run: () => run(async () => { await tana.addField(typeUri, { title, ...(type ? { type } : {}) }); refreshRelated(typeUri); }) }));
}
