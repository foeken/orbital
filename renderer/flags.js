'use strict';
// Feature flags (main/flags.js): Cmd+K Enable feature flag and Disable feature flag, each a page of the flags it can
// switch, on this Mac only. And what a flag adds to the outliner itself: the Decisions API's Suggest sensitive marks
// (main/decisions.js suggestSensitive), which goes with that experiment.
let featureFlags = []; // [{ id, label, hint, on }]: read at load, and sent again whenever any page switches one
const flagOn = (id) => featureFlags.some((f) => f.id === id && f.on);
if (tana.featureFlags) tana.featureFlags().then((list) => { featureFlags = list; }, () => {});
if (tana.onFeatureFlags) tana.onFeatureFlags((list) => { featureFlags = list; });
const FLAG_GROUP = 'Feature flags';
const flagChoices = (enable) => featureFlags.filter((f) => f.on !== enable).map((f) => ({ group: FLAG_GROUP, icon: 'options', label: f.label, hint: f.hint, keepOpen: true,
  run: () => run(async () => { featureFlags = await tana.setFeatureFlag(f.id, enable); closePalette(); showNote(f.label + (enable ? ' on' : ' off')); }) }));
// Settings rows (renderer/palette.js paletteRows): Enable while a flag is off, Disable while one is on. Typing past the
// row names the flag: "Enable feature flag Decisions API".
function flagRows() {
  if (!tana.setFeatureFlag) return [];
  return [true, false].filter((enable) => flagChoices(enable).length).map((enable) => ({ id: enable ? 'enableFlag' : 'disableFlag', group: 'Settings', icon: 'options',
    label: (enable ? 'Enable' : 'Disable') + ' feature flag', keepOpen: true, subAlways: true, sub: async () => flagChoices(enable),
    run: () => openPage('flags', (enable ? 'Enable' : 'Disable') + ' feature flag…', { rows: (q) => matchRows(flagChoices(enable), q), back: BACK_TO_COMMANDS }) }));
}

// ---- Suggest sensitive marks (the Decisions API flag): the page and the documents listed on it that look like
// something to blur, most likely first; ↩ marks one, as Mark as sensitive does. Only titles go, never one already marked.
const SENSITIVE_GROUP = 'Looks sensitive · ↩ marks it';
const SENSITIVE_LIKELY = 0.5; // ponytail: the model's own odds, uncalibrated; raise it if it suggests too much
let sensitiveFound = null; // null while asked, then [{ id, text, p }] or the Error
function sensitiveCandidates() {
  const found = new Map(), add = (id, text) => { if (isRealId(id) && !sensitiveIds.has(id) && (text || '').trim()) found.set(id, text.trim()); };
  if (zoom) add(zoom.docId, titleEl.textContent);
  for (const item of items.values()) if (rendered.has(item.key) && item.node.kind === 'document') add(item.node.id, item.node.text);
  return [...found].map(([id, text]) => ({ id, text }));
}
function suggestSensitiveRows() {
  if (!tana.suggestSensitive || !flagOn('decisions') || !sensitiveIds) return [];
  return [{ id: 'suggestSensitive', group: 'Actions', icon: 'hidden', label: 'Suggest sensitive marks', hint: 'This page and what it lists', keepOpen: true, run: openSensitivePalette }];
}
const sensitiveRows = (q) => listRows(SENSITIVE_GROUP, sensitiveFound, q, 'Nothing here looks sensitive', (list) => list
  .filter((s) => !sensitiveIds.has(s.id) && fuzzyMatch(s.text, q))
  .map((s) => ({ group: SENSITIVE_GROUP, icon: 'hidden', label: demoText(s.text, s.id), hint: Math.round(s.p * 100) + '%', keepOpen: true,
    run: () => { setSensitiveMark([s.id], true); run(async () => renderPalette()); } }))); // after the mark: the row leaves the list
function openSensitivePalette() {
  const nodes = sensitiveCandidates(), text = new Map(nodes.map((n) => [n.id, n.text]));
  loadList('suggestSensitive', async () => (await tana.suggestSensitive(nodes)).filter((s) => s.p >= SENSITIVE_LIKELY).sort((a, b) => b.p - a.p).map((s) => ({ ...s, text: text.get(s.id) })),
    (list) => { sensitiveFound = list; });
  openPage('suggestSensitive', 'Mark what looks sensitive…', { rows: sensitiveRows, back: BACK_TO_COMMANDS });
}
