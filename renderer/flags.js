'use strict';
// Feature flags (main/flags.js): Cmd+K Enable feature flag and Disable feature flag, each a page of the flags it can
// switch, on this Mac only. And what a flag adds to the outliner itself: the Decisions API's Suggest sensitive marks
// and ranked @ and # menus (main/decisions.js), which go with that experiment.
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
// ---- Ranked menus (the Decisions API flag): the @ menu's documents and the # menu's choices, most likely first ----
// Asked once a menu's rows are there (main/decisions.js rankChoices) with what the page and the line say; the rows
// reorder when the answer lands. Nothing is asked on a page marked sensitive, and a sensitive result is never sent.
const RANK_SURE = 0.6; // ponytail: the model's own odds; at this or more the @ menu's top document is selected, so Enter takes it
const rankOn = () => flagOn('decisions') && !!tana.rankChoices && !!sensitiveIds && !(zoom && sensitiveIds.has(zoom.docId));
function rankContext(line, typed) {
  return ['Page: ' + (zoom ? titleEl.textContent : 'a list'), 'Writing: ' + line, typed ? 'Typed in the menu: ' + typed : ''].filter(Boolean).join('\n');
}
// the @ menu (renderer/palette.js searchNow): its documents reordered, the Create and date rows left leading
function rankLinkRows(seq) {
  const ctx = linkCtx;
  if (!ctx || !rankOn()) return;
  const first = palRows.find((r) => r.node), docs = first ? palRows.filter((r) => r.node && r.group === first.group).slice(0, 50) : [];
  const sent = docs.filter((r) => !sensitiveIds.has(r.node.id));
  if (sent.length < 2) return;
  const before = palIndex, line = ctx.composer ? composerText.textContent : plainOf(ctx.segs).slice(0, ctx.start) + '@' + plainOf(ctx.segs).slice(ctx.end);
  tana.rankChoices(rankContext(line, palInput.value.trim()), sent.map((r) => r.label)).then((odds) => {
    if (seq !== palSeq || palMode !== 'search' || linkCtx !== ctx) return; // typed on, or gone
    const p = new Map(sent.map((r, i) => [r, odds[i] || 0])), held = palRows[palIndex];
    const ranked = [...docs].sort((a, b) => (p.get(b) ?? -1) - (p.get(a) ?? -1)), at = palRows.indexOf(docs[0]);
    palRows = [...palRows.slice(0, at), ...ranked, ...palRows.slice(at).filter((r) => !docs.includes(r))];
    palIndex = palIndex === before && p.get(ranked[0]) >= RANK_SURE ? palRows.indexOf(ranked[0]) : Math.max(0, palRows.indexOf(held));
    renderPalette();
  }, () => {}); // unranked is how the menu was anyway
}
// the # menu (renderer/toolbar.js hashRows): its choices in the order asked for, once the answer is there
let hashRank = null; // { link, odds: Map title -> p | null while asked }
function rankHashChoices(link, title, choices) {
  if (!rankOn() || choices.length < 2) return choices;
  if (hashRank?.link !== link) {
    const mine = hashRank = { link, odds: null };
    tana.rankChoices(rankContext(plainOf(link.segs), 'Make "' + title + '" a…'), choices.map((c) => c.title))
      .then((odds) => { mine.odds = new Map(choices.map((c, i) => [c.title, odds[i] || 0])); if (hashRank === mine && palMode === 'hashCreate') renderPalette(); }, () => {});
  }
  return hashRank.odds ? [...choices].sort((a, b) => (hashRank.odds.get(b.title) || 0) - (hashRank.odds.get(a.title) || 0)) : choices; // one list, no sections (renderer/toolbar.js hashRows)
}
